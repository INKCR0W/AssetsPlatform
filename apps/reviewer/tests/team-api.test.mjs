import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
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
const hash = token => createHash('sha256').update(token).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'reviewer-team-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const staticRoot = path.join(directory, 'public');
  await mkdir(staticRoot);
  const configFile = path.join(directory, 'team.json');
  const stateFile = path.join(directory, 'saved-team.json');
  const tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  const config = {
    stateFile: 'saved-team.json',
    projects: [primary, {...primary, datasetId: 'v2'}, {...primary, datasetId: 'toString'}],
    users: [
      {id: 'lin', name: 'Lin', tokenHash: hash(tokens[0])},
      {id: 'chen', name: 'Chen', tokenHash: hash(tokens[1])}
    ]
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
    async function request(token, action, scope = primary) {
      const params = new URLSearchParams(scope);
      const response = await fetch(`${base}/api/workbench?${params}`, {
        method: action ? 'POST' : 'GET',
        headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...(action ? {'Content-Type': 'application/json'} : {})},
        ...(action ? {body: JSON.stringify(action)} : {})
      });
      return {response, data: await response.json()};
    }
    return {base, request};
  }
  return {config, configFile, stateFile, staticRoot, tokens, start};
}

test('team endpoint authenticates membership and limits access to configured datasets', async t => {
  const {start, tokens} = await fixture(t);
  const {request, base} = await start();
  const anonymous = await request();
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(anonymous.data, {mode: 'locked', actor: null, assets: {}});
  assert.equal((await request(randomBytes(32).toString('base64url'))).response.status, 401);
  assert.equal((await request(tokens[0], null, {...primary, datasetId: 'not-registered'})).response.status, 403);
  const legacyScope = {...primary, datasetId: 'toString'};
  assert.equal((await request(tokens[0], vote(subject, 'up'), legacyScope)).response.status, 200);
  assert.deepEqual((await request(tokens[0])).data.assets, {});
  assert.equal((await request(tokens[0], vote({...subject, assetId: '__proto__'}, 'up'))).response.status, 400);
  assert.equal((await request(tokens[0], vote({...subject, versionId: 'constructor'}, 'up'))).response.status, 400);
  const params = new URLSearchParams(primary);
  const response = await fetch(`${base}/api/workbench?${params}`, {
    method: 'POST', headers: {Authorization: `Bearer ${tokens[0]}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({type: 'comment', ...subject, text: 'x'.repeat(8192)})
  });
  assert.equal(response.status, 413);
  await response.arrayBuffer();
  assert.equal((await fetch(`${base}/api/workbench/nested`)).status, 404);
});

test('members share votes, comments, and tags while choices remain per version and dataset', async t => {
  const {start, tokens, stateFile} = await fixture(t);
  const [lin, chen] = tokens;
  const {request} = await start();
  const votes = await Promise.all([request(lin, vote(subject, 'up')), request(chen, vote(subject, 'down'))]);
  assert(votes.every(result => result.response.ok));
  const initial = (await request(chen)).data;
  assert.deepEqual(initial.assets.crate.versions.standard, {up: 1, down: 1, myVote: 'down', comments: []});
  const changed = (await request(lin, vote(subject, 'down'))).data;
  assert.deepEqual(changed.assets.crate.versions.standard, {up: 0, down: 2, myVote: 'down', comments: []});
  const removed = (await request(chen, vote(subject, null))).data;
  assert.deepEqual(removed.assets.crate.versions.standard, {up: 0, down: 1, myVote: null, comments: []});
  await request(lin, vote(alternate, 'up'));
  await request(chen, {type: 'comment', ...subject, text: '这个版本需要修边', actorId: 'lin', name: 'Lin'});
  await request(lin, {type: 'tag', assetId: subject.assetId, tag: 'LOD'});
  await request(chen, {type: 'tag', assetId: subject.assetId, tag: '  lod '});
  const final = (await request(lin)).data.assets.crate;
  assert.deepEqual(final.tags, ['LOD']);
  assert.equal(final.versions.standard.myVote, 'down');
  assert.equal(final.versions.standard.comments[0].name, 'Chen');
  assert.equal(final.versions.standard.comments[0].text, '这个版本需要修边');
  assert.deepEqual(final.versions.light, {up: 1, down: 0, myVote: 'up', comments: []});
  assert.deepEqual((await request(lin, null, {...primary, datasetId: 'v2'})).data.assets, {});
  const saved = await readFile(stateFile, 'utf8');
  assert(!tokens.some(token => saved.includes(token)));

  const restarted = await start();
  assert.deepEqual((await restarted.request(lin)).data.assets.crate, final);
});

test('team client distinguishes server lock from a local-only catalogue', async t => {
  const {start, tokens} = await fixture(t);
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
  assert.equal((await team.load()).mode, 'locked');
  team.setToken(tokens[1]);
  assert.deepEqual(await team.load(), {mode: 'shared', actor: {id: 'chen', name: 'Chen'}, assets: {}});
  assert.equal((await team.vote({...subject, vote: 'down'})).assets.crate.versions.standard.down, 1);
  team.setToken('');
  assert.equal((await team.load()).mode, 'locked');
  removed = true;
  await assert.rejects(team.load(), /404/);
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
