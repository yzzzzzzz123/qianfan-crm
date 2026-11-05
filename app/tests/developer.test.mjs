import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,customer } from './helpers/fixture.mjs';
import { run,one,all } from '../server/database.mjs';
import { sessionControl } from '../public/modules/developer-session.js';
import { auditView } from '../public/modules/audit.js';
import { api } from '../public/api.js';
import { refreshDailyReport } from '../server/scheduler.mjs';

async function developer(t,options={}) {
  const f=await fixture(t,{localIdentitySwitch:true,identityProvider:{loginConfigured:true,identity:async()=>({unionId:'verified-developer',seconds:7200})},...options});
  run(f.db,"INSERT INTO users(id,name,username,role,developer_admin,business_member,performance_enabled,created_at) VALUES(4,'余志政','developer_yu','admin',1,0,0,?)",new Date().toISOString());
  run(f.db,'INSERT INTO ding_identities VALUES(?,?)',4,'verified-developer');
  const result=await f.request('/auth/dingtalk/callback',{method:'POST',body:{code:'test-only-code'}});assert.equal(result.status,200);
  return {...f,operator:{cookie:result.cookie.split(';')[0],csrf:result.body.csrf}};
}

test('开发者直接进入业务成员工作区，切换保留真实会话并按目标权限隔离',async t=>{
  const f=await developer(t),actor=f.operator;
  const sessions=all(f.db,'SELECT * FROM sessions');assert.ok(sessions.every(s=>s.user_id===4));
  const targets=await f.request('/developer/identities',{actor});assert.equal(targets.status,200);assert.deepEqual(new Set(targets.body.map(u=>u.id)),new Set([1,2,3]));
  assert.equal((await f.request('/state',{actor})).body.actor.id,1);
  const selected=await f.request('/developer/identity',{actor,method:'POST',body:{memberId:2}});
  assert.equal(selected.status,200);assert.equal(selected.cookie,null);assert.deepEqual(all(f.db,'SELECT * FROM sessions'),sessions);
  const viewed=(await f.request('/state',{actor,headers:{'X-CRM-Act-As':'2'}})).body;
  assert.equal(viewed.actor.id,2);assert.equal(viewed.developer.operator.id,4);assert.ok(viewed.opportunities.every(o=>o.owner_id===2));assert.ok(viewed.commission.previews.every(p=>p.sales_id===2));
  assert.equal((await f.request('/state',{actor})).body.actor.id,1);
  const failed=await f.request('/rules',{actor,method:'PATCH',headers:{'X-CRM-Act-As':'2'},body:{thresholds:{线索:1}}});assert.equal(failed.status,403);
  const failedAttempt=one(f.db,"SELECT * FROM audit WHERE action='developer.test_request' ORDER BY id DESC LIMIT 1");
  assert.equal(failedAttempt.user_id,4);assert.equal(JSON.parse(failedAttempt.detail).request_id,failed.body.requestId);
  const saved=await f.request('/activities',{actor,method:'POST',headers:{'X-CRM-Act-As':'2'},body:{opportunity_id:1,summary:'开发者使用销售视角核对'}});assert.equal(saved.status,200);
  const audit=one(f.db,"SELECT * FROM audit WHERE action IN('记录跟进','归并跟进') ORDER BY id DESC LIMIT 1");assert.equal(audit.user_id,2);assert.equal(JSON.parse(audit.detail).operator_user_id,4);
  const attempted=one(f.db,"SELECT * FROM audit WHERE action='developer.test_request' ORDER BY id DESC LIMIT 1");assert.equal(attempted.user_id,4);assert.equal(JSON.parse(attempted.detail).request_id,JSON.parse(audit.detail).request_id);
  assert.equal((await f.request('/developer/identity',{actor,method:'POST',body:{memberId:4}})).status,404);
  assert.equal((await f.request('/developer/switch',{actor,method:'POST',body:{user_id:null}})).status,400);
});

