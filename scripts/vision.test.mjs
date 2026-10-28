import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-vision-test-'));
const bundle = join(temp, 'editor.cjs');
await build({ stdin: { contents: `export * from './src/defaults'; export * from './src/store'; export * from './src/actions'; export * from './src/vision'; export * from './src/memory'; export * from './src/sync'; export * from './src/schema.js';`, resolveDir: root }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v), removeItem: k => m.delete(k) }; };
globalThis.localStorage = storage(); globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost', href: 'http://localhost/' };
const handlers = new Map(), broadcasts = [], windows = [];
globalThis.window = { setTimeout: () => 0, setInterval: () => 0, addEventListener: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name,list); }, removeEventListener: () => {}, open: url => { const win = { url, closed: false, messages: [], postMessage(m) { this.messages.push(m); } }; windows.push(win); return win; } };
globalThis.BroadcastChannel = class { postMessage(m) { broadcasts.push(m); } addEventListener() {} removeEventListener() {} };
const api = createRequire(import.meta.url)(bundle);
after(() => rm(temp, { recursive: true, force: true }));
function fixture(auto = false) {
  const w = api.emptyWorld(); w.visionMode = 'individual';
  w.party = ['a','b','c'].map(id => ({ id, name: id.toUpperCase(), tags: [], color: '#fff' }));
  const m = api.newMap('测试', '现实', 0, 12, 6, 'floor', false); m.autoFog = auto;
  w.maps = [m]; w.playerMapId = m.id;
  return { w, m };
}
function install(w) { api.replaceWorld(w); api.setUI({ mode: 'run', trial: null, mapId: w.maps[0].id }); }
const map = () => api.getWorld().maps[0];
const layer = id => map().views[id];
const fog = (id, x, kind = 'fogReveal', y = 1) => api.paintFog(map().id, [[x,y]], kind, [id]);
function freeze(id, x, y = 1) { fog(id,x,'fogHide',y); }
function object(m, x, id = 'box') { const o = { ...api.newObject('object',x,1,1,1), id, name: `秘密-${id}`, height: 0 }; m.objects.push(o); return o; }

test('three modes share current and historical knowledge only with effective members, including members on another map', () => {
  const { w,m } = fixture(true); w.visionMode = 'grouped'; w.party[2].visionGroupId = null;
  for (let y=0;y<m.height;y++) m.cells[y*m.width+5] = 'wall';
  m.tokens = [{ id:'a-eye',pcId:'a',name:'a',color:'#fff',x:1,y:1 },{ id:'c-eye',pcId:'c',name:'c',color:'#fff',x:9,y:1 }];
  install(w);
  assert.equal(layer('a').fog[21],0); assert.equal(layer('b').fog[13],1); assert.equal(layer('b').fog[21],0); assert.equal(layer('c').fog[21],1);
  assert.notEqual(layer('a').fog,layer('b').fog); assert.notEqual(layer('a').seen,layer('b').seen);
  api.update(d => { d.maps[0].tokens = d.maps[0].tokens.filter(t=>t.pcId!=='a'); });
  assert.equal(layer('b').fog[13],2);
  api.setVisionMode('individual');
  api.update(d => { d.maps[0].tokens.push({id:'b-eye',pcId:'b',name:'b',color:'#fff',x:2,y:2}); });
  assert.equal(layer('a').fog[26],2); assert.equal(layer('b').fog[26],1);
  api.setVisionMode('shared'); assert.equal(map().fog[21],1);
  api.setVisionMode('individual'); assert.equal(layer('a').fog[21],2);
  api.update(d => {d.party.push({id:'new',name:'new',color:'#fff',tags:[]});});
  assert.ok(layer('new').fog.every(f=>f===0));
  api.setVisionMode('grouped'); assert.equal(layer('new').fog[26],1);
});

test('merge respects newer terrain and object sightings; observing an empty old position cannot erase a newer position', () => {
  const {w,m}=fixture(); object(m,1); install(w);
  fog('a',1); freeze('a',1);
  api.update(d=>{d.maps[0].objects[0].x=8;d.maps[0].cells[13]='grass';});
  fog('b',8); freeze('b',8);
  fog('a',1); freeze('a',1); // newest empty evidence at OLD position
  api.setVisionMode('grouped');
  assert.equal(layer('a').seen.objects.find(o=>o.id==='box').x,8);
  assert.equal(layer('a').seen.cells[13],'grass');
  api.setVisionMode('individual');
  api.update(d=>{d.maps[0].objects=[];});
  fog('c',8); freeze('c',8); // C never saw box, but knows its location is empty
  api.setVisionMode('grouped');
  assert.equal(layer('a').seen.objects.length,0);
  api.setVisionMode('individual'); api.setVisionMode('grouped');
  assert.equal(layer('b').seen.objects.length,0);
});

