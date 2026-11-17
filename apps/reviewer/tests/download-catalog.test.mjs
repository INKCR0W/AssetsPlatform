import test from 'node:test';
import assert from 'node:assert/strict';
import {galleryModel, isLibraryModel, resolveDownloadAsset} from '../shared/download-catalog.mjs';

test('only objects with a model appear in the library, including variant-only objects', () => {
  assert.equal(isLibraryModel({isObject:true, metadataUrl:'assets/record.json'}), false);
  assert.equal(isLibraryModel({isObject:true, previewUrl:'assets/photo.png'}), false);
  assert.equal(isLibraryModel({isObject:false, modelUrl:'assets/attachment.glb'}), false);
  const item = {
    isObject:true, id:'item', name:'Model', variants:[
      {id:'record', metadataUrl:'assets/record.json'},
      {id:'standard', modelUrl:'assets/model.GLB'}
    ]
  };
  assert.equal(isLibraryModel(item), true);
  assert.equal(galleryModel(item).modelUrl, 'assets/model.GLB');
  assert.deepEqual(resolveDownloadAsset(item, item.variants[0]).versions.map(version => version.id), ['standard']);
});

test('configuration options are scoped to their declared model version', () => {
  const item = {
    id:'crate', name:'Crate', modelUrl:'assets/standard.glb',
    downloadOptions:{
      textures:[{id:'wood', label:'Wood', url:'assets/wood.png', materialIndex:0}],
      motions:[
        {id:'turn', url:'assets/turn.glb', index:0},
        {id:'bad', url:'assets/metadata.json', index:0}
      ]
    },
    variants:[
      {id:'standard', modelUrl:'assets/standard.glb'},
      {id:'light', modelUrl:'assets/light.glb'}
    ]
  };
  const resolve = url => new URL(url, 'https://fixture.invalid/project/').href;
  const result = resolveDownloadAsset(item, item.variants[1], resolve);
  assert.equal(result.activeVersionId, 'light');
  assert.deepEqual(result.versions[0].textures, [
    {id:'wood', label:'Wood', url:'https://fixture.invalid/project/assets/wood.png', materialIndex:0, mimeType:'image/png'}
  ]);
  assert.deepEqual(result.versions[0].motions.map(motion => motion.id), ['turn']);
  assert.deepEqual(result.versions[1].textures, []);
  assert.deepEqual(result.versions[1].motions, []);
});
