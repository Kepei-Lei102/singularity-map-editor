(function(root){
  'use strict';
  const C=typeof CANNON!=='undefined'?CANNON:require('./vendor/cannon.global.js');
  const G=typeof DiceGeometry!=='undefined'?DiceGeometry:require('./geometry.js');
  const Core=typeof DiceCore!=='undefined'?DiceCore:require('./core.js');
  const Random=typeof DiceRandom!=='undefined'?DiceRandom:require('./random.js');
  const Materials=typeof DiceMaterials!=='undefined'?DiceMaterials:require('./materials.js');
  const versionFor=(material='wood',legacy=false)=>{Materials.get(material);const version=legacy?RELEASE_VERSION:VERSION;return material==='wood'?version:version+'-'+material+'-v1';};
  const LEGACY_BOX={halfX:5.5,halfY:3.5,wallHeight:1.3,wallThickness:.28},BOX={...LEGACY_BOX,halfX:8,halfY:5.2},RELEASE={halfX:5.8,halfY:2.9},RADIUS=.83,DT=1/960;
  const Bowl=typeof DiceTrayShape!=='undefined'?DiceTrayShape:require('./tray-shape.js');
  const vec=a=>new C.Vec3(...a);
  function readFace(mesh,quaternion,sides){
    let index=0,score=-Infinity;
    mesh.faces.forEach((f,i)=>{const z=quaternion.vmult(vec(f.normal)).z*(sides===4?-1:1);if(z>score){score=z;index=i;}});return{index,score};
  }
  // One scene unit is 3 cm. Length-normalized solver coordinates avoid
  // cannon-es absolute tolerances overwhelming millimetre-sized bevels.
  // Gravity/velocity are converted from SI; mass is kg and time is seconds.
  const SCALE=.03,VERSION='cannon-physical-v6',RELEASE_VERSION='cannon-physical-v5',STEPS_PER_FRAME=16,PLAYBACK_RATE=.42;
  function massProperties(mesh,density=650){
    let volume=0;const moments=[0,0,0];
    for(const face of mesh.faces)for(let i=1;i<face.ids.length-1;i++){
      const v=[face.ids[0],face.ids[i],face.ids[i+1]].map(id=>G.mul(mesh.vertices[id],RADIUS*SCALE));
      const tetra=Math.abs(G.dot(v[0],G.cross(v[1],v[2])))/6;volume+=tetra;
      for(let axis=0;axis<3;axis++){const[a,b,c]=v.map(p=>p[axis]);moments[axis]+=tetra*(a*a+b*b+c*c+a*b+a*c+b*c)/10;}
    }
    return{mass:volume*density,inertia:[moments[1]+moments[2],moments[0]+moments[2],moments[0]+moments[1]].map(v=>v*density)};
  }
  function createWorld(preset,pull=false,free=false,BOX=LEGACY_BOX,bowl=false){
    const world=new C.World({gravity:new C.Vec3(0,0,-9.81/SCALE),allowSleep:true});world.solver.iterations=32;world.solver.tolerance=1e-9;
    const wood=new C.Material('wood'),felt=new C.Material('felt'),wall=new C.Material('wall');
    world.addContactMaterial(new C.ContactMaterial(wood,felt,{friction:preset.friction,restitution:pull?Math.min(.60,preset.bounce+.18):preset.bounce,contactEquationStiffness:1e8,contactEquationRelaxation:4}));world.addContactMaterial(new C.ContactMaterial(wood,wall,{friction:.06,restitution:pull?preset.wallBounce+.12:preset.wallBounce,contactEquationStiffness:1e8,contactEquationRelaxation:4}));world.addContactMaterial(new C.ContactMaterial(wood,wood,{friction:.32,restitution:pull?.42:(preset.diceBounce??.28),contactEquationStiffness:1e8,contactEquationRelaxation:4}));
    if(bowl){
      const surface=new C.Body({mass:0,material:felt});surface.kind='floor';
      for(const hull of Bowl.hulls){
        const center=hull.vertices.reduce((p,v)=>p.map((x,i)=>x+v[i]/hull.vertices.length),[0,0,0]);
        surface.addShape(new C.ConvexPolyhedron({vertices:hull.vertices.map(v=>vec(v.map((x,i)=>x-center[i]))),faces:hull.faces}),vec(center));
      }
      world.addBody(surface);installContactSolver(world);return{world,wood};
    }
    const floor=new C.Body({mass:0,material:felt,shape:free?new C.Box(new C.Vec3(BOX.halfX,BOX.halfY,.08)):new C.Plane(),position:new C.Vec3(0,0,free?-.08:0)});floor.kind='floor';world.addBody(floor);
    for(const[x,y,hx,hy]of [[BOX.halfX+BOX.wallThickness/2,0,BOX.wallThickness/2,BOX.halfY+BOX.wallThickness],[-BOX.halfX-BOX.wallThickness/2,0,BOX.wallThickness/2,BOX.halfY+BOX.wallThickness],[0,BOX.halfY+BOX.wallThickness/2,BOX.halfX,BOX.wallThickness/2],[0,-BOX.halfY-BOX.wallThickness/2,BOX.halfX,BOX.wallThickness/2]]){
      const b=new C.Body({mass:0,material:wall,shape:new C.Box(new C.Vec3(hx,hy,BOX.wallHeight/2)),position:new C.Vec3(x,y,BOX.wallHeight/2)});b.kind='wall';world.addBody(b);
    }
    return{world,wood};
  }
  // Projected Gauss-Seidel impulses with a Coulomb bound from each actual
  // normal contact, including angular velocity in restitution. The bundled
  // solver's gravity-only friction cap underestimates friction during impact.
  function installContactSolver(world){
    world.narrowphase.enableFrictionReduction=false;
    world.solver.solve=function(dt,w){
      const eq=this.equations,n=eq.length;if(!n)return 0;
      const lambda=new Float64Array(n),rhs=new Float64Array(n),inv=new Float64Array(n),friction=new Map();
      for(const b of w.bodies){b.updateSolveMassProperties();b.vlambda.setZero();b.wlambda.setZero();}
      for(let i=0;i<n;i++){
        const e=eq[i];
        if(e instanceof C.ContactEquation){
          const saved=e.restitution;
          e.restitution=e.getImpactVelocityAlongNormal()>.02/SCALE?saved:0;
          rhs[i]=e.computeB(dt);
          const spin=e.bj.angularVelocity.dot(e.jacobianElementB.rotational)+e.bi.angularVelocity.dot(e.jacobianElementA.rotational);
          rhs[i]-=e.b*e.restitution*spin;e.restitution=saved;
        }else rhs[i]=e.computeB(dt);
        inv[i]=1/e.computeC();
      }
      for(let i=0;i<n;i++)if(eq[i] instanceof C.FrictionEquation){
        const e=eq[i],j=eq.findIndex(c=>c instanceof C.ContactEquation&&c.bi===e.bi&&c.bj===e.bj&&c.ri.distanceSquared(e.ri)<1e-12&&c.rj.distanceSquared(e.rj)<1e-12);
        const pair=w.getContactMaterial(e.bi.material,e.bj.material)||w.defaultContactMaterial;
        friction.set(i,{normal:j,mu:pair.friction});
      }
      const order=eq.map((e,i)=>i).sort((a,b)=>Number(friction.has(a))-Number(friction.has(b)));
      let iteration=0;
      for(;iteration<this.iterations;iteration++){
        let change=0;
        for(const i of order){
          const e=eq[i],f=friction.get(i),cap=f?f.mu*(f.normal<0?0:Math.max(0,lambda[f.normal])):null;
          const lo=f?-cap:e.minForce,hi=f?cap:e.maxForce;
          const next=Math.max(lo,Math.min(hi,lambda[i]+inv[i]*(rhs[i]-e.computeGWlambda()-e.eps*lambda[i]))),delta=next-lambda[i];
          lambda[i]=next;change+=Math.abs(delta);e.addToWlambda(delta);
        }
        if(change*change<this.tolerance*this.tolerance)break;
      }
      for(const b of w.bodies){b.vlambda.vmul(b.linearFactor,b.vlambda);b.velocity.vadd(b.vlambda,b.velocity);b.wlambda.vmul(b.angularFactor,b.wlambda);b.angularVelocity.vadd(b.wlambda,b.angularVelocity);}
      eq.forEach((e,i)=>e.multiplier=lambda[i]/dt);return iteration;
    };
  }
  class Simulation{
    constructor(sides,seed,material='wood',launch=null){
      this.launch=Core.normalizeLaunch(launch);
      const legacy=!!this.launch&&!['tray-random-v4','tray-random-v6','tray-random-v9','tray-drag-v10','tray-crypto-v11','tray-bowl-v12'].includes(this.launch.control);this.box=this.launch?.control==='tray-bowl-v12'?{...BOX,halfX:Bowl.halfX,halfY:Bowl.halfY,wallHeight:Bowl.rimHeight}:legacy?LEGACY_BOX:BOX;
      const preset=['tray-drag-v10','tray-crypto-v11','tray-bowl-v12'].includes(this.launch?.control)?Materials.forTray(material):Materials.get(material);this.material=material;this.version=(this.launch?.control==='tray-drag-v10'?versionFor(material).replace('physical-v6','physical-v9'):this.launch?.control==='tray-random-v9'?versionFor(material).replace('physical-v6','physical-v8'):this.launch?.control==='tray-random-v6'?versionFor(material).replace('physical-v6','physical-v7'):versionFor(material,legacy))+(this.launch?(this.launch.control==='tray-drag-v10'?'-gesture-v10':this.launch.control==='tray-random-v9'?'-gesture-v9':this.launch.control==='tray-random-v6'?'-gesture-v6':this.launch.control==='tray-random-v4'?'-gesture-v4':this.launch.control==='pull-v2'?'-gesture-v2':'-gesture-v1'):'');
      if(this.launch?.control==='tray-crypto-v11')this.version='cannon-physical-v10-'+material+'-crypto-v1';
      if(this.launch?.control==='tray-bowl-v12')this.version='cannon-physical-v11-'+material+'-crypto-v1';
      if(!Core.SIDES.includes(sides)||!Number.isSafeInteger(seed))throw new Error('无效的骰子或时间戳');
      this.sides=sides;this.dieSides=sides===100?10:sides;this.mesh=G.geometry(this.dieSides);this.collider=G.beveled(this.dieSides,preset.bevel);this.labels=G.labelsFor(this.dieSides,this.mesh);this.seed=seed;
      const {world,wood}=createWorld(preset,['pull-v2','tray-random-v4'].includes(this.launch?.control),['tray-random-v4','tray-random-v6','tray-random-v9','tray-drag-v10','tray-crypto-v11','tray-bowl-v12'].includes(this.launch?.control),this.box,this.launch?.control==='tray-bowl-v12');this.world=world;this.bodies=[];this.frames=[];this.steps=0;this.nudges=0;this.done=false;this.valid=false;this.reason=null;this.stableSince=0;this.stablePose=null;this.events={floor:0,wall:0,dice:0};
      const next=Core.seededUint32(String(seed)+':'+RELEASE_VERSION),random=()=>next()/4294967296;
      // Enter from anywhere around the tray, with a shared launch area for a pair.
      const heading=random()*Math.PI*2,spread=.9+random()*.1;
      const origin=[Math.cos(heading)*4.15*spread,Math.sin(heading)*2.15*spread];
      const shape=new C.ConvexPolyhedron({vertices:this.collider.vertices.map(v=>vec(G.mul(v,RADIUS))),faces:this.collider.faces.map(f=>f.ids)});
      const properties=massProperties(this.collider,preset.density);
      for(let i=0;i<(sides===100?2:1);i++){
        const pair=sides===100,offset=pair?(i===0?-1.05:1.05):0;
        const body=new C.Body({mass:properties.mass,material:wood,shape,allowSleep:true,sleepSpeedLimit:.035,sleepTimeLimit:.32,linearDamping:.025,angularDamping:.08});body.kind='dice';
        body.position.set(origin[0]-Math.sin(heading)*offset,origin[1]+Math.cos(heading)*offset,2.8+random()*.7);
        const u=random(),v=random(),w=random();body.quaternion.set(Math.sqrt(1-u)*Math.sin(2*Math.PI*v),Math.sqrt(1-u)*Math.cos(2*Math.PI*v),Math.sqrt(u)*Math.sin(2*Math.PI*w),Math.sqrt(u)*Math.cos(2*Math.PI*w));
        body.inertia.set(...properties.inertia.map(v=>v/(SCALE*SCALE)));body.invInertia.set(...properties.inertia.map(v=>SCALE*SCALE/v));body.updateInertiaWorld(true);
        // A higher ballistic arc creates a real apex, without pausing playback.
        // Independent broad X/Y aims vary the two launch components. Estimate
        // flight time only at release so stronger throws still aim into the tray;
        // all motion and contacts after release belong to the solver.
        const upward=1.15+random()*.45;
        const flight=(upward+Math.sqrt(upward*upward+2*9.81*(body.position.z-RADIUS)*SCALE))/9.81;
        const aimX=(random()-.5)*7,aimY=(random()-.5)*3.7;
        body.velocity.set((aimX-body.position.x)/flight,(aimY-body.position.y)/flight,upward/SCALE);body.angularVelocity.set((random()-.5)*24,(random()-.5)*24,(random()-.5)*18);
        body.addEventListener('collide',e=>{if(Math.abs(e.contact.getImpactVelocityAlongNormal())>.025/SCALE)this.events[e.body.kind]++;});world.addBody(body);this.bodies.push(body);
      }
      if(this.launch)this.applyLaunch();
      this.capture();
    }
    applyLaunch(){
      if(['tray-drag-v10','tray-crypto-v11','tray-bowl-v12'].includes(this.launch.control)){this.applyLivelyLaunch();return;}
      if(['tray-random-v6','tray-random-v9'].includes(this.launch.control)){this.applyBoundedLaunch();return;}
      if(this.launch.control==='tray-random-v4'){this.applyRandomLaunch();return;}
      const l=this.launch,next=Core.seededUint32(this.seed+':gesture:'+l.nonce),random=()=>next()/4294967296;
      const angle=Math.atan2(l.y,l.x)+(random()-.5)*1.0,power=Math.max(0,Math.min(1.2,l.power*(.78+random()*.44)+(random()-.5)*.16));
      const center=[l.atX*3.4,l.atY*1.45],liftNoise=random(),up=l.control==='pull-v2'?.82+power*.38+liftNoise*.10:.94+power*.52+liftNoise*.12;
      this.bodies.forEach((b,i)=>{
        const offset=this.sides===100?(i?1.0:-1.0):0;
        b.position.set(center[0]+offset,center[1],3.15);
        const flight=(up+Math.sqrt(up*up+2*9.81*(b.position.z-RADIUS)*SCALE))/9.81;
        const distance=1.7+power*4.0,limitX=l.control==='pull-v2'?2.8:3.5,limitY=l.control==='pull-v2'?1.1:1.7;
        const aimX=Math.max(-limitX,Math.min(limitX,center[0]+Math.cos(angle)*distance+(random()-.5)*.9));
        const aimY=Math.max(-limitY,Math.min(limitY,center[1]+Math.sin(angle)*distance+(random()-.5)*.7));
        b.velocity.set((aimX-b.position.x)/flight,(aimY-b.position.y)/flight,up/SCALE);
        b.angularVelocity.set((random()-.5)*(18+power*20),(random()-.5)*(18+power*20),(random()-.5)*28);
        const u=random(),v=random(),w=random();b.quaternion.set(Math.sqrt(1-u)*Math.sin(2*Math.PI*v),Math.sqrt(1-u)*Math.cos(2*Math.PI*v),Math.sqrt(u)*Math.sin(2*Math.PI*w),Math.sqrt(u)*Math.cos(2*Math.PI*w));b.updateInertiaWorld(true);
      });
    }
    applyRandomLaunch(){
      const l=this.launch,next=Core.seededUint32(this.seed+':random-release:'+l.nonce),random=()=>next()/4294967296;
      const angle=random()*Math.PI*2,speed=(.10+random()*.65)/SCALE,up=(.10+random()*1.35)/SCALE;
      this.bodies.forEach((b,i)=>{
        b.position.set(l.atX*RELEASE.halfX+(this.sides===100?(i?1:-1):0),l.atY*RELEASE.halfY,l.height/3);
        b.velocity.set(Math.cos(angle)*speed+(random()-.5)*3,Math.sin(angle)*speed+(random()-.5)*3,up);
        b.angularVelocity.set((random()-.5)*38,(random()-.5)*38,(random()-.5)*32);
        const u=random(),v=random(),w=random();b.quaternion.set(Math.sqrt(1-u)*Math.sin(2*Math.PI*v),Math.sqrt(1-u)*Math.cos(2*Math.PI*v),Math.sqrt(u)*Math.sin(2*Math.PI*w),Math.sqrt(u)*Math.cos(2*Math.PI*w));b.updateInertiaWorld(true);
      });
    }
    applyBoundedLaunch(){
      const l=this.launch,next=Core.seededUint32(this.seed+':bounded-release:'+l.nonce),random=()=>next()/4294967296;
      // Sample only initial conditions. Most releases aim at an inset area;
      // the remaining wider throws can miss. Never retry or steer a trajectory.
      const gentle=random()<.85,angle=random()*Math.PI*2;
      const target=[(random()-.5)*7,(random()-.5)*3.8],up=.10+random()*.25;
      const speed=.25+random()*.55;
      // Separate paired initial conditions without changing orientation draws or
      // touching either body after release. Historic v6 remains reproducible.
      const split=this.sides===100&&l.control==='tray-random-v9';
      const pairNext=Core.seededUint32(this.seed+':pair-release:'+l.nonce),pairRandom=()=>pairNext()/4294967296;
      const gapX=.6+pairRandom()*.6,gapY=(pairRandom()-.5)*1.2,liftGap=.14+pairRandom()*.12,high=pairRandom()<.5?0:1;
      this.bodies.forEach((b,i)=>{
        b.position.set(l.atX*RELEASE.halfX+(this.sides===100?(i?1:-1):0),l.atY*RELEASE.halfY,l.height/3);
        const sign=i?1:-1,lift=up+(split?(i===high?liftGap:0):0);
        const flight=(lift+Math.sqrt(lift*lift+2*9.81*(b.position.z-RADIUS)*SCALE))/9.81;
        const direction=angle+(split?sign*.16:0),pace=speed*(split?(i===high?1.1:.9):1);
        b.velocity.set(gentle?(target[0]+(split?sign*gapX:0)-b.position.x)/(flight+.12):Math.cos(direction)*pace/SCALE,
          gentle?(target[1]+(split?sign*gapY:0)-b.position.y)/(flight+.12):Math.sin(direction)*pace/SCALE,lift/SCALE);
        b.angularVelocity.set((random()-.5)*24,(random()-.5)*24,(random()-.5)*20);
        const u=random(),v=random(),w=random();b.quaternion.set(Math.sqrt(1-u)*Math.sin(2*Math.PI*v),Math.sqrt(1-u)*Math.cos(2*Math.PI*v),Math.sqrt(u)*Math.sin(2*Math.PI*w),Math.sqrt(u)*Math.cos(2*Math.PI*w));b.updateInertiaWorld(true);
      });
    }
    applyLivelyLaunch(){
      const l=this.launch,next=l.randomSeed?Random.stream(l.randomSeed,'tray'):Core.seededUint32(this.seed+':drag-release:'+l.nonce),random=()=>next()/4294967296;
      const up=.18+random()*.32,high=random()<.5?0:1,gap=.14+random()*.12;
      this.bodies.forEach((b,i)=>{
        b.position.set(l.atX*RELEASE.halfX+(this.sides===100?(i?1:-1):0),l.atY*RELEASE.halfY,l.height/3);
        // Each horizontal component has a real speed floor, even near the centre.
        const component=position=>{const inward=Math.abs(position)>1&&random()<.75,sign=inward?-Math.sign(position):(random()<.5?-1:1);return sign*(.24+random()*.46)/SCALE;};
        b.velocity.set(component(b.position.x),component(b.position.y),(up+(this.sides===100&&i===high?gap:0))/SCALE);
        b.angularVelocity.set((random()-.5)*30,(random()-.5)*30,(random()-.5)*24);
        const u=random(),v=random(),w=random();b.quaternion.set(Math.sqrt(1-u)*Math.sin(2*Math.PI*v),Math.sqrt(1-u)*Math.cos(2*Math.PI*v),Math.sqrt(u)*Math.sin(2*Math.PI*w),Math.sqrt(u)*Math.cos(2*Math.PI*w));b.updateInertiaWorld(true);
      });
    }
    capture(){this.frames.push(this.bodies.map(b=>({p:[b.position.x,b.position.y,b.position.z],q:[b.quaternion.x,b.quaternion.y,b.quaternion.z,b.quaternion.w]})));}
    stop(reason=null){this.done=true;this.reason=reason;this.valid=reason===null;if(this.steps%STEPS_PER_FRAME)this.capture();}
    step(){
      if(this.done)return;this.world.step(DT);this.steps++;if(this.steps%STEPS_PER_FRAME===0)this.capture();
      const free=['tray-random-v4','tray-random-v6','tray-random-v9','tray-drag-v10','tray-crypto-v11','tray-bowl-v12'].includes(this.launch?.control);
      const outside=b=>Math.abs(b.position.x)>this.box.halfX+RADIUS||Math.abs(b.position.y)>this.box.halfY+RADIUS;
      // A miss stays visible through its airborne arc and descent. The finite
      // floor in this mode cannot bounce it off an invisible surface outside.
      if(this.bodies.some(b=>b.position.z<-.5||outside(b)&&(!free||b.position.z<.6))){this.stop(free?'骰子飞出骰盘了，本次不计；重新悬起再试':'骰子越出骰盘，请重新掷骰');return;}
      if(this.steps%STEPS_PER_FRAME===0){
        const current=this.frames.at(-1);
        const stable=this.stablePose&&current.every((pose,i)=>Math.hypot(...pose.p.map((v,k)=>v-this.stablePose[i].p[k]))<.004&&Math.abs(pose.q.reduce((sum,v,k)=>sum+v*this.stablePose[i].q[k],0))>Math.cos(.006/2));
        if(!stable){this.stablePose=current;this.stableSince=this.steps;}
      }
      // A pose envelope also recognizes numerical contact chatter as rest; it
      // never moves a body or turns a cocked face into a valid result.
      if(this.steps>480&&(this.bodies.every(b=>b.sleepState===C.Body.SLEEPING)||this.steps-this.stableSince>960*.4)){
        this.stop(this.bodies.every(b=>readFace(this.mesh,b.quaternion,this.dieSides).score>.985)?null:'骰子倚在棱上，本次不计，请重新掷骰');return;
      }
      if(this.steps>=960*7)this.stop('骰子尚未停稳，本次不计，请重新掷骰');
    }
    finish(){
      if(!this.done)throw new Error('Simulation incomplete');
      // Read the raw solver orientation. No target result, relabelling, symmetry
      // transform, hidden retries or corrective impulse participates in a throw.
      const faces=this.valid?this.bodies.map(b=>this.labels[readFace(this.mesh,b.quaternion,this.dieSides).index]):[];
      const result=this.valid?{...Core.physicalResult(this.sides,this.seed,faces,this.version),material:this.material,...(this.launch?{launch:{...this.launch}}:{})}:null;
      return{frames:this.frames,duration:(this.frames.length-1)/60,events:this.events,mesh:this.mesh,collider:this.collider,labels:this.labels,nudges:0,valid:this.valid,reason:this.reason,result,version:this.version,material:this.material};
    }
  }
  function simulate(sides,seed,material='wood',launch=null){const simulation=new Simulation(sides,seed,material,launch);while(!simulation.done)simulation.step();return simulation.finish();}
  async function simulateAsync(sides,seed,material='wood',launch=null){const simulation=new Simulation(sides,seed,material,launch);while(!simulation.done){for(let i=0;i<240&&!simulation.done;i++)simulation.step();if(!simulation.done)await new Promise(resolve=>setTimeout(resolve,0));}return simulation.finish();}
  root.DicePhysics={Bowl,BOX,RELEASE,RADIUS,DT,SCALE,VERSION,PLAYBACK_RATE,Simulation,simulate,simulateAsync,readFace,massProperties,versionFor,installContactSolver};if(typeof module!=='undefined')module.exports=root.DicePhysics;
})(typeof window==='undefined'?globalThis:window);
