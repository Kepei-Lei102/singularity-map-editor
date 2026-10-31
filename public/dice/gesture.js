(function(root){
  'use strict';
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  function measure(samples,now,size){
    const first=samples[0],last=samples.at(-1),dx=last.x-first.x,dy=last.y-first.y;
    const maxLength=Math.max(70,Math.min(200,size*.45));
    return{dx,dy,power:clamp(Math.hypot(dx,dy)/maxLength,0,1),maxLength};
  }
  function attach({target,canvas,renderer,canStart,onHold,onThrow,hint,rail=false,onCancel}){
    let active=null,suppressUntil=0,savedHint='';
    const doc=target.ownerDocument,win=doc.defaultView;
    const trail=doc.createElement('div');trail.className='throw-trail';trail.setAttribute('aria-hidden','true');
    trail.innerHTML='<i></i><span></span>';doc.body.append(trail);
    const bar=trail.querySelector('i'),label=trail.querySelector('span');
    function point(e){return{x:e.clientX,y:e.clientY,t:performance.now()};}
    function sample(e){active.samples.push(point(e));if(active.samples.length>40)active.samples.splice(1,1);}
    function display(e){
      const r=canvas.getBoundingClientRect(),m=measure(active.samples,performance.now(),Math.min(r.width,r.height));
      const start=active.samples[0],dx=e.clientX-start.x,dy=e.clientY-start.y;
      const anchor=rail?renderer.chargeAnchor():{x:start.x,y:start.y,angle:Math.atan2(dy,dx)};
      trail.hidden=false;trail.style.left=anchor.x+'px';trail.style.top=anchor.y+'px';
      bar.style.width=Math.min(m.maxLength,Math.hypot(dx,dy))+'px';bar.style.transform='rotate('+anchor.angle+'rad)';
      label.textContent=rail?'桌球力度 '+Math.round(m.power*100)+'% · 松手击发':(m.power<.25?'轻掷':m.power<.7?'顺势一掷':'用力一掷')+' '+Math.round(m.power*100)+'% · 松手投掷';
      if(hint)hint.textContent=rail?'松手击发桌球 · 沿轨道撞出骰子 · Esc 取消':'松手投掷 · Esc 取消';
    }
    function end(cancel,e){
      if(!active)return;
      const a=active;active=null;trail.hidden=true;
      if(target.hasPointerCapture?.(a.id))target.releasePointerCapture(a.id);
      if(!a.started)return;
      suppressUntil=performance.now()+600;renderer.endGrab(cancel);onHold(false);
      if(hint)hint.textContent=savedHint;
      if(cancel){onCancel?.();return;}
      const r=canvas.getBoundingClientRect(),m=measure(a.samples,performance.now(),Math.min(r.width,r.height)),direction=renderer.throwDirection(m.dx,m.dy);
      try{
        const nonce=crypto.getRandomValues(new Uint32Array(1))[0];
        const launch={...direction,power:m.power,atX:a.atX,atY:a.atY,nonce,control:'pull-v2'};
        Promise.resolve(onThrow(launch)).catch(error=>{if(hint)hint.textContent=error.message;});
      }catch(error){if(hint)hint.textContent='无法生成随机出手，请重新拉箭头再试。';}
    }
    target.addEventListener('pointerdown',e=>{
      if(active){if(e.pointerId!==active.id)end(true);return;}
      if(e.isPrimary===false||e.button!==0||!canStart())return;
      active={id:e.pointerId,samples:[point(e)],started:false};target.setPointerCapture(e.pointerId);
    });
    target.addEventListener('pointermove',e=>{
      if(!active||e.pointerId!==active.id)return;
      if(e.pointerType==='mouse'&&e.buttons===0){end(true);return;}
      sample(e);const first=active.samples[0];
      if(!active.started&&Math.hypot(e.clientX-first.x,e.clientY-first.y)<12)return;
      if(!active.started){if(!canStart()){end(true);return;}active.started=true;savedHint=(hint?(win.DiceI18n?.sourceText(hint)??hint.textContent):'');renderer.beginGrab();const origin=renderer.grabOrigin(first.x,first.y);active.atX=origin.atX;active.atY=origin.atY;renderer.grabAt(active.atX,active.atY);onHold(true);}
      e.preventDefault();display(e);
    });
    target.addEventListener('pointerup',e=>{if(!active||e.pointerId!==active.id)return;sample(e);if(active.started)display(e);end(active.started&&Math.hypot(e.clientX-active.samples[0].x,e.clientY-active.samples[0].y)<12,e);});
    target.addEventListener('pointercancel',()=>end(true));target.addEventListener('lostpointercapture',()=>end(true));
    target.addEventListener('click',e=>{if(active?.started||(e.detail!==0&&performance.now()<suppressUntil)){e.preventDefault();e.stopImmediatePropagation();}},{capture:true});
    target.addEventListener('dragstart',e=>e.preventDefault());
    win.addEventListener('blur',()=>end(true));win.addEventListener('keydown',e=>{if(e.key==='Escape'&&active){e.preventDefault();end(true);}});
    doc.addEventListener('visibilitychange',()=>{if(doc.hidden)end(true);});
    trail.hidden=true;return{cancel:()=>end(true),get holding(){return !!active?.started;}};
  }
  function attachRandom({target,canvas,renderer,canStart,onHold,onThrow,hint,getHeight,getSides=()=>6}){
    const doc=target.ownerDocument,win=doc.defaultView;let active=null,suppressUntil=0;
    function end(cancel){
      if(!active)return;const a=active;active=null;suppressUntil=performance.now()+600;
      if(target.hasPointerCapture?.(a.id))target.releasePointerCapture(a.id);
      renderer.endGrab(cancel);onHold(false);if(hint)hint.textContent=a.hint;
      if(!cancel)Promise.resolve(onThrow(a.launch)).catch(error=>{if(hint)hint.textContent=error.message;});
    }
    function begin(e){
      if(active){if(e.pointerId!==active.id)end(true);return;}
      if(e.isPrimary===false||e.button!==0||!canStart())return;
      try{
        const choice=getHeight(),nonce=crypto.getRandomValues(new Uint32Array(1))[0];
        const height=choice.mode==='fixed'?choice.height:8+nonce%21;
        renderer.beginGrab();const origin=renderer.grabSurfaceOrigin(e.clientX,e.clientY);
        active={id:e.pointerId,hint:(hint?(win.DiceI18n?.sourceText(hint)??hint.textContent):''),launch:{control:getSides()===100?'tray-random-v9':'tray-random-v6',...origin,height,heightMode:choice.mode,nonce}};
        renderer.releaseHeight=height/3;renderer.grabAt(origin.atX,origin.atY);renderer.fitReleaseHeight();onHold(true);
        if(e.pointerId!==0)target.setPointerCapture(e.pointerId);e.preventDefault();if(hint)hint.textContent=(choice.mode==='random'?'本次随机高度 ':'出手高度 ')+height+' cm · 松手随机出手 · Esc 取消';
      }catch(error){if(active)end(true);if(hint)hint.textContent='无法准备投掷，请重试。';}
    }
    target.addEventListener('pointerdown',begin);
    target.addEventListener('pointermove',e=>{if(!active||e.pointerId!==active.id)return;if(e.pointerType==='mouse'&&e.buttons===0)end(true);else e.preventDefault();});
    target.addEventListener('pointerup',e=>{if(active?.id===e.pointerId)end(false);});
    target.addEventListener('pointercancel',()=>end(true));target.addEventListener('lostpointercapture',()=>end(true));
    target.addEventListener('click',e=>{
      if(active||e.detail!==0&&performance.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}
      else if(e.detail===0&&canStart()){const r=canvas.getBoundingClientRect();begin({pointerId:0,button:0,clientX:r.left+r.width/2,clientY:r.top+r.height/2,preventDefault(){}});end(false);e.preventDefault();e.stopImmediatePropagation();}
    },{capture:true});
    target.addEventListener('dragstart',e=>e.preventDefault());
    win.addEventListener('blur',()=>end(true));win.addEventListener('keydown',e=>{if(e.key==='Escape'&&active){e.preventDefault();end(true);}});doc.addEventListener('visibilitychange',()=>{if(doc.hidden)end(true);});
    return{cancel:()=>end(true),get holding(){return !!active;}};
  }
  function attachHeight({target,canvas,renderer,canStart,onHold,onThrow,hint,getHeight,onHeight,onCancel}){
    const doc=target.ownerDocument,win=doc.defaultView;let active=null,suppressUntil=0;
    function preview(e){const origin=renderer.grabSurfaceOrigin(e.clientX,e.clientY);renderer.releaseHeight=getHeight()/3;renderer.grabAt(origin.atX,origin.atY);return origin;}
    function display(e){
      const r=canvas.getBoundingClientRect(),height=Math.round(clamp(active.height+(active.y-e.clientY)*23/Math.max(160,r.height*.6),5,28));
      active.launch.height=height;renderer.releaseHeight=height/3;renderer.grabAt(active.launch.atX,active.launch.atY);onHeight(height);
      if(hint)hint.textContent='上下滑动以调整初始高度 · '+height+' cm · 松手投掷 · Esc 取消';
    }
    function end(cancel){
      if(!active)return;const a=active;active=null;suppressUntil=performance.now()+600;
      if(target.hasPointerCapture?.(a.id))target.releasePointerCapture(a.id);
      renderer.setHeightGuide?.(false);renderer.endGrab(cancel);if(cancel){onHeight(a.height);onCancel?.(a.launch);}onHold(false);if(hint)hint.textContent=a.hint;
      if(!cancel)Promise.resolve(onThrow(a.launch)).catch(error=>{if(hint)hint.textContent=error.message;});
    }
    function begin(e){
      if(active){if(e.pointerId!==active.id)end(true);return;}
      if(e.isPrimary===false||e.button!==0||!canStart())return;
      const randomSeed=DiceRandom.seed(),height=getHeight();renderer.beginGrab();const origin=preview(e);
      active={id:e.pointerId,y:e.clientY,height,hint:(hint?(win.DiceI18n?.sourceText(hint)??hint.textContent):''),launch:{control:'tray-bowl-v12',...origin,height,heightMode:'fixed',randomSeed}};renderer.previewLaunch?.(active.launch);
      onHold(true);renderer.setHeightGuide?.(true);if(e.pointerId!==0)target.setPointerCapture(e.pointerId);e.preventDefault();display(e);
    }
    target.addEventListener('pointerdown',begin);
    target.addEventListener('pointermove',e=>{if(active){if(e.pointerId!==active.id)return;if(e.pointerType==='mouse'&&e.buttons===0)end(true);else{e.preventDefault();display(e);}}else if(e.isPrimary!==false&&canStart())preview(e);});
    target.addEventListener('pointerup',e=>{if(active?.id===e.pointerId){display(e);end(false);}});
    target.addEventListener('pointercancel',()=>end(true));target.addEventListener('lostpointercapture',()=>end(true));
    target.addEventListener('click',e=>{if(active||e.detail!==0&&performance.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}else if(e.detail===0&&canStart()){const r=canvas.getBoundingClientRect();begin({pointerId:0,button:0,clientX:r.left+r.width/2,clientY:r.top+r.height/2,preventDefault(){}});end(false);e.preventDefault();e.stopImmediatePropagation();}},{capture:true});
    target.addEventListener('dragstart',e=>e.preventDefault());
    win.addEventListener('blur',()=>end(true));win.addEventListener('keydown',e=>{if(e.key==='Escape'&&active){e.preventDefault();end(true);}});doc.addEventListener('visibilitychange',()=>{if(doc.hidden)end(true);});
    return{cancel:()=>end(true),get holding(){return !!active;}};
  }
  root.DiceGesture={measure,attach,attachRandom,attachHeight};if(typeof module!=='undefined')module.exports=root.DiceGesture;
})(typeof window==='undefined'?globalThis:window);
