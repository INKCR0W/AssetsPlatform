import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {prepareModel} from '../shared/asset-package.mjs';
import {animationNameHash, createUnityBundle, modelContentHash} from '../shared/unity-bundle.mjs';

function unpackStoredEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = new Map();
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
    files.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  return files;
}

test('repeat downloads of a modified configuration get a separate Unity import path', async () => {
  const base = new URL('../demo-a/assets/', import.meta.url);
  const model = await readFile(new URL('crate-standard.glb', base));
  const texture = {bytes:await readFile(new URL('wood-blue.png', base)), mimeType:'image/png', materialIndex:0};
  const original = prepareModel(model).bytes;
  const replacement = prepareModel(model, {texture}).bytes;
  const target = {projectId:'demo-a', datasetId:'example-v1'};
  async function exportFile(bytes) {
    const modelSha256 = await modelContentHash(bytes);
    const row = {asset:{id:'crate', name:'木箱'}, version:{id:'standard', label:'标准版'},
      bytes, modelSha256, motionLabels:['目录显示名'], defaultClipName:'原地转向',
      defaultClipNameSha256:await animationNameHash('原地转向')};
    const files = unpackStoredEntries(createUnityBundle([row], target));
    const decoder = new TextDecoder();
    const manifest = JSON.parse(decoder.decode(files.get('manifest.json')));
    const entry = manifest.items[0];
    assert.equal(entry.modelSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(files.get(entry.model), bytes);
    const folder = entry.model.split('/')[0];
    const marker = JSON.parse(decoder.decode(files.get(folder + '/asset.json')));
    assert.deepEqual(marker, {
      format:'asset-workbench-unity/configuration/2', model:entry.model, animationCount:1,
      defaultClipNameSha256:createHash('sha256').update('原地转向', 'utf8').digest('hex')
    });
    assert.deepEqual(entry.animations, ['目录显示名']);
    assert.equal(entry.defaultClipName, '原地转向');
    return folder;
  }
  const originalPath = await exportFile(original);
  assert.equal(await exportFile(original), originalPath);
  assert.notEqual(await exportFile(replacement), originalPath);
});

test('lists each selected material and texture in the root manifest only', async () => {
  const base = new URL('../demo-a/assets/', import.meta.url);
  const bytes = await readFile(new URL('crate-light.glb', base));
  const chosen = [
    {id:'leather', label:'蓝色皮革', materialIndex:0, materialLabel:'皮革'},
    {id:'metal', label:'黑色金属', materialIndex:1, materialLabel:'金属'}
  ];
  const row = {asset:{id:'crate', name:'木箱'}, version:{id:'light', label:'轻量版'},
    bytes, modelSha256:await modelContentHash(bytes), motionLabels:[], defaultClipName:null,
    defaultClipNameSha256:null,
    textures:chosen.map(texture => ({...texture, sourceUrl:'/private/asset.png'}))};
  const files = unpackStoredEntries(createUnityBundle([row], {projectId:'demo-a', datasetId:'example-v1'}));
  const decoder = new TextDecoder();
  const [entry] = JSON.parse(decoder.decode(files.get('manifest.json'))).items;
  assert.deepEqual(entry.textures, chosen);
  assert.equal(entry.texture, '蓝色皮革、黑色金属');
  const marker = JSON.parse(decoder.decode(files.get(entry.model.split('/')[0] + '/asset.json')));
  assert.deepEqual(marker, {
    format:'asset-workbench-unity/configuration/2', model:entry.model, animationCount:0,
    defaultClipNameSha256:null
  });
});

test('keeps 800 full names in the manifest and bounds the Unity import marker', async () => {
  const bytes = await readFile(new URL('../demo-a/assets/crate-standard.glb', import.meta.url));
  const motionLabels = Array.from({length:800}, (_, index) => 'LongAnimationVariant_'.repeat(6) + index);
  const defaultClipName = '非常长的动作名称'.repeat(5000);
  const row = {asset:{id:'crate', name:'木箱'}, version:{id:'standard', label:'标准版'},
    bytes, modelSha256:await modelContentHash(bytes), motionLabels, defaultClipName,
    defaultClipNameSha256:await animationNameHash(defaultClipName)};
  const files = unpackStoredEntries(createUnityBundle([row], {projectId:'demo-a', datasetId:'example-v1'}));
  const decoder = new TextDecoder();
  const manifest = files.get('manifest.json');
  assert.ok(manifest.byteLength > 64 * 1024);
  const [entry] = JSON.parse(decoder.decode(manifest)).items;
  assert.deepEqual(entry.animations, motionLabels);
  assert.equal(entry.defaultClipName, defaultClipName);
  const markerBytes = files.get(entry.model.split('/')[0] + '/asset.json');
  assert.ok(markerBytes.byteLength < 1024);
  const marker = JSON.parse(decoder.decode(markerBytes));
  assert.equal(marker.animationCount, 800);
  assert.equal(marker.defaultClipNameSha256, createHash('sha256').update(defaultClipName, 'utf8').digest('hex'));
});

test('omits the native animation array when all animations are deselected', async () => {
  const model = await readFile(new URL('../demo-a/assets/crate-standard.glb', import.meta.url));
  const prepared = prepareModel(model, {clips:[]});
  const view = new DataView(prepared.bytes.buffer, prepared.bytes.byteOffset, prepared.bytes.byteLength);
  const jsonBytes = view.getUint32(12, true);
  const document = JSON.parse(new TextDecoder().decode(prepared.bytes.subarray(20, 20 + jsonBytes)));
  assert.equal(Object.hasOwn(document, 'animations'), false);
  assert.equal(prepared.animationData, null);
  assert.equal(prepared.defaultClipName, null);
});
