import {createSourceAnimation, imageDimensions, parseGLB, PREVIEW_LIMITS} from '../viewer.mjs';

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const GLB_MAGIC = 0x46546c67;
const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_FILES = 2048;
const MAX_CURVE_VALUES = 1024 * 1024;
const TRACK_TYPES = {translation:['VEC3',3], rotation:['VEC4',4], scale:['VEC3',3]};
const interpolationModes = new Set(['LINEAR','STEP','CUBICSPLINE']);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8',{fatal:true});
const align4 = size => Math.ceil(size / 4) * 4;

function modelBytes(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array)) throw TypeError('需要二进制文件');
  return bytes;
}

function unpackGLB(input) {
  const bytes = modelBytes(input);
  if (bytes.length < 28 || bytes.length > PREVIEW_LIMITS.downloadBytes) throw Error('GLB 文件大小超出支持范围');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const jsonLength = view.getUint32(12,true);
  const binHeader = 20 + jsonLength;
  if (view.getUint32(0,true) !== GLB_MAGIC || view.getUint32(4,true) !== 2 ||
      view.getUint32(8,true) !== bytes.length || view.getUint32(16,true) !== JSON_CHUNK ||
      !jsonLength || jsonLength % 4 || jsonLength > PREVIEW_LIMITS.jsonBytes || binHeader + 8 > bytes.length ||
      view.getUint32(binHeader + 4,true) !== BIN_CHUNK) throw Error('仅支持自包含 GLB 2.0 文件');
  const binLength = view.getUint32(binHeader,true);
  const binEnd = binHeader + 8 + binLength;
  if (binEnd > bytes.length || binLength % 4) throw Error('GLB 二进制区块不完整');
  const binary = bytes.subarray(binHeader + 8,binEnd);
  for (let offset = binEnd; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw Error('GLB 扩展区块不完整');
    const length = view.getUint32(offset,true);
    const type = view.getUint32(offset + 4,true);
    offset += 8 + length;
    if (offset > bytes.length || length % 4 || type === JSON_CHUNK || type === BIN_CHUNK) {
      throw Error('GLB 扩展区块无效');
    }
  }
  const document = JSON.parse(decoder.decode(bytes.subarray(20,binHeader)));
  for (const key of ['materials','animations','nodes','skins','scenes','bufferViews','accessors','images']) {
    if (document?.[key] !== undefined && !Array.isArray(document[key])) throw Error('GLB 数据结构无效：' + key);
  }
  const buffer = document?.buffers?.[0];
  if (document?.asset?.version !== '2.0' || !Array.isArray(document.buffers) || document.buffers.length !== 1 ||
      !buffer || buffer.uri !== undefined ||
      !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || binary.length < buffer.byteLength ||
      binary.length - buffer.byteLength > 3 ||
      (document.images || []).some(image => image?.uri !== undefined && !/^data:image\/(?:png|jpeg);base64,/.test(image.uri))) {
    throw Error('GLB 含外部依赖或无效的内嵌缓冲区');
  }
  return {bytes,document,binary:binary.subarray(0,buffer.byteLength),extraChunks:bytes.subarray(binEnd),curveValues:0};
}

function combine(parts, size = parts.reduce((total,part) => total + part.length,0)) {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part,offset);
    offset += part.length;
  }
  return result;
}

function binaryBuilder(document, binary) {
  const parts = [binary];
  let size = binary.length;
  return {
    addView(bytes) {
      const byteOffset = align4(size);
      const padding = byteOffset - size;
      size = byteOffset + bytes.length;
      if (size > PREVIEW_LIMITS.downloadBytes) throw Error('组装后模型文件过大');
      parts.push(new Uint8Array(padding),bytes);
      return (document.bufferViews ||= []).push({buffer:0,byteOffset,byteLength:bytes.length}) - 1;
    },
    finish() {
      document.buffers[0].byteLength = size;
      return combine(parts,align4(size));
    }
  };
}

