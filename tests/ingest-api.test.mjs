import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createIngestAPI} from '../apps/reviewer/ingest-api.mjs';

const root = fileURLToPath(new URL('../apps/reviewer',import.meta.url));
const ownerToken = 'a'.repeat(48), secondToken = 'b'.repeat(48);
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const basePath = '/api/v1/ingest-batches';
const project = {projectId:'demo-a',datasetId:'example-v1',assetRoot:'/demo-a/'};
const overlay = '/demo-a/assets/ingested/';
const names = {
  model:'crate-light.glb', standard:'crate-standard.glb',
  texture:'wood-blue.png', animation:'crate-sway.glb', extra:'cube.glb'
};

async function start(configFile) {
  const handler = await createIngestAPI({configFile,staticRoot:root});
  const server = createServer(async (request,response) => {
    const pathname = new URL(request.url,'http://localhost').pathname;
    if (!await handler(request,response,pathname)) response.writeHead(404).end();
  });
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return {
    url:'http://127.0.0.1:'+server.address().port,
    close:()=>new Promise((resolve,reject)=>{
      server.close(error=>error?reject(error):resolve());
      server.closeAllConnections();
    })
  };
}

function client(server, token = ownerToken) {
  return async (route, method, expected, body, extraHeaders = {}) => {
    const bytes = Buffer.isBuffer(body);
    const headers = {...(token ? {Authorization:'Bearer '+token} : {}),
      ...(body !== undefined ? {'Content-Type':bytes?'application/octet-stream':'application/json'} : {}), ...extraHeaders};
    const response=await fetch(server.url+route,{method,headers,body:bytes?body:JSON.stringify(body)});
    const type=response.headers.get('content-type')||'';
    const result=type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status,expected,JSON.stringify(result));
    return {result,response};
  };
}

