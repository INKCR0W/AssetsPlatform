import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, open, readFile, readdir, realpath, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {IngestValidationError, inspectIngestFile, prepareIngestPublication, validateIngestPlan} from './ingest-publication.mjs';
import {suggestIngestBindings} from './ingest-suggestions.mjs';

const prefix = '/api/v1/ingest-batches';
const localOrigin = 'http://assets.ingestion.local';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const safeDataset = value => typeof value === 'string' && value.length <= 240 && value.trim() === value && value &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const safeRoot = value => typeof value === 'string' && /^\/(?:[A-Za-z0-9._-]+\/)*$/.test(value) &&
  !value.split('/').some(part => part.startsWith('.'));
const blobPattern = /^[0-9a-f]{64}\.(?:glb|png|jpg)$/;
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const scope = (projectId, datasetId) => JSON.stringify([projectId, datasetId]);
const mediaTypes = {glb:'model/gltf-binary', png:'image/png', jpg:'image/jpeg'};
const sources = new Set(['', 'original', 'purchased', 'reference', 'other']);
const permissionNames = new Set(['ingest:write', 'ingest:publish']);
const MiB = 1024 * 1024;
const limits = {fileBytes:64*MiB, imageBytes:32*MiB, batchBytes:192*MiB, storedBytes:2*1024*MiB,
  bodyBytes:256*1024, stateBytes:16*MiB, batches:256, files:48, simultaneousUploads:4};
const draftLimits = {files:limits.files, versions:20, bindings:80};

class IngestRequestError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    Object.assign(this, {status, code, headers});
  }
}

function requireRequest(ok, status, code, message, headers) {
  if (!ok) throw new IngestRequestError(status, code, message, headers);
}

function sendJSON(response, status, data, headers) {
  if (response.destroyed) return;
  response.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff', ...headers
  });
  response.end(JSON.stringify(data));
}

function contained(root, file) {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..'+path.sep);
}

async function regularInfo(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Ingestion storage requires regular files');
  return info;
}

async function readBoundedFile(file, limit) {
  const info = await regularInfo(file);
  if (info.size > limit) throw Error('Ingestion storage file exceeds its limit');
  const bytes = await readFile(file);
  if (bytes.length !== info.size) throw Error('Ingestion storage file changed during read');
  return bytes;
}

