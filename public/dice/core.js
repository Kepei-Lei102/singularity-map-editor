(function (root) {
  'use strict';
  const Materials=typeof DiceMaterials!=='undefined'?DiceMaterials:require('./materials.js');
  const SIDES = [4, 6, 8, 10, 12, 20, 100];
  const PURPOSES=['play','check'],PURPOSE_LABELS={play:'扔着玩',check:'正式判定',unclassified:'未标注（旧记录）'};
  function purposeOf(record){return PURPOSES.includes(record.purpose)?record.purpose:'unclassified';}
  function query(records,{day,purpose='all'}={}){
    if(day!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('日期格式应为 YYYY-MM-DD');
    if(!['all','unclassified',...PURPOSES].includes(purpose))throw new Error('无效的日志用途');
    return records.filter(r=>(day===undefined||r.day===day)&&(purpose==='all'||purposeOf(r)===purpose)).sort((a,b)=>a.seed-b.seed||a.id.localeCompare(b.id));
  }
  function normalizeLaunch(value){
    if(value==null)return null;
    if(typeof value!=='object'||Array.isArray(value))throw new Error('无效的出手参数');
    if(['tray-crypto-v11','tray-bowl-v12','tower-crypto-v9'].includes(value.control)){
      const tower=value.control==='tower-crypto-v9',keys=tower?['control','power','randomSeed']:['control','atX','atY','height','heightMode','randomSeed'];
      if(Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))||typeof value.randomSeed!=='string'||!/^([0-9a-f]{64})$/.test(value.randomSeed))throw Error('无效的密码学随机出手参数');
      if(tower?(!Number.isFinite(value.power)||value.power<0||value.power>1):(!['atX','atY','height'].every(k=>Number.isFinite(value[k]))||Math.abs(value.atX)>1||Math.abs(value.atY)>1||value.height<5||value.height>28||value.heightMode!=='fixed'))throw Error('无效的出手范围');
      return Object.fromEntries(keys.map(k=>[k,value[k]]));
    }
    if(['tower-cue-v5','tower-cue-v7','tower-cue-v8'].includes(value.control)){
      if(Object.keys(value).length!==3||!Number.isFinite(value.power)||value.power<0||value.power>1||!Number.isInteger(value.nonce)||value.nonce<0||value.nonce>4294967295)throw new Error('无效的桌球击发参数');
      return{control:value.control,power:value.power,nonce:value.nonce};
    }
    if(value.control==='tray-drag-v10'){
      const keys=['control','atX','atY','height','heightMode','nonce'];
      if(Object.keys(value).length!==6||!keys.every(k=>Object.hasOwn(value,k))||!['atX','atY','height','nonce'].every(k=>Number.isFinite(value[k]))||Math.abs(value.atX)>1||Math.abs(value.atY)>1||value.height<5||value.height>28||value.heightMode!=='fixed'||!Number.isInteger(value.nonce)||value.nonce<0||value.nonce>4294967295)throw new Error('无效的拖动高度参数');
      return Object.fromEntries(keys.map(k=>[k,value[k]]));
    }
    if(['tray-random-v4','tray-random-v6','tray-random-v9'].includes(value.control)){
      const keys=['control','atX','atY','height','heightMode','nonce'];
      if(Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))||!['atX','atY','height','nonce'].every(k=>Number.isFinite(value[k]))||Math.abs(value.atX)>1||Math.abs(value.atY)>1||value.height<(value.control!=='tray-random-v4'?8:10)||value.height>(value.control!=='tray-random-v4'?28:60)||!['random','fixed'].includes(value.heightMode)||!Number.isInteger(value.nonce)||value.nonce<0||value.nonce>4294967295)throw new Error('无效的高度出手参数');
      return Object.fromEntries(keys.map(k=>[k,value[k]]));
    }
    const keys=['x','y','power','atX','atY','nonce'];
    const pull=['pull-v2','tower-pull-v3'].includes(value.control);
    if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length+(pull?1:0)||!keys.every(k=>Object.hasOwn(value,k)&&Number.isFinite(value[k]))||!Number.isInteger(value.nonce)||value.nonce<0||value.nonce>4294967295||value.power<0||value.power>1||Math.abs(value.atX)>1||Math.abs(value.atY)>1||Math.abs(Math.hypot(value.x,value.y)-1)>.00001)throw new Error('无效的手势出手参数');
    return {...Object.fromEntries(keys.map(k=>[k,value[k]])),...(pull?{control:value.control}:{})};
  }
  function validLaunch(r){try{if(r.algorithm?.includes("-crypto-v1"))return normalizeLaunch(r.launch)?.control===(r.algorithm.startsWith("cannon-tower-")?"tower-crypto-v9":r.algorithm.startsWith("cannon-physical-v11-")?"tray-bowl-v12":"tray-crypto-v11");return !(/-gesture-v(?:[1-9]|10)$/.test(r.algorithm||'')&&!r.launch||r.algorithm?.endsWith('-gesture-v2')&&r.launch?.control!=='pull-v2'||r.algorithm?.endsWith('-gesture-v3')&&r.launch?.control!=='tower-pull-v3'||r.algorithm?.endsWith('-gesture-v4')&&r.launch?.control!=='tray-random-v4'||r.algorithm?.endsWith('-gesture-v10')&&r.launch?.control!=='tray-drag-v10'||r.algorithm?.endsWith('-gesture-v9')&&r.launch?.control!=='tray-random-v9'||r.algorithm?.endsWith('-gesture-v8')&&r.launch?.control!=='tower-cue-v8'||r.algorithm?.endsWith('-gesture-v7')&&r.launch?.control!=='tower-cue-v7'||r.algorithm?.endsWith('-gesture-v6')&&r.launch?.control!=='tray-random-v6'||r.algorithm?.endsWith('-gesture-v5')&&r.launch?.control!=='tower-cue-v5')&&(normalizeLaunch(r.launch),true);}catch{return false;}}
  const PERSONAS=['classic','player','witness'],PERSONA_LABELS={classic:'经典',player:'玩家',witness:'见证者'};
  const OUTCOME_LABELS={success:'大成功',criticalSuccess:'特大成功',failure:'大失败',criticalFailure:'特大失败',portal:'000'};
  const isPortal=r=>r?.sides===100&&r.tens===0&&r.units===0&&r.value===100;
  function outcome(r){
    if(!r||!['player','witness'].includes(r.persona))return null;
    if(r.specialFrom&&r.sides===20)return r.value===1?'criticalFailure':r.value<=10?'failure':r.value===20?'criticalSuccess':'success';
    if(isPortal(r))return 'portal';
    return r.sides===20&&r.value===20||r.sides===100&&r.value>=95&&r.value<=99?'success':null;
  }
  function validRitual(r){return (r.persona===undefined||PERSONAS.includes(r.persona))&&(r.specialFrom===undefined||r.sides===20&&['player','witness'].includes(r.persona)&&typeof r.specialFrom==='string'&&/^[\w:-]{1,160}$/.test(r.specialFrom)&&r.specialFrom!==r.id);}
  function validateLinks(records){
    const byId=new Map(records.map(r=>[r.id,r])),used=new Set();
    for(const r of records)if(r.specialFrom){const p=byId.get(r.specialFrom);if(!p||!isPortal(p)||p.persona!==r.persona||p.material!==r.material||p.purpose!==r.purpose||used.has(p.id))throw new Error('特殊 D20 必须关联同身份、材质和用途的 000，且只能完成一次');used.add(p.id);}
    return true;
  }
  function validRecord(r){return !!(r&&validRitual(r)&&validLaunch(r)&&typeof r.id==='string'&&/^[\w:-]{1,160}$/.test(r.id)&&Number.isSafeInteger(r.seed)&&r.seed>=0&&r.seed<=8640000000000000&&SIDES.includes(r.sides)&&Number.isInteger(r.value)&&r.value>=1&&r.value<=r.sides&&/^\d{4}-\d{2}-\d{2}$/.test(r.day)&&typeof r.localTime==='string'&&r.localTime.length<50&&/^\d{4}-\d{2}-\d{2}T/.test(r.localTime)&&(r.purpose===undefined||['unclassified',...PURPOSES].includes(r.purpose))&&(r.material===undefined||Materials.trayIds.includes(r.material))&&(r.source===undefined||['ui','api','legacy'].includes(r.source))&&(r.requestId===undefined||r.requestId===null||typeof r.requestId==='string'&&/^[\w:-]{1,128}$/.test(r.requestId))&&(r.algorithm===undefined||typeof r.algorithm==='string'&&/^[\w.-]{1,100}$/.test(r.algorithm))&&(r.sides!==100||Number.isInteger(r.tens)&&r.tens>=0&&r.tens<=90&&r.tens%10===0&&Number.isInteger(r.units)&&r.units>=0&&r.units<=9&&(r.tens+r.units||100)===r.value));}
  function normalizeRecord(r){
    if(!validRecord(r))throw new Error('无效的投掷记录');
    return{id:r.id,seed:r.seed,day:r.day,localTime:r.localTime,sides:r.sides,value:r.value,tens:r.sides===100?r.tens:null,units:r.sides===100?r.units:null,algorithm:r.algorithm||'fnv1a-mulberry32-rejection-v2',purpose:purposeOf(r),source:r.source||'legacy',requestId:r.requestId||null,schemaVersion:1,material:r.material||'wood',...(r.persona!==undefined?{persona:r.persona}:{}),...(r.specialFrom?{specialFrom:r.specialFrom}:{}),...(r.launch?{launch:normalizeLaunch(r.launch)}:{}),...(typeof r.attemptId==='string'?{attemptId:r.attemptId}:{})};
  }
  function seededUint32(seed) {
    let state = 2166136261;
    for (const char of String(seed)) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
    return () => {
      state = (state + 0x6D2B79F5) | 0;
      let value = Math.imul(state ^ (state >>> 15), state | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return (value ^ (value >>> 14)) >>> 0;
    };
  }
  function sample(next, sides) {
    const limit = Math.floor(4294967296 / sides) * sides;
    let value;
    do { value = next(); } while (value >= limit);
    return value % sides;
  }
  function roll(sides, seed) {
    if (!SIDES.includes(sides) || !Number.isSafeInteger(seed)) throw new Error('无效的骰子或时间戳');
    const next = seededUint32(seed);
    if (sides === 100) {
      const tens = sample(next, 10) * 10, units = sample(next, 10);
      return { sides, seed, value: tens + units || 100, tens, units };
    }
    return { sides, seed, value: sample(next, sides) + 1, tens: null, units: null };
  }
  function physicalResult(sides,seed,faces,algorithm){
    if(!SIDES.includes(sides)||!Number.isSafeInteger(seed)||!Array.isArray(faces)||faces.length!==(sides===100?2:1))throw new Error('无效的物理结果');
    const n=sides===100?10:sides;
    if(!faces.every(v=>Number.isInteger(v)&&v>=(n===10?0:1)&&v<=(n===10?9:n)))throw new Error('无效的骰面');
    const tens=sides===100?faces[0]*10:null,units=sides===100?faces[1]:null;
    return{sides,seed,value:sides===100?(tens+units||100):(n===10?(faces[0]||10):faces[0]),tens,units,algorithm};
  }
  function dayKey(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function localTime(timestamp) {
    const d = new Date(timestamp), p = (n, width = 2) => String(n).padStart(width, '0');
    const offset = -d.getTimezoneOffset();
    return `${dayKey(timestamp)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${offset >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(offset) / 60))}:${p(Math.abs(offset) % 60)}`;
  }
  function daily(records, day) { return query(records,{day}); }
  function csv(records, day, purpose='all') {
    const rows = [['记录ID', '本地时间', 'UTC时间', '时间戳_ms', '种子', '骰子', '点数', '十位D10', '个位D10', '算法','用途','用途代码','来源','外部请求ID','材质','材质代码','出手方式','手势方向X','手势方向Y','手势力度','拿起位置X','拿起位置Y','随机扰动种子','出手高度_cm','高度方式','骰子身份','关联000记录','特殊判定','凭据ID','随机算法','随机材料256位']];
    for (const r of query(records,{day,purpose})) rows.push([r.id, r.localTime, new Date(r.seed).toISOString(), r.seed, r.seed, `D${r.sides}`, r.value, r.tens == null ? '' : String(r.tens).padStart(2, '0'), r.units ?? '', r.algorithm||'fnv1a-mulberry32-rejection-v2',PURPOSE_LABELS[purposeOf(r)],purposeOf(r),r.source||'legacy',r.requestId||'',Materials.get(r.material||'wood').name,r.material||'wood',['tower-cue-v5','tower-cue-v7','tower-cue-v8'].includes(r.launch?.control)?'cue-strike':['tray-random-v4','tray-random-v6','tray-random-v9','tray-drag-v10','tray-crypto-v11','tray-bowl-v12'].includes(r.launch?.control)?'random-release':r.launch?'gesture':'button',r.launch?.x??'',r.launch?.y??'',r.launch?.power??'',r.launch?.atX??'',r.launch?.atY??'',r.launch?.nonce??'',r.launch?.height??'',r.launch?.heightMode??'',PERSONA_LABELS[r.persona]||'',r.specialFrom||'',OUTCOME_LABELS[outcome(r)]||'',r.attemptId||'',r.launch?.randomSeed?'webcrypto-256-chacha20-rfc8439-v1':'',r.launch?.randomSeed||'']);
    const escape = value => `"${String(value).replace(/"/g, '""')}"`;
    return '\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
  }
  root.DiceCore = { PERSONAS,PERSONA_LABELS,OUTCOME_LABELS,isPortal,outcome,validateLinks,SIDES, PURPOSES, PURPOSE_LABELS, purposeOf, query, normalizeLaunch, validRecord, normalizeRecord, seededUint32, roll, physicalResult, dayKey, localTime, daily, csv };
  if (typeof module !== 'undefined') module.exports = root.DiceCore;
})(typeof window === 'undefined' ? globalThis : window);
