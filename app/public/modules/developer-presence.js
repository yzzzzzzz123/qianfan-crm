import {esc,icon} from '../ui.js';

export function presenceControl(){
 return `<details class="developer-live" id="developer-live"><summary aria-label="查看实时在线成员"><span class="live-signal"></span><b>LIVE</b><span data-live-count>连接中</span>${icon('down')}</summary><section class="developer-live-popover" aria-label="当前使用人"><header><div><b>谁正在使用</b><p>全站使用状态 · 每 15 秒更新</p></div><span data-live-active></span></header><div class="developer-live-list" data-live-list aria-live="polite"><p class="live-empty">正在读取在线状态…</p></div><footer data-live-updated>仅开发人员可见</footer></section></details>`;
}
const roles={admin:'管理员',sales:'销售',pm:'协作PM',developer:'开发人员'};
const states={active:'使用中',idle:'空闲',background:'后台'};
const visibleMembers=members=>members.filter(user=>user.role!=='developer'&&user.developer_admin!==1&&user.developer_admin!==true);
export function presenceMembers(members){
 return visibleMembers(members).map(user=>`<article class="live-member"><span class="live-avatar ${esc(user.status)}">${esc(user.name.slice(-2))}<i></i></span><div><div class="live-member-name"><b>${esc(user.name)}</b><span>${esc(roles[user.role]||user.role)}</span></div><p>${esc(user.page)}${user.tab_count>1?` · ${user.tab_count} 个页面`:''}</p></div><span class="live-state ${esc(user.status)}">${esc(states[user.status]||'在线')}</span></article>`).join('')||'<p class="live-empty">当前没有在线成员</p>';
}

export function createPresenceController({getState,getPage,api}){
 const tabId=crypto.randomUUID();let active=false,busy=false,lastActivity=Date.now(),lastSend=0,cached=null,readError=false,generation=0;
 const payload=leave=>({tab_id:tabId,page:getPage(),visible:!document.hidden,idle_ms:Math.min(86400000,Math.max(0,Date.now()-lastActivity)),...(leave?{leave:true}:{})});
 function paint(){
  const host=document.querySelector('#developer-live');if(!host)return;
  const members=cached?visibleMembers(cached.members):[];
  host.classList.toggle('disconnected',readError);
  host.querySelector('[data-live-count]').textContent=readError?'连接中断':cached?`${members.length} 人在线`:'连接中';
  host.querySelector('[data-live-active]').textContent=cached&&!readError?`${members.filter(user=>user.status==='active').length} 人使用中`:'';
  host.querySelector('[data-live-list]').innerHTML=readError?'<p class="live-empty">暂时无法更新，正在自动重连</p>':cached?presenceMembers(cached.members):'<p class="live-empty">正在读取在线状态…</p>';
  host.querySelector('[data-live-updated]').textContent=cached&&!readError?`更新于 ${new Date(cached.updated_at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · 仅开发人员可见`:'仅开发人员可见';
 }
 async function tick(){
  if(!active||busy||!getState())return;busy=true;const requestGeneration=generation;
  try{
   await api('/auth/presence',{method:'POST',body:payload(false)});lastSend=Date.now();
   if(requestGeneration!==generation)return;
   if(getState()?.developer&&!document.hidden){
    const result=await api('/developer/presence');if(requestGeneration!==generation)return;cached=result;readError=false;paint();
   }
  }catch(error){
   if(requestGeneration!==generation)return;
   if(error.status===401){active=false;cached=null;}
   if(error.status===403)document.querySelector('#developer-live')?.setAttribute('hidden','');
   readError=true;paint();
  }finally{busy=false;}
 }
 function stop(){active=false;cached=null;readError=false;generation++;}
 function mount(){
  if(!getState())return;active=true;paint();
  const host=document.querySelector('#developer-live');
  if(host&&!host.dataset.bound){host.dataset.bound='true';host.addEventListener('toggle',()=>{if(host.open){const picker=document.querySelector('#developer-picker');if(picker)picker.open=false;void tick();}});}
  if(Date.now()-lastSend>1000)void tick();
 }
 const activity=()=>{const wasIdle=Date.now()-lastActivity>=120000;lastActivity=Date.now();if(wasIdle)void tick();};
 for(const event of ['pointerdown','keydown','pointermove','scroll','touchstart'])document.addEventListener(event,activity,{passive:true,capture:true});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)lastActivity=Date.now();void tick();});
 window.addEventListener('pagehide',()=>{if(active)void api('/auth/presence',{method:'POST',body:payload(true),keepalive:true}).catch(()=>{});});
 window.addEventListener('pageshow',()=>{if(getState()){active=true;void tick();}});
 document.addEventListener('click',event=>{const host=document.querySelector('#developer-live');if(host&&!event.target.closest('#developer-live'))host.open=false;});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'){const host=document.querySelector('#developer-live');if(host?.open){host.open=false;host.querySelector('summary').focus();}}});
 setInterval(()=>{if(getState()&&active)void tick();},15000);
 return {mount,stop};
}
