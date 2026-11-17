import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {inspectModel, makeZip, prepareModel} from '../shared/asset-package.mjs';
import {createSourceAnimation, parseGLB} from '../viewer.mjs';

const source = readFileSync(new URL('../demo-a/assets/cube.glb',import.meta.url));
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=','base64'));

function unpack(bytes) {
  const data = Buffer.from(bytes);
  const length = data.readUInt32LE(12);
  return {doc:JSON.parse(data.subarray(20,20+length)), bin:data.subarray(28+length)};
}

function fixture(change = () => {}) {
  const {doc, bin} = unpack(source);
  let binary = bin;
  function add(values,type,count,componentType = 5126) {
    const float = componentType === 5126;
    const bytes = Buffer.alloc(values.length * (float ? 4 : 2));
    values.forEach((value,index) => {
      if (float) bytes.writeFloatLE(value,index * 4);
      else bytes.writeUInt16LE(value,index * 2);
    });
    const bufferView = doc.bufferViews.push({buffer:0,byteOffset:binary.length,byteLength:bytes.length}) - 1;
    binary = Buffer.concat([binary,bytes,Buffer.alloc((-bytes.length & 3))]);
    return doc.accessors.push({bufferView,type,count,componentType}) - 1;
  }
  doc.meshes[0].primitives[0].attributes.TEXCOORD_0 = add(Array(16).fill(0),'VEC2',8);
  const input = add([0,1],'SCALAR',2);
  Object.assign(doc.accessors[input],{min:[0],max:[1]});
  const output = add([0,0,0,0,1,0],'VEC3',2);
  const cubic = add([0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0],'VEC3',6);
  doc.animations = [['Lift',output,'LINEAR'],['Slide',cubic,'CUBICSPLINE']].map(([name,output,interpolation]) => ({
    name,samplers:[{input,output,interpolation}],channels:[{sampler:0,target:{node:0,path:'translation'}}]
  }));
  doc.materials[0].name = '原始材质';
  change(doc,add);
  doc.buffers[0].byteLength = binary.length;
  const json = Buffer.from(JSON.stringify(doc));
  const padded = Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67,0);
  header.writeUInt32LE(2,4);
  header.writeUInt32LE(28+padded.length+binary.length,8);
  header.writeUInt32LE(padded.length,12);
  header.writeUInt32LE(0x4e4f534a,16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length,0);
  binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,padded,binHeader,binary]);
}

test('preserves the default GLB animations and uses the baked animation curves for browser preview', () => {
  const original = fixture();
  const inspection = inspectModel(original);
  assert.deepEqual(inspection,{materials:[{index:0,label:'原始材质'}],clips:[{index:0,label:'Lift'},{index:1,label:'Slide'}]});
  const {bytes,animationData,warnings} = prepareModel(original);
  assert.deepEqual(warnings,[]);
  assert.deepEqual(unpack(bytes).doc.animations,unpack(original).doc.animations);
  const runtime = createSourceAnimation(parseGLB(bytes),animationData);
  assert.deepEqual(runtime.clips.map(clip => clip.name),['Lift','Slide']);
  runtime.sample('clip-1',.5);
  assert.equal(runtime.getNodeWorldMatrices().get(0)[12],1);
});

test('accepts an unknown GLB chunk after BIN and preserves it when a configuration is baked', () => {
  const extension = Buffer.from([4,0,0,0,69,88,84,0,1,2,3,4]);
  const original = Buffer.concat([fixture(),extension]);
  original.writeUInt32LE(original.length,8);
  assert.equal(inspectModel(original).clips.length,2);
  assert.deepEqual(Buffer.from(prepareModel(original).bytes).subarray(-extension.length),extension);

  const rebuilt = Buffer.from(prepareModel(original,{clips:[1]}).bytes);
  assert.deepEqual(rebuilt.subarray(-extension.length),extension);
  assert.deepEqual(inspectModel(rebuilt).clips,[{index:0,label:'Slide'}]);

  const truncated = original.subarray(0,-1);
  truncated.writeUInt32LE(truncated.length,8);
  assert.throws(() => inspectModel(truncated),/扩展区块/);
});

