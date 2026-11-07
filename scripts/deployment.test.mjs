import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const host = 'http://localhost:5178', player = 'http://localhost:5179';
test('split ports pin origins and bindings, keep player role fixed, and reconnect after refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ts-deployment-'));
  try {
    const storage = () => { const m = new Map(); return { getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k) }; };
    globalThis.localStorage=storage();globalThis.sessionStorage=storage();
    globalThis.location={origin:host,href:host+'/',search:''};
    let handlers=[];const broadcasts=[];let opened;
    globalThis.window={setTimeout:()=>0,setInterval:()=>0,addEventListener:(n,f)=>{if(n==='message')handlers.push(f);},removeEventListener:()=>{},open:(url)=>opened={url,closed:false,messages:[],postMessage(data,target){this.messages.push({data,target});}}};
    globalThis.BroadcastChannel=class{postMessage(m){broadcasts.push(m);}addEventListener(){}removeEventListener(){}};
    const bundle = async role => {
      const file=join(dir,role+'.cjs');
      await build({stdin:{contents:`export * from './src/core/deployment';export * from './src/runtime/sync';export * from './src/core/store';export * from './src/core/defaults';`,resolveDir:root},outfile:file,bundle:true,platform:'node',format:'cjs',logLevel:'silent',define:{'import.meta.env':JSON.stringify({VITE_APP_ROLE:role,VITE_HOST_ORIGIN:host,VITE_PLAYER_ORIGIN:player})}});
      return createRequire(import.meta.url)(file);
    };
    const api=await bundle('host');const w=api.emptyWorld();w.party=[{id:'a',name:'Alice',tags:[],color:'#fff'}];
    const m=api.newMap('test','real',0,6,6,'floor',false);m.autoFog=false;m.fog.fill(1);w.maps=[m];w.playerMapId=m.id;api.replaceWorld(w);
    api.openPlayerWindow('a');assert.equal(new URL(opened.url).origin,player);
    api.listenAsEditor(()=>api.send({type:'world',world:api.getWorld()}));
    await new Promise(r=>setTimeout(r,270));
    const binding=new URL(opened.url).searchParams.get('binding');
    const hello=(seq)=>({type:'hello',binding,__ts:'ts-map',seq,from:'p',inst:'p',born:1,to:api.SESSION});
    opened.messages=[];
    for(const f of handlers)f({origin:'http://localhost:9999',source:opened,data:hello('bad-origin')});
    assert.equal(opened.messages.length,0);
    const impostor={postMessage(){throw Error('must not send');}};
    for(const f of handlers)f({origin:player,source:impostor,data:hello('bad-source')});
    assert.equal(opened.messages.length,0);
    for(const f of handlers)f({origin:player,source:opened,data:hello('good')});
    const payload=opened.messages.at(-1);assert.equal(payload.target,player);assert.equal(payload.data.world.viewerId,'a');
    api.send({type:'alive'});assert.equal(opened.messages.at(-1).data.type,'alive');assert.equal(opened.messages.at(-1).target,player);
    assert.ok(!broadcasts.some(m=>m.type==='world'));
    const hostSession=api.SESSION;const url=opened.url;
    handlers=[];globalThis.sessionStorage=storage();globalThis.location={origin:player,href:url,search:new URL(url).search};
    const messages=[];globalThis.window.opener={closed:false,postMessage:(data,target)=>messages.push({data,target})};
    const p=await bundle('player');assert.equal(p.isPlayerEntry(),true);assert.equal(p.getWorld().party.length,0);assert.ok(p.getWorld().maps.every(m=>m.objects.length===0));
    globalThis.location.search='?view=editor';assert.equal(p.isPlayerEntry(),true);globalThis.location.search=new URL(url).search;
    const received=[];p.listenAsPlayer(m=>received.push(m));assert.equal(messages[0].target,host);
    const deliver=(origin,source,seq)=>{for(const f of handlers)f({origin,source,data:{...payload.data,from:hostSession,seq}});};
    deliver(player,window.opener,'wrong-origin');deliver(host,{},'wrong-opener');assert.equal(received.length,0);
    deliver(host,window.opener,'right');assert.equal(received.at(-1).world.viewerId,'a');
    handlers=[];const again=[];p.listenAsPlayer(m=>again.push(m));deliver(host,window.opener,'refresh');assert.equal(again.at(-1).world.viewerId,'a');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('只起一个 dev server 时，玩家窗口用同源打开，不跳到没监听的端口', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ts-deployment-single-'));
  try {
    const storage = () => { const m = new Map(); return { getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k) }; };
    globalThis.localStorage=storage();globalThis.sessionStorage=storage();
    globalThis.location={origin:host,href:host+'/',search:''};
    let opened;
    globalThis.window={setTimeout:()=>0,setInterval:()=>0,addEventListener:()=>{},removeEventListener:()=>{},open:(url)=>opened={url,closed:false,messages:[],postMessage(data,target){this.messages.push({data,target});}}};
    globalThis.BroadcastChannel=class{postMessage(){}addEventListener(){}removeEventListener(){}};
    const file = join(dir, 'host-only.cjs');
    // 没有配 VITE_PLAYER_ORIGIN：模拟只跑了 dev:host
    await build({stdin:{contents:`export * from './src/core/deployment';export * from './src/runtime/sync';export * from './src/core/store';export * from './src/core/defaults';`,resolveDir:root},outfile:file,bundle:true,platform:'node',format:'cjs',logLevel:'silent',define:{'import.meta.env':JSON.stringify({VITE_APP_ROLE:'host'})}});
    const api = createRequire(import.meta.url)(file);
    const w = api.emptyWorld(); w.party=[{id:'a',name:'Alice',tags:[],color:'#fff'}];
    const m = api.newMap('test','real',0,6,6,'floor',false); m.autoFog=false; m.fog.fill(1); w.maps=[m]; w.playerMapId=m.id; api.replaceWorld(w);
    api.openPlayerWindow('a');
    // 同源时是相对地址：浏览器会把它解析到当前 dev server，不会跳到 5179
    assert.ok(opened.url.startsWith('?view=player'), opened.url);
    assert.ok(!opened.url.includes('5179'), '不能跳到没监听的端口');
    assert.equal(new URL(opened.url, host + '/').origin, host);
    assert.equal(api.playerWindowOrigin(), host);
    api.listenAsEditor(()=>api.send({type:'world',world:api.getWorld()}));
    await new Promise(r=>setTimeout(r,270));
    opened.messages=[];
    assert.equal(opened.messages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('同源玩家窗口：?view=player 能进玩家视角，消息来回都发当前来源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ts-deployment-同源-'));
  try {
    const storage = () => { const m = new Map(); return { getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k) }; };
    globalThis.localStorage=storage();globalThis.sessionStorage=storage();
    // 带 ?view=player，但角色是 host（只起了 dev:host）
    globalThis.location={origin:host,href:host+'/?view=player&session=s&binding=b',search:'?view=player&session=s&binding=b'};
    const messages=[];
    globalThis.window={setTimeout:()=>0,setInterval:()=>0,addEventListener:()=>{},removeEventListener:()=>{},
      opener:{closed:false,postMessage:(data,target)=>messages.push({data,target})}};
    globalThis.BroadcastChannel=class{postMessage(){}addEventListener(){}removeEventListener(){}};
    const file = join(dir, 'same-origin.cjs');
    await build({stdin:{contents:`export * from './src/core/deployment';export * from './src/runtime/sync';`,resolveDir:root},outfile:file,bundle:true,platform:'node',format:'cjs',logLevel:'silent',define:{'import.meta.env':JSON.stringify({VITE_APP_ROLE:'host'})}});
    const api = createRequire(import.meta.url)(file);
    assert.equal(api.isPlayerEntry(), true, '?view=player 在 host 角色里也要进玩家视角');
    assert.equal(api.playerWindowOrigin(), host);
    assert.equal(api.hostOriginForPlayer(), host);
    api.send({ type: 'hello' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].target, host, '回话应该发当前来源，而不是空地址');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
