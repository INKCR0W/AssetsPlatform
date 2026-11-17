import {makeZip} from './asset-package.mjs';

const encoded = new TextEncoder();

function slug(value) {
  const safe = String(value).normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  return [...safe].slice(0, 36).join('') || 'model';
}

function json(data) {
  return encoded.encode(JSON.stringify(data, null, 2) + '\n');
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const modelContentHash = sha256;

export function animationNameHash(name) {
  return name === null ? null : sha256(encoded.encode(name));
}

export function createUnityBundle(rows, {projectId, datasetId}) {
  const entries = [];
  const items = rows.map((row, index) => {
    const {modelSha256} = row;
    if (!/^[0-9a-f]{64}$/.test(modelSha256)) throw Error('模型配置缺少内容摘要');
    const folder = `${String(index + 1).padStart(2, '0')}-${slug(row.asset.id)}-${modelSha256.slice(0, 16)}`;
    const modelFile = `${slug(row.asset.name)}-${slug(row.version.id)}.glb`;
    const model = `${folder}/${modelFile}`;
    const animationCount = row.motionLabels.length;
    const defaultClipNameSha256 = row.defaultClipNameSha256;
    if (animationCount ? !/^[0-9a-f]{64}$/.test(defaultClipNameSha256) : defaultClipNameSha256 !== null) {
      throw Error('模型配置的默认动画无效');
    }
    const textures = (row.textures || []).map(({id,label,materialIndex,materialLabel}) =>
      ({id,label,materialIndex,materialLabel}));
    const details = {
      assetId:row.asset.id, name:row.asset.name, versionId:row.version.id,
      version:row.version.label, model, modelFile, modelSha256,
      texture:textures.map(texture => texture.label).join('、') || null, textures,
      animations:row.motionLabels, defaultClipName:row.defaultClipName
    };
    entries.push({name:model, data:row.bytes}, {
      name:`${folder}/asset.json`,
      data:json({format:'asset-workbench-unity/configuration/2', model, animationCount, defaultClipNameSha256})
    });
    return details;
  });
  entries.push({name:'manifest.json', data:json({format:'asset-workbench-unity/1', projectId, datasetId, items})});
  entries.push({name:'README.txt', data:encoded.encode(
    '将需要的模型目录解压至已安装 Unity glTFast（com.unity.cloud.gltfast）的工程 Assets 目录。GLB 内已包含该配置的网格、材质、贴图与动画。\n'
  )});
  return makeZip(entries);
}
