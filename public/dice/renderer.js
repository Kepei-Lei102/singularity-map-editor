(function(root){
  'use strict';
  const T=THREE,G=DiceGeometry,P=DicePhysics,A=root.DiceCelestial;
  const {add,sub,mul,dot,cross,norm}=G;
  function woodCanvas(){
    const canvas=document.createElement('canvas');canvas.width=canvas.height=512;const ctx=canvas.getContext('2d'),data=ctx.createImageData(512,512);
    for(let y=0;y<512;y++)for(let x=0;x<512;x++){
      const bend=11*Math.sin(y*.012)+5*Math.sin(y*.027)+7*Math.sin(y*.004+x*.011),grain=Math.sin((x+bend)*.25)+.4*Math.sin((x+bend)*1.3)+.2*Math.sin(x*3.7+y*.04),ring=Math.pow((Math.sin((x+bend)*.073)+1)/2,12),noise=(Math.sin(x*127.1+y*311.7)*43758.5453)%1,shade=grain*7-ring*22+noise*3+8*Math.sin(x*.012+y*.002),i=(y*512+x)*4;
      data.data[i]=158+shade;data.data[i+1]=107+shade*.79;data.data[i+2]=60+shade*.49;data.data[i+3]=255;
    }ctx.putImageData(data,0,0);return canvas;
  }
  const tex=canvas=>{const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.anisotropy=8;return texture;};

  function surfaceCanvas(material,face,basis,extent){
    const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
    const ctx=canvas.getContext('2d'),data=ctx.createImageData(512,512);
    for(let y=0;y<512;y++)for(let x=0;x<512;x++){
      let color;
      if(material==='rubber'){
        const grain=1.5*Math.sin(x*1.7+y*2.8);color=[224+grain,91+grain,69+grain];
      }else if(material==='plastic'){
        const haze=2*Math.sin(x*.019)*Math.sin(y*.013)+Math.sin(x*1.7+y*2.8);
        color=[23+haze,120+haze,119+haze];
      }else if(material==='metal'){
        const brush=2.2*Math.sin(y*2.1)+1.4*Math.sin(y*.53)+.6*Math.sin(x*.13+y*4.3);
        color=[182+brush,145+brush,83+brush];
      }else{
        // Object-space stone: the vein field continues across adjacent faces.
        const p=add(face.center,add(mul(basis.right,(x/512-.5)*extent),mul(basis.up,(.5-y/512)*extent)));
        const [a,b,c]=p,warp=.55*Math.sin(b*9+c*5)+.2*Math.sin(a*19-b*7);
        const main=Math.exp(-Math.abs(Math.sin(a*4+b*2+c*3+warp))/.045);
        const branch=Math.exp(-Math.abs(Math.sin(b*6-c*4+.4*Math.sin(a*11+c*8)))/.025);
        const cloud=5*Math.sin(a*13+b*5)*Math.sin(c*9-b*8),grain=1.4*Math.sin(x*127.1+y*311.7);
        const shade=main*132+branch*60;
        color=[229+cloud+grain-shade,229+cloud+grain-shade,219+cloud+grain-shade*.94];
      }
      const i=(y*512+x)*4;data.data[i]=color[0];data.data[i+1]=color[1];data.data[i+2]=color[2];data.data[i+3]=255;
    }
    ctx.putImageData(data,0,0);return canvas;
  }
  function faceBasis(mesh,face,sides){
    let up;
    if(sides===10){const tip=face.ids.find(id=>id>=10);up=norm(sub(mesh.vertices[tip],face.center));}
    else up=norm(cross(face.normal,sub(mesh.vertices[face.ids[1]],mesh.vertices[face.ids[0]])));
    return{up,right:norm(cross(up,face.normal))};
  }
  class WoodDice{
    constructor(canvas){
      this.canvas=canvas;this.scene=new T.Scene();this.scene.background=new T.Color('#142b36');this.camera=new T.PerspectiveCamera(37,1,.1,100);this.camera.up.set(0,0,1);
      this.renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=T.PCFShadowMap;this.renderer.outputColorSpace=T.SRGBColorSpace;this.renderer.toneMapping=T.ACESFilmicToneMapping;this.renderer.toneMappingExposure=.92;
      this.material='wood';this.wood=woodCanvas();this.meshCache=new Map();this.dice=[];this.frame=0;this.motion=matchMedia('(prefers-reduced-motion: reduce)');this.angle=40;this.closeup=false;this.viewFrame=0;this.lookTarget=new T.Vector3(0,0,.4);this.makeRoom();this.makeBox();this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas);this.resize();
      if(A)A.install(this);
      canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();if(this.reject){this.reject(new Error('三维画面暂时中断，请刷新页面后重试'));this.reject=null;}});
    }
    makeRoom(){Object.assign(this,DiceRoom.create(this.scene,this.wood));}
    updateReflection(){
      if(!this.reflectionTarget){this.reflectionTarget=new T.WebGLCubeRenderTarget(128,{type:T.HalfFloatType});this.reflectionCamera=new T.CubeCamera(.1,80,this.reflectionTarget);this.reflectionCamera.position.set(0,0,2.5);this.pmrem=new T.PMREMGenerator(this.renderer);}
      for(const die of this.dice)die.visible=false;
      this.reflectionCamera.update(this.renderer,this.scene);
      for(const die of this.dice)die.visible=true;
      const next=this.pmrem.fromCubemap(this.reflectionTarget.texture);this.reflection?.dispose();this.reflection=next;
      for(const cached of this.meshCache.values())cached.traverse(o=>{if(o.isMesh)for(const mat of o.material){if(mat.userData.reflective){mat.envMap=next.texture;mat.needsUpdate=true;}}});
    }
    setMaterial(material){
      DiceMaterials.get(material);if(material===this.material)return;
      this.material=material;
      // Preserve a settled result and camera while changing its physical skin.
      const poses=this.dice.map(d=>({p:d.position.toArray(),q:d.quaternion.toArray()}));
      if(this.currentSides){this.prepare(this.currentSides);this.apply(poses);this.updateView(false);}
    }
    setWeather(weather){
      this.weather=weather;const light=DiceWeather.light(weather),ctx=this.skyCanvas.getContext('2d'),w=768,h=512;
      const gradient=ctx.createLinearGradient(0,0,0,h);gradient.addColorStop(0,light.sky);gradient.addColorStop(1,light.day?'#cad3ce':'#425260');ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
      if(!light.day){ctx.fillStyle='#d6dfdf';for(let i=0;i<35;i++){ctx.globalAlpha=(1-light.cloud)*(.3+(i%4)*.15);ctx.fillRect((i*137)%w,(i*79)%300,2,2);}ctx.globalAlpha=1;}
      for(let i=0;i<8;i++){ctx.fillStyle=light.day?`rgba(231,233,226,${light.cloud*.46})`:`rgba(79,95,118,${light.cloud*.4})`;ctx.beginPath();ctx.ellipse((i*181+45)%w,80+(i*63)%230,135,28,0,0,Math.PI*2);ctx.fill();}
      // Soft distant hillside silhouettes give the glass depth without distracting from dice.
      for(let row=0;row<3;row++){ctx.fillStyle=light.day?['#82999d','#6a858c','#526d76'][row]:['#293b4c','#243440','#1c2c36'][row];ctx.beginPath();ctx.moveTo(0,h);for(let x=0;x<=w;x+=12)ctx.lineTo(x,445+row*24+Math.sin(x*.009+row)*22+Math.sin(x*.026)*6);ctx.lineTo(w,h);ctx.fill();}
      if(light.rain>0||light.snow){ctx.strokeStyle='rgba(224,239,244,.44)';ctx.lineWidth=1.4;ctx.fillStyle='#e2eceb';for(let i=0;i<90;i++){const x=(i*173)%w,y=(i*97)%h;if(light.snow){ctx.beginPath();ctx.arc(x,y,1.5,0,7);ctx.fill();}else{ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-3,y+8+light.rain*14);ctx.stroke();}}}
      this.skyTexture.needsUpdate=true;
      this.sun.intensity=light.direct;this.sun.color.set(light.day?new T.Color('#fff1d6').lerp(new T.Color('#ffbe84'),light.warmth):'#8eafd9');this.sun.position.set(-5+light.phase*6,22,12+Math.sin(Math.PI*light.phase)*8);this.sun.target.position.set(0,0,0);this.sun.shadow.radius=light.shadowRadius;
      this.ambient.intensity=light.ambient+(light.day?0:.45);this.ambient.color.set(light.day?'#d6e8f2':'#839ebc');this.lamp.intensity=light.lamp*350;this.bulbMaterial.emissiveIntensity=light.day?1:3;this.lining.emissiveIntensity=light.day?.08:.35;
      this.bounce.intensity=light.day?1.15:.8;this.bounce.color.set(light.day?'#d7e5ec':'#dbc6aa');this.wallMaterial.color.set(light.day?'#c6c4b8':'#889396');this.tableMaterial.color.set('#b6a68b');
      this.scene.background.set(light.day?'#a0b3ba':'#172733');this.renderer.toneMappingExposure=light.day?1.06:1.02;this.configureWeatherLighting(light);this.updateReflection();this.render();
    }
    configureWeatherLighting(light){}
    makeBox(){
      this.frontRim=[];this.legacyTray=new T.Group();this.scene.add(this.legacyTray);
      const B=P.BOX,rim=new T.MeshStandardMaterial({roughness:.84,metalness:0,color:0x315e74});
      const box=(x,y,z,sx,sy,sz,material)=>{const mesh=new T.Mesh(new T.BoxGeometry(sx,sy,sz),material);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;this.legacyTray.add(mesh);return mesh;};
      box(0,0,-.22,B.halfX*2+.7,B.halfY*2+.7,.4,rim);
      const felt=document.createElement('canvas');felt.width=felt.height=512;const ctx=felt.getContext('2d'),data=ctx.createImageData(512,512);
      for(let y=0;y<512;y++)for(let x=0;x<512;x++){const k=(y*512+x)*4,n=3*Math.sin(x*127.1+y*311.7)+2*Math.sin(x*2+y*.5);data.data[k]=43+n;data.data[k+1]=85+n;data.data[k+2]=104+n;data.data[k+3]=255;}ctx.putImageData(data,0,0);
      const feltMap=tex(felt);feltMap.wrapS=feltMap.wrapT=T.RepeatWrapping;feltMap.repeat.set(3,2);
      const floor=box(0,0,-.018,B.halfX*2,B.halfY*2,.036,new T.MeshStandardMaterial({map:feltMap,roughness:1}));floor.castShadow=false;
      for(const[x,y,sx,sy]of [[B.halfX+B.wallThickness/2,0,B.wallThickness,B.halfY*2+B.wallThickness*2],[-B.halfX-B.wallThickness/2,0,B.wallThickness,B.halfY*2+B.wallThickness*2],[0,B.halfY+B.wallThickness/2,B.halfX*2,B.wallThickness],[0,-B.halfY-B.wallThickness/2,B.halfX*2,B.wallThickness]]){const wall=box(x,y,B.wallHeight/2,sx,sy,B.wallHeight,rim);if(y<0)this.frontRim.push(wall);}
      // A fine brass inlay follows the physical box rim in world space.
      const brass=new T.MeshStandardMaterial({color:0xb69958,roughness:.38,metalness:.62});
      for(const x of[-B.halfX-.14,B.halfX+.14])box(x,0,B.wallHeight+.008,.035,B.halfY*2+.35,.025,brass);
      for(const y of[-B.halfY-.14,B.halfY+.14]){const trim=box(0,y,B.wallHeight+.008,B.halfX*2+.3,.035,.025,brass);if(y<0)this.frontRim.push(trim);}
      this.makeBowl(feltMap,rim,brass);
    }
    setTrayShape(bowl=true){if(this.bowlTray){this.bowlTray.visible=bowl;this.legacyTray.visible=!bowl;}}
    makeBowl(feltMap,rim,brass){
      const shape=P.Bowl,group=new T.Group(),positions=[],uvs=[];
      for(const triangle of shape.patches)for(const p of triangle){positions.push(...p);uvs.push(p[0]/(shape.halfX*2)+.5,p[1]/(shape.halfY*2)+.5);}
      const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new T.Float32BufferAttribute(uvs,2));geometry.computeVertexNormals();
      const velvet=new T.Mesh(geometry,new T.MeshStandardMaterial({map:feltMap,roughness:1}));velvet.receiveShadow=true;group.add(velvet);
      const edge=[];for(let i=0;i<shape.sectors;i++){const a=shape.point(1,i),b=shape.point(1,i+1),c=[b[0],b[1],-.22],d=[a[0],a[1],-.22];for(const p of[a,d,c,a,c,b])edge.push(...p);}
      const edgeGeometry=new T.BufferGeometry();edgeGeometry.setAttribute('position',new T.Float32BufferAttribute(edge,3));edgeGeometry.computeVertexNormals();const shell=new T.Mesh(edgeGeometry,rim);shell.castShadow=true;shell.receiveShadow=true;group.add(shell);
      const curve=new T.CatmullRomCurve3(Array.from({length:shape.sectors},(_,i)=>new T.Vector3(...shape.point(1,i))),true,'centripetal');
      const lip=new T.Mesh(new T.TubeGeometry(curve,192,.055,6,true),brass);lip.castShadow=true;group.add(lip);
      this.bowlTray=group;this.scene.add(group);this.setTrayShape(true);
    }
    resize(){
      const{width,height}=this.canvas.getBoundingClientRect();if(!width||!height)return;
      this.renderer.setSize(width,height,false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();this.updateView(false);
    }
    updateView(animate=false){
      cancelAnimationFrame(this.viewFrame);
      const target=new T.Vector3(0,0,3.2),points=[],angle=this.angle*Math.PI/180;
      if(this.closeup&&this.dice.length){
        const bounds=new T.Box3();for(const die of this.dice)bounds.expandByObject(die);bounds.getCenter(target);
        for(const die of this.dice)for(const x of[-P.RADIUS,P.RADIUS])for(const y of[-P.RADIUS,P.RADIUS])for(const z of[-P.RADIUS,P.RADIUS])points.push(die.position.clone().add(new T.Vector3(x,y,z)));
      }else{
        // Leave room above and around the tray for the full launch arc. The
        // wide view establishes distance; settled dice still get a closeup.
        for(const x of[-(this.bowlTray?.visible?P.Bowl.halfX:P.BOX.halfX)-.9,(this.bowlTray?.visible?P.Bowl.halfX:P.BOX.halfX)+.9])for(const y of[-(this.bowlTray?.visible?P.Bowl.halfY:P.BOX.halfY)-.9,(this.bowlTray?.visible?P.Bowl.halfY:P.BOX.halfY)+.9])for(const z of[-.42,9])points.push(new T.Vector3(x,y,z));
        // Keep the lamp, flowers and tabletop objects visible on narrow screens.
        for(const x of[-12.3,12.3])for(const y of[-6.8,6.8])for(const z of[-.5,8.5])points.push(new T.Vector3(x,y,z));
      }
      if(!this.closeup&&this.flightBounds){const {min,max}=this.flightBounds;for(const x of[min.x,max.x])for(const y of[min.y,max.y])for(const z of[min.z,max.z])points.push(new T.Vector3(x,y,z));}
      if(this.closeup&&this.celestialMark){const m=this.celestialMark,rx=m.geometry.parameters.width/2,ry=m.geometry.parameters.height/2,f=m.userData.frameBounds||{minX:m.position.x-rx,maxX:m.position.x+rx,minY:m.position.y-ry,maxY:m.position.y+ry};for(const x of[f.minX,f.maxX])for(const y of[f.minY,f.maxY])points.push(new T.Vector3(x,y,m.position.z));}
      this.camera.far=180;this.camera.updateProjectionMatrix();
      // Fit every die, including widely separated D100 pairs, inside the controls.
      const probe=this.camera.clone();probe.far=10000;probe.updateProjectionMatrix();let distance=this.closeup?4.8:12.6;
      for(let step=0;step<100;step++){
        probe.position.copy(target).add(new T.Vector3(0,-Math.cos(angle)*distance,Math.sin(angle)*distance));probe.lookAt(target);probe.updateMatrixWorld();
        if(points.every(p=>{const q=p.clone().project(probe);return Math.abs(q.x)<.84&&Math.abs(q.y)<.65&&q.z<1;}))break;
        distance*=1.05;
      }
      this.camera.far=Math.max(180,distance+100);this.camera.updateProjectionMatrix();
      const end=probe.position.clone(),start=this.camera.position.clone(),from=this.lookTarget.clone();
      const apply=t=>{this.camera.position.lerpVectors(start,end,t);this.lookTarget.lerpVectors(from,target,t);this.camera.lookAt(this.lookTarget);this.render();};
      if(!animate||this.motion.matches){apply(1);return;}
      const began=performance.now(),tick=now=>{const t=Math.min(1,(now-began)/420);apply(t*t*(3-2*t));if(t<1)this.viewFrame=requestAnimationFrame(tick);};this.viewFrame=requestAnimationFrame(tick);
    }
    setCloseup(enabled,animate=true){this.closeup=enabled;for(const part of this.frontRim)part.visible=!enabled;this.updateView(animate);}
    setAngle(degrees){this.angle=degrees;this.updateView(false);}
    makeDie(sides,kind){
      const material=this.material||'wood',preset=DiceMaterials.get(material);
      const witness=A&&this.persona==='witness',symbol=A&&(witness||this.resultSymbol),phase=A?A.moon(this.celestialTime||Date.now(),this.moonLocation):null;
      const key=`${material}:${sides}:${kind}:${this.persona||'classic'}:${!!this.resultSymbol}:${!!this.zeroSymbol}:${witness?Math.round(phase.displayFraction*100)+':'+phase.waxing+':'+phase.rotation.toFixed(2):''}`;if(this.meshCache.has(key)){const cached=this.meshCache.get(key);this.meshCache.delete(key);this.meshCache.set(key,cached);return cached.clone();}
      const mesh=G.geometry(sides),bevel=G.beveled(sides,preset.bevel),labels=G.labelsFor(sides,mesh),positions=[],uvs=[],normals=[],materials=[],geometry=new T.BufferGeometry();
      mesh.faces.forEach((face,faceIndex)=>{
        const basis=faceBasis(mesh,face,sides), coords=face.ids.map(id=>[dot(sub(mesh.vertices[id],face.center),basis.right),dot(sub(mesh.vertices[id],face.center),basis.up)]);
        const extent=Math.max(...coords.flat().map(Math.abs))*2.15,uv=p=>[.5+dot(sub(p,face.center),basis.right)/extent,.5+dot(sub(p,face.center),basis.up)/extent];
        const canvas=document.createElement('canvas');canvas.width=canvas.height=512;const ctx=canvas.getContext('2d');ctx.drawImage(witness?A.sky(faceIndex):material==='wood'?this.wood:surfaceCanvas(material,face,basis,extent),0,0);
        const mask=document.createElement('canvas');mask.width=mask.height=512;const ink=mask.getContext('2d');ink.fillStyle='#fff';ink.fillRect(0,0,512,512);
        for(const c of [ctx,ink]){c.textAlign='center';c.textBaseline='middle';c.fillStyle=c===ctx?(witness?'#f0e8ce':preset.ink):'#000';}
        if(material==='wood'&&!witness){ctx.shadowColor='#b78b59';ctx.shadowOffsetY=1;}
        let inradius=Infinity;for(let i=0;i<face.ids.length;i++)inradius=Math.min(inradius,Math.hypot(...cross(sub(face.center,mesh.vertices[face.ids[i]]),norm(sub(mesh.vertices[face.ids[(i+1)%face.ids.length]],mesh.vertices[face.ids[i]])))));
        const size=inradius/extent*512*1.22;
        const print=(label,x,y,fontSize)=>{for(const c of[ctx,ink]){c.font=`bold ${fontSize}px ${material==='plastic'?'Arial,sans-serif':'Georgia,serif'}`;c.fillText(label===6||label===9?`${label}.`:String(label),x,y);}};
        const label=kind==='tens'?String(labels[faceIndex]*10).padStart(2,'0'):labels[faceIndex];
        if(A&&((symbol&&sides===20&&Number(label)===20)||(this.zeroSymbol&&sides===10&&Number(label)===0))){
          for(const c of [ctx,ink]){if(witness)A.drawMoon(c,256,256,size*.48,phase,c===ctx?'#f4e9cb':'#000');else if(this.zeroSymbol)A.constellation(c,0,[256-size*.68,256-size*.68,size*1.36,size*1.36]);else A.star(c,256,256,size*.53,c===ctx?preset.ink:'#000');}
        }
        else if(sides===4){for(const id of face.ids){const p=add(mul(mesh.vertices[id],.57),mul(face.center,.43)),[u,v]=uv(p);print(id+1,u*512,(1-v)*512,size*.62);}}
        else if(sides===6){const layouts={1:[[0,0]],2:[[-1,-1],[1,1]],3:[[-1,-1],[0,0],[1,1]],4:[[-1,-1],[1,-1],[-1,1],[1,1]],5:[[-1,-1],[1,-1],[0,0],[-1,1],[1,1]],6:[[-1,-1],[1,-1],[-1,0],[1,0],[-1,1],[1,1]]};for(const[x,y]of layouts[label]){for(const c of[ctx,ink]){c.beginPath();c.arc(256+x*size*.34,256+y*size*.34,size*.095,0,Math.PI*2);c.fill();}}}
        else print(label,256,256,size*(kind==='tens'?.87:1));
        const map=tex(canvas),engraving=new T.CanvasTexture(mask);
        const mat=new T.MeshPhysicalMaterial({map,emissive:material==='metal'?0xffffff:0x000000,emissiveMap:material==='metal'?map:null,emissiveIntensity:.18,bumpMap:material==='wood'?map:engraving,bumpScale:material==='wood'?.007:.012,roughness:preset.roughness,metalness:preset.metalness,metalnessMap:material==='metal'?engraving:null,specularColorMap:material==='wood'?null:engraving,clearcoatMap:material==='wood'?null:engraving,envMap:material==='wood'?null:(this.reflection?.texture||null),envMapIntensity:material==='metal'?.85:.35,specularIntensity:material==='plastic'?.32:1,clearcoat:material==='plastic'?.08:material==='stone'?.18:0,clearcoatRoughness:.5});
        if(witness){mat.bumpMap=engraving;mat.bumpScale=.007;mat.roughness=.60;mat.metalness=.12;mat.metalnessMap=null;mat.envMapIntensity=.25;A.twinkle(mat,tex(A.stars(faceIndex,mask)));}
        mat.userData.reflective=material!=='wood';materials.push(mat);
        const start=positions.length/3;
        const inset=bevel.faces[faceIndex];
        for(let i=1;i<inset.ids.length-1;i++)for(const id of[inset.ids[0],inset.ids[i],inset.ids[i+1]]){positions.push(...mul(bevel.vertices[id],P.RADIUS));uvs.push(...uv(bevel.vertices[id]));normals.push(...face.normal);}
        geometry.addGroup(start,positions.length/3-start,faceIndex);
      });
      const edge=new T.MeshPhysicalMaterial(material==='wood'?{map:tex(this.wood),color:0xbca07c,roughness:.68}:{color:material==='plastic'?0x177877:material==='metal'?0xbfa169:material==='rubber'?0xe05b45:0xdedfd6,roughness:material==='metal'?.23:preset.roughness,metalness:preset.metalness,envMap:this.reflection?.texture||null,envMapIntensity:material==='metal'?.9:.35,clearcoat:material==='plastic'?.42:.1});
      if(witness){edge.color.set('#14274c');edge.map=null;edge.metalness=.15;edge.roughness=.6;}
      edge.userData.reflective=material!=='wood';materials.push(edge);
      const bevelStart=positions.length/3;
      for(const face of bevel.faces.slice(sides))for(let i=1;i<face.ids.length-1;i++)for(const id of[face.ids[0],face.ids[i],face.ids[i+1]]){const v=bevel.vertices[id];positions.push(...mul(v,P.RADIUS));normals.push(...face.normal);uvs.push(v[0]*.5+.5,v[2]*.5+.5);}
      geometry.addGroup(bevelStart,positions.length/3-bevelStart,sides);
      geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new T.Float32BufferAttribute(normals,3));geometry.setAttribute('uv',new T.Float32BufferAttribute(uvs,2));
      const group=new T.Group(),solid=new T.Mesh(geometry,materials);solid.castShadow=true;solid.receiveShadow=true;group.add(solid);
      this.meshCache.set(key,group);
      // Bound GPU memory when exploring every die/material combination.
      while(this.meshCache.size>4){const oldest=this.meshCache.keys().next().value,evicted=this.meshCache.get(oldest);this.meshCache.delete(oldest);evicted.traverse(o=>{if(!o.isMesh)return;o.geometry.dispose();const textures=new Set();for(const mat of o.material){for(const name of['map','bumpMap','metalnessMap','specularColorMap','clearcoatMap','emissiveMap','starMotionMap'])if(mat[name])textures.add(mat[name]);mat.dispose();}textures.forEach(texture=>texture.dispose());});}
      return group.clone();
    }
    prepare(sides){this.currentSides=sides;for(const die of this.dice)this.scene.remove(die);const n=sides===100?10:sides;this.dice=Array.from({length:sides===100?2:1},(_,i)=>this.makeDie(n,sides===100&&i===0?'tens':'units'));for(const die of this.dice)this.scene.add(die);}
    render(){this.updateHeightGuide();this.renderer.render(this.scene,this.camera);}
    setHeightGuide(visible){
      if(visible&&!this.heightGuide){
        const group=new T.Group(),material=new T.LineBasicMaterial({color:0xf6d999,transparent:true,opacity:.85,depthTest:false});
        const segments=[];for(const cm of [5,10,15,20,25,28])segments.push(-.16,0,cm/3,.16,0,cm/3);segments.push(0,0,.03,0,0,28/3);
        const ruler=new T.LineSegments(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(segments,3)),material);ruler.renderOrder=20;group.add(ruler);
        const rings=[];for(let i=0;i<2;i++){const points=Array.from({length:65},(_,j)=>new T.Vector3(Math.cos(j/64*Math.PI*2)*.65,Math.sin(j/64*Math.PI*2)*.65,.035)),ring=new T.Line(new T.BufferGeometry().setFromPoints(points),material);ring.renderOrder=20;group.add(ring);rings.push(ring);}
        const current=new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(-.3,0,0),new T.Vector3(.3,0,0)]),new T.LineBasicMaterial({color:0xffffff,depthTest:false}));current.renderOrder=21;group.add(current);
        const label=document.createElement('span');label.className='height-readout';label.setAttribute('aria-hidden','true');const value=document.createElement('b'),note=document.createElement('span');note.textContent='5–28 cm · 松手投掷';label.append(value,note);this.canvas.parentElement.append(label);
        this.scene.add(group);this.heightGuide={group,rings,current,label,value};
      }
      if(this.heightGuide){this.heightGuide.group.visible=visible;this.heightGuide.label.hidden=!visible;this.render();}
    }
    updateHeightGuide(){
      const guide=this.heightGuide;if(!guide?.group.visible||!this.dice.length)return;
      const center=new T.Vector3();for(const die of this.dice)center.add(die.position);center.multiplyScalar(1/this.dice.length);
      guide.group.position.set(center.x,center.y,0);guide.current.position.z=center.z;
      guide.rings.forEach((ring,i)=>{ring.visible=i<this.dice.length;if(ring.visible)ring.position.set(this.dice[i].position.x-center.x,this.dice[i].position.y-center.y,this.bowlTray?.visible?(P.Bowl.heightAt(this.dice[i].position.x,this.dice[i].position.y)||0):0);});
      const projected=center.clone().project(this.camera),width=this.canvas.clientWidth,height=this.canvas.clientHeight,x=(projected.x+1)*width/2,y=(1-projected.y)*height/2;
      guide.value.textContent=Math.round(center.z*3)+' cm';const w=guide.label.offsetWidth||150,h=guide.label.offsetHeight||60;
      guide.label.style.left=Math.max(8,Math.min(width-w-8,x+24))+'px';guide.label.style.top=Math.max(60,Math.min(height-h-48,y-h/2))+'px';
    }
    apply(frame,next,t=0){this.dice.forEach((die,i)=>{die.position.fromArray(frame[i].p);die.quaternion.fromArray(frame[i].q);if(next){die.position.lerp(new T.Vector3().fromArray(next[i].p),t);die.quaternion.slerp(new T.Quaternion().fromArray(next[i].q),t);}});this.render();}
    prepareThrow(sides){
      this.setHeightGuide(false);this.setTrayShape(true);
      this.flightBounds=null;
      cancelAnimationFrame(this.frame);this.prepare(sides);this.setCloseup(false,false);
      this.dice.forEach(d=>d.quaternion.setFromEuler(new T.Euler(.3,.2,.15)));this.grabAt(0,0);
    }
    previewLaunch(launch){const initial=new P.Simulation(this.currentSides,0,this.material,launch).frames[0];this.apply(initial);}
    fitReleaseHeight(maxHeight=this.releaseHeight??3.15){
      this.flightBounds=new T.Box3(new T.Vector3(-P.RELEASE.halfX,-P.RELEASE.halfY,0),new T.Vector3(P.RELEASE.halfX,P.RELEASE.halfY,maxHeight+P.RADIUS));this.updateView(false);
    }
    grabSurfaceOrigin(clientX,clientY){
      const r=this.renderer.domElement.getBoundingClientRect(),ray=new T.Raycaster();
      ray.setFromCamera(new T.Vector2((clientX-r.left)/r.width*2-1,1-(clientY-r.top)/r.height*2),this.camera);
      const point=ray.ray.intersectPlane(new T.Plane(new T.Vector3(0,0,1),0),new T.Vector3())||new T.Vector3();
      return{atX:Math.max(-1,Math.min(1,point.x/P.RELEASE.halfX)),atY:Math.max(-1,Math.min(1,point.y/P.RELEASE.halfY))};
    }
    releasePoint(clientX,clientY){
      const r=this.renderer.domElement.getBoundingClientRect(),tower=!!this.towerStyle;
      const ray=new T.Raycaster();ray.setFromCamera(new T.Vector2((clientX-r.left)/r.width*2-1,1-(clientY-r.top)/r.height*2),this.camera);
      return ray.ray.intersectPlane(new T.Plane(new T.Vector3(0,0,1),tower?-20.8:-3.15),new T.Vector3())||new T.Vector3(0,0,tower?20.8:(this.releaseHeight??3.15));
    }
    grabOrigin(clientX,clientY){
      // The press ray selects the release plane; constrain only to the usable
      // tray / mouth. Pointer movement changes the arrow, never this anchor.
      this.grabScreen={x:clientX,y:clientY};
      const point=this.releasePoint(clientX,clientY),tower=!!this.towerStyle;
      return{atX:Math.max(-1,Math.min(1,point.x/(tower?2.8:P.RELEASE.halfX))),atY:Math.max(-1,Math.min(1,point.y/(tower?1.05:P.RELEASE.halfY)))};
    }
    beginGrab(){
      this.grabSaved={closeup:this.closeup,releaseHeight:this.releaseHeight,flightBounds:this.flightBounds,poses:this.dice.map(d=>({p:d.position.toArray(),q:d.quaternion.toArray()}))};
      this.setCloseup(false,false);
    }
    grabAt(atX,atY){
      const tower=!!this.towerStyle;
      this.dice.forEach((d,i)=>{const pair=this.dice.length===2;
        d.position.set(tower?atX*2.8:atX*P.RELEASE.halfX+(pair?(i?1:-1):0),tower?(pair?(i?.8:-.8)+atY*.1:atY*1.05):atY*P.RELEASE.halfY,tower?20.8:(this.releaseHeight??3.15));
      });this.render();
    }
    endGrab(cancel=false){
      const saved=this.grabSaved;this.grabSaved=null;
      if(cancel&&saved){this.releaseHeight=saved.releaseHeight;this.flightBounds=saved.flightBounds;this.apply(saved.poses);this.setCloseup(saved.closeup,false);}
    }
    throwDirection(dx,dy){
      if(this.grabScreen){
        const a=this.releasePoint(this.grabScreen.x,this.grabScreen.y),b=this.releasePoint(this.grabScreen.x+dx,this.grabScreen.y+dy),x=b.x-a.x,y=b.y-a.y,n=Math.hypot(x,y);
        return n>1e-6?{x:x/n,y:y/n}:{x:0,y:1};
      }
      // Fallback for programmatic callers without an active screen anchor.
      const right=new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld,0),up=new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld,1);
      const x=right.x*dx-up.x*dy,y=right.y*dx-up.y*dy,n=Math.hypot(x,y);
      return n>1e-6?{x:x/n,y:y/n}:{x:0,y:1};
    }
    async set(sides,values,animate=false,seed=0,launch=null){
      cancelAnimationFrame(this.frame);
      const held=this.dice.map(d=>({p:d.position.toArray(),q:d.quaternion.toArray()}));
      if(!animate)this.flightBounds=null;
      this.setCloseup(false,false);this.prepare(sides);
      // Rebuilt meshes must never appear at the origin while physics yields.
      if(animate)this.apply(held.length===this.dice.length?held:new P.Simulation(sides,seed,this.material,launch).frames[0]);
      const n=sides===100?10:sides,targets=values.map((v,i)=>sides===100&&i===0?v/10:n===10?v%10:v);
      if(!animate){
        const mesh=G.geometry(n),labels=G.labelsFor(n,mesh),frames=targets.map((value,i)=>{const face=mesh.faces[labels.indexOf(value)],q=new T.Quaternion().setFromUnitVectors(new T.Vector3(...face.normal),new T.Vector3(0,0,n===4?-1:1));const yaw=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),i?.35:-.3);q.premultiply(yaw);const height=-Math.min(...G.beveled(n,DiceMaterials.get(this.material).bevel).vertices.map(v=>new T.Vector3(...v).applyQuaternion(q).z))*P.RADIUS;return{p:[sides===100?(i?1.25:-1.25):0,0,height+.004],q:q.toArray()};});this.apply(frames);return;
      }
      this.setTrayShape(launch?.control==='tray-bowl-v12');
      const simulation=await P.simulateAsync(sides,seed,this.material,launch);this.lastSimulation=simulation;
      if(!this.motion.matches)this.apply(simulation.frames[0]);
      if(['tray-random-v4','tray-random-v6','tray-random-v9','tray-drag-v10','tray-crypto-v11','tray-bowl-v12'].includes(launch?.control)){
        this.flightBounds=new T.Box3();for(const frame of simulation.frames)for(const pose of frame)this.flightBounds.expandByPoint(new T.Vector3(...pose.p));this.flightBounds.expandByScalar(P.RADIUS);this.updateView(true);
      }
      if(this.motion.matches){this.apply(simulation.frames.at(-1));return simulation;}
      return new Promise((resolve,reject)=>{this.reject=reject;const start=performance.now();const tick=now=>{try{const progress=Math.max(0,(now-start)/1000*60*P.PLAYBACK_RATE),index=Math.min(Math.floor(progress),simulation.frames.length-1);this.apply(simulation.frames[index],simulation.frames[index+1],progress-index);if(index<simulation.frames.length-1)this.frame=requestAnimationFrame(tick);else{this.reject=null;resolve(simulation);}}catch(error){this.reject=null;reject(error);}};this.frame=requestAnimationFrame(tick);});
    }
  }
  root.WoodDice=WoodDice;
})(window);
