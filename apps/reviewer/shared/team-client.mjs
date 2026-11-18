const browserActor = {id: 'local', name: '本机用户'};
const emptyAssets = () => Object.create(null);

export const teamLimits = Object.freeze({
  identifier: 240,
  comment: 500,
  tag: 32,
  commentsPerVersion: 100,
  tagsPerAsset: 32,
  scopeRows: 8000,
  stateBytes: 2 * 1024 * 1024
});

export class TeamInputError extends Error {}

function validScopePart(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= teamLimits.identifier &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function validTeamId(value) {
  return validScopePart(value) && value !== 'prototype' && !Object.hasOwn(Object.prototype, value);
}

export function validateTeamScope(projectId, datasetId) {
  if (!validScopePart(projectId) || !validScopePart(datasetId)) throw new TeamInputError('缺少有效的项目或数据集');
  return JSON.stringify([projectId, datasetId]);
}

export function normalizeAssetTag(value) {
  const tag = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (tag && tag.length <= teamLimits.tag && !/[\u0000-\u001f\u007f]/u.test(tag)) return tag;
}

export function parseTeamAction(input) {
  if (!input || !validTeamId(input.assetId)) throw new TeamInputError('缺少有效的资产编号');
  const {type, assetId, versionId, vote} = input;
  if (type === 'tag') {
    const tag = normalizeAssetTag(input.tag);
    if (!tag) throw new TeamInputError('标签无效或超过长度限制');
    return {type, assetId, tag};
  }
  if (!validTeamId(versionId)) throw new TeamInputError('缺少有效的版本编号');
  if (type === 'vote' && ['up', 'down', null].includes(vote)) return {type, assetId, versionId, vote};
  if (type === 'comment') {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text && text.length <= teamLimits.comment && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
      return {type, assetId, versionId, text};
    }
    throw new TeamInputError('评论为空、包含控制字符或超过长度限制');
  }
  throw new TeamInputError('未知的协作操作或无效投票');
}

export function newTeamState() {
  return {votes: [], comments: [], tags: []};
}

export function assertTeamState(state) {
  if (!state || !Array.isArray(state.votes) || !Array.isArray(state.comments) || !Array.isArray(state.tags) ||
      [state.votes, state.comments, state.tags].reduce((size, rows) => size + rows.length, 0) > teamLimits.scopeRows) {
    throw new Error('协作记录格式无效');
  }
  for (const [type, rows] of [['vote', state.votes], ['comment', state.comments], ['tag', state.tags]]) {
    for (const row of rows) {
      parseTeamAction({...row, type});
      if (type === 'tag') continue;
      if (!validTeamId(row.actorId) || (type === 'vote' && row.vote == null) ||
          (type === 'comment' && (!validTeamId(row.id) || !Number.isFinite(Date.parse(row.createdAt))))) {
        throw new Error('协作记录缺少有效的身份或时间');
      }
    }
  }
}

export function applyTeamAction(state, actorId, action) {
  const {type, assetId, versionId} = action;
  const hasRoom = () => {
    if (state.votes.length + state.comments.length + state.tags.length >= teamLimits.scopeRows) {
      throw new TeamInputError('此目录的协作记录已达上限');
    }
  };
  const matchesVersion = row => row.assetId === assetId && row.versionId === versionId;
  if (type === 'vote') {
    const existing = state.votes.findIndex(row => matchesVersion(row) && row.actorId === actorId);
    if (existing < 0 && action.vote != null) {
      hasRoom();
      state.votes.push({assetId, versionId, actorId, vote: action.vote});
    } else if (existing >= 0 && action.vote == null) {
      state.votes.splice(existing, 1);
    } else if (existing >= 0) {
      state.votes[existing].vote = action.vote;
    }
  } else if (type === 'comment') {
    hasRoom();
    if (state.comments.filter(matchesVersion).length >= teamLimits.commentsPerVersion) throw new TeamInputError('此版本的评论已达上限');
    state.comments.push({
      id: String(state.comments.length + 1), assetId, versionId, actorId,
      text: action.text, createdAt: new Date().toISOString()
    });
  } else {
    const tags = state.tags.filter(row => row.assetId === assetId);
    if (tags.some(row => row.tag.toLowerCase() === action.tag.toLowerCase())) return;
    hasRoom();
    if (tags.length >= teamLimits.tagsPerAsset) throw new TeamInputError('此资产的标签已达上限');
    state.tags.push({assetId, tag: action.tag});
  }
}

