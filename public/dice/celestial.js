(function(root){
  'use strict';
  const SC=typeof SunCalc!=='undefined'?SunCalc:typeof require==='function'?require('./vendor/suncalc.js'):null;
  const constellations=[
    {name:'北斗七星',points:[[.12,.30],[.28,.33],[.43,.42],[.59,.40],[.79,.30],[.83,.61],[.62,.66]],lines:[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,3]]},
    {name:'仙后座',points:[[.13,.27],[.30,.70],[.48,.38],[.67,.68],[.87,.23]],lines:[[0,1],[1,2],[2,3],[3,4]]},
    {name:'猎户座',points:[[.27,.14],[.75,.18],[.42,.46],[.51,.49],[.60,.52],[.24,.84],[.76,.85]],lines:[[0,1],[0,2],[1,4],[2,3],[3,4],[2,5],[4,6],[5,6]]}
  ];
  function moon(time=Date.now(),location=null){
    const date=new Date(time),m=SC.getMoonIllumination(date),minimum=.09,locked=m.fraction<minimum;
    return{fraction:m.fraction,phase:m.phase,displayFraction:Math.max(minimum,m.fraction),locked,waxing:m.phase<.5,rotation:location?m.angle-SC.getMoonPosition(date,location.lat,location.lon).parallacticAngle+Math.PI/2:0};
  }
  function canvas(){const c=document.createElement('canvas');c.width=c.height=512;return c;}
  function star(ctx,x,y,r,color='#f4e7ba'){
    ctx.fillStyle=color;ctx.beginPath();for(let i=0;i<16;i++){const a=i*Math.PI/8-Math.PI/2,k=i%2?.20:i%4===0?1:.48;const px=x+Math.cos(a)*r*k,py=y+Math.sin(a)*r*k;i?ctx.lineTo(px,py):ctx.moveTo(px,py);}ctx.closePath();ctx.fill();
  }
  function drawMoon(ctx,x,y,r,phase=moon(),color='#f5e6bd'){
    ctx.save();ctx.translate(x,y);ctx.rotate(phase.rotation||0);ctx.fillStyle='#172a49';ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();
    const k=1-2*phase.displayFraction;ctx.fillStyle=color;
    for(let y=-r;y<=r;y+=1){const edge=Math.sqrt(Math.max(0,r*r-y*y)),cut=k*edge;ctx.fillRect(phase.waxing?cut:-edge,y,edge-cut,1.2);}
    ctx.strokeStyle='rgba(221,229,247,.4)';ctx.lineWidth=Math.max(1,r*.015);ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();
    ctx.globalAlpha=.09;ctx.fillStyle='#3d526c';for(const[a,b,s]of [[.34,-.33,.15],[-.24,.28,.19],[.42,.30,.10],[-.18,-.50,.08]]){ctx.beginPath();ctx.arc(a*r,b*r,s*r,0,7);ctx.fill();}ctx.restore();
  }
  function constellation(ctx,which=0,box=[48,48,416,416],illuminated=false){
    ctx.save();
    const c=constellations[which%constellations.length],[x,y,w,h]=box;ctx.strokeStyle=illuminated?'rgba(240,246,255,.95)':'rgba(202,220,249,.5)';ctx.lineWidth=illuminated?3.5:2;
    if(illuminated){ctx.shadowColor='rgba(255,236,174,.9)';ctx.shadowBlur=10;}
    for(const[a,b]of c.lines){ctx.beginPath();ctx.moveTo(x+c.points[a][0]*w,y+c.points[a][1]*h);ctx.lineTo(x+c.points[b][0]*w,y+c.points[b][1]*h);ctx.stroke();}
    for(const [i,p]of c.points.entries()){const px=x+p[0]*w,py=y+p[1]*h;ctx.fillStyle='#eff5ff';ctx.beginPath();ctx.arc(px,py,i===0?4:3,0,7);ctx.fill();star(ctx,px,py,i===0?15:10,illuminated?'#fff5d7':'#f4e7ba');}
    ctx.restore();
  }
  function sky(face=0){
    const c=canvas(),ctx=c.getContext('2d'),g=ctx.createLinearGradient(0,0,512,512);g.addColorStop(0,'#071127');g.addColorStop(.5,'#14274f');g.addColorStop(1,'#0b193b');ctx.fillStyle=g;ctx.fillRect(0,0,512,512);
    for(let i=0;i<4;i++){const nebula=ctx.createRadialGradient(70+i*130,100+(i*97)%300,0,70+i*130,100+(i*97)%300,230);nebula.addColorStop(0,i%2?'rgba(75,63,133,.17)':'rgba(43,109,157,.17)');nebula.addColorStop(1,'rgba(10,20,50,0)');ctx.fillStyle=nebula;ctx.fillRect(0,0,512,512);}return c;
  }
  function starField(face=0){
    // Independent art seed: no draws from the physical roll's random stream.
    let state=(0x93a7b24f^Math.imul(face+1,0x9e3779b1))>>>0;
    const random=()=>{state+=0x6d2b79f5;let t=state;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};
    const gaussian=()=>Math.sqrt(-2*Math.log(Math.max(1e-8,random())))*Math.cos(2*Math.PI*random());
    const clouds=Array.from({length:3},()=>({x:80+random()*352,y:80+random()*352,spread:35+random()*75}));
    const palette=[[255,241,216],[255,224,177],[255,203,144],[255,247,231]];
    return Array.from({length:210},(_,i)=>{
      let x=random()*512,y=random()*512;
      if(i<165&&random()<.36){const c=clouds[Math.floor(random()*clouds.length)],px=c.x+gaussian()*c.spread,py=c.y+gaussian()*c.spread;if(px>5&&px<507&&py>5&&py<507){x=px;y=py;}}
      const bright=i>=204,medium=i>=165,r=bright?1.9+random()*.9:medium?1.0+random()*.65:.38+random()*.62;
      const color=palette[bright?3:random()<.65?0:random()<.65?1:2];
      return{x,y,r,color,brightness:bright?.85+random()*.15:medium?.4+random()*.35:.14+random()*.27,phase:random(),rate:random(),amplitude:bright?.20:medium?.14:.07};
    });
  }
  function stars(face=0,mask=null){
    const c=canvas(),ctx=c.getContext('2d'),motion=c.starMotion=canvas(),m=motion.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,512,512);
    for(const p of starField(face)){
      const {x,y,r,color,brightness}=p,halo=r*(r>1.8?4:2),rgb=color.join(',');
      const glow=ctx.createRadialGradient(x,y,0,x,y,halo);
      glow.addColorStop(0,`rgba(${rgb},${brightness})`);glow.addColorStop(.16,`rgba(${rgb},${brightness*.8})`);glow.addColorStop(.4,`rgba(${rgb},${brightness*.18})`);glow.addColorStop(1,`rgba(${rgb},0)`);
      ctx.fillStyle=glow;ctx.fillRect(x-halo,y-halo,halo*2,halo*2);
      ctx.fillStyle=`rgba(${rgb},${brightness})`;ctx.beginPath();ctx.arc(x,y,r*.52,0,Math.PI*2);ctx.fill();
      // One phase/rate/amplitude per star, constant across its soft halo.
      m.fillStyle=`rgb(${Math.round(p.phase*255)},${Math.round(p.rate*255)},${Math.round(p.amplitude*255)})`;m.beginPath();m.arc(x,y,halo+1,0,Math.PI*2);m.fill();
    }
    if(mask){ctx.globalCompositeOperation='multiply';ctx.drawImage(mask,0,0);ctx.globalCompositeOperation='source-over';}return c;
  }
  const time={value:0};
  function resultLayout(bounds,area,critical=false,art=[103,103,409,409]){
    // The moon occupies only 300 / 512 of its texture. Size the visible disc,
    // not the transparent canvas, to surround every die with breathing room.
    const x=(bounds.min.x+bounds.max.x)/2,y=(bounds.min.y+bounds.max.y)/2;
    const radius=Math.max(2.2,Math.hypot(bounds.max.x-bounds.min.x,bounds.max.y-bounds.min.y)/2+.9)*(critical?1.12:1);
    const size=radius*512/150,left=x-size/2,bottom=y-size/2;
    const x0=Math.max(area.minX,left),x1=Math.min(area.maxX,x+size/2),y0=Math.max(area.minY,bottom),y1=Math.min(area.maxY,y+size/2);
    const frameBounds={minX:Math.max(x0,left+art[0]/512*size),maxX:Math.min(x1,left+art[2]/512*size),minY:Math.max(y0,bottom+(1-art[3]/512)*size),maxY:Math.min(y1,bottom+(1-art[1]/512)*size)};
    return{size,radius,x:(x0+x1)/2,y:(y0+y1)/2,width:x1-x0,height:y1-y0,u0:(x0-left)/size,u1:(x1-left)/size,v0:(y0-bottom)/size,v1:(y1-bottom)/size,frameBounds};
  }
  function twinkle(material,texture){
    material.emissive.set('#fff4df');material.emissiveMap=texture;material.emissiveIntensity=1.25;
    const motion=material.starMotionMap=new THREE.CanvasTexture(texture.image.starMotion);
    material.onBeforeCompile=shader=>{shader.uniforms.starTime=time;shader.uniforms.starMotionMap={value:motion};shader.fragmentShader='uniform float starTime;\nuniform sampler2D starMotionMap;\n'+shader.fragmentShader;shader.fragmentShader=shader.fragmentShader.replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\n vec3 starMotion = texture2D(starMotionMap, vEmissiveMapUv).rgb;\n totalEmissiveRadiance *= 1.0 - starMotion.b + starMotion.b * sin(starTime * (0.65 + starMotion.g * 1.1) + starMotion.r * 6.283185);');};
    material.customProgramCacheKey=()=> 'witness-warm-stars-v2';
  }
  function install(view){
    const T=THREE;view.persona='player';
    view.clearCelestial=function(){this.celestialTime=Date.now();this.resultSymbol=false;this.zeroSymbol=false;if(this.celestialMark){this.scene.remove(this.celestialMark);this.celestialMark.geometry.dispose();this.celestialMark.material.map.dispose();this.celestialMark.material.dispose();this.celestialMark=null;}this.effectUntil=0;};
    view.setPersona=function(persona){if(!['classic','player','witness'].includes(persona))throw Error('无效的骰子身份');this.persona=persona;this.clearCelestial();const poses=this.dice.map(d=>({p:d.position.toArray(),q:d.quaternion.toArray()}));if(this.currentSides){this.prepare(this.currentSides);this.apply(poses);}this.render();};
    view.showCelestial=function(record){
      this.clearCelestial();this.celestialTime=record.seed;const outcome=DiceCore.outcome(record);if(!outcome){this.render();return;}
      this.resultSymbol=record.sides===20&&record.value===20;this.zeroSymbol=DiceCore.isPortal(record);const poses=this.dice.map(d=>({p:d.position.toArray(),q:d.quaternion.toArray()}));this.prepare(record.sides);this.apply(poses);
      if(outcome!=='success'&&outcome!=='criticalSuccess'){this.render();return;}
      const c=canvas(),ctx=c.getContext('2d');if(this.persona==='witness')drawMoon(ctx,256,256,150,moon(record.seed,this.moonLocation));else constellation(ctx,record.specialFrom?0:record.seed%3,undefined,true);
      if(outcome==='criticalSuccess'){ctx.strokeStyle='rgba(236,220,166,.65)';ctx.lineWidth=1.4;ctx.beginPath();ctx.arc(256,256,236,0,7);ctx.stroke();for(let i=0;i<12;i++)star(ctx,256+Math.cos(i*Math.PI/6)*220,256+Math.sin(i*Math.PI/6)*220,8);}
      const map=new T.CanvasTexture(c);map.colorSpace=T.SRGBColorSpace;const mat=new T.MeshBasicMaterial({map,transparent:true,opacity:this.motion.matches?.9:0,depthWrite:false,side:T.DoubleSide,toneMapped:false});
      const bounds=new T.Box3();this.dice.forEach(d=>bounds.expandByObject(d));
      const halfX=this.towerStyle?3.7:DicePhysics.BOX.halfX,minY=this.towerStyle?-9.5:-DicePhysics.BOX.halfY,maxY=this.towerStyle?-2.8:DicePhysics.BOX.halfY;
      const critical=outcome==='criticalSuccess',which=record.specialFrom?0:record.seed%3;
      const stars=constellations[which].points.map(([x,y])=>[48+x*416,48+y*416]);
      const art=critical?[18,18,494,494]:this.persona==='witness'?[103,103,409,409]:[Math.min(...stars.map(p=>p[0]))-26,Math.min(...stars.map(p=>p[1]))-26,Math.max(...stars.map(p=>p[0]))+26,Math.max(...stars.map(p=>p[1]))+26];
      const layout=resultLayout(bounds,{minX:-halfX+.08,maxX:halfX-.08,minY:minY+.08,maxY:maxY-.08},critical,art);
      const geometry=new T.PlaneGeometry(layout.width,layout.height),uv=geometry.attributes.uv;
      // Crop at the tray rim without shrinking or stretching the artwork.
      for(let i=0;i<uv.count;i++)uv.setXY(i,layout.u0+uv.getX(i)*(layout.u1-layout.u0),layout.v0+uv.getY(i)*(layout.v1-layout.v0));
      const mark=this.celestialMark=new T.Mesh(geometry,mat);mark.userData.frameBounds=layout.frameBounds;mark.position.set(layout.x,layout.y,.055);mark.renderOrder=1;this.scene.add(mark);this.effectStarted=performance.now();this.effectUntil=this.effectStarted+5000;this.render();
    };
    const render=view.render.bind(view);view.render=function(){time.value=this.motion.matches?0:performance.now()/1000;render();};
    let last=0;const tick=now=>{if(!document.hidden&&!view.motion.matches&&(view.persona==='witness'||now<view.effectUntil||view.celestialMark&&view.celestialMark.material.opacity!==.9)&&now-last>32){if(view.celestialMark)view.celestialMark.material.opacity=now<view.effectUntil?Math.min(1,(now-view.effectStarted)/650)*(.84+.06*Math.sin(now*.0018)):.9;view.render();last=now;}view.starFrame=requestAnimationFrame(tick);};view.starFrame=requestAnimationFrame(tick);
  }
  root.DiceCelestial={moon,star,drawMoon,constellation,constellations,sky,starField,stars,twinkle,resultLayout,install};if(typeof module!=='undefined')module.exports=root.DiceCelestial;
})(typeof window==='undefined'?globalThis:window);
