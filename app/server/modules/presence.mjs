import {all} from '../database.mjs';
import {assert} from '../domain.mjs';

const pages={intake:'AI接收',workbench:'工作台',customers:'客户档案',opportunities:'商机推进',activities:'跟进记录',minutes:'钉钉听记',contracts:'合同订单',analytics:'经营分析',funnel:'漏斗转化',assets:'客户资产',collections:'回款管理',performance:'绩效评定',commissions:'提成结算',personal:'个人作战看板',team:'团队管理',audit:'操作记录'};
const ttl=90000,idleAfter=120000;

// Presence is ephemeral and keyed to the real authenticated session, never an impersonated member.
export function createPresence(db){
 const tabs=new Map();
 const prune=(at)=>{for(const [key,tab] of tabs)if(at-tab.seen>=ttl||tab.expires<=at)tabs.delete(key);};
 function touch(session,body){
  assert(Object.keys(body).every(k=>['tab_id','page','visible','idle_ms','leave'].includes(k)),'在线状态字段无效');
  assert(typeof body.tab_id==='string'&&/^[a-zA-Z0-9-]{16,80}$/.test(body.tab_id),'页面编号无效');
  assert(Object.hasOwn(pages,body.page)&&typeof body.visible==='boolean'&&Number.isSafeInteger(body.idle_ms)&&body.idle_ms>=0&&body.idle_ms<=86400000,'在线状态无效');
  assert(body.leave===undefined||typeof body.leave==='boolean','离开状态无效');
  const at=Date.now(),key=session.sessionId+':'+body.tab_id;prune(at);
  if(body.leave){tabs.delete(key);return {ok:true};}
  const sessionTabs=[...tabs.entries()].filter(([,v])=>v.sessionId===session.sessionId);
  if(!tabs.has(key)&&sessionTabs.length>=20)tabs.delete(sessionTabs.sort((a,b)=>a[1].seen-b[1].seen)[0][0]);
  if(tabs.size>=4096&&!tabs.has(key))tabs.delete(tabs.keys().next().value);
  tabs.set(key,{sessionId:session.sessionId,userId:session.actor.id,expires:session.expires,page:body.page,visible:body.visible,activeAt:at-body.idle_ms,seen:at});
  return {ok:true};
 }
 function leave(sessionId){for(const [key,tab] of tabs)if(tab.sessionId===sessionId)tabs.delete(key);}
 function read(){
  const at=Date.now();prune(at);
  const sessions=new Map(all(db,'SELECT s.token,s.user_id,u.name,u.role,u.developer_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.expires>? AND u.active=1',at).map(s=>[s.token,s]));
  const users=new Map();
  for(const [key,tab] of tabs){
   const s=sessions.get(tab.sessionId);if(!s||s.user_id!==tab.userId){tabs.delete(key);continue;}
   if(s.developer_admin===1)continue;
   const row=users.get(s.user_id)||{id:s.user_id,name:s.name,role:s.developer_admin===1?'developer':s.role,tabs:[]};row.tabs.push(tab);users.set(row.id,row);
  }
  const members=[...users.values()].map(user=>{
   const visible=user.tabs.filter(t=>t.visible),recent=[...(visible.length?visible:user.tabs)].sort((a,b)=>b.activeAt-a.activeAt||b.seen-a.seen)[0];
   const lastActive=Math.max(...user.tabs.map(t=>t.activeAt));
   return {id:user.id,name:user.name,role:user.role,status:visible.length?(at-lastActive<idleAfter?'active':'idle'):'background',page:pages[recent.page],last_seen_at:new Date(Math.max(...user.tabs.map(t=>t.seen))).toISOString(),last_active_at:new Date(lastActive).toISOString(),tab_count:user.tabs.length};
  }).sort((a,b)=>({active:0,idle:1,background:2}[a.status]-{active:0,idle:1,background:2}[b.status])||a.name.localeCompare(b.name,'zh-CN'));
  return {members,online_count:members.length,active_count:members.filter(u=>u.status==='active').length,updated_at:new Date(at).toISOString(),heartbeat_seconds:15,expires_after_seconds:ttl/1000};
 }
 return {touch,leave,read};
}