test('普通管理员、销售和演示会话不能切换身份，也不能改绑开发者',async t=>{
  const f=await developer(t);
  const admin=await f.login(1),sales=await f.login(2),demoDeveloper=await f.login(4);
  for(const actor of [admin,sales,demoDeveloper]) {
    assert.equal((await f.request('/developer/identity',{actor,method:'POST',body:{memberId:3}})).status,403);
    assert.equal((await f.request('/state',{actor,headers:{'X-CRM-Act-As':'3'}})).status,403);
  }
  assert.equal((await f.request('/users/4',{actor:admin,method:'PATCH',body:{ding_union_id:'attacker'}})).status,403);
  run(f.db,'UPDATE users SET active=0 WHERE id=2');assert.equal((await f.request('/developer/identity',{actor:f.operator,method:'POST',body:{memberId:2}})).status,404);
});

test('开发者退出撤销实际会话，切换身份不能延长或替代登录',async t=>{
  const f=await developer(t),actor=f.operator;
  assert.equal((await f.request('/auth/logout',{actor,method:'POST',headers:{'X-CRM-Act-As':'2'}})).status,200);
  assert.equal((await f.request('/state',{actor,headers:{'X-CRM-Act-As':'2'}})).status,401);
});

test('多位开发者分别登录并切换业务身份，权限一致且均排除业务名单和激励',async t=>{
  const f=await fixture(t,{localIdentitySwitch:true,identityProvider:{loginConfigured:true,identity:async(_req,b)=>({unionId:b.code,seconds:3600})}});
  const members=[[4,'余志政'],[5,'孙笑天'],[6,'杨丽莉']];
  for(const [id,name] of members) {
    run(f.db,'INSERT INTO users(id,name,username,role,developer_admin,business_member,performance_enabled,created_at) VALUES(?,?,?,\'admin\',1,0,0,?)',id,name,'isolated_developer_'+id,new Date().toISOString());
    run(f.db,'INSERT INTO ding_identities VALUES(?,?)',id,'isolated-verified-'+id);
  }
  for(const [id] of members) {
    const r=await f.request('/auth/dingtalk/callback',{method:'POST',body:{code:'isolated-verified-'+id}});assert.equal(r.status,200);
    const actor={cookie:r.cookie.split(';')[0],csrf:r.body.csrf},s=(await f.request('/state',{actor})).body;
    assert.equal(s.actor.id,1);assert.equal(s.developer.operator.id,id);assert.equal(s.developer.impersonating,true);
    for(const list of [s.users,s.team,s.performance,s.commission.previews,s.developer.users])assert.ok(!list.some(u=>members.some(([did])=>[u.id,u.user_id,u.sales_id].includes(did))));
    const switched=await f.request('/developer/identity',{actor,method:'POST',body:{memberId:2}});assert.equal(switched.status,200);
    const own=(await f.request('/state',{actor,headers:{'X-CRM-Act-As':'2'}})).body;assert.equal(own.actor.id,2);assert.equal(own.actor.role,'sales');
    assert.equal((await f.request('/targets',{actor,method:'POST',body:{user_id:2,amount:100},headers:{'X-CRM-Act-As':'2'}})).status,403);
  }
});

test('未启用本机模式或撤销切换资格后，开发者不能绕回自己的业务工作区',async t=>{
  const remote=await developer(t,{localIdentitySwitch:false});
  assert.equal((await remote.request('/developer/identities',{actor:remote.operator})).status,403);
  assert.equal((await remote.request('/state',{actor:remote.operator})).status,403);
  const f=await developer(t);
  run(f.db,'UPDATE users SET developer_admin=0 WHERE id=4');
  assert.equal((await f.request('/developer/identities',{actor:f.operator})).status,403);
  for(const headers of [{},{'X-CRM-Act-As':'2'}]) {
    const denied=await f.request('/state',{actor:f.operator,headers});assert.equal(denied.status,403);assert.equal(denied.body.code,'DEVELOPER_FORBIDDEN');
  }
  assert.equal((await f.request('/auth/me',{actor:f.operator})).body.actor.business_member,false);
});

