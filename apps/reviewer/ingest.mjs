import {prepareModel} from './shared/asset-package.mjs';
import {createViewer, PREVIEW_LIMITS, readBoundedResponse} from './viewer.mjs';

const $ = id => document.getElementById(id);
const locationUrl = new URL(location.href);
const projectId = locationUrl.searchParams.get('project');
const datasetId = locationUrl.searchParams.get('dataset');
const catalogueUrl = new URL('./', locationUrl);
if (projectId) catalogueUrl.searchParams.set('project', projectId);
$('catalog-link').href = $('view-published').href = catalogueUrl;

const sourceNames = new Map([['', '未填写'], ['original', '自制'], ['purchased', '购买'],
  ['reference', '参考'], ['other', '其他']]);
const api = '/api/v1/ingest-batches';
const acceptedFile = /\.(glb|png|jpe?g)$/i;
const modelFolder = /^(models?|meshes?|模型|网格)$/i;
const motionFolder = /^(animations?|motions?|clips?|动作|动画)$/i;
const motionName = /(?:^|[-_. ])(?:anim|animation|motion)(?:[-_. ]|$)|动作|动画/i;
const versionFolder = /^(?:v\d+(?:\.\d+)*|lod[\s_-]*\d+|standard|light|lite|default|full|low|high|标准版|轻量版|默认版|原版|完整版)$/iu;
const maxFolderEntries = 2048;
const maxPathSegments = 17;
const files = new Map();
const suggestions = new Map();
let token = '';
let batchId = null;
let revision = 0;
let draftLimits;
let draftBox;
let draftBoxOpen = false;
let access;
let ownerId;
let recipientId;
let target;
let plan = {versions:[], bindings:[]};
let activeVersion, validation, previewController, viewer, progress;
let dirty = false;
let stale = false;
let published = false;
let publication;
let busy = false;
let onlyIssues = false;
let onlyReview = false;
let frame = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, handler, classes = 'button subtle compact') {
  const node = element('button', label, classes);
  node.type = 'button';
  node.onclick = handler;
  return node;
}

function canEditDraft() {
  return batchId ? Boolean(access?.canEdit) : Boolean(draftBox?.permissions.create);
}

function editingLocked() {
  return busy || published || stale || !canEditDraft();
}

function canUpload() {
  return published ? Boolean(draftBox?.permissions.create) : canEditDraft();
}

function field(control, label, key, onChange) {
  control.setAttribute('aria-label', label);
  control.dataset.edit = key;
  control.disabled = editingLocked();
  control.onchange = () => onChange(control.value);
  return control;
}

function choice(label, key, entries, selected, onChange) {
  const select = field(element('select'), label, key, onChange);
  for (const [value, title] of entries) {
    const option = element('option', title);
    option.value = value;
    select.append(option);
  }
  select.value = selected ?? '';
  return select;
}

function input(label, key, value, onChange) {
  const node = field(element('input'), label, key, onChange);
  node.type = 'text';
  node.value = value;
  node.maxLength = 64;
  return node;
}

function notice(text = '', error = false) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
  $('notice').classList.toggle('error', error);
}

function versionTitle(version) {
  return version.name + ' · ' + version.label;
}

function filePathLabel(file) {
  if (!file) return '';
  const duplicates = Array.from(files.values()).some(item => item.fileId !== file.fileId && item.name === file.name);
  return duplicates && file.relativePath ? file.relativePath : file.name;
}

function versionOptionTitle(version) {
  const title = versionTitle(version);
  const sameTitle = plan.versions.filter(item => versionTitle(item) === title);
  if (sameTitle.length === 1) return title;
  const path = files.get(version.modelFileId)?.relativePath;
  const pathTitle = path ? title + ' · ' + path : title;
  return sameTitle.filter(item => files.get(item.modelFileId)?.relativePath === path).length > 1
    ? pathTitle + ' #' + (plan.versions.indexOf(version) + 1) : pathTitle;
}

function currentIssues() {
  return validation?.issues || [];
}

function endpoint(suffix = '') {
  return api + '/' + encodeURIComponent(batchId) + suffix;
}

function revisionHeaders() {
  return {'If-Match':'"' + revision + '"'};
}

async function request(method, url, body, {headers = {}, signal} = {}) {
  const init = {method, signal, redirect:'error', headers:{...headers, Authorization:'Bearer ' + token}};
  if (body instanceof Blob) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const error = new Error(result?.error?.message ||
      (response.status === 404 ? '找不到入库批次或服务' : '请求失败（' + response.status + '）'));
    error.status = response.status;
    error.code = result?.error?.code;
    error.requestUrl = url;
    throw error;
  }
  return response;
}

async function requestJSON(...args) {
  return (await request(...args)).json();
}

function rememberBatch(id) {
  if (id) locationUrl.searchParams.set('batch', id);
  else locationUrl.searchParams.delete('batch');
  if (target) locationUrl.searchParams.set('targetObjectId', target.id);
  else locationUrl.searchParams.delete('targetObjectId');
  history.replaceState(null, '', locationUrl);
}

function targetCatalogueUrl(versionId) {
  const url = new URL(catalogueUrl);
  url.searchParams.set('objectId', target.id);
  if (versionId) url.searchParams.set('versionId', versionId);
  return url.href;
}

async function refreshDraftBox(targetObjectId) {
  const query = new URLSearchParams({projectId,datasetId});
  if (targetObjectId) query.set('targetObjectId', targetObjectId);
  draftBox = await requestJSON('GET', api + '?' + query);
  draftLimits = draftBox.limits;
}

