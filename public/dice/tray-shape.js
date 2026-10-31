(function(root){
  'use strict';
  // Shared by visible velvet surface and rigid-body colliders. Units are 3 cm.
  const halfX=10,halfY=7,rimHeight=2.2,sectors=48,radii=[.55,.67,.79,.90,1];
  const z=r=>rimHeight*Math.pow(Math.max(0,(r-.55)/.45),2);
  function point(r,i,height=z(r)){const a=i/sectors*Math.PI*2,c=Math.cos(a),s=Math.sin(a);return[halfX*r*Math.sign(c)*Math.sqrt(Math.abs(c)),halfY*r*Math.sign(s)*Math.sqrt(Math.abs(s)),height];}
  const patches=[],hulls=[];
  const base=Array.from({length:sectors},(_,i)=>point(radii[0],i,0));
  hulls.push({vertices:[...base,...base.map(p=>[p[0],p[1],-.2])],faces:[Array.from({length:sectors},(_,i)=>i),Array.from({length:sectors},(_,i)=>2*sectors-1-i),...Array.from({length:sectors},(_,i)=>[i,sectors+i,sectors+(i+1)%sectors,(i+1)%sectors])]});
  for(let i=0;i<sectors;i++)patches.push([[0,0,0],base[i],base[(i+1)%sectors]]);
  for(let k=0;k<radii.length-1;k++)for(let i=0;i<sectors;i++){
    const top=[point(radii[k],i),point(radii[k+1],i),point(radii[k+1],i+1),point(radii[k],i+1)];
    patches.push([top[0],top[1],top[2]],[top[0],top[2],top[3]]);
    hulls.push({vertices:[...top,...top.map(p=>[p[0],p[1],-.2])],faces:[[0,1,2,3],[7,6,5,4],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]]});
  }
  function heightAt(x,y){for(const[a,b,c]of patches){const den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]),u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den,v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den;if(u>=-1e-8&&v>=-1e-8&&u+v<=1+1e-8)return u*a[2]+v*b[2]+(1-u-v)*c[2];}return null;}
  const shape={halfX,halfY,rimHeight,sectors,radii,point,patches,hulls,heightAt};root.DiceTrayShape=shape;if(typeof module!=='undefined')module.exports=shape;
})(typeof window==='undefined'?globalThis:window);
