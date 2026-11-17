import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {imageDimensions, parseGLB, PREVIEW_LIMITS} from '../apps/reviewer/viewer.mjs';

const PYTHON_HELPER = fileURLToPath(new URL('./resize-preview-images.py', import.meta.url));
const MAX_CONVERSION_MS = 120_000;
const FIRST_PREVIEW_AXIS = 1024;
const PREVIEW_IMAGE_BUDGET = /^Preview budget exceeded: aggregate image (bytes|pixels)$/;
const NON_BINARY_EXTENSIONS = new Set([
  'KHR_materials_anisotropy', 'KHR_materials_clearcoat', 'KHR_materials_dispersion',
  'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_iridescence',
  'KHR_materials_pbrSpecularGlossiness', 'KHR_materials_sheen', 'KHR_materials_specular',
  'KHR_materials_transmission', 'KHR_materials_unlit', 'KHR_materials_variants',
  'KHR_materials_volume', 'KHR_texture_transform', 'KHR_mesh_quantization', 'KHR_lights_punctual'
]);
const align4 = length => Math.ceil(length / 4) * 4;

function imageFrame(bytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return [length, bytes];
}

function resizeImages(images, limit) {
  if (!images.length) return [];
  const commands = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  const args = ['-E', '-B', PYTHON_HELPER, String(limit)];
  const input = Buffer.concat(images.flatMap(image => imageFrame(image.bytes)));
  for (const command of commands) {
    const result = spawnSync(command, args, {
      input, maxBuffer: PREVIEW_LIMITS.downloadBytes, timeout: MAX_CONVERSION_MS, windowsHide: true
    });
    if (result.error?.code === 'ENOENT' || result.status === 3) continue;
    if (result.error || result.status !== 0) {
      throw Error('Could not resize preview images: ' + (result.error?.message || result.stderr.toString().trim() || result.status));
    }
    const output = result.stdout;
    let offset = 0;
    const resized = images.map(image => {
      if (offset + 4 > output.length) throw Error('Incomplete preview image response');
      const length = output.readUInt32LE(offset);
      offset += 4;
      if (!length || offset + length > output.length) throw Error('Invalid preview image response');
      const bytes = output.subarray(offset, offset + length);
      offset += length;
      imageDimensions(Uint8Array.from(bytes).buffer, image.mimeType);
      return bytes;
    });
    if (offset !== output.length) throw Error('Unexpected preview image response');
    return resized;
  }
  throw Error('Large model textures need Python 3 and Pillow. Install with python -m pip install Pillow and retry.');
}

function imageGroups(document, images, limit) {
  const groups = new Map();
  for (const [index, image] of document.images.entries()) {
    const {bytes, width, height, mimeType} = images[index];
    if (Math.max(width, height) <= limit) continue;
    const key = image.bufferView ?? 'uri:' + index;
    if (!groups.has(key)) groups.set(key, {indices:[], viewIndex:image.bufferView, mimeType, bytes:Buffer.from(bytes)});
    groups.get(key).indices.push(index);
  }
  return [...groups.values()];
}

function stripUnsupportedPreviewExtensions(document) {
  const keep = new Set([...NON_BINARY_EXTENSIONS, ...(document.extensionsRequired || [])]);
  const pending = [document];
  while (pending.length) {
    const node = pending.pop();
    if (node.extensions && typeof node.extensions === 'object') {
      for (const name of Object.keys(node.extensions)) {
        if (!keep.has(name)) delete node.extensions[name];
      }
      if (!Object.keys(node.extensions).length) delete node.extensions;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'extras' && value && typeof value === 'object') pending.push(value);
    }
  }
  if (!document.extensionsUsed) return;
  document.extensionsUsed = document.extensionsUsed.filter(name => keep.has(name));
  if (!document.extensionsUsed.length) delete document.extensionsUsed;
}

function protectedImageViews(document) {
  const protectedViews = new Set();
  const images = new Set(document.images);
  const pending = [document];
  while (pending.length) {
    const node = pending.pop();
    for (const [key, value] of Object.entries(node)) {
      if (key === 'bufferView' && !images.has(node) && Number.isSafeInteger(value)) protectedViews.add(value);
      if (value && typeof value === 'object') pending.push(value);
    }
  }
  return protectedViews;
}

