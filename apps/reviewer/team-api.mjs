import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {open, readFile, realpath, rename, stat, unlink} from 'node:fs/promises';
import path from 'node:path';
import {
  applyTeamAction, assertTeamState, newTeamState, parseTeamAction, teamLimits,
  TeamInputError, teamSnapshot, validTeamId, validateTeamScope
} from './shared/team-client.mjs';

const bodyBytes = 8 * 1024;
const configBytes = 128 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

async function readJSONFile(file, limit) {
  const info = await stat(file);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid team configuration or state file size');
  const bytes = await readFile(file);
  if (bytes.byteLength > limit) throw new Error('Team file exceeded its byte limit');
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

async function readConfiguration(configFile, staticRoot) {
  const root = await realpath(staticRoot);
  const location = await realpath(configFile);
  if (inside(root, location)) throw new Error('Team configuration must be outside the served asset directory');
  const config = await readJSONFile(location, configBytes);
  if (typeof config?.stateFile !== 'string' || !config.stateFile ||
      !Array.isArray(config.projects) || !config.projects.length ||
      !Array.isArray(config.users) || !config.users.length || config.users.length > 100) {
    throw new Error('Team configuration must include stateFile, projects and 1–100 users');
  }
  const target = path.resolve(path.dirname(location), config.stateFile);
  const stateFile = path.join(await realpath(path.dirname(target)), path.basename(target));
  if (inside(root, stateFile) || inside(location, stateFile)) throw new Error('Team state must be outside the served directory and separate from the configuration');
  try {
    const existing = await realpath(stateFile);
    if (inside(root, existing) || inside(location, existing) || path.relative(existing, stateFile)) {
      throw new Error('Team state must not be a symlink or alias');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const scopes = new Set(config.projects.map(row => validateTeamScope(row?.projectId, row?.datasetId)));
  const users = new Map(), hashes = new Set();
  for (const row of config.users) {
    if (!validTeamId(row?.id) || users.has(row.id) || typeof row.name !== 'string' ||
        !row.name.trim() || row.name.trim().length > 60 || /[\u0000-\u001f\u007f]/u.test(row.name) ||
        !/^[a-f0-9]{64}$/.test(row.tokenHash) || hashes.has(row.tokenHash)) {
      throw new Error('Invalid or duplicate team user');
    }
    users.set(row.id, {id: row.id, name: row.name.trim(), hash: Buffer.from(row.tokenHash, 'hex')});
    hashes.add(row.tokenHash);
  }
  return {stateFile, scopes, users};
}

async function readState(stateFile) {
  let data;
  try {
    data = await readJSONFile(stateFile, teamLimits.stateBytes);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {schema: 1, scopes: Object.create(null)};
  }
  if (data?.schema !== 1 || !data.scopes || typeof data.scopes !== 'object' || Array.isArray(data.scopes)) {
    throw new Error('Invalid saved team state');
  }
  for (const [key, value] of Object.entries(data.scopes)) {
    const pair = JSON.parse(key);
    if (!Array.isArray(pair) || pair.length !== 2 || validateTeamScope(...pair) !== key) throw new Error('Invalid saved team scope');
    assertTeamState(value);
  }
  return data;
}

async function persist(file, data) {
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > teamLimits.stateBytes) throw new TeamInputError('团队记录已达容量上限');
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(json);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    try { await unlink(temporary); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error('Could not clean up temporary team state:', cleanupError.code);
    }
    throw error;
  }
}

function authenticate(req, users) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);
  if (!tokenPattern.test(token)) return null;
  const hash = createHash('sha256').update(token).digest();
  let actor = null;
  for (const user of users.values()) if (timingSafeEqual(hash, user.hash)) actor = user;
  return actor;
}

function sendJSON(res, status, body, headers) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  const type = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, '预期 JSON 请求');
  if (Number(req.headers['content-length']) > bodyBytes) throw new HttpError(413, '请求超出容量限制');
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= bodyBytes) chunks.push(chunk);
      else {
        chunks.length = 0;
        reject(new HttpError(413, '请求超出容量限制'));
      }
    });
    req.once('aborted', () => reject(new HttpError(400, '请求已中断')));
    req.once('error', reject);
    req.once('end', () => {
      if (size > bodyBytes) return;
      try {
        resolve(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))));
      } catch {
        reject(new HttpError(400, '无法读取请求 JSON'));
      }
    });
  });
}

export async function createTeamAPI({configFile, staticRoot}) {
  const {stateFile, scopes, users} = await readConfiguration(configFile, staticRoot);
  let state = await readState(stateFile);
  let writes = Promise.resolve();
  const nameOf = id => users.get(id)?.name ?? '已离开团队';

  function write(scope, actor, action) {
    const operation = writes.then(async () => {
      const records = structuredClone(state.scopes[scope] ?? newTeamState());
      applyTeamAction(records, actor.id, action);
      const next = {...state, scopes: {...state.scopes, [scope]: records}};
      await persist(stateFile, next);
      state = next;
      return records;
    });
    writes = operation.catch(() => {});
    return operation;
  }
  return async function handleTeamRequest(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/api/workbench') return sendJSON(res, 404, {error: '找不到团队操作'});
      if (!['GET', 'POST'].includes(req.method)) {
        return sendJSON(res, 405, {error: '不支持该方法'}, {Allow: 'GET, POST'});
      }
      const actor = authenticate(req, users);
      if (!actor) return sendJSON(res, 401, {mode: 'locked', actor: null, assets: {}}, {'WWW-Authenticate': 'Bearer'});
      const scope = validateTeamScope(url.searchParams.get('projectId'), url.searchParams.get('datasetId'));
      if (!scopes.has(scope)) return sendJSON(res, 403, {error: '团队未登记此目录'});
      const records = req.method === 'POST'
        ? await write(scope, actor, parseTeamAction(await readBody(req)))
        : state.scopes[scope] ?? newTeamState();
      sendJSON(res, 200, teamSnapshot(records, actor, 'shared', nameOf));
    } catch (error) {
      if (error instanceof HttpError || error instanceof TeamInputError) {
        sendJSON(res, error.status ?? 400, {error: error.message});
      } else {
        console.error('Team request failed:', error.code || error.name);
        sendJSON(res, 500, {error: '团队服务暂时无法读写记录'});
      }
    } finally {
      // Rejected requests may still have an unread body.
      if (!req.readableEnded && !req.destroyed) req.resume();
    }
  };
}
