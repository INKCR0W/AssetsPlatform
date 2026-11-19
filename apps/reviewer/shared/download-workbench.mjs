import {inspectModel, prepareModel} from './asset-package.mjs';
import {animationNameHash, createUnityBundle, modelContentHash} from './unity-bundle.mjs';
import {PREVIEW_LIMITS, readBoundedResponse} from '../viewer.mjs';

const MAX_ITEMS = 32;
const MAX_CART_BYTES = 128 * 1024 * 1024;
const TEXTURE_BYTES = 16 * 1024 * 1024;
const MAX_EXTRA_CLIPS = 32;
const camera = {yaw: 0.6, pitch: 0.33, zoom: 3.8};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, action) {
  const node = el('button', label, 'light-btn');
  node.type = 'button';
  node.onclick = action;
  return node;
}

function option(value, label) {
  const node = el('option', label);
  node.value = value;
  return node;
}

function checkOption(label, checked, change) {
  const wrapper = el('label');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.onchange = () => change(input.checked);
  wrapper.append(input, el('span', label));
  return wrapper;
}

function own(object, key) {
  return object && Object.hasOwn(object, key) ? object[key] : undefined;
}

function describe(row) {
  const clips = row.motionLabels.length ? row.motionLabels.join('、') : '无动画';
  const textures = row.textures.map(texture => `${texture.materialLabel} · ${texture.label}`);
  return [row.version.label, textures.join('、') || '原材质', clips].join(' / ');
}

async function readAsset(url, limit, signal) {
  const response = await fetch(url, {signal, redirect: 'error'});
  if (!response.ok) throw Error(`读取资源失败（${response.status}）`);
  return readBoundedResponse(response, limit);
}

function originalUrl(asset) {
  return asset.sourceUrl || asset.url;
}

function sharesPreviewSource(asset) {
  return originalUrl(asset) === asset.url;
}

async function verifyContentHash(bytes, expected, message) {
  if (expected && await modelContentHash(bytes) !== expected) throw Error(message);
}

async function readConfigurationAssets(model, textures, motions, {signal, original = false, approvedSources}) {
  let available = MAX_CART_BYTES - model.byteLength;
  async function readPart(url, limit) {
    if (available <= 0) throw Error('配置使用的资源文件过大');
    const bytes = await readAsset(url, Math.min(limit, available), signal);
    available -= bytes.byteLength;
    return bytes;
  }

  const textureData = [];
  for (const [index, texture] of textures.entries()) {
    const url = original ? originalUrl(texture) : texture.url;
    const mimeType = original ? texture.sourceMimeType || texture.mimeType : texture.mimeType;
    const limit = original ? PREVIEW_LIMITS.imageBytes : TEXTURE_BYTES;
    const bytes = await readPart(url, limit);
    await verifyContentHash(bytes, approvedSources?.textures[index], `贴图「${texture.label}」已更新，请重新预览并保存配置`);
    textureData.push({bytes, mimeType, materialIndex:texture.materialIndex});
  }

  const extraClips = [];
  for (const [index, clip] of motions.entries()) {
    const url = original ? originalUrl(clip) : clip.url;
    const bytes = await readPart(url, PREVIEW_LIMITS.downloadBytes);
    await verifyContentHash(bytes, approvedSources?.motions[index], `外部动作「${clip.label}」已更新，请重新预览并保存配置`);
    extraClips.push({bytes, index:clip.index});
  }
  return {textures:textureData, extraClips};
}

async function approveSharedInputs({version, model, textures, motions, ingredients}, signal) {
  async function hashShared(assets, data) {
    const hashes = [];
    for (const [index, asset] of assets.entries()) {
      signal.throwIfAborted();
      hashes.push(sharesPreviewSource(asset) ? await modelContentHash(data[index].bytes) : null);
    }
    return hashes;
  }
  return {
    model:sharesPreviewSource(version) ? await modelContentHash(model) : null,
    textures:await hashShared(textures, ingredients.textures),
    motions:await hashShared(motions, ingredients.extraClips)
  };
}

function verifyOriginalSelection(model, row) {
  const {materials, clips} = inspectModel(model);
  if (row.textures.some(texture => materials[texture.materialIndex]?.label !== texture.materialLabel) ||
      row.nativeClips.some(clip => clips[clip.index]?.label !== clip.label)) {
    throw Error('原始模型的材质或动画与网页预览不一致');
  }
}

