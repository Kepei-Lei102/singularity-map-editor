(function(root){
  'use strict';
  // Visual and collision shells share the same bevel. Contact values are
  // illustrative presets, not measurements of a particular commercial set.
  const presets={
    wood:{name:'木头',title:'胡桃木',description:'温润木纹 · 深色刻字',bevel:.025,density:650,friction:.42,bounce:.22,wallBounce:.42,roughness:.88,metalness:0,ink:'#170e09'},
    plastic:{name:'塑料',title:'青绿树脂',description:'柔和圆角 · 白色填字',bevel:.10,density:1180,friction:.34,bounce:.30,wallBounce:.46,roughness:.48,metalness:0,ink:'#fff8e5'},
    metal:{name:'金属',title:'拉丝黄铜',description:'宽切边 · 拉丝与凹刻',bevel:.065,density:8500,friction:.38,bounce:.16,wallBounce:.32,roughness:.32,metalness:1,ink:'#241d12'},
    stone:{name:'石头',title:'白松石',description:'灰色脉纹 · 抛光切面',bevel:.018,density:2600,friction:.46,bounce:.19,wallBounce:.36,roughness:.42,metalness:0,ink:'#19252a'}
  };
  for(const value of Object.values(presets))Object.freeze(value);
  const ids=Object.freeze(Object.keys(presets));Object.freeze(presets);
  const rubber=Object.freeze({name:'弹力球',title:'珊瑚橡胶骰',description:'弹力球手感 · 高回弹橡胶',bevel:.14,density:1100,friction:.22,bounce:.84,wallBounce:.88,roughness:.72,metalness:0,ink:'#fff7e5'});
  const trayIds=Object.freeze([...ids,'rubber']);
  // Keep historical presets intact; the new tray control opts into these contacts.
  const trayContacts=Object.freeze({wood:[.40,.36,.50,.28],plastic:[.26,.60,.70,.48],metal:[.52,.10,.18,.10],stone:[.46,.22,.30,.18],rubber:[.22,.84,.88,.76]});
  function get(id='wood'){if(id==='rubber')return rubber;if(!ids.includes(id))throw new Error('无效的骰子材质');return presets[id];}
  function forTray(id){const p=get(id),[friction,bounce,wallBounce,diceBounce]=trayContacts[id];return{...p,friction,bounce,wallBounce,diceBounce};}
  root.DiceMaterials={ids,trayIds,presets,get,forTray};if(typeof module!=='undefined')module.exports=root.DiceMaterials;
})(typeof window==='undefined'?globalThis:window);