test('demolished architecture and changed subcell terrain do not resurrect from older groups or reload', () => {
  const {w,m}=fixture(); m.subdivisions=[13];
  m.objects.push({...api.newObject('object',1,1,1,1),id:'wall',name:'wall',geometry:{kind:'wall',a:{x:3,y:3},b:{x:6,y:3},thickness:100,material:'wall'}});
  install(w); fog('a',1); freeze('a',1); assert.ok(layer('a').seen.architecture.length);
  api.update(d=>{d.maps[0].objects=[];d.maps[0].cells[13]='grass';});
  fog('b',1); freeze('b',1);
  api.setVisionMode('grouped');
  assert.deepEqual(layer('a').seen.architecture,[]);
  assert.equal(layer('a').seen.subCells[3*36+3],'grass');
  const saved=JSON.parse(JSON.stringify(api.getWorld())); api.checkWorld(saved,true); install(saved);
  api.setVisionMode('individual'); api.setVisionMode('grouped'); assert.deepEqual(layer('a').seen.architecture,[]);
});

test('map gifts target an effective group and do not falsely testify that furniture disappeared', () => {
  const {w,m}=fixture(); object(m,1); install(w); fog('a',1); freeze('a',1);
  api.giveMapKnowledge(m.id,['b']); assert.equal(layer('c').fog[13],0); assert.equal(layer('b').seen.objects.length,0);
  api.setVisionMode('grouped'); assert.equal(layer('a').seen.objects.length,1);
  fog('a',1,'fogBlack'); assert.equal(layer('b').fog[13],0); assert.equal(layer('a').seen.objects.length,0);
  api.setVisionGroup('c',null); api.giveMapKnowledge(m.id,['a']); assert.equal(layer('c').fog[0],2); // retains earlier shared knowledge
  api.update(d=>{d.party.push({id:'fresh',name:'fresh',tags:[],color:'#fff',visionGroupId:null});});
  api.giveMapKnowledge(m.id,['a']); assert.equal(layer('fresh').fog[0],0);
});

test('group removal, deleted PCs, undo, resize, copy and save preserve only valid knowledge', () => {
  const {w,m}=fixture();w.visionGroups=[{id:'solo',name:'单线'}];w.party[2].visionGroupId='solo'; install(w);
  fog('a',1);freeze('a',1);api.setVisionMode('grouped');
  api.deleteVisionGroup('solo');assert.equal(api.getWorld().party[2].visionGroupId,null);
  api.undo();assert.equal(api.getWorld().party[2].visionGroupId,'solo');api.redo();
  api.reshapeMaps([m.id],1,1,0,0);assert.equal(layer('a').seen.cells[2*13+2],'floor');
  assert.ok(layer('a').seen.observed[(6)*39+6]>0);
  api.duplicateMap(m.id); assert.ok(api.getWorld().maps[1].fog.every(f=>f===0));assert.equal(api.getWorld().maps[1].seen.objects.length,0);
  api.update(d=>{d.party=d.party.filter(p=>p.id!=='b');});assert.equal(map().views.b,undefined);
  const saved=JSON.parse(JSON.stringify(api.getWorld()));api.checkWorld(saved,true);install(saved);assert.equal(map().views.b,undefined);
});

test('old save without revisions merges deterministically without consulting hidden current state', () => {
  const {w,m}=fixture();
  for (const [id,terrain] of [['a','floor'],['b','grass']]) {m.views[id]=api.emptyVision(72);m.views[id].fog[13]=2;m.views[id].seen.cells[13]=terrain;}
  m.cells[13]='wall';install(w);api.setVisionMode('grouped');const known=layer('a').seen.cells[13];assert.notEqual(known,'wall');
  api.setVisionMode('individual');api.setVisionMode('grouped');assert.equal(layer('a').seen.cells[13],known);
  assert.ok(api.effectiveLayer(api.getWorld(),map(),'missing').fog.every(f=>!f));
});

test('auto discovery records recipient IDs at discovery time and private clues never spread with group changes', () => {
  const {w,m}=fixture();const o=object(m,1);o.secrets=[{id:'auto',label:'发现',check:'观察',kind:'auto',range:1,tiers:{crit:'c',success:'发现内容',fail:'f',fumble:'x'}},{id:'private',label:'私密',check:'观察',kind:'roll',range:1,tiers:{crit:'c',success:'仅A',fail:'f',fumble:'x'},revealed:{scope:'private',to:'A',recipients:['a'],tier:'success',at:1}}];
  m.tokens=[{id:'eye',pcId:'a',name:'A',color:'#fff',x:1,y:1}];install(w);api.autoReveal(m.id);
  assert.ok(api.playerWorld(api.getWorld(),m.id,'a').clues.some(c=>c.id==='auto'));
  assert.equal(api.playerWorld(api.getWorld(),m.id,'b').clues.length,0);
  api.setVisionMode('grouped');assert.equal(api.playerWorld(api.getWorld(),m.id,'b').clues.length,0);
  api.autoReveal(m.id);assert.deepEqual(api.playerWorld(api.getWorld(),m.id,'b').clues.map(c=>c.id),['auto']);
  api.setVisionGroup('c',null);api.update(d=>{d.maps[0].tokens.push({id:'c-eye',pcId:'c',name:'C',color:'#fff',x:1,y:2});});api.autoReveal(m.id);
  assert.deepEqual(api.playerWorld(api.getWorld(),m.id,'c').clues.map(c=>c.id),['auto']);
});

