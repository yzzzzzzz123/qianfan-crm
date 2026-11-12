import {bindCommittedSearch,isCompositionEvent,isSearchComposing} from './search-input.js';

// Keep native selects as the form and change-event contract; enhance all dynamic views.
export function installSearchSelects(){
 const controls=new WeakMap();let active=null,frame=0,serial=0;
 const labelFor=s=>(s.getAttribute('aria-label')||[...(s.closest('label')?.childNodes||[])].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').replace('*','').trim()||s.name||'选项');
 function close(){if(!active)return;const {menu,button}=active;menu.remove();button.setAttribute('aria-expanded','false');active=null;}
 function sync(s,c){const text=[...s.selectedOptions].map(o=>o.textContent).join('、')||'请选择';if(c.value.textContent!==text)c.value.textContent=text;c.wrap.hidden=s.hidden;c.button.disabled=s.disabled;c.button.setAttribute('aria-label',labelFor(s));c.button.classList.toggle('is-placeholder',!s.value);}
 function open(s,c){close();if(s.disabled)return;sync(s,c);const menu=document.createElement('div');menu.className='search-select-menu';menu.setAttribute('popover','manual');menu.innerHTML='<input class="search-select-query" type="search" placeholder="输入关键词搜索" aria-label="搜索选项" autocomplete="off"><div class="search-select-options" role="listbox"></div><div class="search-select-hint">↑↓选择 · Enter确认 · Esc关闭</div>';c.wrap.append(menu);
 const input=menu.querySelector('input'),list=menu.querySelector('[role=listbox]');list.id='select-options-'+(++serial);c.button.setAttribute('aria-controls',list.id);c.button.setAttribute('aria-expanded','true');let visible=[],index=-1;
 active={s,...c,menu};if(menu.showPopover)menu.showPopover();
 const place=()=>{const b=c.button.getBoundingClientRect(),max=Math.min(340,innerHeight-24),below=innerHeight-b.bottom-8;menu.style.width=Math.min(Math.max(b.width,240),innerWidth-24)+'px';menu.style.left=Math.min(Math.max(12,b.left),innerWidth-menu.offsetWidth-12)+'px';menu.style.maxHeight=Math.max(140,Math.min(max,below<180?b.top-16:below))+'px';menu.style.top=(below<180?Math.max(12,b.top-menu.offsetHeight-4):b.bottom+4)+'px';};
 const highlight=()=>{[...list.children].forEach((e,i)=>{e.classList.toggle('is-active',i===index);if(i===index){e.id=list.id+'-active';input.setAttribute('aria-activedescendant',e.id);e.scrollIntoView({block:'nearest'});}else e.removeAttribute('id');});};
 const choose=i=>{const o=visible[i];if(!o)return;if(s.multiple)o.selected=!o.selected;else s.value=o.value;s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));sync(s,c);if(s.multiple)render();else{close();c.button.focus();}};
 function render(){const q=input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);visible=[...s.options].filter(o=>!o.disabled&&!o.parentElement.disabled&&q.every(t=>(o.textContent+' '+o.value+' '+(o.parentElement.label||'')).toLocaleLowerCase().includes(t)));list.replaceChildren();for(const [i,o] of visible.entries()){const b=document.createElement('button');b.type='button';b.setAttribute('role','option');b.setAttribute('aria-selected',String(o.selected));b.textContent=(s.multiple?(o.selected?'☑ ':'☐ '):'')+(o.parentElement.tagName==='OPTGROUP'?o.parentElement.label+' · ':'')+o.textContent;b.addEventListener('click',()=>choose(i));list.append(b);}if(!visible.length){const p=document.createElement('p');p.textContent='没有匹配选项，请换个关键词';p.className='search-select-empty';list.append(p);}index=visible.findIndex(o=>o.selected);place();}
 bindCommittedSearch(menu,'.search-select-query',render);
 input.addEventListener('keydown',e=>{
   if(isCompositionEvent(e))return;
   if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(visible.length){index=(index+(e.key==='ArrowDown'?1:-1)+visible.length)%visible.length;highlight();}}
   if(e.key==='Enter'){e.preventDefault();if(index<0)index=0;choose(index);}
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();c.button.focus();}
   if(e.key==='Tab')close();
 });
 active.reposition=place;render();input.focus({preventScroll:true});
 }
 function enhance(){frame=0;for(const s of document.querySelectorAll('select')){if(s.dataset.searchSelect==='off')continue;let c=controls.get(s);if(!c){const wrap=document.createElement('span');wrap.className='search-select';s.before(wrap);wrap.append(s);const button=document.createElement('button');button.type='button';button.className='search-select-trigger';button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');const value=document.createElement('span');button.append(value);const arrow=document.createElement('span');arrow.textContent='⌄';arrow.setAttribute('aria-hidden','true');button.append(arrow);wrap.append(button);s.classList.add('search-select-native');s.tabIndex=-1;s.setAttribute('aria-hidden','true');c={wrap,button,value};controls.set(s,c);button.addEventListener('click',()=>active?.s===s?close():open(s,c));button.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp',' '].includes(e.key)){e.preventDefault();open(s,c);}});s.addEventListener('change',()=>sync(s,c));s.addEventListener('invalid',e=>{e.preventDefault();button.focus();open(s,c);});}sync(s,c);}}
 const observer=new MutationObserver(()=>{if(!frame)frame=requestAnimationFrame(enhance);if(active&&!active.s.isConnected)close();});observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','selected','label','hidden']});document.addEventListener('pointerdown',e=>{if(active&&!active.wrap.contains(e.target))close();});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&active&&!isCompositionEvent(e)){e.preventDefault();e.stopImmediatePropagation();close();}},true);
 document.addEventListener('scroll',e=>{if(active&&!active.menu.contains(e.target))active.reposition?.();},true);
 window.addEventListener('resize',()=>{if(isSearchComposing())active?.reposition?.();else close();});
 enhance();
}