async function readBatch(id) {
  const batch = await requestJSON('GET', api + '/' + encodeURIComponent(id));
  if (batch.projectId !== projectId || batch.datasetId !== datasetId) {
    const error = new Error('该批次不属于当前目录');
    error.status = 404;
    throw error;
  }
  return batch;
}

function applyBatch(batch, {preserveUrl = false} = {}) {
  batchId = batch.batchId;
  revision = batch.revision;
  draftLimits = batch.limits || draftBox?.limits;
  access = batch.access;
  ownerId = batch.ownerId;
  recipientId = batch.recipientId;
  target = batch.target;
  plan = batch.plan || {versions:[], bindings:[]};
  validation = batch.validation || null;
  published = batch.status === 'published';
  publication = batch.published;
  dirty = false;
  stale = false;
  onlyIssues = false;
  onlyReview = false;
  activeVersion = plan.versions[0]?.id;
  files.clear();
  suggestions.clear();
  for (const file of batch.files || []) files.set(file.fileId, file);
  openFiles(files.size > 0 && !plan.versions.length);
  if (!preserveUrl) rememberBatch(batchId);
}

function clearBatch({showBox = false, nextTarget} = {}) {
  applyBatch({target:nextTarget});
  draftBoxOpen = showBox;
  refreshPreview();
}

async function newBatch() {
  const result = await requestJSON('POST', api, {projectId,datasetId,targetObjectId:target?.id});
  applyBatch(result);
  draftBoxOpen = false;
  refreshPreview();
}

function isDraftConflict(error) {
  if (['STALE_REVISION','BATCH_PUBLISHED','BATCH_ASSIGNED'].includes(error.code)) return true;
  if (error.code !== 'BATCH_NOT_FOUND' || !batchId) return false;
  const currentPath = endpoint();
  return error.requestUrl === currentPath || error.requestUrl?.startsWith(currentPath + '/');
}

async function withBusy(operation) {
  if (busy) return;
  busy = true;
  notice();
  render();
  try { await operation(); }
  catch (error) {
    if (isDraftConflict(error)) {
      stale = true;
      validation = null;
    } else {
      if (error.status === 409 && ['VALIDATION_REQUIRED','VERSION_LABEL_CONFLICT'].includes(error.code)) validation = null;
      notice(error.message, true);
    }
  }
  finally {
    busy = false;
    progress = '';
    render();
  }
}

$('connection').onsubmit = event => {
  event.preventDefault();
  const value = $('token').value.trim();
  if (!value || !projectId || !datasetId) return;
  withBusy(async () => {
    token = value;
    const prior = locationUrl.searchParams.get('batch');
    try {
      await refreshDraftBox(prior ? undefined : locationUrl.searchParams.get('targetObjectId'));
      draftBoxOpen = !prior && ((!draftBox.target && draftBox.batches.length > 0) || !draftBox.permissions.create);
      if (prior) {
        try {
          applyBatch(await readBatch(prior));
          refreshPreview();
        } catch (error) {
          if (error.status !== 404) throw error;
          clearBatch({showBox:true});
          notice(error.message, true);
        }
      } else applyBatch({target:draftBox.target});
      $('token').value = '';
    } catch (error) {
      token = '';
      draftBox = undefined;
      applyBatch({}, {preserveUrl:true});
      throw error;
    }
  });
};

function stage({file,relativePath}) {
  const id = 'file-' + crypto.randomUUID();
  const headers = {'Content-Type':'application/octet-stream', 'X-File-Name':encodeURIComponent(file.name)};
  if (relativePath) headers['X-Relative-Path'] = encodeURIComponent(relativePath);
  return requestJSON('PUT', endpoint('/files/' + id), file, {
    headers
  });
}

function addModel(file) {
  if (plan.versions.some(version => version.modelFileId === file.fileId)) return;
  const stem = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 64);
  const folder = (file.relativePath || '').split('/').slice(0,-1).reverse().find(segment => versionFolder.test(segment));
  const id = 'version-' + crypto.randomUUID();
  const name = target?.name || stem;
  const label = folder?.slice(0,64) || (target ? stem : '默认版');
  plan.versions.push({id, name, label, modelFileId:file.fileId, source:''});
  suggestions.clear();
  activeVersion ||= id;
}

function addBinding(file, kind) {
  const binding = {id:'binding-' + crypto.randomUUID(), fileId:file.fileId, kind};
  if (kind === 'animation' && file.clips?.length === 1) binding.clipIndex = file.clips[0].index;
  plan.bindings.push(binding);
}

function findVersion(id) {
  return plan.versions.find(version => version.id === id);
}

function bindingDetail(binding, version = findVersion(binding.versionId)) {
  const texture = binding.kind === 'texture';
  const key = texture ? 'materialIndex' : 'clipIndex';
  const options = (texture ? files.get(version?.modelFileId)?.materials : files.get(binding.fileId)?.clips) || [];
  return {key, options};
}

function optionTitle(option, options) {
  return options.some(other => other.index !== option.index && other.label === option.label)
    ? option.label + ' #' + option.index : option.label;
}

function needsReview(binding) {
  const version = findVersion(binding.versionId);
  const model = files.get(version?.modelFileId);
  if (!model || model.error || model.kindHint !== 'model') return true;
  const {key,options} = bindingDetail(binding,version);
  return !options.some(option => option.index === binding[key]);
}