test('targeted payload omits other group terrain, geometry, tokens, numbers, memory, NPCs, clues and mark audiences', () => {
  const {w,m}=fixture();object(m,1,'left');object(m,9,'right');
  m.tokens=[{id:'ta',pcId:'a',name:'A',color:'#fff',x:1,y:1},{id:'tc',pcId:'c',name:'C',color:'#fff',x:9,y:1},{id:'npc',pcId:null,name:'秘密NPC',color:'#fff',x:9,y:1}];
  w.marks=[{id:'mark',mapId:m.id,x:9,y:1,author:'c',symbol:'!',text:'秘密标记',createdAt:Date.now(),life:20}];
  for(let y=0;y<m.height;y++)m.cells[y*12+5]='wall';install(w);fog('a',1);fog('c',9);
  api.update(d=>{d.maps[0].cells[21]='grass';});
  const a=api.playerWorld(api.getWorld(),m.id,'a'),c=api.playerWorld(api.getWorld(),m.id,'c');
  assert.equal(a.maps[0].cells[21],'');assert.equal(a.maps[0].seen.cells[21],'');assert.deepEqual(a.maps[0].views,{});
  assert.ok(!JSON.stringify(a).includes('秘密-right'));assert.ok(!JSON.stringify(a).includes('秘密NPC'));assert.ok(!JSON.stringify(a).includes('秘密标记'));
  assert.ok(!a.labels.tc);assert.ok(!a.labels.right);assert.deepEqual(a.party.map(p=>p.id),['a']);assert.equal(a.maps[0].tokens.length,1);
  assert.ok(c.maps[0].objects.some(o=>o.id==='right'));assert.ok(!c.maps[0].objects.some(o=>o.id==='left'));
  assert.deepEqual(api.playerWorld(api.getWorld(),m.id,'missing').maps[0].objects,[]);
});

test('two host-bound windows receive distinct direct payloads; public channel has no world; invalid/replaced bindings clear', async () => {
  const {w,m}=fixture();object(m,1,'left');object(m,9,'right');install(w);fog('a',1);fog('c',9);
  api.openPlayerWindow('a');api.openPlayerWindow('c');api.send({type:'world',world:api.getWorld()});
  const [a,c]=windows;assert.equal(a.messages.at(-1).world.viewerId,'a');assert.equal(c.messages.at(-1).world.viewerId,'c');
  assert.ok(!JSON.stringify(a.messages.at(-1)).includes('秘密-right'));assert.ok(!JSON.stringify(c.messages.at(-1)).includes('秘密-left'));
  assert.equal(broadcasts.some(m=>m.type==='world'),false);
  // A forged hello cannot pick a different PC or adopt another window's binding.
  const off=api.listenAsEditor(()=>api.send({type:'world',world:api.getWorld()}));
  const binding=new URL('http://localhost/'+a.url).searchParams.get('binding');
  for(const fn of handlers.get('message')??[])fn({data:{type:'hello',binding,__ts:'ts-map',seq:'fake',from:'p',inst:'p',born:1},source:c,origin:'http://localhost'});
  assert.equal(c.messages.at(-1).world.viewerId,'c');
  await new Promise(resolve => setTimeout(resolve, 270)); // editor's session-collision quiet window
  api.update(d=>{d.party=d.party.filter(p=>p.id!=='a');});api.send({type:'world',world:api.getWorld()});assert.equal(a.messages.at(-1).type,'clear');
  install(fixture().w);api.send({type:'world',world:api.getWorld()});assert.equal(c.messages.at(-1).type,'clear');
  assert.equal(broadcasts.some(m=>m.type==='world'),false);off();
});