test('ingest shares one durable API for staging, validation and atomic catalogue publishing', async t => {
  const scratch=await mkdtemp(path.join(os.tmpdir(),'assets-ingestion-api-'));
  let server;
  t.after(async()=>{if(server)await server.close();await rm(scratch,{recursive:true,force:true});});
  const configFile=path.join(scratch,'ingest.json');
  const config={stateDir:'state',projects:[project],users:[
    {id:'owner',tokenHash:tokenHash(ownerToken),permissions:['ingest:write','ingest:publish'],projects:['demo-a']},
    {id:'other',tokenHash:tokenHash(secondToken),permissions:['ingest:write'],projects:['demo-a']}
  ]};
  await writeFile(configFile,JSON.stringify(config));
  server=await start(configFile);
  const owner=client(server), other=client(server,secondToken), publicAPI=client(server,'');
  assert.equal((await publicAPI(basePath,'POST',401,project)).result.error.code,'UNAUTHORIZED');
  assert.deepEqual((await publicAPI(overlay+'index.json','GET',200)).result,{assets:[],objects:[]});
  assert.equal((await owner(basePath,'POST',404,{...project,datasetId:'wrong'})).result.error.code,'PROJECT_NOT_FOUND');
  const access=basePath+'?projectId=demo-a&datasetId=example-v1';
  await publicAPI(access,'GET',401);
  await owner(basePath+'?projectId=demo-a&datasetId=wrong','GET',404);
  const {result:accessInfo}=await owner(access,'GET',200);
  const {result:{batchId,limits}} = await owner(basePath,'POST',201,project);
  const uri=basePath+'/'+batchId;
  assert.deepEqual(limits,{files:48,versions:20,bindings:80});
  assert.deepEqual(accessInfo,{limits});
  assert.deepEqual((await owner(uri,'GET',200)).result.limits,limits);
  assert.equal((await other(uri,'GET',404)).result.error.code,'BATCH_NOT_FOUND');
  assert.equal((await publicAPI(uri,'GET',401)).result.error.code,'UNAUTHORIZED');
  const content=Object.fromEntries(await Promise.all(Object.entries(names).map(async ([id,name])=>
    [id,await readFile(path.join(root,'demo-a/assets',name))])));
  async function put(id, expected, data = content[id]) {
    return owner(uri+'/files/'+id,'PUT',expected,data,{'X-File-Name':encodeURIComponent(names[id])});
  }
  for (const entry of ['model','standard','texture','animation']) await put(entry,201);
  const {result:truncated} = await owner(uri+'/files/truncated','PUT',201,content.texture.subarray(0,24),{
    'X-File-Name':'truncated.png'
  });
  assert.ok(truncated.error);
  await owner(uri+'/files/truncated/preview','GET',404);
  // Valid PNG container and CRC, but the compressed stream provides no pixel rows.
  const missingPixels = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAACElEQVR4nAMAAAAAAUgGidIAAAAASUVORK5CYII=', 'base64'
  );
  const {result:undecodable} = await owner(uri+'/files/no-pixels','PUT',201,missingPixels,{
    'X-File-Name':'no-pixels.png'
  });
  assert.match(undecodable.error, /像素数据无法解码/);
  await owner(uri+'/files/no-pixels/preview','GET',404);
  const {result:standard}=await put('standard',200);
  assert.equal(standard.sha256,tokenHash(content.standard));
  assert.equal((await put('standard',409,Buffer.from('different'))).result.error.code,'FILE_ID_CONFLICT');
  assert.equal((await publicAPI(overlay+standard.sha256+'.glb','GET',404)).result.error.code,'ASSET_NOT_FOUND');
  assert.deepEqual((await owner(uri+'/files/standard/preview','GET',200)).result,content.standard);
  await other(uri+'/files/standard/preview','GET',404);
  const plan={versions:[{id:'crate',name:'木箱',label:'标准版',modelFileId:'model',source:'original'}],bindings:[
    {id:'blue',fileId:'texture',versionId:'crate',kind:'texture',materialIndex:0},
    {id:'sway',fileId:'animation',versionId:'crate',kind:'animation',clipIndex:0}
  ]};
  await owner(uri+'/plan','PUT',428,plan);
  await owner(uri+'/plan','PUT',200,plan,{'If-Match':'"0"'});
  const validate=async revision=>(await owner(uri+'/validate','POST',200,{revision})).result;
  const publish=(expected,validation,idempotencyKey='test-key')=>owner(uri+'/publish','POST',expected,
    {revision:validation.revision,validationId:validation.validationId},{'Idempotency-Key':idempotencyKey});
  const invalid=await validate(1);
  assert(invalid.issues.some(issue=>issue.bindingId==='sway'&&issue.severity==='error'));
  assert.equal((await publish(422,invalid)).result.error.code,'VALIDATION_BLOCKED');
  plan.versions[0].modelFileId='standard';
  async function editAtRevisionOne() {
    const response=await fetch(server.url+uri+'/plan',{method:'PUT',headers:{
      Authorization:'Bearer '+ownerToken,'Content-Type':'application/json','If-Match':'"1"'
    },body:JSON.stringify(plan)});
    return response.status;
  }
  const attempts=await Promise.all([editAtRevisionOne(),editAtRevisionOne()]);
  assert.deepEqual(attempts.sort(),[200,409]);
  const valid=await validate(2);
  assert(!valid.issues.some(issue=>issue.severity==='error'),JSON.stringify(valid.issues));
  await put('extra',201);
  assert.equal((await publish(409,valid)).result.error.code,'VALIDATION_REQUIRED');
  const updated=await validate(2);
  assert(updated.issues.some(issue=>issue.fileId==='extra'&&issue.severity==='warning'));
  const {result:receipt}=await publish(200,updated);
  assert.equal(receipt.published.length,1);
  assert.deepEqual((await publish(200,updated)).result,receipt);
  assert.equal((await publish(409,{...updated,validationId:'different'})).result.error.code,'IDEMPOTENCY_KEY_CONFLICT');
  const {result:catalogue}=await publicAPI(overlay+'index.json','GET',200);
  assert.equal(catalogue.objects.length,1);
  assert.equal(catalogue.objects[0].name,plan.versions[0].name);
  const resource=(await publicAPI(overlay+standard.sha256+'.glb','GET',200)).result;
  assert.deepEqual(resource,content.standard);
  const extraDigest=tokenHash(content.extra);
  await publicAPI(overlay+extraDigest+'.glb','GET',404);
  await server.close();
  server=await start(configFile);
  assert.deepEqual((await client(server,'')(overlay+'index.json','GET',200)).result,catalogue);
  const snapshot=(await client(server)(uri,'GET',200)).result;
  assert.equal(snapshot.status,'published');
  assert.deepEqual(snapshot.published,receipt.published);
});