test('binds only the chosen material and selected clips in the exported GLB', () => {
  const original = fixture(doc => {
    doc.images = [{uri:'data:image/png;base64,'+Buffer.from(png).toString('base64')}];
    doc.samplers = [{wrapS:33071}];
    doc.textures = [{source:0,sampler:0}];
    doc.extensionsUsed = ['KHR_texture_transform'];
    doc.materials[0].pbrMetallicRoughness.baseColorTexture = {index:0,extensions:{KHR_texture_transform:{offset:[.25,0]}}};
    doc.materials[1] = structuredClone(doc.materials[0]);
  });
  const prepared = prepareModel(original,{texture:{bytes:png,mimeType:'image/png',materialIndex:0},clips:[1]});
  const {doc,bin} = unpack(prepared.bytes);
  assert.deepEqual(doc.materials[1],unpack(original).doc.materials[1]);
  assert.deepEqual(doc.materials[0].pbrMetallicRoughness.baseColorFactor,[.35,.65,.42,1]);
  const info = doc.materials[0].pbrMetallicRoughness.baseColorTexture;
  assert.deepEqual(info.extensions,{KHR_texture_transform:{offset:[.25,0]}});
  assert.equal(doc.textures[info.index].sampler,0);
  const view = doc.bufferViews[doc.images[doc.textures[info.index].source].bufferView];
  assert.deepEqual(new Uint8Array(bin.subarray(view.byteOffset, view.byteOffset+view.byteLength)),png);
  assert.deepEqual(doc.animations.map(clip => clip.name),['Slide']);
  assert.deepEqual(prepared.animationData.clips.map(clip => clip.name),['Slide']);

  assert.throws(() => prepareModel(source,{texture:{bytes:png,mimeType:'image/png',materialIndex:0}}),/UV0/);
  assert.throws(() => prepareModel(original,{clips:[1,1]}),/动画选择无效/);
});

test('replaces two material slots independently and rejects duplicate slot assignments', () => {
  const original = fixture(doc => {
    doc.materials.push({...doc.materials[0],name:'第二材质'}, {...doc.materials[0],name:'保留材质'});
    const primitives = doc.meshes[0].primitives;
    primitives.push({...primitives[0],material:1}, {...primitives[0],material:2});
  });
  const textures = [0,1].map(materialIndex => ({bytes:png,mimeType:'image/png',materialIndex}));
  const {doc,bin} = unpack(prepareModel(original,{textures}).bytes);
  const baseTextures = doc.materials.map(material => material.pbrMetallicRoughness.baseColorTexture?.index);
  assert.deepEqual(baseTextures,[0,1,undefined]);
  for (const index of baseTextures.slice(0,2)) {
    const image = doc.images[doc.textures[index].source];
    const {byteOffset,byteLength} = doc.bufferViews[image.bufferView];
    assert.deepEqual(new Uint8Array(bin.subarray(byteOffset,byteOffset+byteLength)),png);
  }
  assert.throws(() => prepareModel(original,{textures:[textures[0],textures[0]]}),/贴图材质槽重复/);
});

test('export assembles original-size image references beyond the CPU preview aggregate pixel cap', () => {
  const big = Buffer.from(png);
  big.writeUInt32BE(4096,16);
  big.writeUInt32BE(4096,20);
  const original = fixture(doc => {
    doc.images = Array.from({length:3}, () => ({uri:'data:image/png;base64,'+big.toString('base64')}));
  });
  assert.throws(() => prepareModel(original,{clips:[1]}),/aggregate image pixels/);
  const result = prepareModel(original,{clips:[1],validatePreview:false});
  const {doc} = unpack(result.bytes);
  assert.deepEqual(doc.images,unpack(original).doc.images);
  assert.deepEqual(doc.animations.map(clip => clip.name),['Slide']);
  assert.equal(result.defaultClipName,'Slide');
  assert.equal(result.animationData,null);
});

test('copies compatible standalone curves but rejects a changed node identity or rest transform', () => {
  const target = fixture();
  const external = fixture(doc => { doc.animations[0].name = 'External lift'; });
  const output = prepareModel(target,{clips:[],extraClips:[{bytes:external,index:0}]});
  assert.deepEqual(unpack(output.bytes).doc.animations.map(clip=>clip.name),['External lift']);
  const runtime = createSourceAnimation(parseGLB(output.bytes),output.animationData);
  runtime.sample('clip-0',.5);
  assert.equal(runtime.getNodeWorldMatrices().get(0)[13],.5);
  const mismatched = fixture(doc => { doc.nodes[0].translation = [0,0,1]; });
  assert.throws(() => prepareModel(target,{extraClips:[{bytes:mismatched,index:0}]}),/绑定不同/);
});