function packGLB(document, binary, extraChunks) {
  const json = encoder.encode(JSON.stringify(document));
  const jsonLength = align4(json.length);
  const binHeader = 20 + jsonLength;
  const binEnd = binHeader + 8 + binary.length;
  const size = binEnd + extraChunks.length;
  if (jsonLength > PREVIEW_LIMITS.jsonBytes || size > PREVIEW_LIMITS.downloadBytes) throw Error('组装后模型文件过大');
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0,GLB_MAGIC,true);
  view.setUint32(4,2,true);
  view.setUint32(8,size,true);
  view.setUint32(12,jsonLength,true);
  view.setUint32(16,JSON_CHUNK,true);
  bytes.fill(0x20,20,binHeader);
  bytes.set(json,20);
  view.setUint32(binHeader,binary.length,true);
  view.setUint32(binHeader + 4,BIN_CHUNK,true);
  bytes.set(binary,binHeader + 8);
  bytes.set(extraChunks,binEnd);
  return bytes;
}

export function inspectModel(input) {
  const {document} = unpackGLB(input);
  const names = (entries, prefix) => entries.map((entry,index) => ({
    index,label:typeof entry?.name === 'string' && entry.name.trim() ? entry.name : `${prefix} ${index + 1}`
  }));
  return {materials:names(document.materials || [],'材质'),clips:names(document.animations || [],'动画')};
}

function replaceTexture(document, builder, texture) {
  const {materialIndex,mimeType} = texture;
  const material = Number.isSafeInteger(materialIndex) && document.materials?.[materialIndex];
  const bytes = modelBytes(texture.bytes);
  if (!material || !['image/png','image/jpeg'].includes(mimeType) || bytes.length > PREVIEW_LIMITS.imageBytes) {
    throw Error('贴图格式、大小或材质槽无效');
  }
  imageDimensions(new Uint8Array(bytes).buffer,mimeType);
  const pbr = material.pbrMetallicRoughness ||= {};
  const previous = pbr.baseColorTexture;
  const coord = previous?.extensions?.KHR_texture_transform?.texCoord ?? previous?.texCoord ?? 0;
  const primitives = (document.meshes || []).flatMap(mesh => mesh.primitives || []);
  const targets = primitives.filter(primitive => primitive.material === materialIndex);
  if (coord !== 0 || !targets.length || targets.some(primitive => primitive.attributes?.TEXCOORD_0 === undefined)) {
    throw Error('所选材质槽未使用可预览的 UV0');
  }
  const image = (document.images ||= []).push({bufferView:builder.addView(bytes),mimeType}) - 1;
  const sampler = document.textures?.[previous?.index]?.sampler;
  const index = (document.textures ||= []).push(sampler == null ? {source:image} : {source:image,sampler}) - 1;
  pbr.baseColorTexture = {...previous,index};
}

function accessorRows(asset,index,type,width) {
  const accessor = asset.document.accessors?.[index];
  const buffer = asset.document.bufferViews?.[accessor?.bufferView];
  const count = accessor?.count;
  const bufferOffset = buffer?.byteOffset ?? 0;
  const start = bufferOffset + (accessor?.byteOffset ?? 0);
  const stride = buffer?.byteStride ?? width * 4;
  const end = start + (count - 1) * stride + width * 4;
  if (!accessor || accessor.type !== type || accessor.componentType !== 5126 || accessor.sparse ||
      !buffer || buffer.buffer !== 0 || !Number.isSafeInteger(count) || count < 1 ||
      !Number.isSafeInteger(bufferOffset) || bufferOffset < 0 || !Number.isSafeInteger(buffer.byteLength) ||
      !Number.isSafeInteger(stride) || stride < width * 4 || stride % 4 ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start % 4 ||
      start < bufferOffset || end > bufferOffset + buffer.byteLength || end > asset.binary.length) {
    throw Error('动画只有在使用有效的内嵌浮点曲线时才能预览或复制');
  }
  asset.curveValues += count * width;
  if (asset.curveValues > MAX_CURVE_VALUES) throw Error('动画曲线超出处理容量');
  const view = new DataView(asset.binary.buffer,asset.binary.byteOffset,asset.binary.length);
  return Array.from({length:count},(_,row) => Array.from({length:width},(_,column) => {
    const value = view.getFloat32(start + row * stride + column * 4,true);
    if (!Number.isFinite(value)) throw Error('动画曲线含无效数值');
    return value;
  }));
}

