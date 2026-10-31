(function(root){
  'use strict';
  const platform=globalThis.crypto||require('node:crypto').webcrypto;
  const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  function bytes(value){if(typeof value!=='string'||!/^(?:[0-9a-f]{2})+$/.test(value))throw Error('无效的随机材料');return Uint8Array.from(value.match(/../g),s=>parseInt(s,16));}
  function seed(){return hex(platform.getRandomValues(new Uint8Array(32)));}
  // RFC 8439 section 2.3. Full 256-bit key; fixed, disjoint 96-bit domain nonces.
  // This stream is used for simulation randomness, never encryption/authentication.
  function block(key,nonce,counter){
    if(key.length!==32||nonce.length!==12||!Number.isSafeInteger(counter)||counter<0||counter>0xffffffff)throw Error('ChaCha20 参数无效');
    const state=new Uint32Array(16),read=b=>new DataView(b.buffer,b.byteOffset,b.byteLength);
    state.set([0x61707865,0x3320646e,0x79622d32,0x6b206574]);
    for(let i=0;i<8;i++)state[4+i]=read(key).getUint32(i*4,true);
    state[12]=counter;for(let i=0;i<3;i++)state[13+i]=read(nonce).getUint32(i*4,true);
    const x=state.slice(),rot=(v,n)=>(v<<n)|(v>>>(32-n));
    const q=(a,b,c,d)=>{x[a]+=x[b];x[d]=rot(x[d]^x[a],16);x[c]+=x[d];x[b]=rot(x[b]^x[c],12);x[a]+=x[b];x[d]=rot(x[d]^x[a],8);x[c]+=x[d];x[b]=rot(x[b]^x[c],7);};
    for(let i=0;i<10;i++){q(0,4,8,12);q(1,5,9,13);q(2,6,10,14);q(3,7,11,15);q(0,5,10,15);q(1,6,11,12);q(2,7,8,13);q(3,4,9,14);}
    const out=new Uint8Array(64),view=read(out);for(let i=0;i<16;i++)view.setUint32(i*4,(x[i]+state[i])>>>0,true);return out;
  }
  const domains=Object.freeze({tray:1,tower:2,range:3});
  function stream(value,domain){
    const key=bytes(value);if(key.length!==32||!Object.hasOwn(domains,domain))throw Error('随机流参数无效');
    const nonce=new Uint8Array(12);new DataView(nonce.buffer).setUint32(0,domains[domain],true);let counter=0,words=new Uint32Array(0),index=0;
    return()=>{if(index===words.length){const data=block(key,nonce,counter++),v=new DataView(data.buffer);words=Uint32Array.from({length:16},(_,i)=>v.getUint32(i*4,true));index=0;}return words[index++];};
  }
  function canonical(value){
    if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
    if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
    if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
    throw Error('凭据包含不可序列化的值');
  }
  async function digest(value){return hex(new Uint8Array(await platform.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)))));}
  const api={seed,stream,block,hex,bytes,canonical,digest,algorithm:'webcrypto-256-chacha20-rfc8439-v1'};
  root.DiceRandom=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
