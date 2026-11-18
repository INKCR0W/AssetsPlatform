import assert from 'node:assert/strict';
import test from 'node:test';
import {suggestIngestBindings} from '../apps/reviewer/ingest-suggestions.mjs';

const slots = [
  {index:0,label:'Wood'},
  {index:1,label:'Metal Frame'}
];
function model(fileId,name,relativePath,materials = slots) {
  return {fileId,name,relativePath,kindHint:'model',materials};
}
function texture(fileId,name,relativePath) {
  return {fileId,name,relativePath,kindHint:'texture'};
}
function version(id,modelFileId,name = 'Crate',label = 'Default') {
  return {id,modelFileId,name,label};
}
function binding(id,fileId,assigned = {}) {
  return {id,fileId,kind:'texture',versionId:'',...assigned};
}
function suggestions(versions,bindings,files) {
  return suggestIngestBindings({versions,bindings},files);
}

test('folder scoping distinguishes same basenames and uses actual material slot hints', () => {
  const versions = [version('standard','standard','Crate','Standard'),version('lite','lite','Crate','Lite')];
  const files = [
    model('standard','crate.glb','Warehouse/Crate/Standard/Models/crate.glb'),
    model('lite','crate.glb','Warehouse/Crate/Lite/Models/crate.glb'),
    texture('frame','MetalFrame_BaseColor.png','Warehouse/Crate/Lite/Textures/MetalFrame_BaseColor.png'),
    texture('wood','BaseColor.jpg','Warehouse/Crate/Standard/Materials/Wood/BaseColor.jpg')
  ];
  const result = suggestions(versions,[binding('frame','frame'),binding('wood','wood')],files);
  assert.deepEqual(result.map(({status,fields}) => [status,fields]),[
    ['certain',{versionId:'lite',materialIndex:1}],
    ['certain',{versionId:'standard',materialIndex:0}]
  ]);
});

test('an explicit version in a filename beats a shared model name but conflicting paths need review', () => {
  const versions = [version('standard','standard','Crate','Standard'),version('lite','lite','Crate','Lite')];
  const files = [
    model('standard','crate_standard.glb','Warehouse/Crate/Standard/Models/crate_standard.glb'),
    model('lite','crate_lite.glb','Warehouse/Crate/Lite/Models/crate_lite.glb'),
    texture('exact','CrateLite_Wood_Albedo.png'),
    texture('conflict','CrateLite_Wood_Albedo.png','Warehouse/Crate/Standard/Textures/CrateLite_Wood_Albedo.png')
  ];
  const [exact,conflict] = suggestions(versions,[binding('explicit','exact'),binding('fuzzy','conflict')],files);
  assert.deepEqual(exact.fields,{versionId:'lite',materialIndex:0});
  assert.equal(conflict.status,'review');
  assert.deepEqual(conflict.fields,{});
  assert.deepEqual(conflict.candidates,[{versionId:'lite',materialIndex:0},{versionId:'standard',materialIndex:0}]);
});

test('a strong version can fill independently from tied or absent slot evidence', () => {
  const versions = [version('crate','crate'),version('lamp','lamp','Lamp')];
  const assigned = [binding('tied','tied'),binding('unknown','unknown'),binding('unmatched','unmatched')];
  const files = [
    model('crate','crate.glb',undefined,[{index:0,label:'Wood'},{index:2,label:'Wood'}]),
    model('lamp','lamp.glb',undefined,[{index:1,label:'Glass'}]),
    texture('tied','crate_wood_albedo.png'),
    texture('unknown','crate_color.png'),
    texture('unmatched','texture.png','Shared/Textures/texture.png')
  ];
  const [tied,unknown,unmatched] = suggestions(versions,assigned,files);
  assert.deepEqual(tied,{bindingId:'tied',status:'review',fields:{versionId:'crate'},
    candidates:[{versionId:'crate',materialIndex:0},{versionId:'crate',materialIndex:2}]});
  assert.equal(unknown.status,'review');
  assert.deepEqual(unknown.fields,{versionId:'crate'});
  assert.deepEqual(unmatched,{bindingId:'unmatched',status:'unmatched',fields:{},candidates:[]});
});