test('ingest requires an external store and exact registered project scope',async t=>{
  const scratch=await mkdtemp(path.join(os.tmpdir(),'assets-ingestion-config-'));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  const configFile=path.join(scratch,'ingest.json');
  const config={stateDir:'state',projects:[{...project,datasetId:'wrong'}],users:[
    {id:'owner',tokenHash:tokenHash(ownerToken),permissions:['ingest:write'],projects:['demo-a']}
  ]};
  await writeFile(configFile,JSON.stringify(config));
  await assert.rejects(createIngestAPI({configFile,staticRoot:root}),/indexed descriptor and dataset/);
  await writeFile(configFile,JSON.stringify({...config,stateDir:root,projects:[project]}));
  await assert.rejects(createIngestAPI({configFile,staticRoot:root}),/separate from files being served/);
});

test('suggestions use private folder hints and leave both saved and proposed plans untouched',async t=>{
  const scratch=await mkdtemp(path.join(os.tmpdir(),'assets-ingestion-suggestions-'));
  const configFile=path.join(scratch,'ingest.json');
  await writeFile(configFile,JSON.stringify({stateDir:'state',projects:[project],users:[
    {id:'owner',tokenHash:tokenHash(ownerToken),permissions:['ingest:write'],projects:['demo-a']},
    {id:'other',tokenHash:tokenHash(secondToken),permissions:['ingest:write'],projects:['demo-a']}
  ]}));
  const server=await start(configFile);
  t.after(async()=>{await server.close();await rm(scratch,{recursive:true,force:true});});
  const owner=client(server), other=client(server,secondToken), publicAPI=client(server,'');
  const {result:{batchId}}=await owner(basePath,'POST',201,project);
  const uri=basePath+'/'+batchId;
  const texture=await readFile(path.join(root,'demo-a/assets/wood-blue.png'));
  async function stage(id,name,relativeFile,bytes,expected=201) {
    return (await owner(uri+'/files/'+id,'PUT',expected,bytes,{
      'X-File-Name':encodeURIComponent(name),'X-Relative-Path':encodeURIComponent(relativeFile)
    })).result;
  }
  assert.equal((await stage('bad','木板.png','crate/../木板.png',texture,400)).error.code,'INVALID_RELATIVE_PATH');
  assert.equal((await stage('bad','木板.png','C:/crate/木板.png',texture,400)).error.code,'INVALID_RELATIVE_PATH');
  assert.equal((await stage('bad','木板.png','crate/护角木条.png',texture,400)).error.code,'INVALID_RELATIVE_PATH');
  const standard=await readFile(path.join(root,'demo-a/assets/crate-standard.glb'));
  const light=await readFile(path.join(root,'demo-a/assets/crate-light.glb'));
  await stage('std','crate.glb','木箱/标准版/crate.glb',standard);
  await stage('lite','crate.glb','木箱/轻量版/crate.glb',light);
  const relativeFile='木箱/标准版/贴图/木板.png';
  const uploaded=await stage('board','木板.png',relativeFile,texture);
  assert.equal(uploaded.relativePath,relativeFile);
  assert.deepEqual(await stage('board','木板.png',relativeFile.replaceAll('/','\\'),texture,200),uploaded);
  assert.equal((await stage('board','木板.png','木箱/轻量版/贴图/木板.png',texture,409)).error.code,'FILE_ID_CONFLICT');
  const plan={versions:[
    {id:'standard',name:'木箱',label:'标准版',modelFileId:'std'},
    {id:'light',name:'木箱',label:'轻量版',modelFileId:'lite'}
  ],bindings:[{id:'wood',fileId:'board',kind:'texture',versionId:''}]};
  await publicAPI(uri+'/suggest','POST',401,{revision:0,plan});
  await other(uri+'/suggest','POST',404,{revision:0,plan});
  assert.equal((await owner(uri+'/suggest','POST',409,{revision:1,plan})).result.error.code,'STALE_REVISION');
  const suggested=(await owner(uri+'/suggest','POST',200,{revision:0,plan})).result;
  assert.equal(suggested.revision,0);
  assert.equal(suggested.suggestions[0].status,'certain');
  assert.deepEqual(suggested.suggestions[0].fields,{versionId:'standard',materialIndex:0});
  assert.deepEqual((await owner(uri,'GET',200)).result.plan,{versions:[],bindings:[]});
  plan.bindings[0].versionId='light';
  plan.bindings[0].materialIndex=1;
  await owner(uri+'/plan','PUT',200,plan,{'If-Match':'"0"'});
  assert.deepEqual((await owner(uri+'/suggest','POST',200,{revision:1})).result.suggestions,[]);
});
