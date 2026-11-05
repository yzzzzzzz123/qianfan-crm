import {api,setCsrf,setSimulationIdentity} from './api.js';
const query=new URLSearchParams(location.search),member=Number(query.get('member')),key=query.get('authorization');
const status=document.querySelector('#status'),error=document.querySelector('#error');let authorization,sourceId,pollTimer;
const text=(selector,value)=>document.querySelector(selector).textContent=value;
async function refresh(){
 error.textContent='';clearTimeout(pollTimer);
 try{
  if(!Number.isSafeInteger(member)||member<=0||!/^[a-f0-9-]{36}$/.test(key||''))throw new Error('个人授权交接链接不完整');
  const me=await api('/auth/me');setCsrf(me.csrf);
  let owner=me.actor;
  if(me.developer){setSimulationIdentity(member);const identities=await api('/developer/identities');owner=identities.find(row=>row.id===member);if(!owner)throw new Error('这次授权对应的业务成员不可用');}else{setSimulationIdentity('');if(me.actor.id!==member)throw new Error('当前登录账号不是这次授权对应的 CRM 成员，请使用本人绑定的钉钉账号登录');}
  text('#identity',me.developer?`开发者 ${me.actor.name} · 当前模拟成员：${owner.name}。听记将关联至 ${owner.name}，审计保留实际操作者。`:`当前 CRM 成员：${owner.name}`);
  text('#accepted-text',me.developer?`我确认上述个人听记应关联到当前模拟成员 ${owner.name}，并以开发者身份完成关联。`:'我确认上述听记属于我使用的个人账号，并同意关联到我的 CRM 成员。');
  const prepared=await api('/minutes/personal/import',{method:'POST',body:{authorization_key:key}});
  const connections=await api('/minutes/connections');authorization=connections.authorization;
  if(!authorization||authorization.id!==prepared.id)throw new Error('当前授权状态已变化，请重新核验');
  document.querySelector('#preview').hidden=false;text('#account',`${authorization.candidate.accountName} · 个人听记`);
  const notes=document.querySelector('#notes');notes.replaceChildren();for(const item of authorization.candidate.preview||[]){const li=document.createElement('li'),time=document.createElement('time');li.append(document.createTextNode(item.title));time.textContent=new Date(item.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});li.append(time);notes.append(li);}
  const connected=authorization.status==='connected';document.querySelector('#handoff').hidden=connected||authorization.can_confirm;document.querySelector('#confirmation').hidden=connected||!authorization.can_confirm;
  if(connected){sourceId=prepared.source_id;status.textContent='个人听记已关联到当前 CRM 成员。';await progress();}
  else status.textContent=authorization.can_confirm?'个人只读授权已核验，请核对听记后确认关联。':'个人只读授权已核验，等待成员本人登录 CRM 确认关联。';
 }catch(e){error.textContent=e.message;status.textContent='关联尚未完成';document.querySelector('#confirmation').hidden=true;document.querySelector('#handoff').hidden=false;}
}
async function progress(){if(!sourceId)return;const result=await api('/minutes?'+new URLSearchParams({source_id:sourceId}));const run=result.runs?.[0];status.textContent=`已关联，已读取 ${result.count} 条听记。${run?.status==='running'?'正在分页读取…':run?.status==='failed'?'部分读取未完成，可在听记同步记录中继续。':run?.status==='partial'?'部分源正文或录音尚未提供，已有内容已保存。':''}`;if(run?.status==='running')pollTimer=setTimeout(()=>progress().catch(e=>error.textContent=e.message),2500);}
document.querySelector('#accepted').addEventListener('change',event=>document.querySelector('#confirm').disabled=!event.target.checked);
document.querySelector('#confirmation').addEventListener('submit',async event=>{event.preventDefault();const button=document.querySelector('#confirm');button.disabled=true;error.textContent='';try{const result=await api(`/minutes/authorizations/${authorization.id}/confirm`,{method:'POST',body:{accepted:document.querySelector('#accepted').checked}});sourceId=result.source_id;document.querySelector('#confirmation').hidden=true;status.textContent='已关联，正在读取已有听记…';await api(`/minutes/sources/${sourceId}/history`,{method:'POST',body:{}});await progress();}catch(e){error.textContent=e.message;button.disabled=false;}});
document.querySelector('#login').addEventListener('click',async()=>{try{sessionStorage.setItem('qf_personal_return',location.pathname+location.search);const result=await api('/auth/dingtalk/start');location.assign(result.url);}catch(e){error.textContent=e.message;}});
document.querySelector('#refresh').addEventListener('click',refresh);window.addEventListener('pagehide',()=>clearTimeout(pollTimer));void refresh();
