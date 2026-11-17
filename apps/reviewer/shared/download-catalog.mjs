const MODEL_PATH = /\.glb$/i;
const IMAGE_FORMATS = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg']]);

function pathname(url) {
  try { return new URL(url, 'http://localhost').pathname; } catch { return ''; }
}

function extension(url) {
  return pathname(url).split('.').pop().toLowerCase();
}

function sourceModelUrl(record) {
  const url = record?.sourceModelUrl;
  return typeof url === 'string' && url ? url : undefined;
}

export function hasDownloadModel(record) {
  if (typeof record?.modelUrl !== 'string' || !record.modelUrl || !pathname(record.modelUrl)) return false;
  return record.modelAsset?.format === 'glb' || MODEL_PATH.test(pathname(record.modelUrl));
}

export function modelVariants(item) {
  return Array.isArray(item.variants)
    ? item.variants.filter(variant => typeof variant?.id === 'string' && variant.id && hasDownloadModel(variant))
    : [];
}

export function galleryModel(item) {
  if (hasDownloadModel(item)) return item;
  const version = modelVariants(item)[0];
  if (!version) return item;
  return {...item, modelUrl:version.modelUrl, modelAsset:version.modelAsset,
    sourceModelUrl:sourceModelUrl(version), sourceModelSha256:version.sourceModelSha256,
    resourceBaseUrl:version.resourceBaseUrl, previewUrl:version.previewUrl};
}

export function isLibraryModel(item) {
  return item.isObject && (hasDownloadModel(item) || modelVariants(item).length > 0);
}

function registeredOptions(options, resolve, kind) {
  const seen = new Set();
  if (!Array.isArray(options)) return [];
  return options.flatMap(option => {
    if (typeof option?.id !== 'string' || !option.id || seen.has(option.id) ||
        typeof option.url !== 'string' || !option.url) return [];
    const url = resolve(option.url);
    const label = typeof option.label === 'string' && option.label ? option.label : option.id;
    if (kind === 'texture') {
      const mimeType = IMAGE_FORMATS.get(extension(url));
      if (!mimeType || !Number.isSafeInteger(option.materialIndex) || option.materialIndex < 0) return [];
      const sourceUrl = option.sourceTextureUrl ? resolve(option.sourceTextureUrl) : url;
      const sourceMimeType = IMAGE_FORMATS.get(extension(sourceUrl));
      if (!sourceMimeType) return [];
      seen.add(option.id);
      return [{id:option.id, label, url, mimeType, sourceUrl, sourceMimeType, materialIndex:option.materialIndex}];
    }
    if (extension(url) !== 'glb' || !Number.isSafeInteger(option.index) || option.index < 0) return [];
    seen.add(option.id);
    return [{id:option.id, label, url, index:option.index}];
  });
}

export function resolveDownloadAsset(item, activeVariant, resolve = url => url) {
  const variants = modelVariants(item);
  const seen = new Set();
  const entries = variants.filter(variant => {
    if (seen.has(variant.id)) return false;
    seen.add(variant.id);
    return true;
  });
  const baseSource = sourceModelUrl(item) || item.modelUrl;
  const usesBase = entry => entry.modelUrl === item.modelUrl &&
    (sourceModelUrl(entry) || baseSource) === baseSource;
  if (hasDownloadModel(item) && !entries.some(usesBase)) {
    let id = 'base';
    while (seen.has(id)) id += '-model';
    entries.unshift({id, label:'默认版', modelUrl:item.modelUrl, sourceModelUrl:sourceModelUrl(item),
      sourceModelSha256:item.sourceModelSha256, downloadOptions:item.downloadOptions});
  }
  if (!entries.length) return null;
  const versions = entries.map(entry => {
    const sameModel = usesBase(entry);
    const options = entry.downloadOptions ?? (sameModel ? item.downloadOptions : undefined);
    const url = resolve(entry.modelUrl);
    const original = sourceModelUrl(entry) || (sameModel ? baseSource : entry.modelUrl);
    const sourceSha256 = entry.sourceModelSha256 ?? (sameModel ? item.sourceModelSha256 : undefined);
    return {
      id:entry.id, label:entry.label || entry.id, url, sourceUrl:resolve(original),
      ...(sourceSha256 === undefined ? {} : {sourceSha256}),
      textures:registeredOptions(options?.textures, resolve, 'texture'),
      motions:registeredOptions(options?.motions, resolve, 'motion')
    };
  });
  return {id:item.id, name:item.name, versions,
    activeVersionId:versions.some(version => version.id === activeVariant?.id)
      ? activeVariant.id : versions[0].id};
}