export function teamSnapshot(state, actor, mode, nameOf = () => actor.name) {
  const assets = emptyAssets();
  const asset = id => assets[id] ??= {tags: [], versions: Object.create(null)};
  const version = row => asset(row.assetId).versions[row.versionId] ??= {up: 0, down: 0, myVote: null, comments: []};
  for (const row of state.votes) {
    const summary = version(row);
    summary[row.vote]++;
    if (row.actorId === actor.id) summary.myVote = row.vote;
  }
  for (const row of state.comments) {
    version(row).comments.push({id: row.id, name: nameOf(row.actorId), text: row.text, createdAt: row.createdAt});
  }
  for (const row of state.tags) asset(row.assetId).tags.push(row.tag);
  return {mode, actor: {id: actor.id, name: actor.name}, assets};
}

export function createTeamClient({projectId, datasetId, fetch: request = globalThis.fetch, storage} = {}) {
  const scope = validateTeamScope(projectId, datasetId);
  const key = `assets-workbench:local-team:${scope}`;
  const target = '/api/workbench?' + new URLSearchParams({projectId, datasetId});
  let token = '';
  let generation = 0;
  let mode;
  let backendSeen = false;
  let queue = Promise.resolve();

  function local(action) {
    const browserStorage = storage ?? globalThis.localStorage;
    const text = browserStorage.getItem(key);
    if (text?.length > teamLimits.stateBytes) throw new Error('本机协作记录超过容量限制');
    const state = text == null ? newTeamState() : JSON.parse(text);
    assertTeamState(state);
    if (action) {
      applyTeamAction(state, browserActor.id, action);
      const json = JSON.stringify(state);
      if (new TextEncoder().encode(json).length > teamLimits.stateBytes) throw new Error('本机协作记录已达容量上限');
      browserStorage.setItem(key, json);
    }
    return teamSnapshot(state, browserActor, 'local');
  }
  function checkGeneration(expected) {
    if (expected !== generation) throw new DOMException('Team session changed', 'AbortError');
  }
  async function run(action, expected) {
    checkGeneration(expected);
    if (mode === 'local' && action) return local(action);
    const headers = {Accept: 'application/json'};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (action) headers['Content-Type'] = 'application/json';
    const response = await request(target, {
      method: action ? 'POST' : 'GET',
      headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      ...(action ? {body: JSON.stringify(action)} : {})
    });
    checkGeneration(expected);
    if ((response.status === 404 || response.status === 405) && !backendSeen && !token && !action) {
      mode = 'local';
      return local();
    }
    if (response.status === 401) {
      backendSeen = true;
      mode = 'locked';
      return {mode, actor: null, assets: emptyAssets()};
    }
    if (!response.ok) {
      let error;
      try { error = (await response.json()).error; } catch { /* HTTP status is sufficient if the server supplied no JSON. */ }
      throw new Error(error || `协作请求失败（HTTP ${response.status}）`);
    }
    const data = await response.json();
    checkGeneration(expected);
    if (data?.mode !== 'shared' || !data.actor || !data.assets || typeof data.assets !== 'object') {
      throw new Error('服务未返回有效的团队记录');
    }
    backendSeen = true;
    mode = 'shared';
    return data;
  }
  function enqueue(raw) {
    const expected = generation;
    const result = queue.then(async () => {
      const action = raw && parseTeamAction(raw);
      if (action && !mode) await run(null, expected);
      if (mode === 'locked' && action) {
        checkGeneration(expected);
        return {mode, actor: null, assets: emptyAssets()};
      }
      return run(action, expected);
    });
    queue = result.catch(() => {});
    return result;
  }
  return {
    setToken(value) {
      token = String(value ?? '').trim();
      generation++;
      mode = undefined;
    },
    load: () => enqueue(null),
    vote: input => enqueue({...input, type: 'vote'}),
    comment: input => enqueue({...input, type: 'comment'}),
    addTag: input => enqueue({...input, type: 'tag'})
  };
}