test('maps renamed node indices through static helpers while checking the animation frame', () => {
  const target = fixture();
  const externalFixture = (adjust = () => {}) => fixture(doc => {
    const animated = doc.nodes[0];
    doc.nodes = [{name:'Helper A',children:[1]}, {children:[3]}, {name:'Unrelated',translation:[2,0,0]}, animated];
    doc.scenes[0].nodes = [0,2];
    for (const clip of doc.animations) clip.channels[0].target.node = 3;
    adjust(doc);
  });
  const output = prepareModel(target,{clips:[],extraClips:[{bytes:externalFixture(),index:0}]});
  assert.equal(unpack(output.bytes).doc.animations[0].channels[0].target.node,0);
  const runtime = createSourceAnimation(parseGLB(output.bytes),output.animationData);
  runtime.sample('clip-0',.5);
  assert.equal(runtime.getNodeWorldMatrices().get(0)[13],.5);
  for (const bytes of [
    externalFixture(doc => { doc.nodes[1].translation = [0,1,0]; }),
    externalFixture(doc => { doc.nodes[2].name = doc.nodes[3].name; })
  ]) {
    assert.throws(() => prepareModel(target,{extraClips:[{bytes,index:0}]}),/绑定不同/);
  }
});

test('matches a reordered skin palette by joint name and rejects a changed inverse bind matrix', () => {
  const skinned = ({reorder = false, changeBind = false} = {}) => fixture((doc,add) => {
    const meshNode = doc.nodes[0];
    meshNode.skin = 0;
    const jointA = {name:'Joint A', children:[2]};
    const jointB = {name:'Joint B'};
    doc.nodes.push(jointA,jointB);
    doc.scenes[0].nodes.push(1);
    const attributes = doc.meshes[0].primitives[0].attributes;
    const count = doc.accessors[attributes.POSITION].count;
    attributes.JOINTS_0 = add(Array(count * 4).fill(0),'VEC4',count,5123);
    attributes.WEIGHTS_0 = add(Array.from({length:count * 4}, (_,index) => index % 4 === 0 ? 1 : 0),'VEC4',count);
    const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
    const inverseForA = identity.slice();
    if (changeBind) inverseForA[12] = .2;
    const inverseForB = identity.slice();
    inverseForB[13] = .3;
    const joints = reorder ? [2,1] : [1,2];
    const matrices = reorder ? [...inverseForB,...inverseForA] : [...inverseForA,...inverseForB];
    doc.skins = [{joints,skeleton:1,inverseBindMatrices:add(matrices,'MAT4',2)}];
    for (const clip of doc.animations) clip.channels[0].target.node = 1;
  });
  const target = skinned();
  const output = prepareModel(target,{clips:[],extraClips:[{bytes:skinned({reorder:true}),index:0}]});
  assert.deepEqual(unpack(output.bytes).doc.skins[0].joints,[1,2]);
  assert.equal(unpack(output.bytes).doc.animations[0].channels[0].target.node,1);
  assert.throws(() => prepareModel(target,{extraClips:[{bytes:skinned({changeBind:true}),index:0}]}),/绑定不同/);
});

test('exports distinct clip names and identifies the first clip when native and external names collide', () => {
  const target = fixture(doc => { doc.animations[0].name = 'Idle'; });
  const external = fixture(doc => { doc.animations[0].name = 'Idle'; });
  const output = prepareModel(target,{clips:[0],extraClips:[{bytes:external,index:0}]});
  assert.deepEqual(unpack(output.bytes).doc.animations.map(clip => clip.name),['Idle','Idle (2)']);
  assert.equal(output.defaultClipName,'Idle');
  assert.deepEqual(output.animationData.clips.map(clip => clip.name),['Idle','Idle']);
});

test('keeps native animations that lack browser preview support and states that limitation', () => {
  const native = fixture(doc => { doc.animations[1].extensions = {EXT_test:{}}; });
  const output = prepareModel(native);
  assert.deepEqual(unpack(output.bytes).doc.animations,unpack(native).doc.animations);
  assert.deepEqual(output.animationData.clips.map(clip => clip.name),['Lift']);
  assert.match(output.warnings[0], /Slide.+当前浏览器无法预览/);
});

test('writes UTF-8 ZIP entries with valid CRC and rejects aliased paths', () => {
  const data = new TextEncoder().encode('123456789');
  const name = '木箱/模型.glb';
  const zip = Buffer.from(makeZip([{name,data}]));
  assert.equal(zip.readUInt32LE(0),0x04034b50);
  assert.equal(zip.readUInt32LE(14),0xcbf43926);
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30,30+nameLength).toString(),name);
  assert.deepEqual(new Uint8Array(zip.subarray(30+nameLength,30+nameLength+data.length)),data);
  assert.throws(() => makeZip([{name:'../model.glb',data}]),/路径/);
  assert.throws(() => makeZip([{name:'case/FILE.glb',data},{name:'CASE/file.glb',data}]),/重复/);
  assert.throws(() => makeZip([{name:'base',data},{name:'BASE/file.glb',data}]),/冲突/);
});
