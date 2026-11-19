import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTeamAPI} from '../team-api.mjs';
import {createTeamClient} from '../shared/team-client.mjs';

const primary = {projectId: 'demo-a', datasetId: 'v1'};
const subject = {assetId: 'crate', versionId: 'standard'};
const alternate = {...subject, versionId: 'light'};
const vote = (target, value) => ({type: 'vote', ...target, vote: value});

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'reviewer-team-'));
  t.after(() => rm(directory, {recursive: true, force: true, maxRetries: 2}));
  const staticRoot = path.join(directory, 'public');
  await mkdir(staticRoot);
  const configFile = path.join(directory, 'team.json');
  const stateFile = path.join(directory, 'saved-team.json');
  const config = {
    stateFile: 'saved-team.json',
    projects: [primary, {...primary, datasetId: 'v2'}, {...primary, datasetId: 'toString'}]
  };
  await writeFile(configFile, JSON.stringify(config));
  async function start() {
    const handle = await createTeamAPI({configFile, staticRoot});
    const server = createServer((req, res) => void handle(req, res));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      if (!server.listening) return;
      await new Promise(resolve => {
        server.close(resolve);
        server.closeIdleConnections?.();
      });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(action, scope = primary) {
      const params = new URLSearchParams(scope);
      const response = await fetch(`${base}/api/workbench?${params}`, {
        method: action ? 'POST' : 'GET',
        ...(action ? {headers: {'Content-Type': 'application/json'}} : {}),
        ...(action ? {body: JSON.stringify(action)} : {})
      });
      return {response, data: await response.json()};
    }
    return {base, request};
  }
  return {config, configFile, stateFile, staticRoot, start};
}

test('local review endpoint works without credentials and limits access to configured datasets', async t => {
  const {start} = await fixture(t);
  const {request, base} = await start();
  const anonymous = await request();
  assert.equal(anonymous.response.status, 200);
  assert.equal(anonymous.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(anonymous.data, {mode: 'shared', actor: {id: 'local', name: '本机用户'}, assets: {}});
  assert.equal((await request(null, {...primary, datasetId: 'not-registered'})).response.status, 403);
  const legacyScope = {...primary, datasetId: 'toString'};
  assert.equal((await request(vote(subject, 'up'), legacyScope)).response.status, 200);
  assert.deepEqual((await request()).data.assets, {});
  assert.equal((await request(vote({...subject, assetId: '__proto__'}, 'up'))).response.status, 400);
  assert.equal((await request(vote({...subject, versionId: 'constructor'}, 'up'))).response.status, 400);
  const params = new URLSearchParams(primary);
  const response = await fetch(`${base}/api/workbench?${params}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({type: 'comment', ...subject, text: 'x'.repeat(8192)})
  });
  assert.equal(response.status, 413);
  await response.arrayBuffer();
  assert.equal((await fetch(`${base}/api/workbench/nested`)).status, 404);
});

test('local requests share one vote, comments, and tags while choices remain per version and dataset', async t => {
  const {start} = await fixture(t);
  const {request} = await start();
  const votes = await Promise.all([request(vote(subject, 'up')), request(vote(subject, 'up'))]);
  assert(votes.every(result => result.response.ok));
  const initial = (await request()).data;
  assert.deepEqual(initial.assets.crate.versions.standard, {up: 1, down: 0, myVote: 'up', comments: []});
  const changed = (await request(vote(subject, 'down'))).data;
  assert.deepEqual(changed.assets.crate.versions.standard, {up: 0, down: 1, myVote: 'down', comments: []});
  const removed = (await request(vote(subject, null))).data;
  assert.deepEqual(removed.assets, {});
  await request(vote(alternate, 'up'));
  await request({type: 'comment', ...subject, text: '这个版本需要修边', actorId: 'lin', name: 'Lin'});
  await request({type: 'tag', assetId: subject.assetId, tag: 'LOD'});
  await request({type: 'tag', assetId: subject.assetId, tag: '  lod '});
  const final = (await request()).data.assets.crate;
  assert.deepEqual(final.tags, ['LOD']);
  assert.equal(final.versions.standard.myVote, null);
  assert.equal(final.versions.standard.comments[0].name, '本机用户');
  assert.equal(final.versions.standard.comments[0].text, '这个版本需要修边');
  assert.deepEqual(final.versions.light, {up: 1, down: 0, myVote: 'up', comments: []});
  assert.deepEqual((await request(null, {...primary, datasetId: 'v2'})).data.assets, {});

  const restarted = await start();
  assert.deepEqual((await restarted.request()).data.assets.crate, final);
});

test('team client uses the available local server and retains browser fallback for static catalogues', async t => {
  const {start} = await fixture(t);
  const {base} = await start();
  const values = new Map();
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  const offline = () => Promise.resolve(new Response(null, {status: 404}));
  const local = createTeamClient({...primary, storage, fetch: offline});
  assert.equal((await local.load()).mode, 'local');
  await local.vote({...subject, vote: 'up'});
  const reloaded = createTeamClient({...primary, storage, fetch: offline});
  assert.equal((await reloaded.load()).assets.crate.versions.standard.myVote, 'up');

  let removed = false;
  const team = createTeamClient({...primary, storage, fetch: (url, options) =>
    removed ? offline() : fetch(new URL(url, base), options)});
  assert.deepEqual(await team.load(), {mode: 'shared', actor: {id: 'local', name: '本机用户'}, assets: {}});
  assert.equal((await team.vote({...subject, vote: 'down'})).assets.crate.versions.standard.down, 1);
  removed = true;
  await assert.rejects(team.load(), /404/);
});

test('existing review state keeps historical votes, comments, and tags after switching to local access', async t => {
  const {start, configFile, config, stateFile} = await fixture(t);
  await writeFile(configFile, JSON.stringify({...config, users:[{id:'chen', name:'Chen', tokenHash:'ignored'}]}));
  const scope = JSON.stringify([primary.projectId, primary.datasetId]);
  await writeFile(stateFile, JSON.stringify({schema:1, scopes:{
    [scope]: {
      votes:[{...subject, actorId:'chen', vote:'up'}],
      comments:[{...subject, id:'1', actorId:'chen', text:'旧评论', createdAt:'2026-11-17T00:00:00Z'}],
      tags:[{assetId:subject.assetId, tag:'旧标签'}]
    }
  }}));
  const {request} = await start();
  const prior = (await request()).data.assets.crate;
  assert.deepEqual(prior.tags, ['旧标签']);
  assert.equal(prior.versions.standard.comments[0].name, 'Chen');
  assert.equal(prior.versions.standard.up, 1);
  assert.equal(prior.versions.standard.myVote, null);
  await request(vote(subject, 'down'));
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual(saved.scopes[scope].votes, [
    {...subject, actorId:'chen', vote:'up'}, {...subject, actorId:'local', vote:'down'}
  ]);
});

test('team configuration and saved state cannot live in the static root', async t => {
  const {configFile, staticRoot, config} = await fixture(t);
  const servedConfig = path.join(staticRoot, 'team.json');
  await writeFile(servedConfig, JSON.stringify(config));
  await assert.rejects(createTeamAPI({configFile: servedConfig, staticRoot}), /outside the served/);
  config.stateFile = path.join(staticRoot, 'state.json');
  await writeFile(configFile, JSON.stringify(config));
  await assert.rejects(createTeamAPI({configFile, staticRoot}), /outside the served/);
});
