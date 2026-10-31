(function(root){
  'use strict';
  const T=THREE;
  const material=(color,roughness=.8,extra={})=>new T.MeshStandardMaterial({color,roughness,...extra});
  function create(scene,wood,{wideTray=true}={}){
    const add=(geometry,mat,position=[0,0,0],parent=scene)=>{const m=new T.Mesh(geometry,mat);m.position.set(...position);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;};
    const box=(p,size,mat,parent)=>add(new T.BoxGeometry(...size),mat,p,parent);
    const cylinder=(p,top,bottom,height,mat,parent,segments=40)=>{const m=add(new T.CylinderGeometry(top,bottom,height,segments),mat,p,parent);m.rotation.x=Math.PI/2;return m;};
    const sphere=(p,scale,mat,parent)=>{const m=add(new T.SphereGeometry(1,20,12),mat,p,parent);m.scale.set(...scale);return m;};
    const tube=(points,radius,mat,parent)=>add(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p))),24,radius,8,false),mat,[0,0,0],parent);
    const rounded=(p,w,h,depth,radius,mat,parent)=>{
      const s=new T.Shape(),x=-w/2,y=-h/2,r=radius;
      s.moveTo(x+r,y);s.lineTo(x+w-r,y);s.quadraticCurveTo(x+w,y,x+w,y+r);s.lineTo(x+w,y+h-r);s.quadraticCurveTo(x+w,y+h,x+w-r,y+h);s.lineTo(x+r,y+h);s.quadraticCurveTo(x,y+h,x,y+h-r);s.lineTo(x,y+r);s.quadraticCurveTo(x,y,x+r,y);
      const g=new T.ExtrudeGeometry(s,{depth,bevelEnabled:false,curveSegments:10}),positions=g.getAttribute('position'),uv=g.getAttribute('uv');
      for(let i=0;i<positions.count;i++)uv.setXY(i,positions.getX(i)/w+.5,positions.getY(i)/h+.5);
      return add(g,mat,p,parent);
    };
    const texture=canvas=>{const t=new T.CanvasTexture(canvas);t.colorSpace=T.SRGBColorSpace;t.anisotropy=8;return t;};
    const canvas=(w,h,draw)=>{const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);return c;};
    const woodMap=texture(wood);woodMap.wrapS=woodMap.wrapT=T.RepeatWrapping;woodMap.repeat.set(2,1);
    const tableMaterial=material('#b6a68b',.78,{map:woodMap});
    const edgeWood=material('#574130',.7),brass=material('#b49a64',.4,{metalness:.68});
    const wallMaterial=material('#c6c4b8',1),floorMaterial=material('#657174',.95);
    // One unit is 3 cm: an 87 x 66 cm table, 73 cm above a real floor.
    box([0,0,-25.2],[150,150,.4],floorMaterial);
    const table=rounded([0,0,-1.3],29,22,.8,.7,tableMaterial);table.name='game-table';
    rounded([0,0,-1.42],28.8,21.8,.14,.65,edgeWood);
    for(const x of[-12.5,12.5])for(const y of[-8.6,8.6]){box([x,y,-13],[.85,.85,23.3],edgeWood);box([x,y,-24.825],[.87,.87,.35],brass);}
    for(const y of[-9,9])box([0,y,-2.6],[25.8,.5,2.5],edgeWood);
    for(const x of[-12.6,12.6])box([x,0,-2.6],[.5,18,2.5],edgeWood);
    // An inset leather play mat supports the tray exactly at z=-.42.
    const leatherMap=texture(canvas(512,512,(c,w,h)=>{c.fillStyle='#344b50';c.fillRect(0,0,w,h);for(let i=0;i<12000;i++){const x=(i*137)%w,y=(i*97+Math.floor(i/512)*31)%h;c.fillStyle=i%2?'#ffffff08':'#0000000a';c.fillRect(x,y,1,1);}}));
    const mat=rounded([0,-.35,-.5],18.5,14,.08,.8,material('#d0dbd7',.98,{map:leatherMap}));mat.name='leather-play-mat';
    const stitches=[];
    for(let x=-8.35;x<8.35;x+=.28)for(const y of[-6.95,6.25])stitches.push(x,y,-.413,x+.12,y,-.413);
    for(let y=-6.3;y<5.6;y+=.28)for(const x of[-8.85,8.85])stitches.push(x,y,-.413,x,y+.12,-.413);
    const seam=new T.LineSegments(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(stitches,3)),new T.LineBasicMaterial({color:'#9fada3',transparent:true,opacity:.5}));scene.add(seam);
    // Window is behind the table, with full walls continuing beyond the camera.
    const frame=material('#a39a83',.65),trim=material('#d7d2c3',.85);
    box([-25,12.3,3],[32,.45,64],wallMaterial);box([23,12.3,3],[36,.45,64],wallMaterial);
    box([-2,12.3,-10],[14,.45,28],wallMaterial);box([-2,12.3,31],[14,.45,28],wallMaterial);
    box([0,11.98,-24],[82,.25,1.5],trim);
    for(const x of[-9,-2,5])box([x,12.03,10.5],[.18,.5,13.2],frame);
    for(const z of[4,10.5,17])box([-2,12.03,z],[14.2,.5,.18],frame);
    box([-2,11.7,3.85],[14.8,1.3,.25],trim);
    // Soft linen panels hang from a rod; folds have actual depth and shadows.
    const linen=material('#c6bdab',1,{side:T.DoubleSide});
    tube([[-12,11.7,18.4],[8,11.7,18.4]],.075,brass);
    for(const x of[-12,8])tube([[x,12.08,18.4],[x,11.7,18.4]],.055,brass);
    for(const side of[-1,1]){
      const start=side<0?-12:5.35,positions=[],uv=[];
      for(let j=0;j<=1;j++)for(let i=0;i<=32;i++){const u=i/32;positions.push(start+u*2.55,11.65+Math.sin(u*Math.PI*8)*.22,18.1-j*17.3);uv.push(u,j);}
      const indices=[];for(let i=0;i<32;i++)indices.push(i,i+1,i+33,i+1,i+34,i+33);
      const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(positions,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();add(g,linen);
      for(let x=start+.12;x<start+2.5;x+=.4){const ring=add(new T.TorusGeometry(.14,.025,6,12),brass,[x,11.7,18.25]);ring.rotation.y=Math.PI/2;}
    }
    const skyCanvas=document.createElement('canvas');skyCanvas.width=768;skyCanvas.height=512;const skyTexture=texture(skyCanvas);
    const windowMaterial=new T.MeshBasicMaterial({map:skyTexture,toneMapped:false});
    const sky=add(new T.PlaneGeometry(14,13),windowMaterial,[-2,12.57,10.5]);sky.rotation.x=Math.PI/2;sky.castShadow=false;sky.receiveShadow=false;
    // Weighted base, articulated brass arm and a hollow enamel shade.
    const lampGroup=new T.Group();lampGroup.name='desk-lamp';scene.add(lampGroup);
    const enamel=material('#254d46',.4,{metalness:.2});
    cylinder([-10.8,3.9,-.36],1.22,1.38,.28,enamel,lampGroup);
    cylinder([-10.8,3.9,-.18],.25,.35,.12,brass,lampGroup);
    const mouth=new T.Vector3(-8.9,3.7,6.75),direction=new T.Vector3(0,-.5,.2).sub(mouth).normalize();
    const attachment=mouth.clone().addScaledVector(direction,-1.5);
    tube([[-10.8,3.9,-.12],[-10.8,3.9,3],[-10.4,4,5.4],attachment.toArray()],.09,brass,lampGroup);
    for(const p of[[-10.8,3.9,3],[-10.4,4,5.4],attachment.toArray()])sphere(p,[.19,.19,.19],enamel,lampGroup);
    const shade=new T.Group();shade.position.copy(mouth);shade.quaternion.setFromUnitVectors(new T.Vector3(0,-1,0),direction);lampGroup.add(shade);
    add(new T.CylinderGeometry(.53,1.45,1.45,48,1,true),enamel,[0,.725,0],shade);
    const lining=material('#e6d9b9',.8,{side:T.BackSide,emissive:'#ffc779',emissiveIntensity:.12});
    add(new T.CylinderGeometry(.51,1.42,1.43,48,1,true),lining,[0,.725,0],shade);
    const lip=add(new T.TorusGeometry(1.445,.045,8,48),brass,[0,0,0],shade);lip.rotation.x=Math.PI/2;
    add(new T.CylinderGeometry(.53,.53,.07,32),enamel,[0,1.47,0],shade);
    const bulbMaterial=material('#fff1c9',.3,{emissive:'#ffd28b',emissiveIntensity:2});
    const bulb=sphere([0,.28,0],[.24,.33,.24],bulbMaterial,shade);bulb.castShadow=false;
    const cableMat=material('#242c29',.95);
    tube([[-11.3,4,-.35],[-12.4,5,-.45],[-12.6,8,-.45],[-12,10.8,-.45],[-12,11.15,-3],[-12,11.15,-13],[-12,11.4,-15.15],[-12,11.72,-15]],.045,cableMat);
    box([-12,12,-15],[.7,.16,.9],trim);box([-12,11.85,-15],[.25,.25,.35],cableMat);
    // Light leaves the visible mouth of the shade and lights the same tray.
    if(wideTray){lampGroup.position.x-=1.2;mouth.x-=1.2;}
    const lamp=new T.SpotLight('#ffdb9c',120,40,.88,.65,2);lamp.name='desk-lamp-light';lamp.position.copy(mouth).addScaledVector(direction,.08);lamp.target.position.set(0,-.5,.2);lamp.castShadow=true;lamp.shadow.mapSize.set(1024,1024);lamp.shadow.camera.near=.15;lamp.shadow.camera.far=40;lamp.shadow.normalBias=.015;lamp.shadow.bias=-.00008;scene.add(lamp,lamp.target);
    // A flowering plant: hollow ceramic pot, soil, attached stems and leaves.
    const plant=new T.Group();plant.name='potted-flowers';plant.position.set(10.4,4.3,-.5);scene.add(plant);
    const ceramic=material('#c29470',.85),soil=material('#342a20',1),green=material('#3c6541',.85,{side:T.DoubleSide}),stemMat=material('#416847',.9);
    cylinder([0,0,.12],1.35,1.3,.24,ceramic,plant);
    const profile=[[.72,.24],[.78,.25],[1.08,1.7],[1.04,1.77],[.96,1.76],[.93,1.63],[.68,.32]].map(([r,y])=>new T.Vector2(r,y));
    const pot=add(new T.LatheGeometry(profile,48),ceramic,[0,0,0],plant);pot.rotation.x=Math.PI/2;
    cylinder([0,0,1.57],.95,.95,.08,soil,plant);
    for(let i=0;i<5;i++){
      const a=i*2.4,x=Math.cos(a)*(.6+i*.08),y=Math.sin(a)*(.55+i*.06),height=4.2+(i%3)*.6;
      tube([[0,0,1.6],[x*.25,y*.25,2.3],[x*.85,y*.85,height-.7],[x,y,height]],.035,stemMat,plant);
      for(let j=0;j<3;j++){
        const z=2+j*.64,t=(z-1.6)/(height-1.6),base=new T.Vector3(x*t,y*t,z),b=a+j*2.2;
        const tip=base.clone().add(new T.Vector3(Math.cos(b)*.9,Math.sin(b)*.9,.45));
        tube([base.toArray(),tip.toArray()],.019,stemMat,plant);
        const leaf=sphere(base.clone().lerp(tip,.7).toArray(),[.24,.67,.045],green,plant);
        leaf.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),tip.clone().sub(base).normalize());
      }
      const flower=new T.Group();flower.position.set(x,y,height);flower.rotation.set(.14*Math.cos(a),.22*Math.sin(a),a);plant.add(flower);
      const petals=material(i%2?'#d6a58d':'#e2c5a4',.92);
      for(let k=0;k<7;k++){const b=k*Math.PI*2/7,petal=sphere([Math.cos(b)*.26,Math.sin(b)*.26,.04],[.32,.15,.08],petals,flower);petal.rotation.z=b;}
      sphere([0,0,.11],[.16,.16,.12],material('#b89342',1),flower);
    }
    // A few useful objects make this a game table, with generous clear space.
    const paper=material('#ddd6c5',.96),bookCover=material('#985845',.9);
    const journal=new T.Group();journal.name='score-journal';journal.position.set(-10.8,-4.7,-.5);journal.rotation.z=-.13;scene.add(journal);
    rounded([0,0,.01],2.9,4.4,.12,.13,bookCover,journal);rounded([0,0,.13],2.7,4.2,.2,.1,paper,journal);rounded([0,0,.33],2.9,4.4,.08,.13,bookCover,journal);
    box([.94,0,.43],[.13,4.25,.025],material('#b49b71',.95),journal);
    for(let i=0;i<3;i++)box([-.16,.6-i*.23,.423],[1.5,.04,.014],brass,journal);
    const pencil=add(new T.CylinderGeometry(.065,.065,3.8,6),material('#c69852',.65),[-8.65,-4.7,-.435]);pencil.rotation.z=-.08;
    const tip=add(new T.ConeGeometry(.065,.3,6),material('#494338'),[-8.486,-2.656,-.435]);tip.rotation.z=-.08;
    const cards=new T.Group();cards.name='card-deck';cards.position.set(10.6,-4.8,-.5);cards.rotation.z=.16;scene.add(cards);
    rounded([0,0,0],2.3,3.5,.27,.14,paper,cards);
    const cardTexture=texture(canvas(256,384,(c,w,h)=>{c.fillStyle='#254d59';c.fillRect(0,0,w,h);c.strokeStyle='#c5ae7f';c.lineWidth=3;c.strokeRect(13,13,w-26,h-26);c.strokeRect(22,22,w-44,h-44);for(let y=40;y<h;y+=24)for(let x=38;x<w-20;x+=24){c.beginPath();c.moveTo(x,y-5);c.lineTo(x+4,y);c.lineTo(x,y+5);c.lineTo(x-4,y);c.closePath();c.stroke();}}));
    rounded([0,0,.275],2.25,3.45,.012,.12,material('#ffffff',.85,{map:cardTexture}),cards);
    for(const [x,y,color] of[[8.2,-5.3,'#a86c53'],[8.35,-5.35,'#c6aa70'],[8.2,-5.3,'#355b61']]){const i=scene.children.filter(o=>o.name==='game-token').length;const token=cylinder([x+(wideTray?1:0),y-(wideTray?1:0),-.43+i*.13],.52,.52,.13,material(color,.7));token.name='game-token';}
    const ambient=new T.HemisphereLight('#e4efff','#776046',1.1);ambient.position.set(0,0,1);scene.add(ambient);
    const sun=new T.DirectionalLight('#ffe3bb',2);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-19,right:19,top:24,bottom:-16,near:.5,far:65});sun.shadow.normalBias=.012;sun.shadow.bias=-.00008;scene.add(sun,sun.target);
    const bounce=new T.DirectionalLight('#d7e5ec',1.15);bounce.position.set(4,-6,5);scene.add(bounce);
    return{wallMaterial,tableMaterial,floorMaterial,skyCanvas,skyTexture,windowMaterial,ambient,sun,lamp,bounce,bulbMaterial,lining};
  }
  root.DiceRoom={create};
})(window);