function missingAssignmentFields(binding, proposed) {
  if (proposed.versionId && binding.versionId && proposed.versionId !== binding.versionId) return {};
  const version = findVersion(binding.versionId || proposed.versionId);
  const model = files.get(version?.modelFileId);
  const validModel = model?.kindHint === 'model' && !model.error;
  const {key,options} = bindingDetail(binding,version);
  const missing = {};
  if (!binding.versionId && validModel) missing.versionId = version.id;
  if ((binding.kind === 'animation' || validModel) && binding[key] == null &&
      options.some(option => option.index === proposed[key])) {
    missing[key] = proposed[key];
  }
  return missing;
}

function fillAssignment(binding, proposed) {
  const missing = missingAssignmentFields(binding, proposed);
  if (!Object.keys(missing).length) return false;
  Object.assign(binding,missing);
  dirty = true;
  validation = null;
  return true;
}

async function suggestAssignments({automatic = false} = {}) {
  progress = '匹配归属…';
  renderSummary();
  const {suggestions:results} = await requestJSON('POST',endpoint('/suggest'),{revision,plan});
  suggestions.clear();
  let filled = false;
  for (const result of results) {
    suggestions.set(result.bindingId,result);
    const binding = plan.bindings.find(item => item.id === result.bindingId);
    if (!binding) continue;
    const fields = {...result.fields};
    if (result.reason === 'texture-channel') delete fields.materialIndex;
    if (automatic) {
      for (const key of Object.keys(fields)) {
        if (binding[key] === null) delete fields[key];
      }
    }
    if (fillAssignment(binding,fields)) filled = true;
  }
  return filled;
}

function suggestedFileRole(file) {
  if (file.kindHint !== 'model' || !file.clips?.length) return file.kindHint;
  const directories = (file.relativePath || '').split('/').slice(0,-1).reverse();
  const roleFolder = directories.find(segment => modelFolder.test(segment) || motionFolder.test(segment));
  if (roleFolder) return motionFolder.test(roleFolder) ? 'animation' : 'model';
  return motionName.test(file.name) ? 'animation' : 'model';
}

function openFiles(open) {
  $('file-list').hidden = !open;
  $('toggle-files').setAttribute('aria-expanded', String(open));
  $('toggle-files').textContent = open ? '收起文件' : '查看文件';
}

function takeFiles(readSelection) {
  if (busy || stale || !canUpload()) return;
  withBusy(async () => {
    const eligible = (await readSelection()).filter(({file}) => acceptedFile.test(file.name));
    if (!eligible.length) return notice('未找到 GLB、PNG 或 JPG 文件。', true);
    if (!batchId || published) await newBatch();
    draftBoxOpen = false;
    suggestions.clear();
    const errors = [];
    const capped = new Set();
    const maxFiles = draftLimits.files;
    const picked = eligible.slice(0, Math.max(0,maxFiles-files.size));
    const atLimit = eligible.length > picked.length;
    let badFile = false;
    let added = false;
    for (const [index,entry] of picked.entries()) {
      progress = '上传 ' + (index + 1) + '/' + picked.length;
      renderSummary();
      let uploaded;
      try { uploaded = await stage(entry); }
      catch (error) {
        if (isDraftConflict(error)) throw error;
        errors.push(entry.file.name + '：' + error.message);
        if ([401,403,409].includes(error.status)) break;
        continue;
      }
      files.set(uploaded.fileId, uploaded);
      validation = null;
      if (uploaded.error) {
        badFile = true;
        continue;
      }
      const role = suggestedFileRole(uploaded);
      const group = role === 'model' ? 'versions' : 'bindings';
      if (plan[group].length >= draftLimits[group]) {
        capped.add(group);
        continue;
      }
      if (role === 'model') addModel(uploaded);
      else addBinding(uploaded,role);
      added = dirty = true;
    }
    if (added && plan.bindings.some(needsReview)) {
      try { await suggestAssignments({automatic:true}); }
      catch (error) {
        if (isDraftConflict(error)) throw error;
        errors.push('匹配归属：' + error.message);
      }
    }
    if (capped.has('bindings')) errors.unshift('本批次最多 ' + draftLimits.bindings + ' 个附件关联，超出的文件已暂存。');
    if (capped.has('versions')) errors.unshift('本批次最多 ' + draftLimits.versions + ' 个模型版本，超出的文件已暂存。');
    if (atLimit) errors.unshift('本批次最多 ' + maxFiles + ' 个文件，其余文件未上传。');
    onlyReview = plan.bindings.some(needsReview);
    onlyIssues = false;
    openFiles(badFile || errors.length > 0);
    refreshPreview();
    if (errors.length) notice(errors.slice(0, 3).join('\n'), true);
  });
}

async function savePlan() {
  if (!dirty) return;
  const result = await requestJSON('PUT', endpoint('/plan'), plan, {headers:revisionHeaders()});
  revision = result.revision;
  dirty = false;
}

function confirmDiscard() {
  return !dirty || window.confirm('放弃本地未保存的修改？');
}

async function leaveDraft() {
  if (stale) return confirmDiscard();
  await savePlan();
  return true;
}

async function openDraft(id) {
  if (!await leaveDraft()) return;
  applyBatch(await readBatch(id));
  draftBoxOpen = false;
  refreshPreview();
}

async function changeHandoff(to) {
  await savePlan();
  const returning = access.role === 'recipient';
  const {revision:nextRevision} = await requestJSON('POST', endpoint('/handoff'), {revision,recipientId:to});
  revision = nextRevision;
  validation = null;
  if (returning) {
    clearBatch({showBox:true});
  } else {
    stale = true;
    const previousVersion = activeVersion;
    applyBatch(await readBatch(batchId));
    if (findVersion(previousVersion)) activeVersion = previousVersion;
    refreshPreview();
  }
  await refreshDraftBox();
  notice(to ? '草稿已交接给 ' + to : returning ? '已退回给提交人' : '已撤回交接');
}

