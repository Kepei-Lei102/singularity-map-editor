(function (root) {
  'use strict';
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const mul = (a, s) => a.map(v => v * s);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const norm = a => mul(a, 1 / Math.hypot(...a));
  const center = points => mul(points.reduce(add, [0, 0, 0]), 1 / points.length);
  function hull(vertices) {
    const found = new Map(), epsilon = 1e-6;
    for (let i=0; i<vertices.length; i++) for (let j=i+1; j<vertices.length; j++) for (let k=j+1; k<vertices.length; k++) {
      let n = cross(sub(vertices[j], vertices[i]), sub(vertices[k], vertices[i]));
      if (Math.hypot(...n) < epsilon) continue;
      n = norm(n);
      let d = dot(n, vertices[i]);
      const distances = vertices.map(v => dot(n, v) - d);
      if (distances.some(v => v > epsilon) && distances.some(v => v < -epsilon)) continue;
      if (d < 0) { n = mul(n, -1); d = -d; }
      const ids = vertices.map((v, id) => Math.abs(dot(n, v) - d) < epsilon ? id : -1).filter(id => id >= 0);
      const key = ids.join(',');
      if (found.has(key)) continue;
      const c = center(ids.map(id => vertices[id])), u = norm(sub(vertices[ids[0]], c)), v = cross(n, u);
      ids.sort((a,b) => Math.atan2(dot(sub(vertices[a], c),v), dot(sub(vertices[a],c),u)) - Math.atan2(dot(sub(vertices[b],c),v),dot(sub(vertices[b],c),u)));
      found.set(key, { ids, normal:n, distance:d, center:c, u, v });
    }
    return Array.from(found.values());
  }
  function geometry(sides) {
    let vertices = [], phi = (1 + Math.sqrt(5)) / 2;
    if (sides === 4) vertices = [[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1]];
    if (sides === 6) for (const x of [-1,1]) for (const y of [-1,1]) for (const z of [-1,1]) vertices.push([x,y,z]);
    if (sides === 8) vertices = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    if (sides === 20 || sides === 12) {
      for (const a of [-1,1]) for (const b of [-phi,phi]) vertices.push([0,a,b],[a,b,0],[b,0,a]);
      if (sides === 12) vertices = hull(vertices).map(f => mul(f.normal, 1 / f.distance));
    }
    if (sides === 10) {
      // Ten alternating equatorial vertices and two poles, forming ten planar kites.
      // A broad shoulder gives the familiar compact spinning-top silhouette.
      const ringHeight=(1-Math.cos(Math.PI/5))/(1+Math.cos(Math.PI/5));
      for (let i=0;i<10;i++) {
        const angle=i*Math.PI/5;
        vertices.push([1.02*Math.cos(angle),1.02*Math.sin(angle),(i%2?1:-1)*ringHeight]);
      }
      vertices.push([0,0,1],[0,0,-1]);
    }
    const radius = Math.max(...vertices.map(v => Math.hypot(...v)));
    vertices = vertices.map(v => mul(v,1 / radius));
    return { vertices, faces:hull(vertices) };
  }

  const bevelCache=new Map();
  function beveled(sides,width=.025){
    const key=`${sides}:${width}`;if(bevelCache.has(key))return bevelCache.get(key);
    const source=geometry(sides),vertices=[],faces=[],edges=new Map(),corners=source.vertices.map(()=>[]);
    function face(ids){
      const c=center(ids.map(i=>vertices[i]));let n=norm(cross(sub(vertices[ids[1]],vertices[ids[0]]),sub(vertices[ids[2]],vertices[ids[0]])));
      if(dot(n,c)<0)n=mul(n,-1);const u=norm(sub(vertices[ids[0]],c)),v=cross(n,u);
      ids.sort((a,b)=>Math.atan2(dot(sub(vertices[a],c),v),dot(sub(vertices[a],c),u))-Math.atan2(dot(sub(vertices[b],c),v),dot(sub(vertices[b],c),u)));
      return{ids,normal:n,center:c,distance:dot(n,c)};
    }
    source.faces.forEach(f=>{
      const ids=f.ids.map(id=>{const index=vertices.length;vertices.push(add(mul(source.vertices[id],1-width),mul(f.center,width)));corners[id].push(index);return index;});
      faces.push(face(ids.slice()));
      f.ids.forEach((id,i)=>{const next=(i+1)%f.ids.length,key=[id,f.ids[next]].sort((a,b)=>a-b).join(':');if(!edges.has(key))edges.set(key,[]);edges.get(key).push(ids[i],ids[next]);});
    });
    for(const ids of edges.values())faces.push(face(ids));for(const ids of corners)faces.push(face(ids));
    const mesh={vertices,faces};bevelCache.set(key,mesh);return mesh;
  }
  function labelsFor(sides, mesh) {
    const labels=Array(mesh.faces.length).fill(null);
    if(sides===10) {
      const north=mesh.faces.map((f,i)=>({f,i})).filter(({f})=>f.normal[2]>0).sort((a,b)=>Math.atan2(a.f.center[1],a.f.center[0])-Math.atan2(b.f.center[1],b.f.center[0]));
      north.forEach(({f,i},k)=>{labels[i]=k*2;const opposite=mesh.faces.findIndex(other=>dot(other.normal,f.normal)<-.999999);labels[opposite]=9-k*2;});
    } else if(sides===4) mesh.faces.forEach((f,i)=>labels[i]=mesh.vertices.findIndex((_,j)=>!f.ids.includes(j))+1);
    else {
      let next=1;mesh.faces.forEach((f,i)=>{if(labels[i]!=null)return;labels[i]=next;const opposite=mesh.faces.findIndex(other=>dot(other.normal,f.normal)<-.999999);labels[opposite]=sides+1-next;next++;});
    }
    return labels;
  }
  function symmetry(mesh, from, to) {
    const source=mesh.faces[from],target=mesh.faces[to];
    for(const targetId of target.ids) {
      const su=norm(sub(mesh.vertices[source.ids[0]],source.center)),sv=cross(source.normal,su);
      const tu=norm(sub(mesh.vertices[targetId],target.center)),tv=cross(target.normal,tu);
      const apply=p=>add(add(mul(tu,dot(su,p)),mul(tv,dot(sv,p))),mul(target.normal,dot(source.normal,p)));
      if(mesh.vertices.every(p=>mesh.vertices.some(q=>Math.hypot(...sub(apply(p),q))<1e-6)))return [apply([1,0,0]),apply([0,1,0]),apply([0,0,1])];
    }
    throw new Error('No rigid symmetry maps these dice faces');
  }
  root.DiceGeometry={geometry,beveled,hull,labelsFor,symmetry,add,sub,mul,dot,cross,norm,center};
  if(typeof module!=='undefined')module.exports=root.DiceGeometry;
})(typeof window==='undefined'?globalThis:window);
