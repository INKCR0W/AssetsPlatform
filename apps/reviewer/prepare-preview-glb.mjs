import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {imageDimensions, parseGLB, PREVIEW_LIMITS} from './viewer.mjs';

const PYTHON_HELPER = fileURLToPath(new URL('./resize-preview-images.py', import.meta.url));
const MAX_CONVERSION_MS = 120_000;
const FIRST_PREVIEW_AXIS = 1024;
const MAX_UPLOAD_IMAGE_PIXELS = 128 * 1024 * 1024;
const PREVIEW_IMAGE_BUDGET = /^Preview budget exceeded: aggregate image (bytes|pixels)$/;
const NON_BINARY_EXTENSIONS = new Set([
  'KHR_materials_anisotropy', 'KHR_materials_clearcoat', 'KHR_materials_dispersion',
  'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_iridescence',
  'KHR_materials_pbrSpecularGlossiness', 'KHR_materials_sheen', 'KHR_materials_specular',
  'KHR_materials_transmission', 'KHR_materials_unlit', 'KHR_materials_variants',
  'KHR_materials_volume', 'KHR_texture_transform', 'KHR_mesh_quantization', 'KHR_lights_punctual'
]);
const align4 = length => Math.ceil(length / 4) * 4;
const pythonCommands = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
const pngCrc = Uint32Array.from({length:256}, (_,index) => {
  let value = index;
  for (let bit=0;bit<8;bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});

function validPng(bytes) {
  let offset=8, hasData=false, endedData=false;
  while (offset+12 <= bytes.length) {
    const length=bytes.readUInt32BE(offset), start=offset+8, end=start+length;
    if (end+4 > bytes.length) return false;
    const type=bytes.toString('latin1',offset+4,start);
    if (!/^[A-Za-z]{4}$/.test(type) || (offset===8 ? type!=='IHDR' || length!==13 : type==='IHDR')) return false;
    let crc=0xffffffff;
    for (let index=offset+4;index<end;index++) crc=(crc >>> 8) ^ pngCrc[(crc ^ bytes[index]) & 255];
    if ((~crc >>> 0) !== bytes.readUInt32BE(end)) return false;
    if (type==='IEND') return hasData && length===0 && end+4===bytes.length;
    if (type==='IDAT') {
      if (endedData) return false;
      hasData ||= length>0;
    } else if (hasData) endedData=true;
    offset=end+4;
  }
  return false;
}

function validJpeg(bytes) {
  let offset=2, inScan=false, sawScan=false, scanData=false;
  while (offset<bytes.length) {
    if (inScan) {
      const next=bytes.indexOf(0xff,offset);
      if (next<0) return false;
      scanData ||= next>offset;
      offset=next;
    }
    if (bytes[offset++]!==0xff) return false;
    while (bytes[offset]===0xff) offset++;
    if (offset>=bytes.length) return false;
    const marker=bytes[offset++];
    if (inScan && marker===0) { scanData=true; continue; }
    if (inScan && marker>=0xd0 && marker<=0xd7) continue;
    if (inScan && !scanData) return false;
    inScan=false;
    if (marker===0xd9) return sawScan && offset===bytes.length;
    if (marker===1) continue;
    if (marker<0xc0 || marker>=0xd0 && marker<=0xd8 || offset+2>bytes.length) return false;
    const length=bytes.readUInt16BE(offset);
    if (length<2 || offset+length>bytes.length) return false;
    if (marker===0xda) {
      const components=bytes[offset+2];
      if (!components || length!==6+2*components) return false;
      inScan=sawScan=true;
      scanData=false;
    }
    offset+=length;
  }
  return false;
}

function validateImageContainer(bytes,mimeType) {
  const info = imageDimensions(Uint8Array.from(bytes).buffer,mimeType);
  const complete = mimeType==='image/png' ? validPng(bytes) : validJpeg(bytes);
  if (!complete) throw Error('图片数据不完整或已损坏。');
  return info;
}

export async function validateEmbeddedImages(document,binary) {
  const inspected=new Set();
  const images=[];
  let totalEncoded=0,totalPixels=0;
  function add(bytes,mimeType) {
    totalEncoded+=bytes.length;
    if (totalEncoded>PREVIEW_LIMITS.downloadBytes) throw Error('内嵌图片总大小超出入库上限。');
    const {pixels}=validateImageContainer(bytes,mimeType);
    totalPixels+=pixels;
    if (totalPixels>MAX_UPLOAD_IMAGE_PIXELS) throw Error('内嵌图片总像素超出入库上限。');
    images.push({bytes});
  }
  for (const image of document.images || []) {
    if (image?.bufferView!==undefined) {
      const view=document.bufferViews?.[image.bufferView];
      const start=view?.byteOffset ?? 0, length=view?.byteLength;
      if (!view || (view.buffer ?? 0)!==0 || !Number.isSafeInteger(start) || start<0 ||
          !Number.isSafeInteger(length) || length<=0 || length>PREVIEW_LIMITS.imageBytes || start+length>binary.length) {
        throw Error('内嵌图片缓冲区无效。');
      }
      const key=image.mimeType+':'+start+':'+length;
      if (inspected.has(key)) continue;
      inspected.add(key);
      add(binary.subarray(start,start+length),image.mimeType);
    } else {
      const inline=typeof image?.uri==='string' && /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.uri);
      if (!inline) throw Error('内嵌图片格式无效。');
      add(Buffer.from(inline[2],'base64'),inline[1]);
    }
  }
  if (images.length) await validateImageDecodes(images);
}