function compactBinary(document, binary, groups) {
  const protectedViews = protectedImageViews(document);
  const views = document.bufferViews;
  const ranges = views.map(({byteOffset:offset=0, byteLength:length}, index) => ({index,offset,length}));
  if (ranges.some(({offset,length}) => !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset + length > binary.length)) {
    return {parts:[binary], size:binary.length, removed:new Set()};
  }
  const deletions = groups.flatMap(({viewIndex}) => {
    if (viewIndex === undefined || protectedViews.has(viewIndex)) return [];
    const {offset,length} = ranges[viewIndex];
    const usedElsewhere = ranges.some(other => other.index !== viewIndex && other.offset < offset + length &&
      other.offset + other.length > offset);
    const count = length - length % 4;
    return usedElsewhere || count === 0 ? [] : [{viewIndex,start:offset,end:offset + count}];
  });
  const removed = new Set(deletions.map(range => range.viewIndex));
  deletions.sort((a,b) => a.start - b.start);
  const parts = [];
  let from = 0;
  let totalRemoved = 0;
  for (const {start,end} of deletions) {
    parts.push(binary.subarray(from,start));
    from = end;
    totalRemoved += end - start;
  }
  parts.push(binary.subarray(from));
  for (const {index,offset} of ranges) {
    if (removed.has(index)) continue;
    const before = deletions.reduce((total, range) => range.end <= offset ? total + range.end - range.start : total, 0);
    if (before) views[index].byteOffset = offset - before;
  }
  return {parts, size:binary.length - totalRemoved, removed};
}

function previewBytes(document, binary, groups, resized) {
  document.bufferViews ??= [];
  const {parts, removed, size} = compactBinary(document, binary, groups);
  let length = size;
  for (const [index, group] of groups.entries()) {
    const bytes = resized[index];
    const start = align4(length);
    parts.push(Buffer.alloc(start - length), bytes);
    length = start + bytes.length;
    const view = {buffer:0,byteOffset:start,byteLength:bytes.length};
    const viewIndex = removed.has(group.viewIndex) ? group.viewIndex : document.bufferViews.length;
    document.bufferViews[viewIndex] = view;
    for (const imageIndex of group.indices) {
      const image = document.images[imageIndex];
      delete image.uri;
      image.mimeType = group.mimeType;
      image.bufferView = viewIndex;
    }
  }
  document.buffers[0].byteLength = length;
  const paddedLength = align4(length);
  parts.push(Buffer.alloc(paddedLength - length));
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = align4(json.length);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67,0);
  header.writeUInt32LE(2,4);
  header.writeUInt32LE(28 + paddedJson + paddedLength,8);
  header.writeUInt32LE(paddedJson,12);
  header.writeUInt32LE(0x4e4f534a,16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(paddedLength,0);
  binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,json,Buffer.alloc(paddedJson - json.length,0x20),binHeader,...parts]);
}

export function preparePreviewGLB(bytes, document, binary) {
  let geometry;
  try {
    geometry = parseGLB(bytes);
  } catch (error) {
    if (!PREVIEW_IMAGE_BUDGET.test(error.message)) throw error;
  }
  if (geometry && geometry.images.every(image => Math.max(image.width, image.height) <= FIRST_PREVIEW_AXIS)) {
    return {geometry};
  }
  const sourceGeometry = geometry ?? parseGLB(bytes, {validatePreviewImages:false});
  if (document.buffers?.length !== 1) throw Error('Preview conversion requires one embedded GLB buffer.');
  const previewDocument = structuredClone(document);
  stripUnsupportedPreviewExtensions(previewDocument);
  for (const limit of [FIRST_PREVIEW_AXIS, 768, 512, 256]) {
    const groups = imageGroups(previewDocument, sourceGeometry.images, limit);
    if (!groups.length) continue;
    const preview = previewBytes(structuredClone(previewDocument), binary, groups, resizeImages(groups, limit));
    try {
      const geometry = parseGLB(preview);
      geometry.warnings = [...new Set([...sourceGeometry.warnings, ...geometry.warnings])];
      return {geometry, preview};
    } catch (error) {
      if (!PREVIEW_IMAGE_BUDGET.test(error.message) && error.message !== 'Preview budget exceeded: model bytes') throw error;
    }
  }
  throw Error('Could not fit a lightweight preview into the browser image budget.');
}