test('无效、停用及开发者本人均不可选，认证会话仍归实际登录者',async t=>{
  const f=await developer(t),actor=f.operator;
  for(const memberId of ['2x','-1','2.5',9007199254740992])assert.equal((await f.request('/developer/identity',{actor,method:'POST',body:{memberId}})).status,400);
  run(f.db,'UPDATE users SET active=0 WHERE id=2');
  for(const id of [2,4]) {
    const missing=await f.request('/state',{actor,headers:{'X-CRM-Act-As':String(id)}});assert.equal(missing.status,403);assert.equal(missing.body.code,'DEVELOPER_TARGET_UNAVAILABLE');
  }
  assert.equal((await f.request('/auth/me',{actor,headers:{'X-CRM-Act-As':'2'}})).body.actor.name,'余志政');
  assert.equal((await f.request('/developer/identities',{actor})).body.some(u=>[2,4].includes(u.id)),false);
  run(f.db,'UPDATE users SET active=0 WHERE business_member=1');
  assert.equal((await f.request('/state',{actor})).status,403);
  assert.deepEqual((await f.request('/developer/identities',{actor})).body,[]);
});

test('右上角只显示业务成员，操作审计仍可追溯开发者',async t=>{
  const f=await developer(t),actor=f.operator;
  const defaultState=(await f.request('/state',{actor})).body;
  const html=sessionControl(defaultState);assert.match(html,/开发者模式/);assert.match(html,/王宏 · 管理员/);assert.doesNotMatch(html,/余志政|本人身份|返回本人|实际登录者/);
  const simulated=(await f.request('/state',{actor,headers:{'X-CRM-Act-As':'2'}})).body;
  const controls=sessionControl(simulated);assert.match(controls,/祝天 · 销售/);assert.doesNotMatch(controls,/余志政|本人身份|返回本人/);
  await f.request('/activities',{actor,method:'POST',headers:{'X-CRM-Act-As':'2'},body:{opportunity_id:1,summary:'身份切换审计核对'}});
  const audit=auditView((await f.request('/state',{actor})).body);assert.match(audit,/实际登录者：余志政 · 当前模拟：祝天/);assert.match(audit,/模拟身份操作尝试/);
});

test('开发者不出现在业务名单和统计中，服务端禁止为其分配业务或激励',async t=>{
  const f=await developer(t),actor=f.operator;
  const state=(await f.request('/state',{actor})).body;
  for(const list of [state.users,state.team,state.developer.users])assert.ok(!list.some(u=>u.id===4));
  assert.ok(!state.performance.some(p=>p.user_id===4));assert.ok(!state.commission.previews.some(p=>p.sales_id===4));
  assert.equal((await f.request('/customers',{actor,method:'POST',body:customer({owner_id:4})})).status,400);
  assert.equal((await f.request('/targets',{actor,method:'POST',body:{user_id:4,amount:100}})).status,400);
  assert.equal((await f.request('/rules',{actor,method:'PATCH',body:{commission:{manager_id:4}}})).status,400);
  const saved=await f.request('/customers',{actor,method:'POST',body:customer()});assert.equal(saved.status,200);assert.equal(one(f.db,'SELECT owner_id FROM customers WHERE id=?',saved.body.id).owner_id,1);
  run(f.db,"UPDATE users SET role='sales',performance_enabled=1 WHERE id=4");
  const changed=(await f.request('/state',{actor})).body;assert.ok(!changed.performance.some(p=>p.user_id===4));assert.ok(!changed.commission.previews.some(p=>p.sales_id===4));assert.ok(!changed.team.some(p=>p.id===4));
  refreshDailyReport(f.db);const snapshot=JSON.parse(one(f.db,'SELECT snapshot FROM daily_reports ORDER BY day DESC LIMIT 1').snapshot);assert.ok(!snapshot.summary.some(u=>u.user_id===4));
});

test('标签页中过期的模拟身份自动清理并恢复默认业务成员',async t=>{
  const f=await developer(t),actor=f.operator;
  run(f.db,'UPDATE users SET active=0 WHERE id=2');
  const storage=new Map([['qf_act_as','2']]);
  const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else delete globalThis.sessionStorage;});
  const fetchActual=globalThis.fetch;
  t.mock.method(globalThis,'fetch',(url,options)=>fetchActual(f.base+url,{...options,headers:{...options.headers,Cookie:actor.cookie}}));
  const restored=await api('/state');assert.equal(restored.actor.id,1);assert.equal(restored.actor.name,'王宏');assert.equal(storage.has('qf_act_as'),false);
});