async function prepareOriginalModel(row, available, signal) {
  const model = await readAsset(originalUrl(row.version), Math.min(PREVIEW_LIMITS.downloadBytes, available), signal);
  await verifyContentHash(model, row.approvedSources.model || row.version.sourceSha256,
    '原始模型内容与已确认的版本不一致，请检查入库记录或重新预览');
  signal.throwIfAborted();
  verifyOriginalSelection(model, row);
  const ingredients = await readConfigurationAssets(model, row.textures, row.motions, {
    signal, original:true, approvedSources:row.approvedSources
  });
  signal.throwIfAborted();
  const prepared = prepareModel(model, {
    ...ingredients, clips:row.nativeClips.map(clip => clip.index), validatePreview:false
  });
  if (prepared.defaultClipName !== row.defaultClipName) throw Error('原始模型的默认动画与网页预览不一致');
  return prepared.bytes;
}

async function prepareExport(row, available, signal) {
  if (available <= 0) throw Error('清单中的原始模型过大，请分批下载');
  const bytes = row.approvedBytes || await prepareOriginalModel(row, available, signal);
  if (bytes.byteLength > available) throw Error('清单中的原始模型过大，请分批下载');
  const [modelSha256, defaultClipNameSha256] = await Promise.all([
    modelContentHash(bytes), animationNameHash(row.defaultClipName)
  ]);
  return {...row, bytes, modelSha256, defaultClipNameSha256};
}

function createDialogs() {
  const editor = el('dialog', undefined, 'download-workbench');
  editor.setAttribute('aria-labelledby', 'workbench-title');
  editor.innerHTML = `
    <div class="workbench-shell">
      <header class="workbench-heading">
        <h2 id="workbench-title"></h2>
        <div><button class="light-btn" type="button" data-wb="open-cart"></button>
          <button class="light-btn" type="button" data-wb="close-editor">关闭</button></div>
      </header>
      <div class="workbench-body">
        <section class="workbench-preview" aria-label="导出预览">
          <div data-wb="stage" class="workbench-stage"></div>
          <div class="workbench-play" data-wb="play-controls" hidden>
            <label>动作 <select data-wb="play-clip" aria-label="预览动作"></select></label>
            <button type="button" class="light-btn" data-wb="play">播放</button>
          </div>
          <p data-wb="preview-status" class="workbench-note" role="status"></p>
        </section>
        <div class="workbench-options">
          <label class="workbench-field">模型版本 <select data-wb="version"></select></label>
          <fieldset data-wb="texture-row" hidden><legend>底色贴图</legend>
            <div class="workbench-texture-slots" data-wb="texture-slots"></div></fieldset>
          <fieldset><legend>动画</legend><div class="workbench-clips" data-wb="clips"></div></fieldset>
          <section class="workbench-team" aria-label="投票、标签与评论">
            <div class="workbench-team-heading"><h3>版本评阅</h3>
              <span class="workbench-note" data-wb="team-mode"></span>
              <button type="button" class="text-btn" data-wb="team-refresh" hidden>刷新</button></div>
            <div class="workbench-votes">
              <button type="button" class="light-btn" data-wb="vote-up"></button>
              <button type="button" class="light-btn" data-wb="vote-down"></button>
            </div>
            <div class="workbench-tags" data-wb="tags"></div>
            <form class="workbench-inline" data-wb="tag-form">
              <input type="text" data-wb="tag" aria-label="新标签" placeholder="新标签" maxlength="32" required>
              <button class="light-btn">添加标签</button>
            </form>
            <details class="workbench-comments"><summary data-wb="comments-title">评论</summary>
              <ul data-wb="comments"></ul>
              <form class="workbench-inline" data-wb="comment-form">
                <textarea data-wb="comment" aria-label="版本评论" placeholder="记录这个版本的使用意见" maxlength="500" rows="2" required></textarea>
                <button class="light-btn">发表</button>
              </form>
            </details>
            <p class="workbench-note" data-wb="team-status" role="status"></p>
          </section>
        </div>
      </div>
      <footer class="workbench-footer">
        <p class="workbench-note" data-wb="add-status" role="status"></p>
        <button class="primary-btn" type="button" data-wb="add"></button>
      </footer>
    </div>`;
  const cart = el('dialog', undefined, 'download-workbench download-workbench-cart');
  cart.setAttribute('aria-labelledby', 'workbench-cart-title');
  cart.innerHTML = `
    <div class="workbench-shell">
      <header class="workbench-heading"><h2 id="workbench-cart-title">待下载清单</h2>
        <button class="light-btn" type="button" data-wb="close-cart">关闭</button></header>
      <div class="workbench-cart-rows" data-wb="cart-rows"></div>
      <footer class="workbench-footer">
        <p class="workbench-note" data-wb="cart-status" role="status"></p>
        <button class="primary-btn" type="button" data-wb="download">下载全部 ZIP</button>
      </footer>
    </div>`;
  document.body.append(editor, cart);
  return {editor, cart};
}