async function deleteDraft() {
  if (!window.confirm('丢弃本批草稿及其中上传的文件？')) return;
  await request('DELETE', endpoint(), undefined, {headers:revisionHeaders()});
  clearBatch({showBox:true});
  await refreshDraftBox();
  notice('草稿已丢弃');
}

async function deleteFile(file) {
  const name = filePathLabel(file);
  if (!window.confirm('删除「' + name + '」及其直接关联？')) return;
  await savePlan();
  const result = await requestJSON('DELETE', endpoint('/files/' + encodeURIComponent(file.fileId)), undefined,
    {headers:revisionHeaders()});
  plan = result.plan;
  revision = result.revision;
  files.delete(file.fileId);
  validation = null;
  onlyIssues = false;
  suggestions.clear();
  if (!findVersion(activeVersion)) activeVersion = plan.versions[0]?.id;
  refreshPreview();
  notice('已删除 ' + name);
}

function changed(preview = true) {
  dirty = true;
  validation = null;
  onlyIssues = false;
  render();
  if (preview) refreshPreview();
  else {
    const active = plan.versions.find(version => version.id === activeVersion);
    if (active) $('preview-title').textContent = versionTitle(active);
  }
}

function removeVersion(version) {
  plan.versions = plan.versions.filter(item => item.id !== version.id);
  suggestions.clear();
  for (const binding of plan.bindings) {
    if (binding.versionId !== version.id) continue;
    binding.versionId = null;
    delete binding.materialIndex;
  }
  if (activeVersion === version.id) activeVersion = plan.versions[0]?.id;
  changed();
}

function renderFiles() {
  const rows = [];
  const locked = editingLocked();
  const bindingLimit = draftLimits?.bindings ?? 0;
  const versionLimit = draftLimits?.versions ?? 0;
  for (const file of files.values()) {
    const row = element('div', undefined, 'file-row');
    const label = element('div', undefined, 'file-name');
    const size = file.bytes >= 1024 * 1024 ? (file.bytes / (1024 * 1024)).toFixed(1) + ' MB' :
      Math.max(0.1, file.bytes / 1024).toFixed(1) + ' KB';
    label.append(element('strong', filePathLabel(file)), element('small', file.error || size));
    row.append(label);
    if (file.kindHint === 'model' && !file.error) {
      const model = button('作为模型', () => { addModel(file); changed(); });
      model.disabled = locked || plan.versions.length >= versionLimit ||
        plan.versions.some(version => version.modelFileId === file.fileId);
      row.append(model);
      if (file.clips?.length) {
        const clip = button('添加动画', () => { addBinding(file, 'animation'); changed(); });
        clip.disabled = locked || plan.bindings.length >= bindingLimit;
        row.append(clip);
      }
    } else if (file.kindHint === 'animation' && !file.error) {
      const clip = button('添加动画', () => { addBinding(file, 'animation'); changed(); });
      clip.disabled = locked || plan.bindings.length >= bindingLimit;
      row.append(clip);
    } else if (file.kindHint === 'texture' && !file.error) {
      const texture = button('添加贴图', () => { addBinding(file, 'texture'); changed(); });
      texture.disabled = locked || plan.bindings.length >= bindingLimit;
      row.append(texture);
    }
    if (access?.canEdit && !published) {
      const remove = button('删除文件', () => withBusy(() => deleteFile(file)), 'button quiet compact danger');
      remove.disabled = locked;
      remove.setAttribute('aria-label', '删除文件 ' + filePathLabel(file));
      row.append(remove);
    }
    rows.push(row);
  }
  $('file-list').replaceChildren(...(rows.length ? rows : [element('p', '未添加文件', 'empty')]));
}

function selectVersion(version) {
  activeVersion = version.id;
  render();
  refreshPreview();
}

function renderVersions() {
  const cards = plan.versions.map(version => {
    const file = files.get(version.modelFileId);
    const active = version.id === activeVersion;
    const card = element('div', undefined, 'version-card' + (active ? ' active' : ''));
    const summary = button(undefined, () => selectVersion(version), 'version-select');
    summary.setAttribute('aria-label', '预览 ' + versionTitle(version));
    summary.setAttribute('aria-pressed', String(active));
    summary.append(element('strong', version.name), element('small', filePathLabel(file) || '未选择模型'));
    card.append(summary,
      input('版本名 · ' + version.name, 'version-label-' + version.id, version.label, value => {
        version.label = value.trim(); suggestions.clear(); changed(false);
      }),
      choice('来源 · ' + versionTitle(version), 'version-source-' + version.id, sourceNames,
        version.source, value => { version.source = value; changed(false); }));
    if (active) {
      const detail = element('div', undefined, 'version-extra');
      if (!target) {
        const name = element('label', '模型名称');
        name.append(input('模型名称', 'version-name-' + version.id, version.name, value => {
          version.name = value.trim(); suggestions.clear(); changed(false);
        }));
        detail.append(name);
      }
      const shortcut = button('查看预览', () => $('preview-title').scrollIntoView({block:'start'}), 'button quiet compact preview-shortcut');
      const remove = button('移除版本', () => removeVersion(version), 'button quiet compact');
      remove.disabled = editingLocked();
      detail.append(shortcut, remove);
      card.append(detail);
    }
    return card;
  });
  $('version-list').replaceChildren(...(cards.length ? cards : [element('p', '未添加模型', 'empty')]));
}