test('a sole version does not claim attachments from a different informative folder', () => {
  const versions = [version('crate','crate')];
  const files = [
    model('crate','crate.glb','Pack/Crate/Models/crate.glb'),
    texture('light','Wood_Albedo.png','Pack/Lamp/Textures/Wood_Albedo.png'),
    texture('isolated','Wood_Albedo.png')
  ];
  const [light,isolated] = suggestions(versions,[binding('other','light'),binding('plain','isolated')],files);
  assert.equal(light.status,'unmatched');
  assert.deepEqual(light.fields,{});
  assert.deepEqual(isolated.fields,{versionId:'crate',materialIndex:0});
});

test('explicit assignments and zero-based indices are never overwritten', () => {
  const versions = [version('crate','crate'),version('lamp','lamp','Lamp')];
  const files = [
    model('crate','crate.glb'),
    model('lamp','lamp.glb',undefined,[{index:0,label:'Glass'},{index:1,label:'Metal Frame'}]),
    texture('side','crate_metal_frame.png'),
    texture('zero','crate_wood.png')
  ];
  const result = suggestions(versions,[
    binding('full','side',{versionId:'crate',materialIndex:0}),
    binding('explicit','side',{versionId:'lamp'}),
    binding('zero','zero',{materialIndex:0})
  ],files);
  assert.deepEqual(result.map(({bindingId,fields}) => [bindingId,fields]),[
    ['explicit',{materialIndex:1}],['zero',{versionId:'crate'}]
  ]);
});

test('recognizes Chinese names and does not read a material name from the model identifier alone', () => {
  const versions = [version('zh','zh','木制运输箱','标准版'),version('lite','lite','木制运输箱','轻量版'),
    version('jacket','jacket','Leather Jacket')];
  const files = [
    model('zh','木制运输箱_标准版.glb',undefined,[{index:0,label:'木板'},{index:1,label:'护角'}]),
    model('lite','木制运输箱_轻量版.glb',undefined,[{index:0,label:'木板'},{index:1,label:'护角'}]),
    model('jacket','leather_jacket.glb',undefined,[{index:0,label:'Leather'},{index:1,label:'Zip'}]),
    texture('board','木制运输箱标准木板底色.png'),
    texture('coat','leather_jacket_basecolor.png')
  ];
  const [board,coat] = suggestions(versions,[binding('board','board'),binding('coat','coat')],files);
  assert.deepEqual(board.fields,{versionId:'zh',materialIndex:0});
  assert.equal(coat.status,'review');
  assert.deepEqual(coat.fields,{versionId:'jacket'});
});

test('other PBR channels are held for review instead of becoming base color', () => {
  const versions = [version('crate','crate')];
  const files = [
    model('crate','crate.glb',undefined,[{index:0,label:'Wood'}]),
    texture('normal','crate_wood_NormalDX.png'),
    texture('ao','AO.png','Crate/Textures/AO/AO.png'),
    texture('coat','crate_wood_mask_albedo.png')
  ];
  const [normal,ao,coat] = suggestions(versions,[
    binding('normal','normal'),binding('ao','ao'),binding('coat','coat')
  ],files);
  assert.deepEqual(normal,{bindingId:'normal',status:'review',fields:{versionId:'crate'},
    candidates:[{versionId:'crate'}],reason:'texture-channel'});
  assert.equal(ao.reason,'texture-channel');
  assert.equal(Object.hasOwn(ao.fields,'materialIndex'),false);
  assert.deepEqual(coat.fields,{versionId:'crate',materialIndex:0});
});

test('anim files suggest named clips, leave ambiguous clips for review, and never use invalid models', () => {
  const versions = [version('crate','crate'),version('broken','broken','Broken')];
  const clips = [{index:0,label:'Idle'},{index:1,label:'Run'}];
  const animation = (fileId,name) => ({fileId,name,kindHint:'animation',clips});
  const files = [
    model('crate','crate.glb'),
    {...model('broken','broken.glb'),error:'invalid'},
    animation('match','crate_run.glb'),
    animation('tie','crate_idle_run.glb'),
    animation('missing','broken.glb')
  ];
  const [match,tie,missing] = suggestions(versions,[
    {id:'match',fileId:'match',kind:'animation'},
    {id:'tie',fileId:'tie',kind:'animation'},
    {id:'missing',fileId:'missing',kind:'animation'}
  ],files);
  assert.deepEqual(match.fields,{versionId:'crate',clipIndex:1});
  assert.equal(tie.status,'review');
  assert.deepEqual(tie.candidates,[{versionId:'crate',clipIndex:0},{versionId:'crate',clipIndex:1}]);
  assert.equal(missing.status,'unmatched');
  assert.deepEqual(missing.fields,{});
});