test('cross-map group history and connections use the receiver knowledge; stale deleted views never contribute', () => {
  const {w,m}=fixture();const other=api.newMap('另图','现实',1,8,8,'floor',false);other.autoFog=false;w.maps.push(other);
  w.connections=[{id:'stairs',kind:'stairs',label:'楼梯',hidden:false,a:{mapId:m.id,x:1,y:1},b:{mapId:other.id,x:7,y:7}}];
  m.views.ghost=api.emptyVision(72);m.views.ghost.fog.fill(1);install(w);
  assert.equal(map().views.ghost,undefined);assert.equal(layer('a').fog[0],0);
  fog('a',1);api.paintFog(other.id,[[2,2]],'fogReveal',['b']);api.paintFog(other.id,[[2,2]],'fogHide',['b']);
  assert.equal(api.playerWorld(api.getWorld(),m.id,'a').connections[0].b.mapId,'');
  api.setVisionMode('grouped');const a=api.playerWorld(api.getWorld(),m.id,'a');assert.equal(a.connections[0].b.mapId,other.id);assert.equal(a.connections[0].b.x,0);
  assert.equal(api.getWorld().maps[1].views.a.seen.cells[18],'floor');
});

test('fine payload filters invisible terrain definitions and geometry within one main cell', () => {
  const {w,m}=fixture(true);w.visionMode='grouped';w.party[2].visionGroupId=null;m.subdivisions=Array.from({length:72},(_,i)=>i);
  m.objects.push({...api.newObject('object',5,0,1,6),id:'divider',name:'主持人墙名',geometry:{kind:'wall',a:{x:16,y:0},b:{x:16,y:18},thickness:100,material:'wall'}});
  m.cells[1*12+9]='grass';m.tokens=[{id:'ta',pcId:'a',name:'a',color:'#fff',x:1,y:1},{id:'tc',pcId:'c',name:'c',color:'#fff',x:9,y:1}];install(w);
  const a=api.playerWorld(api.getWorld(),m.id,'a'),c=api.playerWorld(api.getWorld(),m.id,'c');
  assert.equal(a.maps[0].subFog[4*36+17],0);assert.equal(c.maps[0].subFog[4*36+17],1);
  assert.equal(a.maps[0].seen.subCells[4*36+17],undefined);assert.ok(!a.terrains.some(t=>t.id==='grass'));
  assert.ok(!JSON.stringify(a).includes('主持人墙名'));assert.ok(a.maps[0].architectureFragments.every(r=>r.x+r.w<=16/3+1e-8));
});

test('marks cross groups by hearing, and are sent only to actual recipients', () => {
  const {w,m}=fixture();m.tokens=[{id:'ta',pcId:'a',name:'a',color:'#fff',x:1,y:1},{id:'tc',pcId:'c',name:'c',color:'#fff',x:3,y:1}];
  w.marks=[{id:'heard',mapId:m.id,x:3,y:1,author:'c',symbol:'!',text:'听得到',createdAt:Date.now(),life:20}];install(w);
  assert.deepEqual(api.playerWorld(api.getWorld(),m.id,'a').marks[0].audience,['a']);assert.equal(api.playerWorld(api.getWorld(),m.id,'b').marks.length,0);
  api.update(d=>{d.maps[0].cells[14]='wall';});assert.equal(api.playerWorld(api.getWorld(),m.id,'a').marks.length,0);
});

test('host and player refresh reconnect through saved binding and opener; player rejects broadcast worlds', async () => {
  const {w,m}=fixture();object(m,1);install(w);fog('a',1);api.saveNow();api.openPlayerWindow('a');const win=windows.at(-1);
  // Reload the real module graph as the host does; sessionStorage and saved world survive.
  const require=createRequire(import.meta.url);delete require.cache[bundle];const host=require(bundle);
  const off=host.listenAsEditor(()=>host.send({type:'world',world:host.getWorld()}));await new Promise(resolve=>setTimeout(resolve,270));
  const binding=new URL('http://localhost/'+win.url).searchParams.get('binding');
  const hello={type:'hello',binding,__ts:'ts-map',seq:'reload-hello',from:'player',inst:'player',born:1,to:api.SESSION};
  for(const fn of handlers.get('message')??[])fn({data:hello,source:win,origin:'http://localhost'});
  assert.equal(win.messages.at(-1).world.viewerId,'a');
  globalThis.location.href='http://localhost/'+win.url;const opener={postMessage(){},closed:false};globalThis.window.opener=opener;
  const received=[];const playerOff=host.listenAsPlayer(msg=>received.push(msg));
  const payload=win.messages.at(-1);
  for(const fn of handlers.get('message')??[])fn({data:{...payload,seq:'broadcast-world'},source:null,origin:'http://localhost'});
  assert.equal(received.length,0);
  for(const fn of handlers.get('message')??[])fn({data:{...payload,seq:'direct-world'},source:opener,origin:'http://localhost'});
  assert.equal(received.at(-1).world.viewerId,'a');
  assert.equal(broadcasts.some(m=>m.type==='world'||m.binding),false);
  playerOff();off();globalThis.window.opener=null;globalThis.location.href='http://localhost/';
});
