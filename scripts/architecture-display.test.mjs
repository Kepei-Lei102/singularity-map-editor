import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleArchitectureGeometry,architectureGeometry} from '../src/architectureData.js';
const fixture=()=>({objects:[
 {id:'a',geometry:{kind:'wall',a:{x:0,y:0},b:{x:0,y:12},thickness:100,material:'wall'},states:['active','off'],state:0,blocksWhen:[0]},
 {id:'a-door',opening:{wallId:'a',offset:3,width:3,openStates:[1,2]},states:['closed','open','off'],state:1},
 {id:'b',geometry:{kind:'wall',a:{x:6,y:0},b:{x:6,y:12},thickness:100,material:'wall'},states:['active','off'],state:1,blocksWhen:[0]},
 {id:'b-door',opening:{wallId:'b',offset:3,width:3,openStates:[1,2]},states:['closed','open','off'],state:2}
]});
test('only selected walls render; active open doorway remains visible',()=>{
 const m=fixture(),all=architectureGeometry(m,true),shown=visibleArchitectureGeometry(m);
 assert(all.some(r=>r.objectId==='b'));
 assert.deepEqual(new Set(shown.map(r=>r.objectId)),new Set(['a','a-door']));
 assert(shown.some(r=>r.objectId==='a-door'&&r.material==='opening'));
 m.objects[0].state=1;m.objects[1].state=2;m.objects[2].state=0;m.objects[3].state=0;
 const switched=visibleArchitectureGeometry(m);
 assert.deepEqual(new Set(switched.map(r=>r.objectId)),new Set(['b','b-door']));
 assert(switched.some(r=>r.objectId==='b-door'&&r.material==='door'));
});
test('glass and physical overrides remain visible, fully retracted partitions disappear',()=>{
 const m=fixture();m.objects[0].geometry.material='glass';delete m.objects[0].blocksWhen;
 assert(visibleArchitectureGeometry(m).some(r=>r.objectId==='a'));
 m.objects[2].physical={blocksMove:false,blocksSight:true};
 assert(visibleArchitectureGeometry(m).some(r=>r.objectId==='b'));
 m.objects[2].physical={blocksMove:false,blocksSight:false};
 assert(!visibleArchitectureGeometry(m).some(r=>r.objectId==='b'||r.objectId==='b-door'));
});
