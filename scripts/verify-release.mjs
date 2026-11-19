import fs from 'node:fs';
import {get} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {startLocalTestServer} from './local-test-server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=path.join(root,'apps/reviewer');
const check=spawnSync(process.execPath,['verify.mjs'],{cwd:app,encoding:'utf8'});
assert.equal(check.status,0,check.stdout+check.stderr);
const {parseGLB}=await import('../apps/reviewer/viewer.mjs');
for(const id of ['demo-a','demo-b']){
 const b=fs.readFileSync(path.join(app,id,'assets/cube.glb'));
 const g=parseGLB(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
 assert(g,'sample parsed');
}
function walk(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>['.git','dist'].includes(e.name)?[]:e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);}
const all=walk(root);let links=0;
for(const p of all.filter(p=>p.endsWith('.md')&&!p.includes('/reference/hosted/'))){
 const s=fs.readFileSync(p,'utf8');
 for(const m of s.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
  const url=m[1];if(/^(https?:|#)/.test(url))continue;
  assert(fs.existsSync(path.resolve(path.dirname(p),url.split('#')[0])),`missing document link ${p}: ${url}`);links++;
 }
}
for(const p of all){
 assert(!/\/(?:node_modules|\.env|\.openai|\.wrangler)(?:\/|$)/.test(p),'excluded payload');
 if(p.endsWith('.glb'))assert(p.startsWith(app+path.sep),'only own demo GLBs');
}
const port=30000+Math.floor(Math.random()*20000);
const state=fs.mkdtempSync(path.join(os.tmpdir(),'assets-local-release-'));
const server=startLocalTestServer(path.join(app,'server.mjs'),{port,
 env:{ASSETS_STATE_DIR:state,ASSETS_INGEST_CONFIG:'',ASSETS_TEAM_CONFIG:''}});
try{
 await server.waitUntilReady();
 const base=`http://127.0.0.1:${port}`;
 let res=await fetch(base+'/');assert.equal(res.status,200);assert((await res.text()).includes('资产检查站'));
 res=await fetch(base+'/project-directory.json');assert.equal((await res.json()).projects.length,2);
 res=await fetch(base+'/demo-a/assets/cube.glb',{method:'HEAD'});assert.equal(res.status,200);assert.equal((await res.arrayBuffer()).byteLength,0);
 res=await fetch(base+'/agent.md');assert.equal(res.status,200);assert((await res.text()).includes('/api/v1/ingest-batches'));
 const ingest='/api/v1/ingest-batches';
 res=await fetch(base+ingest);assert.equal(res.status,200);assert.equal((await res.json()).projects.length,2);
 const draftBody=JSON.stringify({projectId:'demo-a',datasetId:'example-v1'});
 const create=extra=>fetch(base+ingest,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:draftBody});
 res=await create({Origin:'http://untrusted.invalid'});assert.equal(res.status,403);
 res=await create({'Sec-Fetch-Site':'same-site'});assert.equal(res.status,403);
 const remoteHostStatus=await new Promise((resolve,reject)=>{
  get(base+ingest,{headers:{Host:'untrusted.invalid'}},response=>{
   response.resume();
   resolve(response.statusCode);
  }).on('error',reject);
 });
 assert.equal(remoteHostStatus,403);
 res=await create({Origin:base,'Sec-Fetch-Site':'same-origin'});assert.equal(res.status,201);
 res=await fetch(base+'/',{method:'POST'});assert.equal(res.status,405);
 res=await fetch(base+'/missing.json');assert.equal(res.status,404);
}finally{await server.stop();fs.rmSync(state,{recursive:true,force:true,maxRetries:2});}
console.log(JSON.stringify({passed:true,appVerification:JSON.parse(check.stdout),sampleGLBParses:2,documentLinksChecked:links,files:all.length,localHTTP:['GET index','GET directory','HEAD model','reject POST','missing 404','agent guide','local ingest','loopback request boundary'],hostedBackendBuild:'not-run-reference-only',gpu:'not-run',networkDependencyAudit:'not-comprehensive'}));
