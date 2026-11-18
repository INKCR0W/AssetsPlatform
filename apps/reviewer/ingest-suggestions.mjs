const generic = new Set([
  'asset','assets','source','sources','export','exports','output','model','models','mesh','meshes','glb',
  'material','materials','map','maps','texture','textures','tex','animation','animations','anim','anims',
  'motion','motions','image','images','png','jpg','jpeg','default','base','defaultversion',
  '资源','资产','原件','源文件','模型','网格','贴图','纹理','材质','动画','动作','导出','默认','默认版','基础版'
]);
const nonBaseMaps = new Set([
  'normal','normalmap','normalgl','normaldx','nrm','roughness','roughnessmap','metallic','metalness',
  'occlusion','orm','rma','ao','specular','gloss','glossiness','displacement','height','heightmap',
  'emissive','opacity','alpha','mask','bump',
  '法线','粗糙度','金属度','环境遮蔽','自发光','高光','位移','高度贴图','透明度','遮罩','凹凸'
]);
const baseMaps = new Set(['basecolor','albedo','diffuse','color','colour','rgb','底色','漫反射','颜色']);
const MAX_CANDIDATES = 3;

function words(value = '') {
  return value.normalize('NFKC')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu,'$1 $2')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu,'$1 $2')
    .replace(/(\p{Script=Han})(?=[A-Za-z0-9])/gu,'$1 ')
    .replace(/([A-Za-z0-9])(?=\p{Script=Han})/gu,'$1 ')
    .toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];
}

function stem(value) {
  return value.replace(/\.[^.]+$/u,'');
}

function key(terms) {
  return terms.join('');
}

function usableName(terms) {
  const value = key(terms);
  return value.length > 1 && !generic.has(value) && !baseMaps.has(value) && !/^\d+$/u.test(value);
}

function contains(haystack, needle) {
  if (!needle.length) return false;
  const spaced = ' ' + haystack.join(' ') + ' ';
  if (spaced.includes(' ' + needle.join(' ') + ' ')) return true;
  const compact = key(needle);
  // Chinese asset and material names are often written without word delimiters.
  return /^[\p{Script=Han}]{2,}$/u.test(compact) && haystack.some(part => part.includes(compact));
}

function folders(file) {
  if (!file.relativePath) return [];
  return file.relativePath.split(/[\\/]/u).slice(0,-1).map(words).filter(usableName);
}

function profile(version, model) {
  const name = words(version.name);
  const labels = [words(version.label),words(version.label.replace(/(?:版本|版)$/u,''))];
  const aliases = [words(stem(model.name)), name];
  if (usableName(name)) {
    for (const label of labels.filter(usableName)) aliases.push([...name,...label],[...label,...name]);
  }
  return {version,model,aliases:aliases.filter(usableName),folder:folders(model)};
}

function namedCandidates(profiles, hints) {
  const matches = profiles.flatMap(profile => profile.aliases
    .filter(alias => contains(hints,alias))
    .map(alias => ({profile,alias})));
  // Prefer a qualified name ("crate light") over its matching shorter alias ("crate").
  return [...new Set(matches.filter(match => !matches.some(other =>
    key(other.alias).length > key(match.alias).length && contains(other.alias,match.alias)
  )).map(match => match.profile))];
}

function folderCandidates(profiles, actual) {
  const eligible = profiles.filter(item => item.folder.length && item.folder.length <= actual.length &&
    item.folder.every((segment,index) => key(segment) === key(actual[index])));
  const depth = eligible.reduce((maximum,item) => Math.max(maximum,item.folder.length),0);
  return eligible.filter(item => item.folder.length === depth);
}

function versionCandidates(profiles, file) {
  const actualFolder = folders(file);
  const signals = [
    namedCandidates(profiles,words(stem(file.name))),
    folderCandidates(profiles,actualFolder),
    namedCandidates(profiles,actualFolder.flat())
  ].filter(signal => signal.length);
  if (!signals.length) return {candidates:[],conflict:false};
  const agreement = signals[0].filter(candidate => signals.every(signal => signal.includes(candidate)));
  return agreement.length
    ? {candidates:agreement,conflict:false}
    : {candidates:[...new Set(signals.flat())],conflict:true};
}

function matchLabels(items, hints) {
  const matches = items.map(item => ({item,label:words(item.label)}))
    .filter(({label}) => usableName(label) && hints.some(words => contains(words,label)));
  return matches.filter(match => !matches.some(other =>
    key(other.label).length > key(match.label).length && contains(other.label,match.label)
  )).map(match => match.item);
}

function likelyNonBaseMap(file) {
  const name = words(stem(file.name));
  const directories = folders(file);
  const explicitBase = baseMaps.has(name.at(-1)) || key(name.slice(-2)) === 'basecolor' ||
    /底色|漫反射/u.test(name.at(-1) || '');
  if (explicitBase) return false;
  return [...name,...directories.flat()].some(word => nonBaseMaps.has(word) ||
    /法线|粗糙度|金属度|环境遮蔽|自发光|高光|位移贴图|高度贴图|透明度|遮罩|凹凸/u.test(word));
}