function readTrack(asset,clip,channel) {
  const path = channel?.target?.path;
  const node = channel?.target?.node;
  const target = Number.isSafeInteger(node) && asset.document.nodes?.[node];
  const sampler = clip.samplers?.[channel?.sampler];
  const interpolation = sampler?.interpolation ?? 'LINEAR';
  if (!target || target.matrix || !Object.hasOwn(TRACK_TYPES,path) || !sampler || !interpolationModes.has(interpolation) ||
      channel.extensions || channel.target.extensions || sampler.extensions) {
    throw Error('不支持当前动画通道');
  }
  const [type,width] = TRACK_TYPES[path];
  const times = accessorRows(asset,sampler.input,'SCALAR',1).map(row => row[0]);
  if (times.some((time,index) => time < 0 || (index > 0 && time <= times[index-1]))) throw Error('动画关键帧时间无效');
  const values = accessorRows(asset,sampler.output,type,width);
  if (interpolation === 'CUBICSPLINE' ? values.length !== 3 * times.length : values.length !== times.length) {
    throw Error('动画时间与关键帧数量不匹配');
  }
  if (path === 'rotation' && values.some((value,index) =>
    (interpolation !== 'CUBICSPLINE' || index % 3 === 1) && Math.hypot(...value) < 1e-10)) {
    throw Error('动画含无效的旋转关键帧');
  }
  return {node,path,interpolation,times,values,type,width};
}

function readClip(asset,clip) {
  if (!Array.isArray(clip?.channels) || !clip.channels.length || clip.channels.length > PREVIEW_LIMITS.nodes * 3 ||
      clip.extensions) throw Error('未找到支持的动画通道');
  const keys = new Set();
  return clip.channels.map(channel => {
    const track = readTrack(asset,clip,channel);
    const key = `${track.node}:${track.path}`;
    if (keys.has(key)) throw Error('动画含重复的绑定目标');
    keys.add(key);
    return track;
  });
}

function nodeRest(node) {
  return {
    translation:node.translation ?? [0,0,0], rotation:node.rotation ?? [0,0,0,1], scale:node.scale ?? [1,1,1]
  };
}

// Copying only exact, named layouts avoids guessing joint retargets from similar mesh names.
function rigSignature(asset) {
  const {document} = asset;
  const nodes = document.nodes || [];
  const names = nodes.map(node => node.name);
  if (!nodes.length || names.some(name => typeof name !== 'string' || !name.trim()) || new Set(names).size !== names.length) {
    throw Error('模型缺少唯一的节点名称，无法匹配外部动画');
  }
  return JSON.stringify({
    nodes:nodes.map(node => [node.name,node.children ?? [],node.skin ?? null,node.matrix ?? nodeRest(node)]),
    roots:document.scenes?.[document.scene ?? 0]?.nodes ?? [],
    skins:(document.skins || []).map(skin => [skin.joints,skin.skeleton ?? null,skin.inverseBindMatrices === undefined
      ? null : accessorRows(asset,skin.inverseBindMatrices,'MAT4',16)])
  });
}

function appendFloats(document,builder,rows,type, bounds) {
  const width = rows[0].length;
  const bytes = new Uint8Array(rows.length * width * 4);
  const view = new DataView(bytes.buffer);
  rows.forEach((row,index) => row.forEach((value,column) => view.setFloat32((index * width + column) * 4,value,true)));
  return (document.accessors ||= []).push({bufferView:builder.addView(bytes),componentType:5126,count:rows.length,type,...bounds}) - 1;
}

function appendExternalClip(document,builder,name,tracks) {
  const samplers = tracks.map(track => ({
    input:appendFloats(document,builder,track.times.map(time => [time]),'SCALAR',{min:[track.times[0]],max:[track.times.at(-1)]}),
    output:appendFloats(document,builder,track.values,track.type),
    interpolation:track.interpolation
  }));
  return {name,samplers,channels:tracks.map((track,sampler) => ({sampler,target:{node:track.node,path:track.path}}))};
}

function sidecarTrack(track,nodeId) {
  const {path,interpolation,times,values} = track;
  if (interpolation !== 'CUBICSPLINE') return {nodeId,path,interpolation,times,values};
  return {nodeId,path,interpolation,times,
    values:values.filter((_,index) => index % 3 === 1),
    inTangents:values.filter((_,index) => index % 3 === 0),
    outTangents:values.filter((_,index) => index % 3 === 2)};
}