function renderCandidates(binding, row) {
  const suggestion = suggestions.get(binding.id);
  if (!suggestion || !needsReview(binding)) return;
  if (suggestion.reason === 'texture-channel') {
    row.append(element('p','仅支持底色贴图','row-message warning'));
    return;
  }
  const box = element('div', undefined, 'binding-candidates');
  box.setAttribute('aria-label','建议归属');
  const seen = new Set();
  for (const candidate of suggestion.candidates || []) {
    const missing = missingAssignmentFields(binding,candidate);
    if (!Object.keys(missing).length) continue;
    const version = findVersion(binding.versionId || missing.versionId);
    const {key,options} = bindingDetail(binding,version);
    const option = options.find(option => option.index === missing[key]);
    const detail = option && optionTitle(option,options);
    const label = [missing.versionId && versionOptionTitle(version),detail].filter(Boolean).join(' · ');
    const identity = (missing.versionId || '') + '/' + (missing[key] ?? '');
    if (!label || seen.has(identity)) continue;
    seen.add(identity);
    const action = button(label, () => {
      if (!fillAssignment(binding,missing)) return;
      activeVersion = binding.versionId;
      suggestions.delete(binding.id);
      changed();
    });
    action.disabled = editingLocked();
    box.append(action);
  }
  if (box.childElementCount) row.append(box);
}

function renderBindings() {
  const issueByBinding = new Map();
  for (const issue of currentIssues()) {
    if (issue.bindingId && (!issueByBinding.has(issue.bindingId) || issue.severity === 'error')) {
      issueByBinding.set(issue.bindingId, issue);
    }
  }
  const targets = [['','选择版本'], ...plan.versions.map(version => [version.id, versionOptionTitle(version)])];
  const visible = plan.bindings.filter(binding => (!onlyIssues || issueByBinding.has(binding.id)) &&
    (!onlyReview || needsReview(binding)));
  const rows = visible.map(binding => {
    const file = files.get(binding.fileId);
    const fileTitle = filePathLabel(file) || binding.fileId;
    const texture = binding.kind === 'texture';
    const issue = issueByBinding.get(binding.id);
    const version = plan.versions.find(item => item.id === binding.versionId);
    const model = files.get(version?.modelFileId);
    const row = element('div', undefined, 'binding-row' + (issue?.severity === 'error' ? ' is-error' : ''));
    row.dataset.binding = binding.id;
    const name = element('div', undefined, 'binding-name');
    name.append(element('strong', fileTitle), element('small', texture ? '底色贴图' : '外部动画'));
    const versionChoice = choice('归属版本 · ' + fileTitle, 'binding-target-' + binding.id, targets,
      binding.versionId, value => {
        binding.versionId = value || null;
        if (texture) delete binding.materialIndex;
        suggestions.delete(binding.id);
        if (value) activeVersion = value;
        changed();
      });
    const {key,options} = bindingDetail(binding,version);
    const assignment = choice((texture ? '材质槽 · ' : '动画片段 · ') + fileTitle, 'binding-detail-' + binding.id,
      [['', texture ? '选择材质槽' : '选择片段'], ...options.map(option => [option.index, optionTitle(option,options)])],
      binding[key], value => {
        if (value === '') binding[key] = null;
        else binding[key] = Number(value);
        suggestions.delete(binding.id);
        if (binding.versionId) activeVersion = binding.versionId;
        changed();
      });
    if (!options?.length) assignment.disabled = true;
    const status = element('div', undefined, 'binding-status');
    if (issue || validation && model?.kindHint === 'model' && !model.error) status.append(element('span',
      issue ? (issue.severity === 'error' ? '错误' : '提示') : '兼容', 'pill ' + (issue?.severity || 'pass')));
    const remove = button('×', () => {
      plan.bindings = plan.bindings.filter(item => item.id !== binding.id);
      suggestions.delete(binding.id);
      changed();
    }, 'remove');
    remove.setAttribute('aria-label', '移除关联 ' + fileTitle);
    remove.disabled = editingLocked();
    status.append(remove);
    row.append(name, versionChoice, assignment, status);
    if (issue) row.append(element('p', issue.message, 'row-message ' + issue.severity));
    renderCandidates(binding, row);
    return row;
  });
  const emptyText = onlyIssues ? '无关联问题' : '未添加附件';
  $('binding-list').replaceChildren(...(rows.length ? rows : [element('p', emptyText, 'empty')]));
}

function showIssue(issue) {
  if (issue.bindingId && onlyReview) {
    onlyReview = false;
    render();
  }
  const version = plan.versions.find(item => item.id === issue.versionId);
  if (version) selectVersion(version);
  const detailIssue = ['MATERIAL_SLOT_REQUIRED', 'CLIP_REQUIRED'].includes(issue.code);
  const fieldKey = issue.bindingId ? (detailIssue ? 'binding-detail-' : 'binding-target-') + issue.bindingId :
    version && (issue.code === 'SOURCE_UNSET' ? 'version-source-' : 'version-label-') + version.id;
  if (fieldKey) {
    const target = document.querySelector('[data-edit="' + CSS.escape(fieldKey) + '"]');
    target?.scrollIntoView({block:'center'});
    target?.focus({preventScroll:true});
  } else if (issue.fileId) {
    openFiles(true);
    $('staging-title').scrollIntoView({block:'center'});
  }
}

