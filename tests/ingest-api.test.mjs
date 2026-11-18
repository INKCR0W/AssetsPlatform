import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadData} from '../apps/reviewer/adapters/indexed-data.mjs';
import {createIngestAPI} from '../apps/reviewer/ingest-api.mjs';
import {appendModelVariants, resolveDownloadAsset} from '../apps/reviewer/shared/download-catalog.mjs';

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

async function start(configFile, staticRoot=root) {
  const handler = await createIngestAPI({configFile,staticRoot});
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
    if (Array.isArray(expected)) assert(expected.includes(response.status),JSON.stringify(result));
    else assert.equal(response.status,expected,JSON.stringify(result));
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
  assert.deepEqual(accessInfo,{limits,permissions:{create:true},recipients:[],batches:[]});
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

function directoryQuery(projectId) {
  return basePath+'?'+new URLSearchParams({projectId,datasetId:'example-v1'});
}

function revisionHeader(revision) {
  return {'If-Match':'"'+revision+'"'};
}

async function testBatch(request, scope=project) {
  const {result}=await request(basePath,'POST',201,scope);
  return {...result,uri:basePath+'/'+result.batchId};
}

async function stageDemoFile(request,uri,fileId,name) {
  const bytes=await readFile(path.join(root,'demo-a/assets',name));
  const {result}=await request(uri+'/files/'+fileId,'PUT',201,bytes,{'X-File-Name':name});
  assert.equal(result.error,undefined);
  return bytes;
}

function appendQuery(targetObjectId,projectId='demo-a') {
  return directoryQuery(projectId)+'&'+new URLSearchParams({targetObjectId});
}

async function stageVersion(request,uri,label,model=names.standard,bindings=[]) {
  const bytes=await stageDemoFile(request,uri,'model',model);
  const plan={
    versions:[{id:'draft-version',name:'草稿中的模型名',label,modelFileId:'model',source:'original'}],
    bindings
  };
  const {result:{revision}}=await request(uri+'/plan','PUT',200,plan,revisionHeader(0));
  return {bytes,revision};
}

async function validateBatch(request,uri,revision) {
  return (await request(uri+'/validate','POST',200,{revision})).result;
}

function publishBatch(request,uri,receipt,expected,key='append-test') {
  const {revision,validationId}=receipt;
  return request(uri+'/publish','POST',expected,{revision,validationId},{'Idempotency-Key':key});
}

test('agent tags survive draft handoff and publish on new and appended versions',async t=>{
  const scratch=await mkdtemp(path.join(os.tmpdir(),'assets-ingestion-tags-'));
  const configFile=path.join(scratch,'ingest.json');
  let server;
  t.after(async()=>{
    if (server) await server.close();
    await rm(scratch,{recursive:true,force:true,maxRetries:2});
  });
  await writeFile(configFile,JSON.stringify({stateDir:'state',projects:[project],users:[
    {id:'agent',tokenHash:tokenHash(ownerToken),permissions:['ingest:write'],projects:['demo-a']},
    {id:'publisher',tokenHash:tokenHash(secondToken),permissions:['ingest:publish'],projects:['demo-a']}
  ]}));
  server=await start(configFile);
  const agent=client(server), publisher=client(server,secondToken), publicAPI=client(server,'');
  const {uri}=await testBatch(agent);
  await stageDemoFile(agent,uri,'model',names.standard);
  const version={id:'main',name:'分类木箱',label:'标准版',modelFileId:'model',source:'original'};
  const invalidTags=[
    null,'道具',{},[false],['  '],['木\u0000箱'],['x'.repeat(33)],['🎨'.repeat(17)],
    Array.from({length:33},(_,index)=>'标签'+index)
  ];
  for (const tags of invalidTags) {
    const {result}=await agent(uri+'/plan','PUT',400,{versions:[{...version,tags}],bindings:[]},revisionHeader(0));
    assert.equal(result.error.code,'INVALID_TAGS',JSON.stringify(tags));
  }

  const submittedTags=[' 场景 ', 'Cafe\u0301','Café','Prop','prop','自制'];
  const savedTags=['场景','Café','Prop','自制'];
  const plan={versions:[
    {...version,tags:submittedTags},
    {...version,id:'blue',label:'蓝版',source:'reference',tags:['夜景','场景']},
    {...version,id:'red',label:'红版',source:'purchased'}
  ],bindings:[]};
  const {result:{revision}}=await agent(uri+'/plan','PUT',200,plan,revisionHeader(0));
  const {result:{revision:assignedRevision}}=await agent(uri+'/handoff','POST',200,{revision,recipientId:'publisher'});
  const {result:received}=await publisher(uri,'GET',200);
  assert.deepEqual(received.plan.versions.map(({tags})=>tags),[savedTags,['夜景','场景'],undefined]);
  assert.equal(Object.hasOwn(received.plan.versions[2],'tags'),false);
  const validation=await validateBatch(publisher,uri,assignedRevision);
  const {result:published}=await publishBatch(publisher,uri,validation,200);
  const {objectId}=published.published[0];
  const readCatalogue=async()=> (await publicAPI(overlay+'index.json','GET',200)).result;
  const [object]=(await readCatalogue()).objects;
  assert.equal(object.id,objectId);
  assert.deepEqual([...object.variants[0].tags].sort(),[...savedTags].sort());
  assert.deepEqual([...object.tags].sort(),[...savedTags,'夜景','参考','购买'].sort());

  const {uri:appendUri}=await testBatch(agent,{...project,targetObjectId:objectId});
  await stageDemoFile(agent,appendUri,'model',names.standard);
  const appendPlan={versions:[{...version,label:'展台版',tags:[' 陈列 ']}],bindings:[]};
  const {result:{revision:appendRevision}}=await agent(appendUri+'/plan','PUT',200,appendPlan,revisionHeader(0));
  const {result:{revision:reviewRevision}}=await agent(appendUri+'/handoff','POST',200,{
    revision:appendRevision,recipientId:'publisher'
  });
  const {result:appendReceipt}=await publishBatch(publisher,appendUri,await validateBatch(publisher,appendUri,reviewRevision),200);
  const index=await readCatalogue();
  assert.deepEqual(index.objects,[object]);
  const [addition]=index.versionAdditions;
  assert.equal(addition.objectId,objectId);
  assert.equal(addition.variants[0].id,appendReceipt.published[0].id);
  assert.deepEqual([...addition.variants[0].tags].sort(),['陈列','自制'].sort());
});

test('agent hands off a draft to one publisher who can return, edit and publish it',async t=>{
  const scratch=await mkdtemp(path.join(os.tmpdir(),'assets-ingestion-handoff-'));
  let server;
  t.after(async()=>{if(server) await server.close();await rm(scratch,{recursive:true,force:true});});
  const configFile=path.join(scratch,'ingest.json');
  const otherProject={...project,projectId:'demo-b',assetRoot:'/demo-b/'};
  const observerToken='c'.repeat(48), outsideToken='d'.repeat(48);
  await writeFile(configFile,JSON.stringify({stateDir:'state',projects:[project,otherProject],users:[
    {id:'agent',tokenHash:tokenHash(ownerToken),permissions:['ingest:write'],projects:['demo-a']},
    {id:'publisher',tokenHash:tokenHash(secondToken),permissions:['ingest:publish'],projects:['demo-a']},
    {id:'observer',tokenHash:tokenHash(observerToken),permissions:['ingest:write','ingest:publish'],projects:['demo-a']},
    {id:'outside',tokenHash:tokenHash(outsideToken),permissions:['ingest:write','ingest:publish'],projects:['demo-b']},
    {id:'writer',tokenHash:tokenHash('e'.repeat(48)),permissions:['ingest:write'],projects:['demo-a']}
  ]}));
  server=await start(configFile);
  const agent=client(server), publisher=client(server,secondToken), observer=client(server,observerToken);
  const outside=client(server,outsideToken), publicAPI=client(server,'');
  const list=directoryQuery('demo-a');
  const {result:box}=await agent(list,'GET',200);
  assert.deepEqual(box.permissions,{create:true});
  assert.deepEqual(box.recipients.map(({id})=>id).sort(),['observer','publisher']);
  assert.deepEqual(box.batches,[]);
  await agent(directoryQuery('demo-b'),'GET',404);
  await outside(list,'GET',404);
  await testBatch(outside,otherProject);
  assert.deepEqual((await publisher(list,'GET',200)).result.permissions,{create:false});
  await publisher(basePath,'POST',403,project);

  const {batchId,uri,access}=await testBatch(agent);
  assert.equal(access.role,'owner');
  assert.equal(access.canHandoff,true);
  assert.equal(access.canPublish,false);
  const model=await stageDemoFile(agent,uri,'model',names.standard);
  const plan={versions:[{id:'crate',name:'候审木箱',label:'标准版',modelFileId:'model',source:'original'}],bindings:[]};
  await agent(uri+'/plan','PUT',200,plan,revisionHeader(0));
  const {result:beforeHandoff}=await agent(uri+'/validate','POST',200,{revision:1});
  assert(!beforeHandoff.issues.some(issue=>issue.severity==='error'),JSON.stringify(beforeHandoff.issues));
  const {result:outbox}=await agent(list,'GET',200);
  assert.deepEqual(outbox.batches.map(row=>[row.batchId,row.ownerId,row.relation,row.fileCount,row.versionCount]),[
    [batchId,'agent','mine',1,1]
  ]);
  for (const recipientId of ['agent','outside','writer','unknown']) {
    assert.equal((await agent(uri+'/handoff','POST',400,{revision:1,recipientId})).result.error.code,'INVALID_RECIPIENT');
  }
  const idempotency={'Idempotency-Key':'publisher-review'};
  await agent(uri+'/publish','POST',403,{revision:1,validationId:beforeHandoff.validationId},idempotency);
  await publisher(uri,'GET',404);
  await observer(uri,'GET',404);
  await outside(uri,'GET',404);

  assert.equal((await agent(uri+'/handoff','POST',409,{revision:0,recipientId:'publisher'})).result.error.code,'STALE_REVISION');
  assert.equal((await agent(uri+'/handoff','POST',200,{revision:1,recipientId:'publisher'})).result.revision,2);
  const {result:frozen}=await agent(uri,'GET',200);
  assert.equal(frozen.recipientId,'publisher');
  assert.equal(frozen.access.canEdit,false);
  assert.equal(frozen.access.canReturn,true);
  assert.equal(frozen.validation,undefined);
  await agent(uri+'/plan','PUT',409,plan,revisionHeader(2));
  await agent(uri+'/files/model','DELETE',409,undefined,revisionHeader(2));
  await agent(uri+'/suggest','POST',409,{revision:2});
  await agent(uri,'DELETE',409,undefined,revisionHeader(2));
  await observer(uri,'GET',404);
  await observer(uri+'/files/model/preview','GET',404);
  assert.deepEqual((await observer(list,'GET',200)).result.batches,[]);
  const {result:inbox}=await publisher(list,'GET',200);
  assert.deepEqual(inbox.batches.map(row=>[row.batchId,row.ownerId,row.recipientId,row.relation]),[
    [batchId,'agent','publisher','incoming']
  ]);
  const {result:received}=await publisher(uri,'GET',200);
  assert.equal(received.access.role,'recipient');
  assert.equal(received.access.canEdit,true);
  assert.equal(received.access.canPublish,true);
  assert.equal(received.access.canDelete,false);
  assert.deepEqual((await publisher(uri+'/files/model/preview','GET',200)).result,model);
  await publisher(uri,'DELETE',403,undefined,revisionHeader(2));
  await publisher(uri+'/publish','POST',409,{revision:2,validationId:beforeHandoff.validationId},idempotency);

  assert.equal((await publisher(uri+'/handoff','POST',200,{revision:2,recipientId:null})).result.revision,3);
  await publisher(uri,'GET',404);
  assert.deepEqual((await publisher(list,'GET',200)).result.batches,[]);
  assert.equal((await agent(uri,'GET',200)).result.access.canEdit,true);
  assert.equal((await agent(uri+'/handoff','POST',200,{revision:3,recipientId:'publisher'})).result.revision,4);
  assert.equal((await agent(uri+'/handoff','POST',200,{revision:4,recipientId:null})).result.revision,5);
  await publisher(uri,'GET',404);
  assert.equal((await agent(uri+'/handoff','POST',200,{revision:5,recipientId:'publisher'})).result.revision,6);
  await publisher(uri+'/suggest','POST',200,{revision:6});
  await stageDemoFile(publisher,uri,'extra',names.extra);
  assert.equal((await publisher(uri+'/files/extra','DELETE',200,undefined,revisionHeader(6))).result.revision,7);
  const revised={...plan,versions:[{...plan.versions[0],name:'复核木箱'}]};
  await publisher(uri+'/plan','PUT',200,revised,revisionHeader(7));
  const {result:validation}=await publisher(uri+'/validate','POST',200,{revision:8});
  assert(!validation.issues.some(issue=>issue.severity==='error'),JSON.stringify(validation.issues));
  const publication={revision:8,validationId:validation.validationId};
  const {result:receipt}=await publisher(uri+'/publish','POST',200,publication,idempotency);
  assert.equal(receipt.published[0].name,'复核木箱');
  assert.deepEqual((await publisher(uri+'/publish','POST',200,publication,idempotency)).result,receipt);
  assert.deepEqual((await publicAPI(overlay+'index.json','GET',200)).result.objects.map(object=>object.name),['复核木箱']);
  assert.deepEqual((await agent(list,'GET',200)).result.batches,[]);
  assert.deepEqual((await publisher(list,'GET',200)).result.batches,[]);

  await server.close();
  server=undefined;
  server=await start(configFile);
  assert.deepEqual((await client(server)(uri,'GET',200)).result.published,receipt.published);
  assert.deepEqual((await client(server,secondToken)(uri,'GET',200)).result.published,receipt.published);
  await client(server,observerToken)(uri,'GET',404);
});

test('deleting a staged file or abandoned draft preserves unrelated plans and shared blobs',async t=>{
  const scratch=await mkdtemp(path.join(os.tmpdir(),'assets-ingestion-delete-'));
  const configFile=path.join(scratch,'ingest.json');
  await writeFile(configFile,JSON.stringify({stateDir:'state',projects:[project],users:[
    {id:'owner',tokenHash:tokenHash(ownerToken),permissions:['ingest:write','ingest:publish'],projects:['demo-a']},
    {id:'other',tokenHash:tokenHash(secondToken),permissions:['ingest:write'],projects:['demo-a']}
  ]}));
  const server=await start(configFile);
  t.after(async()=>{await server.close();await rm(scratch,{recursive:true,force:true,maxRetries:2});});
  const owner=client(server), other=client(server,secondToken), publicAPI=client(server,'');
  const {batchId,uri}=await testBatch(owner);
  const {uri:otherUri}=await testBatch(other);
  const standard=await stageDemoFile(owner,uri,'standard',names.standard);
  const light=await stageDemoFile(owner,uri,'light',names.model);
  const texture=await stageDemoFile(owner,uri,'texture',names.texture);
  await stageDemoFile(other,otherUri,'shared',names.standard);
  const versions=[
    {id:'standard',name:'木箱',label:'标准版',modelFileId:'standard',source:'original'},
    {id:'light',name:'木箱',label:'轻量版',modelFileId:'light',source:'original'}
  ];
  const bindings=[
    {id:'standard-color',fileId:'texture',versionId:'standard',kind:'texture',materialIndex:0},
    {id:'light-color',fileId:'texture',versionId:'light',kind:'texture',materialIndex:0}
  ];
  await owner(uri+'/plan','PUT',200,{versions,bindings},revisionHeader(0));
  const {result:validated}=await owner(uri+'/validate','POST',200,{revision:1});
  assert(!validated.issues.some(issue=>issue.severity==='error'),JSON.stringify(validated.issues));
  await other(uri+'/files/standard','DELETE',404,undefined,revisionHeader(1));
  await owner(uri+'/files/standard','DELETE',428);
  assert.equal((await owner(uri+'/files/standard','DELETE',409,undefined,revisionHeader(0))).result.error.code,'STALE_REVISION');
  await owner(uri+'/files/missing','DELETE',404,undefined,revisionHeader(1));
  const {result:deleted}=await owner(uri+'/files/standard','DELETE',200,undefined,revisionHeader(1));
  assert.equal(deleted.revision,2);
  assert.deepEqual(deleted.plan.versions,[versions[1]]);
  const {result:updated}=await owner(uri,'GET',200);
  assert.deepEqual(updated.plan,deleted.plan);
  assert.deepEqual(updated.plan.bindings,[{...bindings[0],versionId:null,materialIndex:null},bindings[1]]);
  assert.deepEqual(updated.files.map(file=>file.fileId),['light','texture']);
  assert.equal(updated.validation,undefined);
  await owner(uri+'/files/standard/preview','GET',404);
  assert.deepEqual((await other(otherUri+'/files/shared/preview','GET',200)).result,standard);

  const idempotency={'Idempotency-Key':'cleanup-verify'};
  await owner(uri+'/publish','POST',409,{revision:2,validationId:validated.validationId},idempotency);
  await owner(uri+'/plan','PUT',200,{versions:deleted.plan.versions,bindings:[bindings[1]]},revisionHeader(2));
  const {result:ready}=await owner(uri+'/validate','POST',200,{revision:3});
  assert(!ready.issues.some(issue=>issue.severity==='error'),JSON.stringify(ready.issues));
  await owner(uri+'/publish','POST',200,{revision:3,validationId:ready.validationId},idempotency);
  await owner(uri,'DELETE',409,undefined,revisionHeader(3));
  await owner(uri+'/files/light','DELETE',409,undefined,revisionHeader(3));

  await stageDemoFile(other,otherUri,'published-model',names.model);
  await stageDemoFile(other,otherUri,'published-color',names.texture);
  const duplicatePlan={versions:[{...versions[1],modelFileId:'published-model'}],
    bindings:[{...bindings[1],fileId:'published-color'}]};
  await other(otherUri+'/plan','PUT',200,duplicatePlan,revisionHeader(0));
  const {result:deletedTexture}=await other(otherUri+'/files/published-color','DELETE',200,undefined,revisionHeader(1));
  assert.deepEqual(deletedTexture,{revision:2,plan:{versions:duplicatePlan.versions,bindings:[]}});
  await other(otherUri,'DELETE',428);
  assert.equal((await other(otherUri,'DELETE',409,undefined,revisionHeader(1))).result.error.code,'STALE_REVISION');
  await other(otherUri,'DELETE',200,undefined,revisionHeader(2));
  await other(otherUri,'GET',404);
  assert.deepEqual((await other(directoryQuery('demo-a'),'GET',200)).result.batches,[]);
  assert.deepEqual((await publicAPI(overlay+tokenHash(light)+'.glb','GET',200)).result,light);
  assert.deepEqual((await publicAPI(overlay+tokenHash(texture)+'.png','GET',200)).result,texture);
  const remainingBlobs=await readdir(path.join(scratch,'state','blobs'));
  assert(!remainingBlobs.includes(tokenHash(standard)+'.glb'));
  assert(remainingBlobs.includes(tokenHash(light)+'.glb'));
  assert(remainingBlobs.includes(tokenHash(texture)+'.png'));
  assert.equal((await owner(uri,'GET',200)).result.batchId,batchId);
});

async function catalogueObjects(server) {
  const assetRoot=server.url+project.assetRoot;
  const publicAPI=client(server,'');
  const {objectCatalog,versionAdditions}=await loadData({
    config:{projectId:project.projectId,datasetId:project.datasetId,assetRoot,origin:server.url},
    async readJSON(url,required=true) {
      const pathname=new URL(url).pathname;
      if (pathname===overlay+'index.json') return (await publicAPI(pathname,'GET',200)).result;
      try { return JSON.parse(await readFile(path.join(root,pathname.slice(1)),'utf8')); }
      catch (error) {
        if (!required&&error.code==='ENOENT') return null;
        throw error;
      }
    }
  });
  return objectCatalog.objects.map(object=>{
    const additions=versionAdditions.get(object.id);
    return additions?.length ? {...object,variants:appendModelVariants(object,additions)} : object;
  });
}

test('a handed-off append keeps existing catalogue objects and their download versions intact',async t=>{
  const scratch=await mkdtemp(path.join(os.tmpdir(),'assets-ingestion-append-static-'));
  let server;
  t.after(async()=>{if(server) await server.close();await rm(scratch,{recursive:true,force:true});});
  const configFile=path.join(scratch,'ingest.json');
  const otherProject={...project,projectId:'demo-b',assetRoot:'/demo-b/'};
  await writeFile(configFile,JSON.stringify({stateDir:'state',projects:[project,otherProject],users:[
    {id:'agent',tokenHash:tokenHash(ownerToken),permissions:['ingest:write'],projects:['demo-a','demo-b']},
    {id:'publisher',tokenHash:tokenHash(secondToken),permissions:['ingest:publish'],projects:['demo-a']}
  ]}));
  server=await start(configFile);
  const agent=client(server), publisher=client(server,secondToken), publicAPI=client(server,'');
  const target={id:'object-demo-crate',name:'木制运输箱'};
  const cube={id:'object-demo-a',name:'示例立方体'};
  assert.deepEqual((await agent(appendQuery(target.id),'GET',200)).result.target,target);
  await publicAPI(appendQuery(target.id),'GET',401);
  await agent(appendQuery(target.id,'demo-b'),'GET',404);
  await agent(basePath,'POST',404,{...otherProject,targetObjectId:target.id});
  await agent(basePath,'POST',404,{...project,targetObjectId:'mesh-demo-crate-standard'});
  await agent(basePath,'POST',400,{...project,targetObjectId:12});
  assert.deepEqual((await agent(appendQuery(cube.id),'GET',200)).result.target,cube);

  const before=await catalogueObjects(server);
  const crateBefore=before.find(object=>object.id===target.id);
  const downloadsBefore=resolveDownloadAsset(crateBefore,null);
  const cubeBefore=before.find(object=>object.id===cube.id);
  const cubeDownloadsBefore=resolveDownloadAsset(cubeBefore,null);
  assert.deepEqual(downloadsBefore.versions.map(({id})=>id),['standard','light']);
  assert.deepEqual(cubeDownloadsBefore.versions.map(({id})=>id),['base']);

  const {batchId,uri,target:draftTarget}=await testBatch(agent,{...project,targetObjectId:target.id});
  assert.deepEqual(draftTarget,target);
  const texture=await stageDemoFile(agent,uri,'texture',names.texture);
  const motion=await stageDemoFile(agent,uri,'motion',names.animation);
  const bindings=[
    {id:'new-texture',fileId:'texture',kind:'texture',versionId:'draft-version',materialIndex:0},
    {id:'new-motion',fileId:'motion',kind:'animation',versionId:'draft-version',clipIndex:0}
  ];
  const {bytes,revision}=await stageVersion(agent,uri,'展台版',names.standard,bindings);
  const {result:saved}=await agent(uri,'GET',200);
  assert.equal(saved.plan.versions[0].name,target.name);
  assert.deepEqual(saved.target,target);
  await publisher(uri,'GET',404);
  const {result:{revision:assignedRevision}}=await agent(uri+'/handoff','POST',200,{revision,recipientId:'publisher'});
  const {batches}= (await publisher(directoryQuery('demo-a'),'GET',200)).result;
  assert.deepEqual(batches.find(row=>row.batchId===batchId).target,target);
  const validation=await validateBatch(publisher,uri,assignedRevision);
  assert(!validation.issues.some(issue=>issue.severity==='error'),JSON.stringify(validation.issues));
  const {result:published}=await publishBatch(publisher,uri,validation,200);
  assert.equal(published.published.length,1);
  const [receipt]=published.published;
  assert.equal(receipt.objectId,target.id);
  assert.equal(receipt.label,'展台版');
  assert.ok(typeof receipt.id==='string' && receipt.id.length>0);
  assert(!['standard','light','draft-version'].includes(receipt.id));
  assert.deepEqual((await publishBatch(publisher,uri,validation,200)).result,published);

  const implicit=await testBatch(agent,{...project,targetObjectId:cube.id});
  const cubeDraft=await stageVersion(agent,implicit.uri,'扩展版',names.extra);
  const cubeAssignment=(await agent(implicit.uri+'/handoff','POST',200,{
    revision:cubeDraft.revision,recipientId:'publisher'
  })).result.revision;
  const cubeValidation=await validateBatch(publisher,implicit.uri,cubeAssignment);
  assert(!cubeValidation.issues.some(issue=>issue.severity==='error'),JSON.stringify(cubeValidation.issues));
  const {result:cubePublication}=await publishBatch(publisher,implicit.uri,cubeValidation,200);
  assert.equal(cubePublication.published[0].objectId,cube.id);
  const {result:index}=await publicAPI(overlay+'index.json','GET',200);
  assert.deepEqual(index.objects,[]);
  const crateAddition=index.versionAdditions.find(addition=>addition.objectId===target.id);
  assert.equal(crateAddition.variants.length,1);
  const [variant]=crateAddition.variants;
  assert.equal(variant.id,receipt.id);
  assert.equal(variant.downloadOptions.textures[0].materialIndex,0);
  assert.equal(variant.downloadOptions.motions[0].index,0);
  const grantedAssets=new Set(index.assets.map(asset=>asset.id));
  assert(variant.assetIds.every(id=>grantedAssets.has(id)));
  for (const [url,original] of [
    [variant.sourceModelUrl||variant.modelUrl,bytes],
    [variant.downloadOptions.textures[0].sourceTextureUrl||variant.downloadOptions.textures[0].url,texture],
    [variant.downloadOptions.motions[0].sourceMotionUrl||variant.downloadOptions.motions[0].url,motion]
  ]) {
    const pathname=new URL(url,server.url+project.assetRoot).pathname;
    assert.deepEqual((await publicAPI(pathname,'GET',200)).result,original);
  }

  const after=await catalogueObjects(server);
  assert.deepEqual(after.map(object=>object.id),before.map(object=>object.id));
  const crateAfter=after.find(object=>object.id===target.id);
  const downloadsAfter=resolveDownloadAsset(crateAfter,null);
  assert.deepEqual(crateAfter.tags,crateBefore.tags);
  assert.deepEqual(downloadsAfter.versions.slice(0,2),downloadsBefore.versions);
  assert.equal(downloadsAfter.versions[2].id,receipt.id);
  const cubeAfter=resolveDownloadAsset(after.find(object=>object.id===cube.id),null);
  assert.deepEqual(cubeAfter.versions[0],cubeDownloadsBefore.versions[0]);
  assert.equal(cubeAfter.versions[1].id,cubePublication.published[0].id);

  await server.close();
  server=undefined;
  server=await start(configFile);
  assert.deepEqual((await client(server,'')(overlay+'index.json','GET',200)).result,index);
  assert.deepEqual((await client(server,secondToken)(uri,'GET',200)).result.published,published.published);
});

test('a stale append receipt cannot claim a version label already added by another draft',async t=>{
  const scratch=await mkdtemp(path.join(os.tmpdir(),'assets-ingestion-append-conflict-'));
  let server;
  t.after(async()=>{if(server) await server.close();await rm(scratch,{recursive:true,force:true});});
  const configFile=path.join(scratch,'ingest.json');
  await writeFile(configFile,JSON.stringify({stateDir:'state',projects:[project],users:[
    {id:'owner',tokenHash:tokenHash(ownerToken),permissions:['ingest:write','ingest:publish'],projects:['demo-a']}
  ]}));
  server=await start(configFile);
  const owner=client(server), publicAPI=client(server,'');
  const original=await testBatch(owner);
  const {revision}=await stageVersion(owner,original.uri,'基础版');
  const originalValidation=await validateBatch(owner,original.uri,revision);
  const {result:originalPublication}=await publishBatch(owner,original.uri,originalValidation,200);
  const targetObjectId=originalPublication.published[0].objectId;
  const {result:initialCatalogue}=await publicAPI(overlay+'index.json','GET',200);
  const originalObject=initialCatalogue.objects[0];
  assert.equal(originalObject.id,targetObjectId);
  assert.equal((await owner(appendQuery(targetObjectId),'GET',200)).result.target.name,originalObject.name);

  const duplicates=[
    {targetObjectId:'object-demo-a',label:'默认版'},
    {targetObjectId:'object-demo-crate',label:'标准版'},
    {targetObjectId,label:'基础版'}
  ];
  for (const duplicate of duplicates) {
    const {uri}=await testBatch(owner,{...project,targetObjectId:duplicate.targetObjectId});
    const {revision}=await stageVersion(owner,uri,duplicate.label);
    const validation=await validateBatch(owner,uri,revision);
    const issue=validation.issues.find(issue=>issue.code==='DUPLICATE_VERSION_LABEL');
    assert.equal(issue?.severity,'error',JSON.stringify(validation.issues));
    assert.equal(issue.versionId,'draft-version');
    await publishBatch(owner,uri,validation,422);
  }

  const staged=await Promise.all([1,2].map(async attempt=>{
    const {uri}=await testBatch(owner,{...project,targetObjectId});
    const {revision}=await stageVersion(owner,uri,'变体版',attempt===1?names.standard:names.model);
    const validation=await validateBatch(owner,uri,revision);
    assert(!validation.issues.some(issue=>issue.severity==='error'),JSON.stringify(validation.issues));
    return {uri,revision,validation};
  }));
  const attempts=await Promise.all(staged.map(({uri,validation})=>publishBatch(owner,uri,validation,[200,409])));
  assert.deepEqual(attempts.map(({response})=>response.status).sort(),[200,409]);
  const winner=attempts.find(({response})=>response.status===200).result.published[0];
  const losingIndex=attempts.findIndex(({response})=>response.status===409);
  assert.equal(attempts[losingIndex].result.error.code,'VERSION_LABEL_CONFLICT');
  const loser=staged[losingIndex];
  const nowInvalid=await validateBatch(owner,loser.uri,loser.revision);
  assert(nowInvalid.issues.some(issue=>issue.code==='DUPLICATE_VERSION_LABEL'),JSON.stringify(nowInvalid.issues));

  const {result:catalogue}=await publicAPI(overlay+'index.json','GET',200);
  assert.deepEqual(catalogue.objects,[originalObject]);
  assert.deepEqual(catalogue.versionAdditions.map(({objectId,variants})=>[objectId,variants.map(version=>version.id)]),[
    [targetObjectId,[winner.id]]
  ]);
  const merged=(await catalogueObjects(server)).find(object=>object.id===targetObjectId);
  assert.deepEqual(merged.variants.map(version=>version.id),[originalPublication.published[0].id,winner.id]);
});

test('an append lookup cannot inherit resources from a registered nested project without ingest enabled',async t=>{
  const scratch=await mkdtemp(path.join(os.tmpdir(),'assets-ingestion-append-roots-'));
  let server;
  t.after(async()=>{if(server) await server.close();await rm(scratch,{recursive:true,force:true});});
  const staticRoot=path.join(scratch,'static');
  const parent=path.join(staticRoot,'demo-a');
  const nested=path.join(parent,'nested');
  await mkdir(path.join(parent,'assets'),{recursive:true});
  await mkdir(nested);
  async function writeJSON(file,data) {await writeFile(file,JSON.stringify(data));}
  await writeJSON(path.join(staticRoot,'project-directory.json'),{projects:[
    {id:'demo-a',config:'demo-a/project-config.json',assetRoot:'./'},
    {id:'nested',config:'demo-a/nested/project-config.json'}
  ]});
  await writeJSON(path.join(parent,'project-config.json'),{id:'demo-a',datasetId:project.datasetId,dataKind:'indexed',assetRoot:'./'});
  await writeJSON(path.join(nested,'project-config.json'),{id:'nested',datasetId:'nested-data',dataKind:'indexed',assetRoot:'./'});
  await writeJSON(path.join(parent,'assets','objects-catalog.json'),{objects:[
    {id:'own-model',name:'Parent model',modelUrl:'assets/local.glb'},
    {id:'inherited-model',name:'Nested model',assetId:'mesh-nested'},
    {id:'explicit-model',name:'Nested direct model',modelUrl:'nested/cube.glb'}
  ]});
  await writeJSON(path.join(parent,'assets','catalog.json'),{assetShards:['nested/shard.json']});
  await writeJSON(path.join(nested,'shard.json'),[{id:'mesh-nested',modelUrl:'nested/cube.glb'}]);
  const configFile=path.join(scratch,'ingest.json');
  await writeJSON(configFile,{stateDir:'state',projects:[project],users:[
    {id:'owner',tokenHash:tokenHash(ownerToken),permissions:['ingest:write'],projects:['demo-a']}
  ]});
  server=await start(configFile,staticRoot);
  const owner=client(server);
  await testBatch(owner);
  assert.deepEqual((await owner(appendQuery('own-model'),'GET',200)).result.target,{id:'own-model',name:'Parent model'});
  for (const targetObjectId of ['inherited-model','explicit-model']) {
    const {result}=await owner(appendQuery(targetObjectId),'GET',500);
    assert.equal(result.error.code,'INGEST_FAILED');
  }
});