function labelHints(file) {
  return [words(stem(file.name)), ...folders(file)];
}

function withoutModelName(hint, aliases) {
  const match = aliases.filter(alias => contains(hint,alias))
    .sort((a,b) => key(b).length - key(a).length)[0];
  if (!match) return hint;
  const start = hint.findIndex((_,index) => match.every((word,next) => word === hint[index+next]));
  if (start >= 0) return [...hint.slice(0,start),...hint.slice(start+match.length)];
  const phrase = key(match);
  const index = hint.findIndex(word => word.includes(phrase));
  return hint.flatMap((word,at) => at === index ? word.split(phrase).filter(Boolean) : [word]);
}

function sampledIndexes(items,hints,allowOnlyChoice) {
  const matches = matchLabels(items,hints);
  if (matches.length) return matches.map(item => item.index);
  return allowOnlyChoice && items.length === 1 ? [items[0].index] : [];
}

function assignedIndex(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function fileCanBind(file, kind) {
  return file && !file.error && (kind === 'texture' ? file.kindHint === 'texture' :
    ['model','animation'].includes(file.kindHint) && file.clips?.length);
}

function suggestBinding(binding, file, profiles, versionCount) {
  const indexKey = binding.kind === 'texture' ? 'materialIndex' : 'clipIndex';
  const hasIndex = assignedIndex(binding[indexKey]);
  if (binding.versionId && hasIndex) return null;
  const result = {bindingId:binding.id,status:'unmatched',fields:{},candidates:[]};
  if (!fileCanBind(file,binding.kind)) return result;
  const isTexture = binding.kind === 'texture';
  const hints = labelHints(file);
  const otherMap = isTexture && likelyNonBaseMap(file);
  if (otherMap && !hasIndex) result.reason = 'texture-channel';
  const presetVersion = profiles.find(item => item.version.id === binding.versionId);
  const eligible = isTexture && hasIndex ? profiles.filter(item =>
    item.model.materials?.some(slot => slot.index === binding.materialIndex)) : profiles;
  let rule = binding.versionId
    ? {candidates:presetVersion ? [presetVersion] : [],conflict:false}
    : versionCandidates(profiles,file);
  if (!binding.versionId && eligible.length !== profiles.length && rule.candidates.some(item => !eligible.includes(item))) {
    rule = {candidates:rule.candidates.filter(item => eligible.includes(item)),conflict:true};
  }
  if (!binding.versionId && !rule.candidates.length && versionCount === 1 && eligible.length === 1 &&
      (!eligible[0].folder.length || !folders(file).length)) {
    rule = {candidates:eligible,conflict:false};
  }
  const resolvedVersion = !rule.conflict && rule.candidates.length === 1 ? rule.candidates[0] : undefined;
  if (resolvedVersion && !binding.versionId) result.fields.versionId = resolvedVersion.version.id;
  const clipIndices = isTexture ? [] : sampledIndexes(file.clips,hints,true);
  if (!isTexture && !hasIndex && clipIndices.length === 1) result.fields.clipIndex = clipIndices[0];

  for (const item of rule.candidates) {
    const versionId = item.version.id;
    let indices = clipIndices;
    if (isTexture && !otherMap) {
      const scopeHints = hints.map(terms => withoutModelName(terms,item.aliases));
      indices = sampledIndexes(item.model.materials || [],scopeHints,true);
    }
    if (isTexture && item === resolvedVersion && !hasIndex && !otherMap && indices.length === 1) {
      result.fields.materialIndex = indices[0];
    }
    for (const index of (hasIndex ? [binding[indexKey]] : indices.length ? indices : [undefined])) {
      result.candidates.push({versionId,...(index === undefined ? {} : {[indexKey]:index})});
      if (result.candidates.length === MAX_CANDIDATES) break;
    }
    if (result.candidates.length === MAX_CANDIDATES) break;
  }

  const complete = resolvedVersion && (hasIndex || assignedIndex(result.fields[indexKey]));
  if (complete) result.status = 'certain';
  else if (result.candidates.length || Object.keys(result.fields).length || binding.versionId) result.status = 'review';
  return result;
}

export function suggestIngestBindings(plan, files) {
  const byId = new Map(files.map(file => [file.fileId,file]));
  const profiles = plan.versions.flatMap(version => {
    const model = byId.get(version.modelFileId);
    return model?.kindHint === 'model' && !model.error ? [profile(version,model)] : [];
  });
  return plan.bindings.map(binding => suggestBinding(binding,byId.get(binding.fileId),profiles,plan.versions.length))
    .filter(Boolean);
}
