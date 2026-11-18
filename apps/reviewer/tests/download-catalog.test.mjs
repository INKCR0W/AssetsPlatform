import test from 'node:test';
import assert from 'node:assert/strict';
import {appendModelVariants, galleryModel, isLibraryModel, resolveDownloadAsset} from '../shared/download-catalog.mjs';

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
    {id:'wood', label:'Wood', url:'https://fixture.invalid/project/assets/wood.png', materialIndex:0, mimeType:'image/png',
      sourceUrl:'https://fixture.invalid/project/assets/wood.png', sourceMimeType:'image/png'}
  ]);
  assert.deepEqual(result.versions[0].motions.map(motion => motion.id), ['turn']);
  assert.deepEqual(result.versions[1].textures, []);
  assert.deepEqual(result.versions[1].motions, []);
});

test('resolves original model, material, and motion files separately from their previews', () => {
  const item = {
    id:'helmet', name:'Helmet', modelUrl:'assets/helmet-preview.glb', sourceModelUrl:'assets/helmet.glb',
    sourceModelSha256:'b'.repeat(64),
    downloadOptions:{
      textures:[
        {id:'leather', url:'assets/leather-preview.jpg', sourceTextureUrl:'assets/leather.png', materialIndex:4},
        {id:'metal', url:'assets/metal.png', materialIndex:3},
        {id:'invalid', url:'assets/metal.png', sourceTextureUrl:'assets/metadata.json', materialIndex:3}
      ],
      motions:[
        {id:'turn', url:'assets/turn-preview.glb', sourceMotionUrl:'assets/turn.glb', index:0},
        {id:'idle', url:'assets/idle.glb', index:1},
        {id:'invalid', url:'assets/metadata.glb', sourceMotionUrl:'assets/metadata.json', index:0}
      ]
    },
    variants:[
      {id:'same', modelUrl:'assets/helmet-preview.glb'},
      {id:'different', modelUrl:'assets/helmet-preview.glb', sourceModelUrl:'assets/helmet-v2.glb'}
    ]
  };
  const resolve = url => new URL(url, 'https://fixture.invalid/project/').pathname;
  const [same,different] = resolveDownloadAsset(item, null, resolve).versions;
  assert.equal(same.url, '/project/assets/helmet-preview.glb');
  assert.equal(same.sourceUrl, '/project/assets/helmet.glb');
  assert.equal(same.sourceSha256, item.sourceModelSha256);
  assert.deepEqual(same.textures.map(({id,sourceUrl,sourceMimeType}) => [id,sourceUrl,sourceMimeType]), [
    ['leather','/project/assets/leather.png','image/png'],
    ['metal','/project/assets/metal.png','image/png']
  ]);
  assert.deepEqual(same.motions, [
    {id:'turn', label:'turn', url:'/project/assets/turn-preview.glb', sourceUrl:'/project/assets/turn.glb', index:0},
    {id:'idle', label:'idle', url:'/project/assets/idle.glb', index:1}
  ]);
  assert.equal(different.sourceUrl, '/project/assets/helmet-v2.glb');
  assert.equal(different.sourceSha256, undefined);
  assert.deepEqual(different.textures, []);
  assert.deepEqual(different.motions, []);
});

test('an appended version sharing model bytes keeps the implicit base and its options', () => {
  const item = {
    id:'cube', name:'Cube', modelUrl:'assets/cube.glb', sourceModelSha256:'a'.repeat(64),
    downloadOptions:{textures:[{id:'base-wood',url:'assets/wood.png',materialIndex:0}]}
  };
  const before = resolveDownloadAsset(item);
  const added = {
    id:'ingested-version-distinct',label:'New',modelUrl:item.modelUrl,
    downloadOptions:{motions:[{id:'spin',url:'assets/spin.glb',index:0}]}
  };
  const versions = appendModelVariants(item,[added]);
  const after = resolveDownloadAsset({...item,variants:versions},added);
  assert.equal(after.id,before.id);
  assert.equal(after.activeVersionId,added.id);
  assert.deepEqual(after.versions[0],before.versions[0]);
  assert.deepEqual(after.versions[1].textures,[]);
  assert.deepEqual(after.versions[1].motions.map(clip => clip.id),['spin']);
});