async function readDiskJSON(file, limit) {
  const bytes = await readBoundedFile(file, limit);
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

function registeredURL(value, base) {
  if (typeof value !== 'string' || !value || value.startsWith('//') || /[\\%:\u0000-\u0020\u007f]/u.test(value) ||
      value.split('/').includes('..')) throw Error('Invalid registered project resource path');
  const url = new URL(value, base);
  if (url.origin !== localOrigin || url.search || url.hash) throw Error('Invalid registered project resource URL');
  return url;
}

async function loadConfiguration(configFile, staticRoot) {
  const root = await realpath(staticRoot);
  const file = await realpath(configFile);
  if (contained(root,file)) throw Error('Ingestion configuration must be outside the served directory');
  const config = await readDiskJSON(file, limits.bodyBytes);
  if (!config || typeof config.stateDir !== 'string' || !config.stateDir || !Array.isArray(config.projects) ||
      !config.projects.length || config.projects.length > 64 || !Array.isArray(config.users) ||
      !config.users.length || config.users.length > 100) throw Error('Invalid ingestion configuration');
  const statePath = path.resolve(path.dirname(file), config.stateDir);
  const stateParent = await realpath(path.dirname(statePath));
  const stateDir = path.join(stateParent, path.basename(statePath));
  if (contained(root,stateDir) || contained(stateDir,root) || contained(stateDir,file)) {
    throw Error('Ingestion state directory must be separate from files being served and the configuration');
  }
  await mkdir(stateDir, {mode:0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(stateDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Ingestion state directory cannot be an alias');
  const directory = await readDiskJSON(path.join(root,'project-directory.json'),2*MiB);
  const registered = new Map((directory.projects || []).map(entry=>[entry.id,entry]));
  const projects = new Map(), assetsRoots = new Set();
  for (const entry of config.projects) {
    if (!id(entry?.projectId) || projects.has(entry.projectId) || !safeDataset(entry.datasetId) ||
        !safeRoot(entry.assetRoot) || assetsRoots.has(entry.assetRoot)) throw Error('Invalid ingestion project declaration');
    const project = registered.get(entry.projectId);
    const descriptorURL = registeredURL(project?.config, localOrigin+'/');
    const descriptorFile = await realpath(path.join(root,descriptorURL.pathname.slice(1)));
    if (!contained(root,descriptorFile)) throw Error('Ingestion project descriptor escapes the served directory');
    const descriptor = await readDiskJSON(descriptorFile,2*MiB);
    const descriptorRoot = registeredURL(descriptor.assetRoot,descriptorURL).pathname;
    if (descriptor.id !== entry.projectId || descriptor.datasetId !== entry.datasetId ||
        descriptor.dataKind !== 'indexed' || descriptorRoot !== entry.assetRoot ||
        (project.assetRoot !== undefined && registeredURL(project.assetRoot,descriptorURL).pathname !== descriptorRoot)) {
      throw Error('Ingestion project must match its indexed descriptor and dataset');
    }
    if (!contained(root,await realpath(path.join(root,entry.assetRoot.slice(1))))) {
      throw Error('Ingestion project asset root escapes the served directory');
    }
    assetsRoots.add(entry.assetRoot);
    projects.set(entry.projectId,{...entry, key:scope(entry.projectId,entry.datasetId),
      overlayPath:entry.assetRoot+'assets/ingested/'});
  }
  const users = new Map(), tokens = new Set();
  for (const user of config.users) {
    if (!id(user?.id) || users.has(user.id) || typeof user.tokenHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(user.tokenHash) || tokens.has(user.tokenHash) || !Array.isArray(user.projects) ||
        !user.projects.length || user.projects.some(projectId=>!projects.has(projectId)) ||
        !Array.isArray(user.permissions) || !user.permissions.length ||
        user.permissions.some(value=>!permissionNames.has(value))) throw Error('Invalid ingestion user declaration');
    tokens.add(user.tokenHash);
    users.set(user.id,{
      id:user.id, hash:Buffer.from(user.tokenHash,'hex'), projects:new Set(user.projects), permissions:new Set(user.permissions)
    });
  }
  return {stateDir, projects, users};
}

function authenticate(request, users) {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization || '');
  requireRequest(match && tokenPattern.test(match[1]),401,'UNAUTHORIZED','请输入入库访问令牌。',{'WWW-Authenticate':'Bearer'});
  const candidate = Buffer.from(digest(match[1]),'hex');
  let actor;
  for (const user of users.values()) if (timingSafeEqual(user.hash,candidate)) actor = user;
  requireRequest(actor,401,'UNAUTHORIZED','入库访问令牌无效。',{'WWW-Authenticate':'Bearer'});
  return actor;
}

async function atomicWrite(file, bytes) {
  const temporary = path.join(path.dirname(file),'.'+randomUUID()+'.tmp');
  try {
    const handle = await open(temporary,'wx',0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary,file);
  } catch (error) {
    await unlink(temporary).catch(cleanup => {
      if (cleanup.code !== 'ENOENT') console.error('Ingestion temporary file cleanup failed:',cleanup.code);
    });
    throw error;
  }
}

async function openStore(stateDir) {
  const blobDir = path.join(stateDir,'blobs');
  await mkdir(blobDir,{mode:0o700}).catch(error=>{if(error.code !== 'EEXIST')throw error;});
  const directory = await lstat(blobDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Invalid ingestion blob directory');
  const stateFile = path.join(stateDir,'state.json');
  let state = {schema:1,batches:[],publications:[]};
  try { state = await readDiskJSON(stateFile,limits.stateBytes); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state?.schema !== 1 || !Array.isArray(state.batches) || state.batches.length > limits.batches ||
      !Array.isArray(state.publications) || state.publications.length > limits.batches) throw Error('Invalid ingestion state');
  const blobs = new Map();
  let storedBytes = 0;
  for (const name of await readdir(blobDir)) {
    if (!blobPattern.test(name)) continue;
    const size = (await regularInfo(path.join(blobDir,name))).size;
    if (size > limits.fileBytes) throw Error('Invalid ingestion blob size');
    blobs.set(name,size);
    storedBytes += size;
  }
  let pending = Promise.resolve();
  return {
    get state() { return state; },
    async save(next) {
      const serialized = Buffer.from(JSON.stringify(next));
      requireRequest(serialized.length <= limits.stateBytes,409,'STATE_LIMIT','入库记录已达容量上限。');
      await atomicWrite(stateFile,serialized);
      state = next;
    },
    async saveBlob(bytes, sha, extension) {
      const filename = sha+'.'+extension;
      if (!blobPattern.test(filename) || bytes.length > limits.fileBytes || digest(bytes) !== sha) {
        throw Error('Invalid ingestion blob');
      }
      if (!blobs.has(filename)) {
        requireRequest(storedBytes+bytes.length <= limits.storedBytes,409,'STORAGE_LIMIT','入库文件已达存储上限。');
        await atomicWrite(path.join(blobDir,filename),bytes);
        blobs.set(filename,bytes.length);
        storedBytes += bytes.length;
      }
      return filename;
    },
    async loadBlob(filename) {
      if (!blobPattern.test(filename) || !blobs.has(filename)) throw Error('Missing ingestion blob');
      const bytes = await readBoundedFile(path.join(blobDir,filename),limits.fileBytes);
      if (digest(bytes) !== filename.slice(0,64)) throw Error('Ingestion file checksum mismatch');
      return bytes;
    },
    async sendBlob(request,response,filename,cacheControl) {
      if (!blobPattern.test(filename) || !blobs.has(filename)) throw Error('Missing ingestion blob');
      const file=path.join(blobDir,filename), info=await regularInfo(file);
      const stream = request.method === 'HEAD' ? null : createReadStream(file);
      if (stream) {
        stream.on('error',()=>response.destroy());
        response.once('close',()=>stream.destroy());
      }
      response.writeHead(200,{
        'Content-Type':mediaTypes[filename.split('.').at(-1)],
        'Content-Length':info.size,'Cache-Control':cacheControl,'X-Content-Type-Options':'nosniff'
      });
      if (stream) stream.pipe(response);
      else response.end();
    },
    mutate(work) {
      const next = pending.then(work);
      pending = next.catch(()=>{});
      return next;
    }
  };
}

async function readBytes(request, limit) {
  requireRequest(Number(request.headers['content-length']) <= limit || request.headers['content-length'] === undefined,
    413,'BODY_TOO_LARGE','请求超出容量限制。');
  return new Promise((resolve,reject)=>{
    let size=0;
    let exceeded=false;
    const chunks=[];
    request.on('data',chunk=>{
      size+=chunk.length;
      if (size <= limit) chunks.push(chunk);
      else if (!exceeded) {
        exceeded=true;
        chunks.length=0;
        reject(new IngestRequestError(413,'BODY_TOO_LARGE','请求超出容量限制。'));
      }
    });
    request.once('end',()=>{
      if (size > limit) reject(new IngestRequestError(413,'BODY_TOO_LARGE','请求超出容量限制。'));
      else resolve(Buffer.concat(chunks,size));
    });
    request.once('aborted',()=>reject(new IngestRequestError(400,'REQUEST_ABORTED','请求已中断。')));
    request.once('error',reject);
  });
}

function contentType(request) {
  return request.headers['content-type']?.split(';',1)[0].trim().toLowerCase();
}

async function readJSON(request) {
  requireRequest(contentType(request)==='application/json',415,'INVALID_CONTENT_TYPE','请发送 application/json。');
  const raw=await readBytes(request,limits.bodyBytes);
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)); }
  catch { throw new IngestRequestError(400,'INVALID_JSON','无法读取请求 JSON。'); }
}

function uploadName(request) {
  let name;
  try { name = decodeURIComponent(request.headers['x-file-name'] || ''); }
  catch { throw new IngestRequestError(400,'INVALID_FILE_NAME','无法读取 X-File-Name。'); }
  requireRequest(name && name.length <= 240 && !/[/\\\u0000-\u001f\u007f]/u.test(name),
    400,'INVALID_FILE_NAME','请在 X-File-Name 中提供文件名。');
  const extension=path.extname(name).toLowerCase().slice(1).replace(/^jpeg$/,'jpg');
  requireRequest(Object.hasOwn(mediaTypes,extension),415,'INVALID_FILE_TYPE','支持自包含 GLB、PNG 或 JPG 文件。');
  return {name,extension,relativePath:uploadRelativePath(request.headers['x-relative-path'],name)};
}

function uploadRelativePath(header,name) {
  if (header===undefined) return undefined;
  let relativePath;
  try { relativePath=decodeURIComponent(header).replaceAll('\\','/'); }
  catch { throw new IngestRequestError(400,'INVALID_RELATIVE_PATH','无法读取 X-Relative-Path。'); }
  const segments=relativePath.split('/');
  requireRequest(relativePath.length<=512 && segments.length<=17 && segments.at(-1)===name &&
    segments.every(segment=>segment && segment.length<=240 && segment!=='.' && segment!=='..' &&
      !/[:\u0000-\u001f\u007f]/u.test(segment)),
    400,'INVALID_RELATIVE_PATH','请提供以文件名结尾的批次相对路径。');
  return relativePath;
}

const textField=(value,length)=>typeof value === 'string' && value.length <= length && !/[\u0000-\u001f\u007f]/u.test(value);
const optionalId=value=>value==null || value==='' || id(value);
const optionalIndex=value=>value==null || Number.isSafeInteger(value) && value>=0;

function parsePlan(body) {
  const {versions,bindings}=body ?? {};
  requireRequest(Array.isArray(versions)&&versions.length<=draftLimits.versions&&
    Array.isArray(bindings)&&bindings.length<=draftLimits.bindings,
    400,'INVALID_PLAN','入库计划需要 versions 和 bindings。');
  const versionsOk=versions.every(version=>version && id(version.id) && textField(version.name,100) &&
    textField(version.label,80) && optionalId(version.modelFileId) && sources.has(version.source??''));
  const bindingsOk=bindings.every(binding=>binding && id(binding.id) && id(binding.fileId) &&
    optionalId(binding.versionId) && ['texture','animation'].includes(binding.kind) &&
    optionalIndex(binding.materialIndex) && optionalIndex(binding.clipIndex));
  requireRequest(versionsOk&&bindingsOk&&new Set(versions.map(v=>v.id)).size===versions.length&&
    new Set(bindings.map(binding=>binding.id)).size===bindings.length,400,'INVALID_PLAN','模型版本、附件或标识不正确。');
  return {
    versions:versions.map(({id,name,label,modelFileId,source})=>({id,name,label,modelFileId,source})),
    bindings:bindings.map(({id,fileId,kind,versionId,materialIndex,clipIndex})=>({id,fileId,kind,versionId,materialIndex,clipIndex}))
  };
}

function batching(store, projects) {
  function draft(id, actor) {
    const batch=store.state.batches.find(record=>record.id===id);
    const project=batch && projects.get(batch.projectId);
    requireRequest(batch && batch.owner===actor.id && actor.projects.has(batch.projectId) &&
      project?.datasetId===batch.datasetId,404,'BATCH_NOT_FOUND','找不到此入库批次。');
    return batch;
  }

  function writePermission(actor, permission='ingest:write') {
    requireRequest(actor.permissions.has(permission),403,'INGEST_PERMISSION_REQUIRED','当前账号不能执行此入库操作。');
  }

  function draftOnly(batch) {
    requireRequest(!batch.published,409,'BATCH_PUBLISHED','该批次已入库。');
  }

  function atRevision(batch, revision) {
    requireRequest(batch.revision===revision,409,'STALE_REVISION','草稿已更新，请重新读取后校验。');
  }

  async function persistBatch(batch, publications=store.state.publications) {
    const batches=store.state.batches.map(record=>record.id===batch.id?batch:record);
    await store.save({...store.state,batches,publications});
  }

  async function loadFiles(batch) {
    const attached=new Set([
      ...batch.plan.versions.map(version=>version.modelFileId),
      ...batch.plan.bindings.map(binding=>binding.fileId)
    ]);
    const files=new Map();
    for (const record of batch.files) {
      const fileId=record.metadata.fileId;
      if (!attached.has(fileId) || record.metadata.error) {
        files.set(fileId,{metadata:record.metadata});
        continue;
      }
      const [data,preview]=await Promise.all([
        store.loadBlob(record.original),record.preview && store.loadBlob(record.preview.filename)
      ]);
      files.set(fileId,{metadata:record.metadata,data,
        ...(preview ? {preview:{...record.preview,bytes:preview}} : {})});
    }
    return files;
  }

  let activeUploads=0;
  async function upload(request,response,actor,batchId,fileId) {
    writePermission(actor);
    requireRequest(id(fileId),400,'INVALID_FILE_ID','文件标识不正确。');
    requireRequest(contentType(request)==='application/octet-stream',415,'INVALID_CONTENT_TYPE','请发送 application/octet-stream。');
    const {name,extension,relativePath}=uploadName(request);
    const current=draft(batchId,actor);
    draftOnly(current);
    requireRequest(activeUploads < limits.simultaneousUploads,429,'UPLOAD_BUSY','同时上传过多，请稍后重试。',{'Retry-After':'2'});
    activeUploads++;
    try {
      const data=await readBytes(request,extension==='glb'?limits.fileBytes:limits.imageBytes);
      const sha256=digest(data);
      const uploaded=await store.mutate(async()=>{
        const batch=draft(batchId,actor);
        draftOnly(batch);
        const previous=batch.files.find(file=>file.metadata.fileId===fileId);
        if (previous) {
          requireRequest(previous.metadata.sha256===sha256 && previous.metadata.name===name &&
            previous.metadata.relativePath===relativePath,
            409,'FILE_ID_CONFLICT','该文件标识已用于其他内容。');
          return {metadata:previous.metadata,status:200};
        }
        const size=batch.files.reduce((total,file)=>total+file.metadata.bytes,0)+data.length;
        requireRequest(batch.files.length<limits.files&&size<=limits.batchBytes,409,'STAGING_LIMIT','批次暂存已达上限。');
        const inspected=await inspectIngestFile(name,data);
        if (inspected?.metadata?.sha256!==sha256) throw Error('Invalid inspected file digest');
        const metadata={...inspected.metadata,fileId,...(relativePath===undefined?{}:{relativePath})};
        const original=await store.saveBlob(data,sha256,extension);
        const file={metadata,original};
        if (inspected.preview) {
          const {digest,extension,mimeType,bytes}=inspected.preview;
          file.preview={digest,extension,mimeType,filename:await store.saveBlob(bytes,digest,extension)};
        }
        // Files are immutable, but adding any unvalidated input invalidates the existing receipt.
        await persistBatch({...batch,files:[...batch.files,file],validation:undefined});
        return {metadata,status:201};
      });
      sendJSON(response,uploaded.status,uploaded.metadata);
    } finally { activeUploads--; }
  }

  async function modify(request,response,actor,batchId,action) {
    writePermission(actor,action==='publish'?'ingest:publish':'ingest:write');
    const body=await readJSON(request);
    const result=await store.mutate(async()=>{
      const batch=draft(batchId,actor);
      if (action==='plan') {
        draftOnly(batch);
        const header=request.headers['if-match'];
        requireRequest(typeof header==='string'&&/^"\d+"$/.test(header),428,'REVISION_REQUIRED','请在 If-Match 中发送草稿修订号。');
        atRevision(batch,Number(header.slice(1,-1)));
        const revision=batch.revision+1;
        await persistBatch({...batch,plan:parsePlan(body),revision,validation:undefined});
        return {data:{revision},headers:{ETag:'"'+revision+'"'}};
      }
      if (action==='validate') {
        draftOnly(batch);
        atRevision(batch,body?.revision);
        const validation=await validateIngestPlan(batch,await loadFiles(batch));
        await persistBatch({...batch,validation});
        return {data:validation};
      }
      const key=request.headers['idempotency-key'];
      requireRequest(typeof key==='string'&&/^[!-~]{1,160}$/.test(key),400,'IDEMPOTENCY_KEY_REQUIRED','请在 Idempotency-Key 中提供发布标识。');
      const intent=JSON.stringify([body?.revision,body?.validationId]);
      if (batch.published?.key===key) {
        requireRequest(batch.published.intent===intent,409,'IDEMPOTENCY_KEY_CONFLICT','发布标识已用于其他请求。');
        return {data:batch.published.result};
      }
      draftOnly(batch);
      atRevision(batch,body?.revision);
      requireRequest(batch.validation?.validationId && batch.validation.validationId===body?.validationId,
        409,'VALIDATION_REQUIRED','请重新校验当前草稿。');
      requireRequest(!batch.validation.issues.some(issue=>issue.severity==='error'),422,'VALIDATION_BLOCKED','先处理阻塞问题，再重新校验。');
      const {assets,objects,blobs}=await prepareIngestPublication(batch,await loadFiles(batch));
      const publishedBlobs=new Set();
      for (const blob of blobs) publishedBlobs.add(await store.saveBlob(blob.bytes,blob.digest,blob.extension));
      const publication={key:scope(batch.projectId,batch.datasetId),assets,objects,blobs:[...publishedBlobs]};
      const output={status:'published',published:objects.flatMap(object=>object.variants.map(version=>({
        id:version.id, objectId:object.id, name:object.name, label:version.label
      })))};
      await persistBatch({...batch,published:{key,intent,result:output}},[...store.state.publications,publication]);
      return {data:output};
    });
    sendJSON(response,200,result.data,result.headers);
  }

  async function suggest(request,response,actor,batchId) {
    writePermission(actor);
    const body=await readJSON(request);
    const batch=draft(batchId,actor);
    draftOnly(batch);
    atRevision(batch,body?.revision);
    const plan=body && Object.hasOwn(body,'plan') ? parsePlan(body.plan) : batch.plan;
    const suggestions=suggestIngestBindings(plan,batch.files.map(record=>record.metadata));
    sendJSON(response,200,{revision:batch.revision,suggestions});
  }

  return async function handle(request,response,pathname,actor) {
    if (pathname===prefix && ['GET','POST'].includes(request.method)) {
      writePermission(actor);
      const {projectId,datasetId} = request.method==='GET'
        ? Object.fromEntries(new URL(request.url,localOrigin).searchParams) : (await readJSON(request)) ?? {};
      const project=projects.get(projectId);
      requireRequest(project&&project.datasetId===datasetId&&actor.projects.has(project.projectId),
        404,'PROJECT_NOT_FOUND','找不到可入库的资产目录。');
      if (request.method==='GET') return sendJSON(response,200,{limits:draftLimits});
      const batch=await store.mutate(async()=>{
        requireRequest(store.state.batches.length < limits.batches,409,'BATCH_LIMIT','服务已达到批次数量上限。');
        const batch={id:randomUUID(),owner:actor.id,projectId:project.projectId,datasetId:project.datasetId,
          revision:0,files:[],plan:{versions:[],bindings:[]}};
        await store.save({...store.state,batches:[...store.state.batches,batch]});
        return batch;
      });
      return sendJSON(response,201,{batchId:batch.id,revision:0,limits:draftLimits},{ETag:'"0"'});
    }

    const [,batchId,action,fileId,preview]=/^\/api\/v1\/ingest-batches\/([A-Za-z0-9_-]+)(?:\/(files|plan|suggest|validate|publish)(?:\/([A-Za-z0-9_-]+)(?:\/(preview))?)?)?$/.exec(pathname)||[];
    const batch=draft(batchId,actor);
    if (request.method==='GET'&&!action) {
      return sendJSON(response,200,{
        batchId:batch.id,projectId:batch.projectId,datasetId:batch.datasetId,revision:batch.revision,
        limits:draftLimits,plan:batch.plan,
        files:batch.files.map(file=>file.metadata),validation:batch.validation,
        status:batch.published?'published':'draft',published:batch.published?.result.published
      },{ETag:'"'+batch.revision+'"'});
    }
    if (request.method==='PUT'&&action==='files'&&fileId&&!preview) return upload(request,response,actor,batchId,fileId);
    if (['GET','HEAD'].includes(request.method)&&action==='files'&&fileId&&preview) {
      const file=batch.files.find(item=>item.metadata.fileId===fileId);
      requireRequest(file&&!file.metadata.error,404,'PREVIEW_NOT_FOUND','找不到文件预览。');
      return store.sendBlob(request,response,file.preview?.filename||file.original,'no-store');
    }
    if (request.method==='POST'&&action==='suggest'&&!fileId) return suggest(request,response,actor,batchId);
    if (!fileId&&(request.method==='PUT'&&action==='plan'||request.method==='POST'&&['validate','publish'].includes(action))) {
      return modify(request,response,actor,batchId,action);
    }
    throw new IngestRequestError(404,'ROUTE_NOT_FOUND','找不到此入库接口。');
  };
}

export async function createIngestAPI({configFile,staticRoot}) {
  const {stateDir,projects,users}=await loadConfiguration(configFile,staticRoot);
  const store=await openStore(stateDir);
  const handleBatch=batching(store,projects);
  const registered=[...projects.values()].sort((a,b)=>b.overlayPath.length-a.overlayPath.length);

  return async function handleIngestRequest(request,response,pathname) {
    const isBatch=pathname===prefix||pathname.startsWith(prefix+'/');
    const project=registered.find(entry=>pathname.startsWith(entry.overlayPath));
    if (!isBatch&&!project) return false;
    try {
      if (isBatch) await handleBatch(request,response,pathname,authenticate(request,users));
      else if (['GET','HEAD'].includes(request.method)) {
        const relative=pathname.slice(project.overlayPath.length);
        const visible=store.state.publications.filter(publication=>publication.key===project.key);
        if (relative==='index.json') {
          const catalogue={assets:visible.flatMap(record=>record.assets),objects:visible.flatMap(record=>record.objects)};
          if (request.method==='HEAD') {
            response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
            response.end();
          } else sendJSON(response,200,catalogue);
        } else {
          requireRequest(blobPattern.test(relative)&&visible.some(record=>record.blobs.includes(relative)),
            404,'ASSET_NOT_FOUND','找不到已入库的文件。');
          await store.sendBlob(request,response,relative,'private, max-age=31536000, immutable');
        }
      } else throw new IngestRequestError(405,'METHOD_NOT_ALLOWED','不支持此方法。',{Allow:'GET, HEAD'});
    } catch (error) {
      if (error instanceof IngestRequestError || error instanceof IngestValidationError) {
        sendJSON(response,error.status,{error:{code:error.code,message:error.message}},error.headers);
      } else {
        console.error('Ingestion request failed:',error.code||error.name,error.message);
        sendJSON(response,500,{error:{code:'INGEST_FAILED',message:'入库请求暂时无法完成。'}});
      }
    } finally { if (!request.readableEnded&&!request.destroyed) request.resume(); }
    return true;
  };
}
