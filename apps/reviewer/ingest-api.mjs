import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, open, readFile, readdir, realpath, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {readAssetShards} from './adapters/indexed-data.mjs';
import {conflictingVersionLabels, IngestValidationError, inspectIngestFile, prepareIngestPublication, validateIngestPlan} from './ingest-publication.mjs';
import {suggestIngestBindings} from './ingest-suggestions.mjs';
import {resolveDownloadAsset} from './shared/download-catalog.mjs';
import {createJSONBudget, readBoundedJSON} from './shared/json-budget.mjs';
import {createResourceResolver, resolveResourceRoot} from './shared/resource-url.mjs';
import {normalizeAssetTag, teamLimits} from './shared/team-client.mjs';

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
const writeGrant = 'ingest:write';
const publishGrant = 'ingest:publish';
const permissionNames = new Set([writeGrant,publishGrant]);
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

async function readProjectDescriptor(root, descriptorURL) {
  const descriptorFile=await realpath(path.resolve(root,'.'+decodeURIComponent(descriptorURL.pathname)));
  if (!contained(root,descriptorFile)) throw Error('Ingestion project descriptor escapes the served directory');
  return readDiskJSON(descriptorFile,2*MiB);
}

function catalogueResolvers(root, registered, projects) {
  let pendingRoots;
  const resolvers=new Map();
  async function registeredRoots() {
    const roots=[];
    for (const entry of registered.values()) {
      const enabled=projects.get(entry.id);
      if (enabled) {
        roots.push(enabled.assetRoot);
        continue;
      }
      const descriptorURL=registeredURL(entry.config,localOrigin+'/');
      const descriptor=await readProjectDescriptor(root,descriptorURL);
      const assetRoot=resolveResourceRoot(descriptor.assetRoot,descriptorURL);
      if (descriptor.id!==entry.id || new URL(assetRoot).origin!==localOrigin ||
          entry.assetRoot!==undefined && resolveResourceRoot(entry.assetRoot,descriptorURL)!==assetRoot) {
        throw Error('Ingestion catalogue project root does not match the directory');
      }
      roots.push(assetRoot);
    }
    return roots;
  }
  return async project => {
    if (resolvers.has(project.projectId)) return resolvers.get(project.projectId);
    pendingRoots ??= registeredRoots().catch(error=>{pendingRoots=undefined;throw error;});
    const registeredProjectRoots=await pendingRoots;
    const resolver=createResourceResolver({origin:localOrigin,assetRoot:project.assetRoot,
      resourceMounts:project.resourceMounts,registeredProjectRoots});
    resolvers.set(project.projectId,resolver);
    return resolver;
  };
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
    const descriptor = await readProjectDescriptor(root,descriptorURL);
    const descriptorRoot = registeredURL(descriptor.assetRoot,descriptorURL).pathname;
    if (descriptor.id !== entry.projectId || descriptor.datasetId !== entry.datasetId ||
        descriptor.dataKind !== 'indexed' || descriptorRoot !== entry.assetRoot ||
        (project.assetRoot !== undefined && registeredURL(project.assetRoot,descriptorURL).pathname !== descriptorRoot)) {
      throw Error('Ingestion project must match its indexed descriptor and dataset');
    }
    const assetDirectory=await realpath(path.join(root,entry.assetRoot.slice(1)));
    if (!contained(root,assetDirectory)) {
      throw Error('Ingestion project asset root escapes the served directory');
    }
    assetsRoots.add(entry.assetRoot);
    projects.set(entry.projectId,{...entry, key:scope(entry.projectId,entry.datasetId),
      assetDirectory,objectNames:descriptor.objectNames,resourceMounts:descriptor.resourceMounts,
      jsonLimits:descriptor.config?.jsonLimits,
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
  return {stateDir,projects,users,catalogueResolver:catalogueResolvers(root,registered,projects)};
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
  let restored = false;
  try {
    state = await readDiskJSON(stateFile,limits.stateBytes);
    restored = true;
  }
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
  const readers = new Map();
  const garbage = new Set(restored ? blobs.keys() : []);

  function trackFiles(files) {
    for (const file of files) {
      garbage.add(file.original);
      if (file.preview) garbage.add(file.preview.filename);
    }
  }

  async function collectGarbage() {
    if (!garbage.size) return;
    const referenced = new Set(state.publications.flatMap(record => record.blobs));
    for (const batch of state.batches) {
      for (const file of batch.files) {
        referenced.add(file.original);
        if (file.preview) referenced.add(file.preview.filename);
      }
    }
    for (const filename of garbage) {
      if (referenced.has(filename) || !blobs.has(filename)) {
        garbage.delete(filename);
        continue;
      }
      if (readers.has(filename)) continue;
      try { await unlink(path.join(blobDir,filename)); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('Ingestion blob cleanup failed:',error.code);
          continue;
        }
      }
      storedBytes -= blobs.get(filename);
      blobs.delete(filename);
      garbage.delete(filename);
    }
  }

  await collectGarbage();
  let pending = Promise.resolve();
  function mutate(work) {
    const next = pending.then(async () => {
      try { return await work(); }
      finally { await collectGarbage(); }
    });
    pending = next.catch(()=>{});
    return next;
  }

  function pin(filename) {
    readers.set(filename,(readers.get(filename) || 0) + 1);
    return () => {
      const remaining = readers.get(filename) - 1;
      if (remaining) readers.set(filename,remaining);
      else {
        readers.delete(filename);
        if (garbage.has(filename)) {
          mutate(()=>{}).catch(error => console.error('Ingestion blob cleanup failed:',error.code || error.name));
        }
      }
    };
  }

  return {
    get state() { return state; },
    mutate,
    trackFiles,
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
        garbage.add(filename);
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
      const release = pin(filename);
      let stream;
      try {
        const file=path.join(blobDir,filename), info=await regularInfo(file);
        if (response.destroyed) return;
        if (request.method !== 'HEAD') {
          stream = createReadStream(file);
          stream.once('close',release);
          stream.on('error',()=>response.destroy());
          response.once('close',()=>stream.destroy());
        }
        response.writeHead(200,{
          'Content-Type':mediaTypes[filename.split('.').at(-1)],
          'Content-Length':info.size,'Cache-Control':cacheControl,'X-Content-Type-Options':'nosniff'
        });
        if (stream) stream.pipe(response);
        else response.end();
      } catch (error) {
        stream?.destroy();
        throw error;
      } finally {
        if (!stream) release();
      }
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

function parseTags(values) {
  requireRequest(Array.isArray(values) && values.length <= teamLimits.tagsPerAsset,
    400,'INVALID_TAGS','每个版本最多提交 '+teamLimits.tagsPerAsset+' 个标签。');
  const tags = [];
  const seen = new Set();
  for (const value of values) {
    const tag = normalizeAssetTag(value);
    requireRequest(tag,400,'INVALID_TAGS','标签不能为空，最长 '+teamLimits.tag+' 个字符。');
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function parsePlan(body, target) {
  const {versions,bindings}=body ?? {};
  requireRequest(Array.isArray(versions)&&versions.length<=draftLimits.versions&&
    Array.isArray(bindings)&&bindings.length<=draftLimits.bindings,
    400,'INVALID_PLAN','入库计划需要 versions 和 bindings。');
  const versionsOk=versions.every(version=>version && id(version.id) && (target || textField(version.name,100)) &&
    textField(version.label,80) && optionalId(version.modelFileId) && sources.has(version.source??''));
  const bindingsOk=bindings.every(binding=>binding && id(binding.id) && id(binding.fileId) &&
    optionalId(binding.versionId) && ['texture','animation'].includes(binding.kind) &&
    optionalIndex(binding.materialIndex) && optionalIndex(binding.clipIndex));
  requireRequest(versionsOk&&bindingsOk&&new Set(versions.map(v=>v.id)).size===versions.length&&
    new Set(bindings.map(binding=>binding.id)).size===bindings.length,400,'INVALID_PLAN','模型版本、附件或标识不正确。');
  return {
    versions:versions.map(({id,name,label,modelFileId,source,tags})=>({
      id,name:target?.name ?? name,label,modelFileId,source,
      ...(tags === undefined ? {} : {tags:parseTags(tags)})
    })),
    bindings:bindings.map(({id,fileId,kind,versionId,materialIndex,clipIndex})=>({id,fileId,kind,versionId,materialIndex,clipIndex}))
  };
}

function planWithoutFile(plan, fileId) {
  const removed = new Set(plan.versions.filter(version => version.modelFileId===fileId).map(version => version.id));
  return {
    versions:plan.versions.filter(version => !removed.has(version.id)),
    bindings:plan.bindings.filter(binding => binding.fileId!==fileId).map(binding => {
      if (!removed.has(binding.versionId)) return binding;
      return {...binding,versionId:null,...(binding.kind==='texture' ? {materialIndex:null} : {})};
    })
  };
}

function catalogueReader(project, resolve) {
  const budget=createJSONBudget(project);
  return async reference => {
    const url=new URL(resolve(reference));
    const fragment=url.hash.slice(1);
    const relative=decodeURIComponent(url.pathname).replace(/\/+/g,'/').slice(project.assetRoot.length);
    if (!relative || relative.split('/').some(part => !part || part.startsWith('.') || /[\\:]/u.test(part))) {
      throw Error('Invalid ingestion catalogue path');
    }
    const file=await realpath(path.resolve(project.assetDirectory,relative));
    if (!contained(project.assetDirectory,file)) throw Error('Ingestion catalogue escapes the project root');
    const bytes=await readBoundedFile(file,Math.min(budget.downloadLimit,budget.totalDownloadLimit-budget.downloaded));
    const data=await readBoundedJSON(new Response(bytes),{budget,context:url.pathname,gzip:url.pathname.endsWith('.gz')});
    if (!fragment) return data;
    const key=decodeURIComponent(fragment);
    if (!data?.records || !Object.hasOwn(data.records,key)) throw Error('Ingestion catalogue record not found');
    return data.records[key];
  };
}

async function staticCatalogueObject(project, objectId, resolve) {
  const read=catalogueReader(project,resolve);
  const objectCatalogue=await read('assets/objects-catalog.json');
  const rows=objectCatalogue?.objects ?? objectCatalogue?.assets;
  if (!Array.isArray(rows)) throw Error('Invalid ingestion object catalogue');
  const object=rows.find(record => record && String(record.id)===objectId);
  if (!object) return;
  const explicit=object.assemblyModelUrl || object.modelUrl || object.materialModelUrl;
  let base={};
  if (object.assetId != null || object.prefabId != null || object.sourceId != null) {
    const catalog=await read('assets/catalog.json');
    const assets=catalog.assetShards ? await readAssetShards(catalog.assetShards,read,project.jsonLimits) : catalog.assets;
    if (!Array.isArray(assets)) throw Error('Invalid ingestion resource catalogue');
    base=assets.find(record=>record?.id===object.assetId && object.assetId!=null) ??
      assets.find(record=>record?.id===object.prefabId && object.prefabId!=null) ??
      assets.find(record=>record?.sourceId===object.sourceId && object.sourceId!=null) ?? {};
  }
  const modelUrl=resolve(explicit || base.modelUrl);
  const rawName=object.name || base.name || object.id;
  const variants=object.variants || (explicit ? [] : base.variants);
  const sourceModelUrl=object.sourceModelUrl === undefined && modelUrl===resolve(base.modelUrl)
    ? base.sourceModelUrl : object.sourceModelUrl;
  return {
    id:objectId,name:String(object.displayName || project.objectNames?.[rawName] || rawName),
    modelUrl,modelAsset:object.modelAsset || (explicit ? undefined : base.modelAsset),
    sourceModelUrl:resolve(sourceModelUrl),
    variants:Array.isArray(variants) ? variants.filter(Boolean)
      .map(variant => ({...variant,modelUrl:resolve(variant.modelUrl),sourceModelUrl:resolve(variant.sourceModelUrl)})) : []
  };
}

function batching(store, projects, users, catalogueResolver) {
  async function appendTarget(project, objectId) {
    requireRequest(textField(objectId,240) && objectId.trim(),400,'INVALID_TARGET_OBJECT','请选择有效的已有模型。');
    const publications=store.state.publications.filter(record=>record.key===project.key);
    const published=publications.flatMap(record=>record.objects).find(object=>String(object.id)===objectId);
    const object=published || await staticCatalogueObject(project,objectId,(await catalogueResolver(project)).resolve);
    const downloadable=object && resolveDownloadAsset(object);
    requireRequest(downloadable,404,'TARGET_NOT_FOUND','找不到可追加版本的已有模型。');
    const existingLabels=downloadable.versions.map(version=>version.label);
    for (const publication of publications) {
      for (const addition of publication.versionAdditions || []) {
        if (addition.objectId===objectId) existingLabels.push(...addition.variants.map(variant=>variant.label));
      }
    }
    return {target:{id:objectId,name:String(object.name)},existingLabels};
  }

  function draftRole(batch, actor) {
    if (!batch || !actor.projects.has(batch.projectId) || projects.get(batch.projectId)?.datasetId !== batch.datasetId) return;
    if (batch.owner===actor.id) return 'owner';
    if (batch.recipientId===actor.id && actor.permissions.has(publishGrant)) return 'recipient';
  }

  function draft(batchId, actor) {
    const batch=store.state.batches.find(record=>record.id===batchId);
    requireRequest(draftRole(batch,actor),404,'BATCH_NOT_FOUND','找不到此入库批次。');
    return batch;
  }

  function requirePermission(allowed) {
    requireRequest(allowed,403,'INGEST_PERMISSION_REQUIRED','当前令牌不能执行此入库操作。');
  }

  function mayPublish(batch, actor) {
    return actor.permissions.has(publishGrant) && actor.id === (batch.recipientId || batch.owner);
  }

  function accessFor(batch, actor) {
    const role = draftRole(batch,actor);
    const active = !batch.published;
    const recipient = role === 'recipient';
    const ownerWrites = role === 'owner' && actor.permissions.has(writeGrant);
    const ownerCanEdit = active && ownerWrites && !batch.recipientId;
    return {
      role,
      canEdit:ownerCanEdit || (active && recipient),
      canPublish:active && mayPublish(batch,actor),
      canDelete:ownerCanEdit,
      canHandoff:ownerCanEdit,
      canReturn:active && Boolean(batch.recipientId) && (ownerWrites || recipient)
    };
  }

  function draftOnly(batch) {
    requireRequest(!batch.published,409,'BATCH_PUBLISHED','该批次已入库。');
  }

  function assignedElsewhere(batch, actor) {
    requireRequest(!batch.recipientId || batch.recipientId===actor.id,409,'BATCH_ASSIGNED','该批次已交接，请先收回草稿。');
  }

  function requireEdit(batch, actor, grant='canEdit') {
    draftOnly(batch);
    assignedElsewhere(batch,actor);
    requirePermission(accessFor(batch,actor)[grant]);
  }

  function atRevision(batch, revision) {
    requireRequest(batch.revision===revision,409,'STALE_REVISION','草稿已更新，请重新读取后校验。');
  }

  function ifMatch(request) {
    const header=request.headers['if-match'];
    requireRequest(typeof header==='string'&&/^"\d+"$/.test(header),428,'REVISION_REQUIRED','请在 If-Match 中发送草稿修订号。');
    return Number(header.slice(1,-1));
  }

  async function persistBatch(batch, publications=store.state.publications) {
    const updated={...batch,updatedAt:new Date().toISOString()};
    const batches=store.state.batches.map(record=>record.id===batch.id?updated:record);
    await store.save({...store.state,batches,publications});
  }

  function recipientsFor(ownerId, projectId) {
    return [...users.values()].filter(user => user.id!==ownerId &&
      user.permissions.has(publishGrant) && user.projects.has(projectId));
  }

  function draftBox(project, actor) {
    const batches = store.state.batches.filter(batch => !batch.published &&
      batch.projectId===project.projectId && draftRole(batch,actor))
      .reverse().sort((a,b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .map(batch => ({
        batchId:batch.id,revision:batch.revision,relation:batch.owner===actor.id?'mine':'incoming',
        ownerId:batch.owner,recipientId:batch.recipientId,fileCount:batch.files.length,
        versionCount:batch.plan.versions.length,
        title:batch.target?.name || batch.plan.versions.find(version=>version.name.trim())?.name.trim() || batch.files[0]?.metadata.name,
        target:batch.target,
        updatedAt:batch.updatedAt
      }));
    return {
      limits:draftLimits,permissions:{create:actor.permissions.has(writeGrant)},
      recipients:recipientsFor(actor.id,project.projectId).map(({id})=>({id})),
      batches
    };
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
    requireRequest(id(fileId),400,'INVALID_FILE_ID','文件标识不正确。');
    requireRequest(contentType(request)==='application/octet-stream',415,'INVALID_CONTENT_TYPE','请发送 application/octet-stream。');
    const {name,extension,relativePath}=uploadName(request);
    const current=draft(batchId,actor);
    requireEdit(current,actor);
    requireRequest(activeUploads < limits.simultaneousUploads,429,'UPLOAD_BUSY','同时上传过多，请稍后重试。',{'Retry-After':'2'});
    activeUploads++;
    try {
      const data=await readBytes(request,extension==='glb'?limits.fileBytes:limits.imageBytes);
      const sha256=digest(data);
      const uploaded=await store.mutate(async()=>{
        const batch=draft(batchId,actor);
        requireEdit(batch,actor);
        atRevision(batch,current.revision);
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
    const body=await readJSON(request);
    const result=await store.mutate(async()=>{
      const batch=draft(batchId,actor);
      if (action!=='publish') requireEdit(batch,actor);
      if (action==='plan') {
        atRevision(batch,ifMatch(request));
        const revision=batch.revision+1;
        await persistBatch({...batch,plan:parsePlan(body,batch.target),revision,validation:undefined});
        return {data:{revision},headers:{ETag:'"'+revision+'"'}};
      }
      if (action==='validate') {
        atRevision(batch,body?.revision);
        const target=batch.target && await appendTarget(projects.get(batch.projectId),batch.target.id);
        const validation=await validateIngestPlan(batch,await loadFiles(batch),target?.existingLabels);
        await persistBatch({...batch,validation});
        return {data:validation};
      }
      requirePermission(actor.permissions.has(publishGrant));
      assignedElsewhere(batch,actor);
      requirePermission(mayPublish(batch,actor));
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
      if (batch.target) {
        const {existingLabels}=await appendTarget(projects.get(batch.projectId),batch.target.id);
        requireRequest(!conflictingVersionLabels(batch.plan.versions,existingLabels).size,
          409,'VERSION_LABEL_CONFLICT','这个模型已有同名版本，请更改版本名后重新校验。');
      }
      const {assets,objects,blobs,versionAdditions}=await prepareIngestPublication(batch,await loadFiles(batch));
      const publishedBlobs=new Set();
      for (const blob of blobs) publishedBlobs.add(await store.saveBlob(blob.bytes,blob.digest,blob.extension));
      const publication={key:scope(batch.projectId,batch.datasetId),assets,objects,versionAdditions,blobs:[...publishedBlobs]};
      const publishedObjects=batch.target ? [{...batch.target,variants:versionAdditions[0].variants}] : objects;
      const output={status:'published',published:publishedObjects.flatMap(object=>object.variants.map(version=>({
        id:version.id, objectId:object.id, name:object.name, label:version.label
      })))};
      await persistBatch({...batch,published:{key,intent,result:output}},[...store.state.publications,publication]);
      return {data:output};
    });
    sendJSON(response,200,result.data,result.headers);
  }

  async function handoff(request,response,actor,batchId) {
    const body=await readJSON(request);
    const recipientId=body?.recipientId;
    const revision=await store.mutate(async()=>{
      const batch=draft(batchId,actor);
      draftOnly(batch);
      atRevision(batch,body?.revision);
      if (recipientId===null && batch.recipientId) {
        requirePermission(accessFor(batch,actor).canReturn);
      } else {
        requireEdit(batch,actor,'canHandoff');
        if (recipientId===null) return batch.revision;
        requireRequest(recipientsFor(batch.owner,batch.projectId).some(user=>user.id===recipientId),
          400,'INVALID_RECIPIENT','请选择有入库发布权限的成员。');
      }
      const next=batch.revision+1;
      await persistBatch({...batch,recipientId:recipientId ?? undefined,revision:next,validation:undefined});
      return next;
    });
    sendJSON(response,200,{revision},{ETag:'"'+revision+'"'});
  }

  async function discard(request,response,actor,batchId,fileId) {
    const result=await store.mutate(async()=>{
      const batch=draft(batchId,actor);
      requireEdit(batch,actor,fileId?'canEdit':'canDelete');
      atRevision(batch,ifMatch(request));
      if (!fileId) {
        const batches=store.state.batches.filter(record=>record.id!==batchId);
        await store.save({...store.state,batches});
        store.trackFiles(batch.files);
        return {};
      }
      const file=batch.files.find(record=>record.metadata.fileId===fileId);
      requireRequest(file,404,'FILE_NOT_FOUND','找不到该暂存文件。');
      const files=batch.files.filter(record=>record!==file);
      const plan=planWithoutFile(batch.plan,fileId);
      const revision=batch.revision+1;
      await persistBatch({...batch,files,plan,revision,validation:undefined});
      store.trackFiles([file]);
      return {revision,plan};
    });
    const headers=fileId ? {ETag:'"'+result.revision+'"'} : undefined;
    sendJSON(response,200,result,headers);
  }

  async function suggest(request,response,actor,batchId) {
    const body=await readJSON(request);
    const batch=draft(batchId,actor);
    requireEdit(batch,actor);
    atRevision(batch,body?.revision);
    const plan=body && Object.hasOwn(body,'plan') ? parsePlan(body.plan,batch.target) : batch.plan;
    const suggestions=suggestIngestBindings(plan,batch.files.map(record=>record.metadata));
    sendJSON(response,200,{revision:batch.revision,suggestions});
  }

  return async function handle(request,response,pathname,actor) {
    if (pathname===prefix && ['GET','POST'].includes(request.method)) {
      const {projectId,datasetId,targetObjectId} = request.method==='GET'
        ? Object.fromEntries(new URL(request.url,localOrigin).searchParams) : (await readJSON(request)) ?? {};
      const project=projects.get(projectId);
      requireRequest(project&&project.datasetId===datasetId&&actor.projects.has(project.projectId),
        404,'PROJECT_NOT_FOUND','找不到可入库的资产目录。');
      if (request.method==='GET') {
        const result=draftBox(project,actor);
        if (targetObjectId!==undefined) result.target=(await appendTarget(project,targetObjectId)).target;
        return sendJSON(response,200,result);
      }
      requirePermission(actor.permissions.has(writeGrant));
      const batch=await store.mutate(async()=>{
        requireRequest(store.state.batches.length < limits.batches,409,'BATCH_LIMIT','服务已达到批次数量上限。');
        const target=targetObjectId===undefined ? undefined : (await appendTarget(project,targetObjectId)).target;
        const batch={id:randomUUID(),owner:actor.id,projectId:project.projectId,datasetId:project.datasetId,
          target,revision:0,files:[],plan:{versions:[],bindings:[]},updatedAt:new Date().toISOString()};
        await store.save({...store.state,batches:[...store.state.batches,batch]});
        return batch;
      });
      return sendJSON(response,201,{batchId:batch.id,revision:0,limits:draftLimits,
        ownerId:batch.owner,access:accessFor(batch,actor),target:batch.target},{ETag:'"0"'});
    }

    const [,batchId,action,fileId,preview]=/^\/api\/v1\/ingest-batches\/([A-Za-z0-9_-]+)(?:\/(files|plan|suggest|validate|publish|handoff)(?:\/([A-Za-z0-9_-]+)(?:\/(preview))?)?)?$/.exec(pathname)||[];
    const batch=draft(batchId,actor);
    if (request.method==='GET'&&!action) {
      return sendJSON(response,200,{
        batchId:batch.id,projectId:batch.projectId,datasetId:batch.datasetId,revision:batch.revision,
        limits:draftLimits,plan:batch.plan,
        ownerId:batch.owner,recipientId:batch.recipientId,access:accessFor(batch,actor),
        target:batch.target,
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
    if (request.method==='POST'&&action==='handoff'&&!fileId) return handoff(request,response,actor,batchId);
    if (request.method==='DELETE'&&(!action || (action==='files'&&fileId&&!preview))) {
      return discard(request,response,actor,batchId,fileId);
    }
    if (!fileId&&(request.method==='PUT'&&action==='plan'||request.method==='POST'&&['validate','publish'].includes(action))) {
      return modify(request,response,actor,batchId,action);
    }
    throw new IngestRequestError(404,'ROUTE_NOT_FOUND','找不到此入库接口。');
  };
}

export async function createIngestAPI({configFile,staticRoot}) {
  const {stateDir,projects,users,catalogueResolver}=await loadConfiguration(configFile,staticRoot);
  const store=await openStore(stateDir);
  const handleBatch=batching(store,projects,users,catalogueResolver);
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
          const versionAdditions=visible.flatMap(record=>record.versionAdditions || []);
          if (versionAdditions.length) catalogue.versionAdditions=versionAdditions;
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
