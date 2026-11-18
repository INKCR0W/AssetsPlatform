import {createHash, randomUUID} from 'node:crypto';
import {extname} from 'node:path';
import {inspectModel, prepareModel} from './shared/asset-package.mjs';
import {PREVIEW_LIMITS} from './viewer.mjs';
import {preparePreviewGLBAsync, preparePreviewImage, readEmbeddedGLB, validateEmbeddedImages} from './prepare-preview-glb.mjs';

const MODEL_TYPE = 'model/gltf-binary';
const extensions = new Map([
  ['.glb',{extension:'glb',mimeType:MODEL_TYPE,kindHint:'model'}],
  ['.png',{extension:'png',mimeType:'image/png',kindHint:'texture'}],
  ['.jpg',{extension:'jpg',mimeType:'image/jpeg',kindHint:'texture'}],
  ['.jpeg',{extension:'jpg',mimeType:'image/jpeg',kindHint:'texture'}]
]);
const sourceNames = new Map([['original','自制'],['purchased','购买'],['reference','参考'],['other','其他']]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identifier = (prefix,...components) => prefix + '-' + digest(JSON.stringify(components)).slice(0,32);
const modelInput = (file,preview) => (preview ? file.preview?.bytes : undefined) || file.data;
const distinct = values => [...new Set(values)];

export async function inspectIngestFile(name, input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const type = extensions.get(extname(name).toLowerCase());
  const metadata = {name,bytes:bytes.length,sha256:digest(bytes),materials:[],clips:[],kindHint:'unknown',...type};
  let preview;
  try {
    if (!type) throw Error('请选择自包含 GLB 或 PNG/JPG 文件。');
    if (!bytes.length || bytes.length > (type.kindHint === 'model' ? PREVIEW_LIMITS.downloadBytes : PREVIEW_LIMITS.imageBytes)) {
      throw Error('文件大小超出支持范围。');
    }
    if (type.kindHint === 'texture') {
      const {width,height,preview:derivative,previewPixels} = await preparePreviewImage(bytes,type.mimeType);
      Object.assign(metadata,{width,height,previewPixels});
      preview = derivative;
    } else {
      const {document,binary} = readEmbeddedGLB(bytes,name);
      Object.assign(metadata,inspectModel(bytes));
      await validateEmbeddedImages(document,binary);
      if (!document.meshes?.length && metadata.clips.length) {
        metadata.kindHint = 'animation';
      } else {
        const {geometry,preview:derivative} = await preparePreviewGLBAsync(bytes,document,binary);
        Object.assign(metadata,{vertexCount:geometry.vertices,triangleCount:geometry.triangles,warnings:geometry.warnings});
        preview = derivative;
      }
    }
  } catch (error) {
    metadata.error = error.message;
  }
  return {
    metadata,
    ...(preview ? {preview:{bytes:preview,digest:digest(preview),extension:metadata.extension,mimeType:metadata.mimeType}} : {})
  };
}

function bindingOptions(binding,file,preview) {
  const bytes = modelInput(file,preview);
  if (binding.kind === 'texture') {
    return {textures:[{
      bytes,mimeType:file.metadata.mimeType,materialIndex:binding.materialIndex,
      pixels:preview ? file.metadata.previewPixels : (file.metadata.width || 0) * (file.metadata.height || 0)
    }]};
  }
  return {extraClips:[{bytes,index:binding.clipIndex}]};
}

function collectRecipe(combination,fragment) {
  for (const texture of fragment.textures || []) {
    // Combined picks must fit both file bytes and decoded preview pixels.
    const largest = combination.textures.get(texture.materialIndex);
    if (!largest || texture.bytes.length > largest.bytes.length) combination.textures.set(texture.materialIndex,texture);
    const widest = combination.byPixels.get(texture.materialIndex);
    if (!widest || texture.pixels > widest.pixels) combination.byPixels.set(texture.materialIndex,texture);
  }
  combination.extraClips.push(...(fragment.extraClips || []));
}

function testModel(model,recipe,preview) {
  prepareModel(modelInput(model,preview),{...recipe,validatePreview:preview});
}

function validateBinding(binding,file,model,hasDerivatives,fragments) {
  const preview = bindingOptions(binding,file,true);
  testModel(model,preview,true);
  if (hasDerivatives) {
    const source = bindingOptions(binding,file,false);
    testModel(model,source,false);
    collectRecipe(fragments.source,source);
  }
  collectRecipe(fragments.preview,preview);
}

function testCombined(model,recipe,preview) {
  if (recipe.textures.size + recipe.extraClips.length < 2) return;
  testModel(model,{textures:[...recipe.textures.values()],extraClips:recipe.extraClips},preview);
  if (preview && [...recipe.byPixels].some(([index,option]) => recipe.textures.get(index) !== option)) {
    testModel(model,{textures:[...recipe.byPixels.values()],extraClips:recipe.extraClips},true);
  }
}

export function validateIngestPlan(batch,files) {
  const {versions,bindings} = batch.plan;
  const versionIds = new Set(versions.map(version => version.id));
  const usedFiles = new Set();
  const issues = [];
  const identities = new Set();
  function add(severity,code,message,versionId,bindingId,fileId) {
    issues.push({severity,code,message,versionId,bindingId,fileId});
  }
  if (!versions.length) add('error','EMPTY_PLAN','至少需要一个模型版本。');
  for (const binding of bindings) {
    usedFiles.add(binding.fileId);
    if (!versionIds.has(binding.versionId)) {
      add('error','BINDING_VERSION_MISSING','请选择模型版本。',undefined,binding.id,binding.fileId);
    }
  }
  for (const version of versions) {
    const model = files.get(version.modelFileId);
    const id = version.id;
    const name = version.name.trim(), label = version.label.trim();
    const identity = JSON.stringify([name,label]);
    if (!name || !label) add('error','VERSION_IDENTITY_MISSING','请填写模型名和版本名。',id);
    else if (identities.has(identity)) add('error','DUPLICATE_VERSION','该模型版本重复。',id);
    identities.add(identity);
    if (!version.source) add('warning','SOURCE_UNSET','未填写来源。',id);
    if (version.modelFileId) usedFiles.add(version.modelFileId);
    if (!model || model.metadata.kindHint !== 'model' || model.metadata.error) {
      add('error','MODEL_REQUIRED',model?.metadata.error || '请选择可预览的 GLB。',id,undefined,version.modelFileId);
      continue;
    }
    for (const warning of (model.metadata.warnings || []).slice(0,20)) {
      add('warning','MODEL_PREVIEW_LIMITATION',warning,id,undefined,version.modelFileId);
    }
    const assigned = bindings.filter(binding => binding.versionId === id);
    const hasDerivatives = Boolean(model.preview || assigned.some(binding => files.get(binding.fileId)?.preview));
    const fragments = {
      source:{textures:new Map(),byPixels:new Map(),extraClips:[]},
      preview:{textures:new Map(),byPixels:new Map(),extraClips:[]}
    };
    const seenBindings = new Set();
    for (const binding of assigned) {
      const file = files.get(binding.fileId);
      if (!file || file.metadata.error) {
        add('error','FILE_UNAVAILABLE',file?.metadata.error || '找不到附件。',id,binding.id,binding.fileId);
        continue;
      }
      const index = binding.kind === 'texture' ? binding.materialIndex : binding.clipIndex;
      if (binding.kind === 'texture' && (file.metadata.kindHint !== 'texture' || !model.metadata.materials.some(slot => slot.index === index))) {
        add('error','MATERIAL_SLOT_REQUIRED','请选择有效贴图和对应的材质槽。',id,binding.id,binding.fileId);
        continue;
      }
      if (binding.kind === 'animation' && !file.metadata.clips.some(clip => clip.index === index)) {
        add('error','CLIP_REQUIRED','请选择文件中的动画片段。',id,binding.id,binding.fileId);
        continue;
      }
      const key = JSON.stringify([binding.kind,file.metadata.sha256,index]);
      if (seenBindings.has(key)) {
        add('warning','DUPLICATE_BINDING','附件已绑定到相同位置。',id,binding.id,binding.fileId);
        continue;
      }
      seenBindings.add(key);
      try {
        validateBinding(binding,file,model,hasDerivatives,fragments);
      } catch (error) {
        add('error',binding.kind === 'texture' ? 'TEXTURE_INCOMPATIBLE' : 'ANIMATION_INCOMPATIBLE',
          error.message,id,binding.id,binding.fileId);
      }
    }
    if (issues.some(issue => issue.versionId === id && issue.severity === 'error')) continue;
    try {
      testCombined(model,fragments.preview,true);
      if (hasDerivatives) testCombined(model,fragments.source,false);
    } catch (error) {
      add('error','COMBINED_CONFIGURATION_INVALID',error.message,id);
    }
  }
  for (const [fileId,{metadata}] of files) {
    if (!usedFiles.has(fileId)) add('warning','FILE_UNASSIGNED',metadata.name + ' 未绑定。',undefined,undefined,fileId);
  }
  return {
    validationId:randomUUID(),
    revision:batch.revision,
    issues,
    versions:versions.map(({id}) => ({id,ready:!issues.some(issue => issue.versionId === id && issue.severity === 'error')}))
  };
}

export class IngestValidationError extends Error {
  constructor(validation) {
    super('请先处理入库错误。');
    this.status = 422;
    this.code = 'VALIDATION_BLOCKED';
    this.validation = validation;
  }
}

function modelPaths(file,register) {
  const {metadata} = file;
  const original = register(file);
  const modelUrl = register(file,true);
  return {
    modelUrl, vertexCount:metadata.vertexCount, triangleCount:metadata.triangleCount,
    materialCount:metadata.materials.length,
    ...(original === modelUrl ? {} : {sourceModelUrl:original,sourceModelSha256:metadata.sha256})
  };
}

function attachments(batch,bindings,files,register) {
  const records = new Map();
  const options = {textures:[],motions:[]};
  const seen = new Set();
  for (const binding of bindings) {
    const file = files.get(binding.fileId);
    const {metadata} = file;
    const texture = binding.kind === 'texture';
    const index = texture ? binding.materialIndex : binding.clipIndex;
    const key = JSON.stringify([binding.kind,metadata.sha256,index]);
    if (seen.has(key)) continue;
    seen.add(key);
    const original = register(file);
    const preview = register(file,true);
    const id = identifier(texture ? 'ingested-texture' : 'ingested-motion',batch.id,metadata.sha256,texture ? null : index);
    if (texture) {
      records.set(id,{id,name:metadata.name,type:'texture',category:'model',previewUrl:preview,imageUrl:original});
      options.textures.push({
        id:binding.id,label:metadata.name,url:preview,materialIndex:index,
        ...(preview === original ? {} : {sourceTextureUrl:original})
      });
    } else {
      const label = metadata.clips.find(clip => clip.index === index).label;
      records.set(id,{id,name:label,type:'animation',category:'model',downloads:[{kind:'url',label:'GLB',url:original}]});
      options.motions.push({
        id:binding.id,label,url:preview,index,
        ...(preview === original ? {} : {sourceMotionUrl:original})
      });
    }
  }
  return {records,options};
}

export function prepareIngestPublication(batch,files) {
  const validation = validateIngestPlan(batch,files);
  if (validation.issues.some(issue => issue.severity === 'error')) throw new IngestValidationError(validation);
  const assets = new Map(), groups = new Map(), blobs = new Map();
  function register(file,usePreview = false) {
    const derivative = usePreview && file.preview;
    const entry = derivative || {digest:file.metadata.sha256,extension:file.metadata.extension,bytes:file.data};
    const key = entry.digest + '.' + entry.extension;
    blobs.set(key,entry);
    return 'assets/ingested/' + key;
  }
  for (const version of batch.plan.versions) {
    const name = version.name.trim(), label = version.label.trim();
    const group = groups.get(name) || [];
    groups.set(name,group);
    const paths = modelPaths(files.get(version.modelFileId),register);
    const assetId = identifier('ingested-mesh',batch.id,version.id);
    assets.set(assetId,{id:assetId,name:name + ' · ' + label,type:'mesh',category:'model',...paths});
    const {records,options} = attachments(batch,batch.plan.bindings.filter(item => item.versionId === version.id),files,register);
    for (const [id,record] of records) assets.set(id,record);
    const tags = sourceNames.has(version.source) ? [sourceNames.get(version.source)] : [];
    group.push({
      id:version.id,label,assetId,assetIds:[assetId,...records.keys()],type:'object',...paths,
      sourceKind:version.source || '',tags,downloadOptions:options
    });
  }
  const objects = [...groups].map(([name,variants]) => {
    const {id:_baseId,label:_baseLabel,...base} = variants[0];
    return {...base,id:identifier('ingested-object',batch.id,name),name,category:'model',variants,
      tags:distinct(variants.flatMap(variant => variant.tags))};
  });
  return {assets:[...assets.values()],objects,blobs:[...blobs.values()]};
}