function visibleSceneNodes(document) {
  const nodes = document.nodes || [];
  const scene = document.scenes?.[document.scene ?? 0];
  const children = new Set(nodes.flatMap(node => node.children || []));
  const remaining = [...(scene ? scene.nodes || [] : nodes.map((_,index) => index).filter(index => !children.has(index)))];
  const visited = new Set();
  while (remaining.length) {
    const index = remaining.pop();
    if (!nodes[index] || visited.has(index)) continue;
    visited.add(index);
    for (const child of nodes[index].children || []) remaining.push(child);
  }
  return visited;
}

function createAnimationSidecar(asset,clips,warnings) {
  const nodes = new Map();
  const usedIds = new Set(asset.document.nodes?.map(node => node.extras?.sourceId));
  const assignedIds = new Set();
  const activeNodes = visibleSceneNodes(asset.document);
  const register = index => {
    if (nodes.has(index)) return nodes.get(index).id;
    const node = asset.document.nodes[index];
    let id = node.extras?.sourceId;
    if (typeof id !== 'string' || !id || assignedIds.has(id)) {
      id = `workbench-node-${index}`;
      while (usedIds.has(id)) id += '_';
      usedIds.add(id);
      node.extras = {...node.extras,sourceId:id};
    }
    assignedIds.add(id);
    nodes.set(index,{id,glbNodeIndex:index,...nodeRest(node)});
    return id;
  };
  const result = [];
  for (const [index,entry] of clips.entries()) {
    try {
      const tracks = entry.tracks ?? readClip(asset,entry.clip);
      if (tracks.some(track => !activeNodes.has(track.node))) throw Error('动画目标未包含在预览场景中');
      const duration = Math.max(...tracks.map(track => track.times.at(-1)));
      if (!(duration > 0)) throw Error('没有可播放的时间范围');
      result.push({id:`clip-${index}`,name:entry.label,duration,tracks:tracks.map(track => sidecarTrack(track,register(track.node)))});
    } catch (error) {
      if (entry.tracks) throw Error(`外部动画「${entry.label}」不能应用：${error.message}`);
      warnings.push(`「${entry.label}」保留在导出模型中，当前浏览器无法预览：${error.message}`);
    }
  }
  if (!result.length) return null;
  const sourceId = typeof asset.document.extras?.sourceId === 'string' && asset.document.extras.sourceId || 'asset-workbench';
  asset.document.extras = {...asset.document.extras,sourceId};
  return {schemaVersion:1,coordinateSystem:'glTF',sourceId,nodes:[...nodes.values()],clips:result};
}

export function prepareModel(input, {texture, clips, extraClips = []} = {}) {
  const asset = unpackGLB(input);
  const {document,binary} = asset;
  const native = document.animations || [];
  const indices = clips ?? native.map((_,index) => index);
  if (!Array.isArray(indices) || indices.length > 1024 || new Set(indices).size !== indices.length ||
      indices.some(index => !Number.isSafeInteger(index) || !native[index]) ||
      !Array.isArray(extraClips) || extraClips.length > 32 || indices.length + extraClips.length > 1024) {
    throw Error('动画选择无效或超出支持范围');
  }
  let changed = Boolean(texture) || clips !== undefined || extraClips.length > 0;
  const builder = binaryBuilder(document,binary);
  if (texture) replaceTexture(document,builder,texture);
  const selected = indices.map(index => ({clip:native[index],label:native[index].name || `动画 ${index + 1}`}));
  if (extraClips.length) {
    const targetRig = rigSignature(asset);
    for (const entry of extraClips) {
      const external = unpackGLB(entry?.bytes);
      if (rigSignature(external) !== targetRig) throw Error('外部动画与当前模型的节点或骨架绑定不同');
      const clip = Number.isSafeInteger(entry.index) && external.document.animations?.[entry.index];
      const tracks = readClip(external,clip);
      asset.curveValues += external.curveValues;
      if (asset.curveValues > MAX_CURVE_VALUES) throw Error('动画曲线超出处理容量');
      const label = clip.name || `外部动画 ${entry.index + 1}`;
      selected.push({clip:appendExternalClip(document,builder,label,tracks),label,tracks});
    }
  }
  const warnings = [];
  const animationData = createAnimationSidecar(asset,selected,warnings);
  const authoredNames = new Set(selected.map(entry => entry.clip.name).filter(Boolean));
  const usedNames = new Set();
  for (const entry of selected) {
    const original = entry.clip.name;
    let name = original;
    if (!original || usedNames.has(original)) {
      const label = original || entry.label;
      name = label;
      for (let suffix = 2; authoredNames.has(name) || usedNames.has(name); suffix++) name = `${label} (${suffix})`;
      entry.clip = {...entry.clip,name};
      changed = true;
    }
    usedNames.add(name);
  }
  const defaultClipName = selected[0]?.clip.name ?? null;
  if (animationData) changed = true;
  if (changed) {
    if (selected.length) document.animations = selected.map(entry => entry.clip);
    else delete document.animations;
  }
  const bytes = changed ? packGLB(document,builder.finish(),asset.extraChunks) : new Uint8Array(asset.bytes);
  const geometry = parseGLB(bytes);
  if (!animationData) return {bytes,animationData:null,defaultClipName,warnings};
  const evaluated = createSourceAnimation(geometry,animationData);
  const playable = new Set(evaluated.clips.map(clip => clip.id));
  for (const clip of animationData.clips) {
    if (playable.has(clip.id)) continue;
    const index = Number(clip.id.slice('clip-'.length));
    if (selected[index].tracks) throw Error(`外部动画「${clip.name}」未绑定到可预览模型`);
    warnings.push(`「${clip.name}」保留在导出模型中，当前浏览器无法预览。`);
  }
  animationData.clips = animationData.clips.filter(clip => playable.has(clip.id));
  return {bytes,animationData:animationData.clips.length ? animationData : null,defaultClipName,warnings};
}

