import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMXFMetadata, buildMXFFrameIndex, isEncryptedMXF, parseMCALabels } from '../src/index.js';
const hex = s => Uint8Array.from(s.match(/../g), h => parseInt(h, 16));
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0,n); return b; };
const join = (...parts) => Uint8Array.from(parts.flatMap(p => Array.from(p)));
const klv = (key, value) => join(hex(key), value.length < 128 ? [value.length] : [0x82,value.length>>8,value.length&255], value);
const prop = (tag, value) => join([tag>>8,tag&255,value.length>>8,value.length&255],value);
const rgba = '060e2b34025301010d01010101012900';
const stereo = '060e2b34025301010d01010101016300';
const crypt = '060e2b34025301010d01040102020000';
const picture = '060e2b34010201010d01030115010800';
const descriptor = (n=48,d=1) => klv(rgba,join(prop(0x3203,u32(2048)),prop(0x3202,u32(1080)),prop(0x3001,join(u32(n),u32(d)))));
const file = (...parts) => new File(parts,'synthetic.mxf');
test('stereo rate is an exact edit-unit rational; absent rate stays unproven',async()=>{
 const m=await parseMXFMetadata(file(descriptor(48000,1001),klv(stereo,[])));
 assert.equal(m.stereoscopic,true);
 assert.deepEqual(m.video.editRate,{numerator:24000,denominator:1001});
 assert.equal(m.video.frameRate,24000/1001);
 const missing=await parseMXFMetadata(file(descriptor(0,0)));
 assert.equal(missing.video.editRate,null);
 assert.equal(missing.video.frameRate,24);
});
test('stereo index pairs left and right pictures into edit units',async()=>{
 const f=file(descriptor(),klv(stereo,[]),...Array.from({length:4},()=>klv(picture,[0xff,0x4f,0xff,0x51,0,0,0xff,0xd9])));
 const frames=await buildMXFFrameIndex(f);
 assert.equal(frames.length,2);
 for(const frame of frames){
  assert.equal(frame.size,8); assert.equal(frame.rightEye.size,8);
  assert.ok(frame.rightEye.offset>frame.offset);
  assert.deepEqual(new Uint8Array(await f.slice(frame.offset,frame.offset+2).arrayBuffer()),new Uint8Array([0xff,0x4f]));
 }
});
test('encrypted metadata is exposed and indexing refuses it explicitly',async()=>{
 const f=file(descriptor(),klv(crypt,[]));
 assert.equal(await isEncryptedMXF(f),true);
 assert.equal((await parseMXFMetadata(f)).encrypted,true);
 await assert.rejects(buildMXFFrameIndex(f),{code:'ENCRYPTED_MXF'});
 assert.equal(await isEncryptedMXF(file(descriptor())),false);
});
test('MCA reads arbitrary primer tags and preserves rear-surround slots',()=>{
 const labelTag=0x9001,idTag=0x9002;
 const primer=klv('060e2b34020501010d01020101050100',join(u32(2),u32(18),[labelTag>>8,labelTag&255],hex('060e2b340101010e0103070101000000'),[idTag>>8,idTag&255],hex('060e2b340101010e0103040a00000000')));
 const channel=(slot,label)=>klv('060e2b34025301010d01010101016b00',join(prop(idTag,u32(slot)),prop(labelTag,hex('060e2b340401010d030201'+label+'00000000'))));
 const bytes=join(primer,channel(11,'09'),channel(12,'0a'));
 assert.deepEqual(parseMCALabels(bytes),[{channelIndex:10,label:'Lrs'},{channelIndex:11,label:'Rrs'}]);
 assert.equal(parseMCALabels(channel(11,'09')),null);
});

test('a final small picture element is indexed once, including at a read-window boundary', async () => {
 for (const padding of [0, 4 * 1024 * 1024 - descriptor().length - 20]) {
  const f=file(descriptor(),new Uint8Array(padding),klv(picture,[0xff,0x4f,0xff,0x51,0,0,0xff,0xd9]));
  const frames=await buildMXFFrameIndex(f);
  assert.equal(frames.length,1);
  assert.equal(frames[0].offset,f.size-8);
 }
});