function renderSummary() {
  const issues = currentIssues();
  const errors = issues.filter(issue => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  const status = published ? '已入库' : stale ? '' : validation ? (errors ? errors + ' 处错误' :
    warnings ? warnings + ' 条提示' : '校验通过') : dirty ? '未保存' : '未校验';
  $('publish-summary').textContent = progress ||
    [files.size + ' 个文件', plan.versions.length + ' 个版本', status].filter(Boolean).join(' · ');
  $('save').disabled = editingLocked() || !dirty;
  $('publish').disabled = busy || published || stale || !access?.canPublish || !validation || errors > 0;
  $('save').hidden = published || !canEditDraft();
  $('publish').hidden = published || !access?.canPublish;
  const view = $('view-published');
  view.hidden = !published;
  view.href = target ? targetCatalogueUrl(publication?.[0]?.id) : catalogueUrl.href;
  view.textContent = target ? '查看模型' : '查看目录';
  $('validate').disabled = editingLocked() || !files.size;
  const rows = issues.map(issue => {
    const row = button(undefined, () => showIssue(issue), 'issue-row ' + issue.severity);
    const version = plan.versions.find(item => item.id === issue.versionId);
    const target = files.get(issue.fileId)?.name || (version && versionTitle(version));
    row.append(element('span', issue.severity === 'error' ? '错误' : '提示', 'type'),
      element('span', target ? target + ' · ' + issue.message : issue.message));
    return row;
  });
  $('issue-list').replaceChildren(...(rows.length ? rows : [element('p',
    validation ? '无问题' : '未校验', 'empty')]));
}

function renderDraftGroup(relation, listId, countId) {
  const batches = draftBox.batches.filter(batch => batch.relation === relation);
  $(countId).textContent = batches.length;
  const rows = batches.map(batch => {
    const row = element('li');
    const current = batch.batchId === batchId;
    const open = button(undefined, () => withBusy(() => openDraft(batch.batchId)), 'draft-row');
    open.disabled = busy;
    if (current) open.setAttribute('aria-current', 'true');
    const title = batch.target?.name || batch.title || '未命名草稿 · ' + batch.batchId.slice(0, 8);
    const meta = [batch.fileCount + ' 个文件', batch.versionCount + ' 个版本'];
    if (batch.target) meta.unshift('追加版本');
    if (relation === 'incoming') meta.push('来自 ' + batch.ownerId);
    else if (batch.recipientId) meta.push('已交给 ' + batch.recipientId);
    if (batch.updatedAt) {
      const updated = new Date(batch.updatedAt);
      if (Number.isFinite(updated.getTime())) meta.push(updated.toLocaleString());
    }
    const copy = element('span');
    copy.append(element('strong',title), element('span',meta.join(' · '),'draft-meta'));
    open.append(copy, element('span',current ? '当前草稿' : '打开','draft-open'));
    row.append(open);
    return row;
  });
  $(listId).replaceChildren(...(rows.length ? rows : [element('li','没有草稿','empty')]));
}

function renderDraftBox() {
  $('draft-box').hidden = !draftBoxOpen || !draftBox;
  $('show-drafts').setAttribute('aria-expanded', String(!$('draft-box').hidden));
  if ($('draft-box').hidden) return;
  renderDraftGroup('incoming','incoming-drafts','incoming-count');
  renderDraftGroup('mine','own-drafts','own-count');
}

function renderHandoff() {
  const recipients = draftBox?.recipients || [];
  const showForm = access?.canHandoff && files.size > 0 && recipients.length > 0;
  const canUndo = Boolean(!published && access?.canReturn);
  const canDiscard = Boolean(!published && access?.canDelete);
  let status = '';
  if (!published && access?.role === 'recipient') status = '收到 ' + ownerId + ' 的入库草稿';
  else if (!published && recipientId) status = '已交给 ' + recipientId + ' · 等待发布';
  else if (access?.canHandoff && files.size && !recipients.length && !access.canPublish) {
    status = '当前目录没有可接收草稿的发布者';
  }
  $('handoff-bar').hidden = !showForm && !canUndo && !canDiscard && !status;
  $('handoff-status').textContent = status;
  $('handoff-status').hidden = !status;
  $('handoff-form').hidden = !showForm || published;
  const picker = $('handoff-recipient');
  const chosen = picker.value;
  const placeholder = element('option','选择发布者');
  placeholder.value = '';
  picker.replaceChildren(placeholder, ...recipients.map(({id}) => {
    const option = element('option',id);
    option.value = id;
    return option;
  }));
  picker.value = recipients.some(({id}) => id === chosen) ? chosen : '';
  picker.disabled = busy || stale;
  $('handoff-form').querySelector('button').disabled = busy || stale;
  $('undo-handoff').textContent = access?.role === 'recipient' ? '退回草稿' : '撤回交接';
  $('undo-handoff').hidden = !canUndo;
  $('undo-handoff').disabled = busy || stale;
  $('discard-draft').hidden = !canDiscard;
  $('discard-draft').disabled = busy || stale;
}

function render() {
  const editing = document.activeElement?.dataset.edit;
  const connected = Boolean(draftLimits);
  $('connection').hidden = connected;
  $('disconnect').hidden = $('work').hidden = !connected;
  $('disconnect').disabled = $('new-batch').disabled = $('show-drafts').disabled = busy;
  $('new-batch').hidden = !draftBox?.permissions.create;
  $('new-batch').textContent = target ? '新建版本批次' : '新建批次';
  $('work-title').textContent = target ? '追加版本' : '批量入库';
  const targetLink = $('target-model');
  targetLink.hidden = !target;
  if (target) {
    targetLink.textContent = target.name;
    targetLink.href = targetCatalogueUrl();
  }
  $('draft-editor').hidden = !batchId && !draftBox?.permissions.create;
  $('browse-files').hidden = !canUpload();
  $('browse-folder').hidden = !canUpload() || !('webkitdirectory' in $('folder-input'));
  $('browse-files').disabled = $('browse-folder').disabled = busy || stale;
  $('drop-help').hidden = !canUpload();
  $('stale-plan').hidden = !connected || !stale;
  $('reload-plan').disabled = busy;
  $('connect').disabled = busy || !projectId || !datasetId;
  $('file-count').textContent = files.size;
  $('toggle-issues').setAttribute('aria-pressed', String(onlyIssues));
  $('toggle-issues').disabled = !validation;
  const pending = plan.bindings.filter(needsReview).length;
  if (!pending) onlyReview = false;
  $('suggest').disabled = editingLocked() || !pending || !plan.versions.length;
  $('toggle-review').disabled = !pending;
  $('toggle-review').textContent = pending ? '待确认 ' + pending : '待确认';
  $('toggle-review').setAttribute('aria-pressed', String(onlyReview));
  renderDraftBox();
  renderHandoff();
  renderFiles();
  renderVersions();
  renderBindings();
  renderSummary();
  if (editing) document.querySelector('[data-edit="' + CSS.escape(editing) + '"]')?.focus({preventScroll:true});
}

function stopPlayback() {
  cancelAnimationFrame(frame);
  frame = 0;
  $('play').textContent = '播放';
}

function previewStatus(text = '', error = false) {
  $('preview-status').textContent = text;
  $('preview-status').hidden = !text;
  $('preview-status').classList.toggle('error', error);
}

async function previewFile(file, signal, limit = PREVIEW_LIMITS.downloadBytes) {
  const response = await request('GET', endpoint('/files/' + encodeURIComponent(file.fileId) + '/preview'), undefined, {signal});
  return {bytes:await readBoundedResponse(response, limit), mimeType:response.headers.get('Content-Type')?.split(';')[0]};
}

async function previewOptions(version, signal, modelBytes) {
  const textures = [];
  const extraClips = [];
  const seen = new Set();
  let alternate = false;
  let available = PREVIEW_LIMITS.downloadBytes * 2 - modelBytes;
  async function read(file, fileLimit) {
    if (available <= 0) throw Error('选配超出预览大小上限');
    const input = await previewFile(file, signal, Math.min(available, fileLimit));
    available -= input.bytes.byteLength;
    return input;
  }
  for (const binding of plan.bindings) {
    if (binding.versionId !== version.id) continue;
    const file = files.get(binding.fileId);
    if (!file || file.error) continue;
    const isTexture = binding.kind === 'texture';
    const index = isTexture ? binding.materialIndex : binding.clipIndex;
    if (!Number.isInteger(index)) continue;
    const key = JSON.stringify([binding.kind,file.sha256,index]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isTexture) {
      if (textures.some(texture => texture.materialIndex === index)) {
        alternate = true;
        continue;
      }
      const texture = await read(file, PREVIEW_LIMITS.imageBytes);
      textures.push({...texture, materialIndex:index});
    } else {
      const clip = await read(file, PREVIEW_LIMITS.downloadBytes);
      extraClips.push({bytes:clip.bytes, index});
    }
  }
  return {textures, extraClips, alternate};
}

async function refreshPreview() {
  previewController?.abort();
  previewController = new AbortController();
  const {signal} = previewController;
  stopPlayback();
  viewer?.dispose();
  viewer = null;
  $('recenter').disabled = true;
  $('preview-controls').hidden = true;
  $('stage').replaceChildren();
  const version = plan.versions.find(item => item.id === activeVersion);
  const file = files.get(version?.modelFileId);
  $('preview-title').textContent = version ? versionTitle(version) : '预览';
  $('stage-hint').hidden = false;
  $('stage-hint').textContent = file ? '载入中…' : '未选择版本';
  previewStatus();
  if (!file) return;
  if (file.error) {
    $('stage-hint').textContent = '预览未加载';
    previewStatus(file.error, true);
    return;
  }
  const host = element('div', undefined, 'preview-view');
  $('stage').append(host);
  try {
    const model = await previewFile(file, signal);
    let prepared, alternate, fallback;
    try {
      const options = $('show-config').checked ? await previewOptions(version, signal, model.bytes.byteLength) : {};
      prepared = prepareModel(model.bytes, options);
      alternate = options.alternate;
    } catch (error) {
      signal.throwIfAborted();
      fallback = error.message;
      prepared = prepareModel(model.bytes);
    }
    signal.throwIfAborted();
    const opened = await createViewer(host, prepared.bytes, {signal, animationData:prepared.animationData});
    if (signal.aborted) { opened.dispose(); return; }
    viewer = opened;
    const clips = viewer.getAnimationClips();
    const picker = $('preview-animation');
    picker.replaceChildren(...clips.map(clip => {
      const option = element('option', clip.name || clip.id);
      option.value = clip.id;
      return option;
    }));
    picker.hidden = $('play').hidden = !clips.length;
    $('preview-controls').hidden = false;
    $('stage-hint').hidden = true;
    $('recenter').disabled = false;
    if (fallback) previewStatus('当前绑定无法预览，已显示基础模型。' + fallback, true);
    else if (alternate) previewStatus('同一材质槽只预览第一张贴图。');
  } catch (error) {
    if (signal.aborted) return;
    $('stage-hint').textContent = '预览未加载';
    previewStatus(error.message, true);
  }
}

function selectedFiles(fileList) {
  const selection = [];
  for (const file of fileList) {
    if (acceptedFile.test(file.name)) selection.push({file, relativePath:file.webkitRelativePath || ''});
    if (selection.length > draftLimits.files) break;
  }
  return selection;
}

async function readDroppedFiles(items) {
  const selection = [];
  const pending = items.map(item => ({...item, parents:[]}));
  let scanned = 0;
  while (pending.length && selection.length <= draftLimits.files) {
    const {entry,file,parents} = pending.shift();
    if (++scanned > maxFolderEntries) throw Error('文件夹包含过多文件，请分批选择。');
    if (entry?.isDirectory) {
      if (parents.length + 1 >= maxPathSegments) throw Error('文件夹层级过深，请分批选择。');
      const reader = entry.createReader();
      const path = [...parents,entry.name];
      while (true) {
        const entries = await new Promise((resolve,reject) => reader.readEntries(resolve,reject));
        if (!entries.length) break;
        if (scanned + pending.length + entries.length > maxFolderEntries) {
          throw Error('文件夹包含过多文件，请分批选择。');
        }
        for (const child of entries) pending.push({entry:child, parents:path});
      }
    } else if (acceptedFile.test(entry?.name || file?.name || '')) {
      const selected = file || await new Promise((resolve,reject) => entry.file(resolve,reject));
      selection.push({file:selected, relativePath:parents.length ? [...parents, selected.name].join('/') : ''});
    }
  }
  return selection;
}

function droppedFiles(transfer) {
  const items = Array.from(transfer.items || []).filter(item => item.kind === 'file').map(item => ({
    entry:item.webkitGetAsEntry?.(), file:item.getAsFile()
  }));
  if (items.some(({entry}) => entry?.isDirectory)) return () => readDroppedFiles(items);
  const selection = selectedFiles(transfer.files);
  return () => selection;
}

function chooseFiles(event) {
  if (!canUpload()) return;
  const selection = selectedFiles(event.target.files);
  const picked = event.target.files.length > 0;
  event.target.value = '';
  if (picked) takeFiles(() => selection);
}

$('browse-files').onclick = () => $('files-input').click();
$('browse-folder').onclick = () => $('folder-input').click();
$('files-input').onchange = $('folder-input').onchange = chooseFiles;
$('toggle-files').onclick = () => openFiles($('file-list').hidden);
$('suggest').onclick = () => withBusy(async () => {
  if (await suggestAssignments()) refreshPreview();
  onlyReview = plan.bindings.some(needsReview);
  onlyIssues = false;
});
$('toggle-review').onclick = () => {
  onlyReview = !onlyReview;
  onlyIssues = false;
  render();
};
$('toggle-issues').onclick = () => {
  onlyIssues = !onlyIssues;
  onlyReview = false;
  render();
};
$('save').onclick = () => withBusy(savePlan);
$('validate').onclick = () => withBusy(async () => {
  await savePlan();
  validation = await requestJSON('POST', endpoint('/validate'), {revision});
});
$('publish').onclick = () => withBusy(async () => {
  const result = await requestJSON('POST', endpoint('/publish'), {revision, validationId:validation.validationId}, {
    headers:{'Idempotency-Key':'publish-' + validation.validationId}
  });
  publication = result.published;
  published = true;
  draftBox.batches = draftBox.batches.filter(batch => batch.batchId !== batchId);
});
$('new-batch').onclick = () => withBusy(async () => {
  if (!await leaveDraft()) return;
  clearBatch({nextTarget:target});
});
$('show-drafts').onclick = () => withBusy(async () => {
  if (!draftBoxOpen) await refreshDraftBox();
  draftBoxOpen = !draftBoxOpen;
});
$('handoff-form').onsubmit = event => {
  event.preventDefault();
  const to = $('handoff-recipient').value;
  if (to) withBusy(() => changeHandoff(to));
};
$('undo-handoff').onclick = () => withBusy(() => changeHandoff(null));
$('discard-draft').onclick = () => withBusy(deleteDraft);
$('disconnect').onclick = async () => {
  await withBusy(async () => {
    if (!await leaveDraft()) return;
    token = '';
    draftBox = undefined;
    draftBoxOpen = false;
    applyBatch({}, {preserveUrl:true});
    refreshPreview();
  });
  if (!draftLimits) $('token').focus();
};
$('reload-plan').onclick = () => withBusy(async () => {
  if (!confirmDiscard()) return;
  try {
    applyBatch(await readBatch(batchId));
    refreshPreview();
  } catch (error) {
    if (error.status !== 404) throw error;
    clearBatch({showBox:true});
    await refreshDraftBox();
    notice(error.message, true);
  }
});
$('recenter').onclick = () => viewer?.reset();
$('show-config').onchange = refreshPreview;
$('preview-animation').onchange = () => {
  stopPlayback();
  viewer?.resetAnimation();
};
$('play').onclick = () => {
  if (frame) { stopPlayback(); return; }
  const clip = viewer?.getAnimationClips().find(item => item.id === $('preview-animation').value);
  if (!clip) return;
  const start = performance.now();
  $('play').textContent = '暂停';
  function advance(time) {
    viewer?.setAnimationTime(clip.id, ((time - start) / 1000) % clip.duration);
    frame = requestAnimationFrame(advance);
  }
  frame = requestAnimationFrame(advance);
};
const drop = $('dropzone');
drop.ondragover = event => {
  event.preventDefault();
  if (canUpload() && !stale && !busy && event.dataTransfer.types.includes('Files')) drop.classList.add('is-dragged');
};
drop.ondragleave = () => drop.classList.remove('is-dragged');
drop.ondrop = event => {
  event.preventDefault();
  drop.classList.remove('is-dragged');
  if (canUpload() && !stale && !busy) takeFiles(droppedFiles(event.dataTransfer));
};
window.addEventListener('beforeunload', event => {
  if (dirty) event.preventDefault();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(); });
if (!projectId || !datasetId) notice('请从资产目录打开批量入库。', true);
render();