const crcTable = Uint32Array.from({length:256},(_,index) => {
  let crc = index;
  for (let bit=0; bit<8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(name,data,offset) {
  const path = encoder.encode(name);
  const local = new Uint8Array(30 + path.length);
  const header = new DataView(local.buffer);
  const checksum = crc32(data);
  header.setUint32(0,0x04034b50,true);
  header.setUint16(4,20,true);
  header.setUint16(6,0x800,true);
  header.setUint16(12,0x21,true);
  header.setUint32(14,checksum,true);
  header.setUint32(18,data.length,true);
  header.setUint32(22,data.length,true);
  header.setUint16(26,path.length,true);
  local.set(path,30);
  const central = new Uint8Array(46 + path.length);
  const entry = new DataView(central.buffer);
  entry.setUint32(0,0x02014b50,true);
  entry.setUint16(4,20,true);
  entry.setUint16(6,20,true);
  entry.setUint16(8,0x800,true);
  entry.setUint16(14,0x21,true);
  entry.setUint32(16,checksum,true);
  entry.setUint32(20,data.length,true);
  entry.setUint32(24,data.length,true);
  entry.setUint16(28,path.length,true);
  entry.setUint32(42,offset,true);
  central.set(path,46);
  return {local,central};
}

export function makeZip(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ZIP_FILES) throw Error('待打包文件过多');
  const files = new Set(), folders = new Set(), locals = [], directory = [];
  let offset = 0, directorySize = 0;
  for (const {name,data} of entries) {
    if (typeof name !== 'string' || name.length > 512 || /[\\<>:"|?*\x00-\x1f\x7f]/.test(name) ||
        !(data instanceof Uint8Array) ||
        name.split('/').some(part => !part || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
      throw Error('打包路径或文件无效');
    }
    const key = name.normalize('NFC').toLowerCase();
    if (files.has(key) || folders.has(key)) throw Error('打包路径重复');
    for (let slash=key.indexOf('/'); slash!==-1; slash=key.indexOf('/',slash+1)) {
      const folder = key.slice(0,slash);
      if (files.has(folder)) throw Error('打包路径与目录冲突');
      folders.add(folder);
    }
    files.add(key);
    const pathLength = encoder.encode(name).length;
    if (offset + data.length + directorySize + 2 * pathLength + 98 > MAX_ZIP_BYTES) throw Error('下载包超过 256 MiB');
    const {local,central} = zipEntry(name,data,offset);
    locals.push(local,data);
    directory.push(central);
    offset += local.length + data.length;
    directorySize += central.length;
  }
  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0,0x06054b50,true);
  footer.setUint16(8,entries.length,true);
  footer.setUint16(10,entries.length,true);
  footer.setUint32(12,directorySize,true);
  footer.setUint32(16,offset,true);
  return combine([...locals,...directory,end]);
}