// Use the closed two-chunk GLB profile for both directory and HTTP ingestion.
export function readEmbeddedGLB(bytes, name) {
  if(bytes.length<28 || bytes.readUInt32LE(0)!==0x46546c67 || bytes.readUInt32LE(4)!==2 || bytes.readUInt32LE(8)!==bytes.length) throw Error('Invalid GLB 2.0 header');
  const jsonLength=bytes.readUInt32LE(12);
  if(bytes.readUInt32LE(16)!==0x4e4f534a || jsonLength%4 || jsonLength>PREVIEW_LIMITS.jsonBytes || 28+jsonLength>bytes.length) throw Error('Invalid GLB JSON chunk or budget');
  const binOffset=20+jsonLength, binLength=bytes.readUInt32LE(binOffset);
  if(bytes.readUInt32LE(binOffset+4)!==0x004e4942 || binLength%4 || binOffset+8+binLength!==bytes.length) throw Error('Expected exactly one JSON and one BIN chunk');
  const document=JSON.parse(bytes.subarray(20,binOffset).toString('utf8').replace(/\0+$/,''));
  if ((document.buffers||[]).some(buffer=>buffer.uri!==undefined) ||
      (document.images||[]).some(image=>image.uri!==undefined && !/^data:image\/(png|jpeg);base64,/.test(image.uri))) {
    throw Error('GLB must contain its buffers and images: '+name);
  }
  return {document, binary:bytes.subarray(binOffset+8)};
}

function imageFrame(bytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return [length, bytes];
}

function imageWorkerRequest(images, command) {
  return {
    args:['-E', '-B', PYTHON_HELPER, String(command)],
    input:Buffer.concat(images.flatMap(image => imageFrame(image.bytes)))
  };
}

function resizeResponse(images, result) {
  if (result.error?.code === 'ENOENT' || result.status === 3) return null;
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

function missingResizer() {
  return Error('Large model textures need Python 3 and Pillow. Install with python -m pip install Pillow and retry.');
}

function resizeImages(images, limit) {
  const {args,input} = imageWorkerRequest(images,limit);
  for (const command of pythonCommands) {
    const result = spawnSync(command, args, {
      input, maxBuffer: PREVIEW_LIMITS.downloadBytes, timeout: MAX_CONVERSION_MS, windowsHide: true
    });
    const resized = resizeResponse(images,result);
    if (resized) return resized;
  }
  throw missingResizer();
}

function runResize(command,args,input) {
  return new Promise(resolve => {
    const child = spawn(command,args,{windowsHide:true});
    const stdout = [], stderr = [];
    let size = 0, error;
    function stop(failure) {
      error ??= failure;
      child.kill();
    }
    const timeout = setTimeout(() => stop(Error('Preview conversion timed out')), MAX_CONVERSION_MS);
    child.on('error', failure => {error ??= failure;});
    child.stdin.on('error', failure => {if (failure.code !== 'EPIPE') stop(failure);});
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size <= PREVIEW_LIMITS.downloadBytes) stdout.push(chunk);
      else stop(Error('Preview image response exceeded its byte limit'));
    });
    child.stderr.on('data', chunk => {if (stderr.length < 4) stderr.push(chunk);});
    child.on('close', status => {
      clearTimeout(timeout);
      resolve({status,error,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)});
    });
    child.stdin.end(input);
  });
}

async function resizeImagesAsync(images,limit) {
  const {args,input} = imageWorkerRequest(images,limit);
  for (const command of pythonCommands) {
    const result = await runResize(command,args,input);
    const resized = resizeResponse(images,result);
    if (resized) return resized;
  }
  throw missingResizer();
}

async function validateImageDecodes(images) {
  const {args,input} = imageWorkerRequest(images,'--validate');
  for (const command of pythonCommands) {
    const result = await runResize(command,args,input);
    if (result.error?.code==='ENOENT' || result.status===3) continue;
    if (result.error) throw Error('图片校验失败：'+result.error.message);
    if (result.status!==0 || result.stdout.length) throw Error('图片像素数据无法解码。');
    return;
  }
  throw Error('贴图入库需要 Python 3 和 Pillow。');
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

function* previewPreparation(bytes, document, binary) {
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
    const resized = yield {groups,limit};
    const preview = previewBytes(structuredClone(previewDocument), binary, groups, resized);
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

export function preparePreviewGLB(bytes,document,binary) {
  const preparation = previewPreparation(bytes,document,binary);
  let step = preparation.next();
  while (!step.done) {
    const {groups,limit} = step.value;
    step = preparation.next(resizeImages(groups,limit));
  }
  return step.value;
}

export async function preparePreviewGLBAsync(bytes,document,binary) {
  const preparation = previewPreparation(bytes,document,binary);
  let step = preparation.next();
  while (!step.done) {
    const {groups,limit} = step.value;
    step = preparation.next(await resizeImagesAsync(groups,limit));
  }
  return step.value;
}

export async function preparePreviewImage(bytes,mimeType) {
  const info = validateImageContainer(bytes,mimeType);
  if (Math.max(info.width,info.height) <= FIRST_PREVIEW_AXIS) {
    await validateImageDecodes([{bytes}]);
    return {...info,preview:null,previewPixels:info.pixels};
  }
  const [preview] = await resizeImagesAsync([{bytes,mimeType}],FIRST_PREVIEW_AXIS);
  return {...info,preview,previewPixels:imageDimensions(Uint8Array.from(preview).buffer,mimeType).pixels};
}
