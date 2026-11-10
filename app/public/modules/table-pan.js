// One shared controller for every horizontally scrollable business table.
export function installTablePanning(doc=document){
 const win=doc.defaultView,watchedAnimations=new WeakSet();let drag=null,blockedClick=null,active=null,frame=0,syncing=false;
 const bar=doc.createElement('div');bar.className='viewport-table-scroll';bar.hidden=true;bar.setAttribute('aria-label','左右查看表格字段');bar.tabIndex=0;
 const track=doc.createElement('div');bar.append(track);doc.body.append(bar);
 const schedule=()=>{if(!frame)frame=win.requestAnimationFrame(update);};
 function update(){
  frame=0;
  const modal=doc.querySelector('dialog[open]'),scope=modal||doc.querySelector('#content')||doc;
  // A transforming drawer temporarily becomes the fixed bar's containing
  // block. Wait for its own opening animation before measuring coordinates.
  const opening=modal?.getAnimations?.().filter(animation=>animation.playState==='running')||[];
  if(opening.length){active=null;bar.hidden=true;for(const animation of opening)if(!watchedAnimations.has(animation)){watchedAnimations.add(animation);animation.finished.then(schedule,schedule);}return;}
  const candidates=[...scope.querySelectorAll('.table-scroll')].map(el=>({el,rect:el.getBoundingClientRect()})).filter(({el,rect})=>el.scrollWidth>el.clientWidth+2&&rect.width>0&&rect.top<win.innerHeight-80&&rect.bottom>100);
  candidates.sort((a,b)=>Math.abs(Math.max(80,a.rect.top)-win.innerHeight/3)-Math.abs(Math.max(80,b.rect.top)-win.innerHeight/3));
  const chosen=candidates[0];active=chosen?.el||null;bar.hidden=!active;
  if(!chosen)return;
  const parent=modal||doc.body;if(bar.parentElement!==parent)parent.append(bar);
  const left=Math.max(12,chosen.rect.left),right=Math.min(win.innerWidth-12,chosen.rect.right);
  bar.style.left=left+'px';bar.style.width=Math.max(0,right-left)+'px';bar.style.bottom='16px';track.style.width=active.scrollWidth+'px';
  if(bar.scrollLeft!==active.scrollLeft){syncing=true;bar.scrollLeft=active.scrollLeft;syncing=false;}
 }
 bar.addEventListener('scroll',()=>{if(active&&!syncing)active.scrollLeft=bar.scrollLeft;});
 doc.addEventListener('scroll',schedule,true);win.addEventListener('resize',schedule);
 doc.addEventListener('pointerdown',e=>{
  if(e.button!==0||e.pointerType==='touch'||e.target.closest('button,a,input,select,textarea,summary,[contenteditable]'))return;
  const el=e.target.closest('.table-scroll');if(!el||el.scrollWidth<=el.clientWidth+2)return;
  drag={el,start:e.clientX,left:el.scrollLeft,pointer:e.pointerId,moved:false};
 });
 doc.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.pointer)return;
  const distance=e.clientX-drag.start;if(!drag.moved&&Math.abs(distance)<6)return;
  if(!drag.moved){drag.moved=true;drag.el.classList.add('is-table-panning');drag.el.setPointerCapture(e.pointerId);}
  e.preventDefault();drag.el.scrollLeft=drag.left-distance;schedule();
 },{passive:false});
 const end=e=>{if(!drag||drag.pointer!==e.pointerId)return;if(drag.moved){blockedClick={el:drag.el,until:performance.now()+500};drag.el.classList.remove('is-table-panning');if(drag.el.hasPointerCapture(e.pointerId))drag.el.releasePointerCapture(e.pointerId);}drag=null;};
 doc.addEventListener('pointerup',end);doc.addEventListener('pointercancel',end);
 doc.addEventListener('click',e=>{if(blockedClick&&performance.now()<blockedClick.until&&blockedClick.el.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();blockedClick=null;}},true);
 new MutationObserver(schedule).observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
 schedule();
}