export function mountDownloadWorkbench({
  config, resolveAsset, team, createViewer, notify = () => {}, onCartChanged, onTagsChanged
}) {
  const rows = [];
  let dialogs, selected, sequence = 0, viewer, frame = 0, previewAbort, versionAbort;
  let snapshot, teamBusy = false, teamError = '';
  let downloadAbort;
  let disposed = false;
  const get = key => (dialogs.editor.querySelector(`[data-wb="${key}"]`) ||
    dialogs.cart.querySelector(`[data-wb="${key}"]`));
  const canWrite = () => snapshot?.mode === 'shared' || snapshot?.mode === 'local';

  function stopsPlayback() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (dialogs) get('play').textContent = '播放';
  }

  function stopPreview() {
    stopsPlayback();
    previewAbort?.abort();
    viewer?.dispose();
    viewer = undefined;
  }

  function snapshotTags(value) {
    return JSON.stringify(Object.entries(value?.assets || {})
      .filter(([, asset]) => asset.tags?.length).map(([id, asset]) => [id, asset.tags]));
  }

  async function updateTeam(action) {
    if (!team || teamBusy || disposed) return false;
    teamBusy = true;
    teamError = '';
    renderTeam();
    try {
      const next = await action();
      if (disposed) return false;
      const changedTags = snapshotTags(next) !== snapshotTags(snapshot);
      snapshot = next;
      if (changedTags) onTagsChanged?.();
      return canWrite();
    } catch (error) {
      teamError = error.message;
      return false;
    } finally {
      teamBusy = false;
      renderTeam();
    }
  }

  function tagsFor(item) {
    const id = typeof item === 'string' ? item : item?.id;
    return own(snapshot?.assets, id)?.tags || [];
  }

  function renderTeam() {
    if (!dialogs || !selected || disposed) return;
    const asset = own(snapshot?.assets, selected.asset.id);
    const record = own(asset?.versions, selected.version.id);
    const mode = snapshot?.mode;
    get('team-mode').textContent = mode === 'shared' ? '本机共用记录' :
      mode === 'local' ? '浏览器记录' : team && !teamError ? '正在读取评阅记录' : '评阅记录不可用';
    get('team-refresh').hidden = !team || mode === 'local';
    get('team-refresh').disabled = teamBusy;
    get('tag-form').hidden = !canWrite();
    get('comment-form').hidden = !canWrite();
    for (const [key, side, title] of [['vote-up','up','可用'], ['vote-down','down','有问题']]) {
      const vote = get(key);
      vote.textContent = `${title} ${record?.[side] || 0}`;
      vote.setAttribute('aria-pressed', String(record?.myVote === side));
      vote.disabled = teamBusy || !canWrite();
    }
    for (const key of ['tag-form', 'comment-form']) {
      get(key).querySelector('button').disabled = teamBusy;
    }
    get('tags').replaceChildren(...tagsFor(selected.asset).map(tag => el('span', tag)));
    const comments = record?.comments || [];
    get('comments-title').textContent = `评论 ${comments.length}`;
    get('comments').replaceChildren(...comments.map(comment => {
      const item = el('li');
      item.append(el('strong', comment.name), el('p', comment.text));
      return item;
    }));
    get('team-status').textContent = teamError;
  }

  function runVersionAction(method, fields) {
    if (!selected || !canWrite()) return;
    const target = {assetId: selected.asset.id, versionId: selected.version.id};
    return updateTeam(() => team[method]({...target, ...fields}));
  }

  function bindTeam() {
    for (const [key,side] of [['vote-up','up'],['vote-down','down']]) {
      get(key).onclick = () => {
        const asset = own(snapshot?.assets, selected.asset.id);
        const vote = own(asset?.versions, selected.version.id)?.myVote;
        return runVersionAction('vote', {vote: vote === side ? null : side});
      };
    }
    get('tag-form').onsubmit = event => {
      event.preventDefault();
      const input = get('tag');
      const choice = selected;
      const draft = input.value;
      return runVersionAction('addTag', {tag:draft.trim()})?.then(saved => {
        if (saved && selected === choice && input.value === draft) input.value = '';
      });
    };
    get('comment-form').onsubmit = event => {
      event.preventDefault();
      const input = get('comment');
      const version = versionAbort;
      const draft = input.value;
      return runVersionAction('comment', {text:draft.trim()})?.then(saved => {
        if (saved && version && !version.signal.aborted && input.value === draft) input.value = '';
      });
    };
    get('team-refresh').onclick = () => updateTeam(() => team.load());
  }

  function togglePlay() {
    if (!viewer) return;
    if (frame) {
      stopsPlayback();
      viewer.resetAnimation?.();
      return;
    }
    const clip = viewer.getAnimationClips().find(entry => entry.id === get('play-clip').value);
    if (!clip) return;
    const start = performance.now();
    get('play').textContent = '停止';
    function play(now) {
      viewer.setAnimationTime(clip.id, ((now - start) / 1000) % clip.duration);
      frame = requestAnimationFrame(play);
    }
    frame = requestAnimationFrame(play);
  }

  function ensureDialogs() {
    if (dialogs) return;
    dialogs = createDialogs();
    get('close-editor').onclick = () => dialogs.editor.close();
    dialogs.editor.addEventListener('close', () => {
      if (dialogs.editor.open) return;
      versionAbort?.abort();
      stopPreview();
      selected = undefined;
    });
    get('close-cart').onclick = () => {
      downloadAbort?.abort();
      dialogs.cart.close();
    };
    dialogs.cart.addEventListener('cancel', () => downloadAbort?.abort());
    get('open-cart').onclick = openCart;
    get('download').onclick = download;
    get('add').onclick = keepConfiguration;
    get('play').onclick = togglePlay;
    get('play-clip').onchange = () => {
      stopsPlayback();
      viewer?.resetAnimation?.();
    };
    get('version').onchange = () => loadVersion(selected.asset.versions.find(version => version.id === get('version').value));
    bindTeam();
  }

  function renderTextureSlots(materials, textures, textureIds) {
    const slots = new Map();
    for (const texture of textures) {
      const slot = materials[texture.materialIndex];
      if (!slot) continue;
      if (!slots.has(slot)) slots.set(slot, []);
      slots.get(slot).push(texture);
    }
    get('texture-row').hidden = slots.size === 0;
    get('texture-slots').replaceChildren(...Array.from(slots, ([slot, options]) => {
      const label = el('label', undefined, 'workbench-field workbench-texture-slot');
      const select = el('select');
      select.dataset.wb = 'texture';
      select.dataset.materialIndex = slot.index;
      select.append(option('', '原贴图'), ...options.map(texture => option(texture.id, texture.label)));
      select.value = textureIds.get(slot.index) || '';
      select.onchange = () => {
        if (select.value) textureIds.set(slot.index, select.value);
        else textureIds.delete(slot.index);
        refreshPreview();
      };
      label.append(el('span', slot.label), select);
      return label;
    }));
  }

  function renderIngredients() {
    const {version, textureIds, clips, extraIds, inspected} = selected;
    renderTextureSlots(inspected?.materials || [], version.textures || [], textureIds);
    const choices = [
      ...(inspected?.clips || []).map(clip => checkOption(clip.label, clips.has(clip.index), checked => {
        if (checked) clips.add(clip.index);
        else clips.delete(clip.index);
        refreshPreview();
      })),
      ...(version.motions || []).map(clip => checkOption(clip.label, extraIds.has(clip.id), checked => {
        if (checked) extraIds.add(clip.id);
        else extraIds.delete(clip.id);
        refreshPreview();
      }))
    ];
    get('clips').replaceChildren(...(choices.length ? choices : [el('p', '无已登记的动画', 'workbench-note')]));
  }

  async function loadVersion(version, row) {
    if (!version || !selected) return;
    versionAbort?.abort();
    stopPreview();
    const controller = new AbortController();
    versionAbort = controller;
    Object.assign(selected, {
      version, model: undefined, inspected: undefined, prepared: undefined,
      textureIds: new Map(row?.textures.map(texture => [texture.materialIndex, texture.id])),
      clips: new Set(), extraIds: new Set(row?.motions.map(clip => clip.id))
    });
    get('version').value = version.id;
    get('add').disabled = true;
    get('add-status').textContent = '';
    get('preview-status').textContent = '正在读取模型…';
    get('play-controls').hidden = true;
    get('stage').replaceChildren();
    get('texture-row').hidden = true;
    get('texture-slots').replaceChildren();
    get('clips').replaceChildren();
    get('comment').value = '';
    renderTeam();
    try {
      const bytes = await readAsset(version.url, PREVIEW_LIMITS.downloadBytes, controller.signal);
      if (sharesPreviewSource(version)) {
        await verifyContentHash(bytes, version.sourceSha256, '模型内容与入库记录不一致');
      }
      if (controller.signal.aborted) return;
      const inspected = inspectModel(bytes);
      selected.model = bytes;
      selected.inspected = inspected;
      selected.clips = new Set((row?.nativeClips ?? inspected.clips).map(clip => clip.index));
      renderIngredients();
      await refreshPreview();
    } catch (error) {
      if (!controller.signal.aborted) get('preview-status').textContent = `无法加载模型：${error.message}`;
    }
  }

  async function refreshPreview() {
    stopPreview();
    if (!selected?.model) return;
    get('stage').replaceChildren();
    const choice = selected;
    const controller = new AbortController();
    previewAbort = controller;
    const {version, model, inspected, textureIds, clips, extraIds} = choice;
    const textures = (version.textures || [])
      .filter(texture => textureIds.get(texture.materialIndex) === texture.id)
      .map(texture => ({...texture, materialLabel:inspected.materials[texture.materialIndex].label}));
    const selectedMotions = (version.motions || []).filter(clip => extraIds.has(clip.id));
    const native = inspected.clips.filter(clip => clips.has(clip.index));
    choice.prepared = undefined;
    get('add').disabled = true;
    get('add-status').textContent = '';
    get('play-controls').hidden = true;
    get('preview-status').textContent = '正在准备预览…';
    try {
      if (selectedMotions.length > MAX_EXTRA_CLIPS) throw Error(`每份配置最多可添加 ${MAX_EXTRA_CLIPS} 个外部动作`);
      const ingredients = await readConfigurationAssets(model, textures, selectedMotions, {signal:controller.signal});
      if (controller.signal.aborted) return;
      const prepared = prepareModel(model, {...ingredients, clips:native.map(clip => clip.index)});
      const hasSeparateSource = !sharesPreviewSource(version) ||
        textures.some(texture => !sharesPreviewSource(texture)) || selectedMotions.some(clip => !sharesPreviewSource(clip));
      const approvedSources = hasSeparateSource
        ? await approveSharedInputs({version, model, textures, motions:selectedMotions, ingredients}, controller.signal) : null;
      if (controller.signal.aborted) return;
      const next = await createViewer(get('stage'), prepared.bytes, {
        signal:controller.signal, animationData:prepared.animationData, camera
      });
      if (controller.signal.aborted) { next.dispose(); return; }
      viewer = next;
      choice.prepared = {
        asset:choice.asset, version, textures, motions:selectedMotions, nativeClips:native,
        approvedSources, approvedBytes:hasSeparateSource ? null : prepared.bytes,
        previewByteLength:prepared.bytes.byteLength, defaultClipName:prepared.defaultClipName,
        motionLabels:[...native.map(clip => clip.label), ...selectedMotions.map(clip => clip.label)]
      };
      const playable = viewer.getAnimationClips?.() || [];
      get('play-clip').replaceChildren(...playable.map(clip => option(clip.id, clip.name || clip.id)));
      get('play-controls').hidden = !playable.length;
      const warnings = [...new Set([...(prepared.warnings || []), ...(viewer.warnings || [])])];
      if (hasSeparateSource) warnings.unshift('网页使用轻量预览，下载使用原分辨率');
      get('preview-status').textContent = warnings.join('；') || describe(choice.prepared);
      get('add').disabled = false;
    } catch (error) {
      if (!controller.signal.aborted) get('preview-status').textContent = `无法预览配置：${error.message}`;
    }
  }

  function openEditor(asset, initialVariant, row) {
    ensureDialogs();
    const version = asset.versions.find(candidate => candidate.id === initialVariant) || asset.versions[0];
    selected = {asset, version, rowId:row?.id};
    dialogs.editor.querySelector('#workbench-title').textContent = asset.name;
    get('version').replaceChildren(...asset.versions.map(entry => option(entry.id, entry.label)));
    get('tag').value = '';
    get('add').textContent = row ? '保存到清单' : '加入待下载';
    get('open-cart').textContent = `待下载（${rows.length}）`;
    if (!dialogs.editor.open) dialogs.editor.showModal();
    dialogs.editor.querySelector('.workbench-body').scrollTop = 0;
    loadVersion(version, row);
    if (team && snapshot?.mode === 'shared') updateTeam(() => team.load());
  }

  function configure(item, variant) {
    let asset;
    try {
      asset = resolveAsset(item, variant);
    } catch (error) {
      notify(`读取模型配置失败：${error.message}`);
      return;
    }
    if (!asset?.versions?.length) {
      notify('当前资产无可配置的模型文件');
      return;
    }
    openEditor(asset, (typeof variant === 'string' ? variant : variant?.id) || asset.activeVersionId);
  }

  function keepConfiguration() {
    const prepared = selected?.prepared;
    if (!prepared) return;
    const index = rows.findIndex(row => row.id === selected.rowId);
    const total = rows.reduce((sum, row, i) => sum + (i === index ? 0 : row.previewByteLength), prepared.previewByteLength);
    if (index < 0 && rows.length >= MAX_ITEMS || total > MAX_CART_BYTES) {
      get('add-status').textContent = '清单容量已达上限，请分批下载';
      return;
    }
    const row = {...prepared, id:index < 0 ? ++sequence : selected.rowId};
    if (index < 0) rows.push(row); else rows[index] = row;
    selected.rowId = undefined;
    get('add').textContent = '加入待下载';
    get('add-status').textContent = index < 0 ? '已加入清单' : '已更新配置';
    renderCart();
  }

  function renderCart() {
    if (!dialogs) return;
    get('open-cart').textContent = `待下载（${rows.length}）`;
    get('cart-status').textContent = rows.length ? `${rows.length} 项配置` : '清单为空';
    get('download').disabled = rows.length === 0 || Boolean(downloadAbort);
    get('cart-rows').replaceChildren(...rows.map(row => {
      const item = el('article', undefined, 'workbench-cart-row');
      const summary = el('div');
      summary.append(el('h3', row.asset.name), el('p', describe(row), 'workbench-note'));
      const actions = el('div');
      actions.append(button('修改', () => {
        dialogs.cart.close();
        openEditor(row.asset, row.version.id, row);
      }), button('移除', () => {
        rows.splice(rows.indexOf(row), 1);
        if (selected?.rowId === row.id) {
          selected.rowId = undefined;
          get('add').textContent = '加入待下载';
        }
        renderCart();
      }));
      if (downloadAbort) for (const action of actions.children) action.disabled = true;
      item.append(summary, actions);
      return item;
    }));
    onCartChanged?.(rows.length);
  }

  function openCart() {
    ensureDialogs();
    if (dialogs.editor.open && frame) {
      stopsPlayback();
      viewer?.resetAnimation?.();
    }
    renderCart();
    if (!dialogs.cart.open) dialogs.cart.showModal();
  }

  async function download() {
    if (!rows.length || downloadAbort) return;
    const controller = new AbortController();
    downloadAbort = controller;
    renderCart();
    const queued = rows.slice();
    const packed = [];
    let used = 0;
    let result;
    try {
      for (const row of queued) {
        const progress = `${packed.length + 1}/${queued.length} · ${row.asset.name}`;
        get('cart-status').textContent = `正在组装原分辨率模型 ${progress}`;
        const prepared = await prepareExport(row, MAX_CART_BYTES - used, controller.signal);
        if (controller.signal.aborted || !dialogs.cart.open) return;
        used += prepared.bytes.byteLength;
        packed.push(prepared);
      }
      const url = URL.createObjectURL(new Blob([createUnityBundle(packed, config)], {type:'application/zip'}));
      const link = el('a');
      link.href = url;
      link.download = 'unity-assets.zip';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      result = `已生成 ${packed.length} 项配置的 ZIP`;
    } catch (error) {
      if (!controller.signal.aborted) result = `打包失败：${error.message}`;
    } finally {
      downloadAbort = undefined;
      if (!disposed) {
        renderCart();
        if (result) get('cart-status').textContent = result;
      }
    }
  }

  if (team) updateTeam(() => team.load());
  return {
    configure, openCart, tagsFor, get count() { return rows.length; },
    dispose() {
      disposed = true;
      stopPreview();
      versionAbort?.abort();
      downloadAbort?.abort();
      selected = undefined;
      rows.length = 0;
      dialogs?.editor.remove();
      dialogs?.cart.remove();
    }
  };
}
