import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {one,all,run} from '../server/database.mjs';
import {formContent,renderPage} from '../public/views.js';

test('人工季度目标跨销售季度保存、更新回读、不重复行并留审计；销售不可修改',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),quarter='2027Q2';
  for(const amount of [456789.12,612345.67]) {
    const r=await f.request('/targets',{actor:admin,method:'POST',body:{user_id:2,quarter,amount}});assert.equal(r.status,200);
    assert.equal(one(f.db,'SELECT amount FROM targets WHERE user_id=2 AND quarter=?',quarter).amount,Math.round(amount*100));
  }
  assert.equal(one(f.db,'SELECT count(*) n FROM targets WHERE user_id=2 AND quarter=?',quarter).n,1);
  const s=(await f.request('/state',{actor:admin})).body,record=s.targets.find(t=>t.user_id===2&&t.quarter===quarter);
  assert.equal(record.amount,61234567);assert.equal(record.locked,false);assert.deepEqual(record.locked_months,[]);
  assert.ok(one(f.db,"SELECT id FROM audit WHERE action='配置季度目标' AND json_extract(detail,'$.quarter')=?",quarter));
  assert.equal((await f.request('/targets',{actor:sales,method:'POST',body:{user_id:2,quarter,amount:9}})).status,403);
  assert.deepEqual((await f.request('/state',{actor:sales})).body.targets,[]);
  for(const amount of [0,-1,'abc',1.001])assert.equal((await f.request('/targets',{actor:admin,method:'POST',body:{user_id:2,quarter,amount}})).status,400);
  run(f.db,'UPDATE users SET active=0 WHERE id=3');assert.equal((await f.request('/targets',{actor:admin,method:'POST',body:{user_id:3,quarter,amount:1000}})).status,400);
});

test('历史季度存在已确认绩效时列表带锁定月份，服务端拒绝改目标且快照不变',async t=>{
  const f=await fixture(t),admin=await f.login(1),quarter='2025Q4';
  assert.equal((await f.request('/targets',{actor:admin,method:'POST',body:{user_id:2,quarter,amount:900000}})).status,200);
  assert.equal((await f.request('/performance/review',{actor:admin,method:'POST',body:{user_id:2,month:'2025-10',adjustment:40,reason:'历史绩效验收',status:'confirmed'}})).status,200);
  const before=one(f.db,"SELECT snapshot FROM performance_reviews WHERE user_id=2 AND month='2025-10'").snapshot;
  const s=(await f.request('/state',{actor:admin})).body,tgt=s.targets.find(t=>t.user_id===2&&t.quarter===quarter);
  assert.equal(tgt.locked,true);assert.deepEqual(tgt.locked_months,['2025-10']);
  const html=renderPage(s,{view:'team',targetQuarter:quarter});assert.match(html,/已锁定/);assert.doesNotMatch(html,/data-action="target" data-id="2"/);
  assert.equal((await f.request('/targets',{actor:admin,method:'POST',body:{user_id:2,quarter,amount:1}})).status,409);
  assert.equal(one(f.db,'SELECT amount FROM targets WHERE user_id=2 AND quarter=?',quarter).amount,90000000);
  assert.equal(one(f.db,"SELECT snapshot FROM performance_reviews WHERE user_id=2 AND month='2025-10'").snapshot,before);
});

test('季度目标在团队逐人设置，绩效跳转团队且不重复录入入口，AI字段列表不含目标',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),s=(await f.request('/state',{actor:admin})).body;
  const form=formContent(s,'target',2,'2027Q3');assert.match(form,/data-form="target"/);assert.match(form,/name="user_id"/);assert.match(form,/value="2027Q3"/);assert.match(form,/name="amount"/);
  assert.doesNotMatch(form,/AI接收|name="text"/);
  const team=renderPage(s,{view:'team'}),performance=renderPage(s,{view:'performance'});
  assert.match(team,/class="panel target-settings"/);assert.match(team,/data-action="target" data-id="2"/);
  assert.doesNotMatch(team,/data-action="target" data-id=""/);
  assert.match(performance,/href="#team">季度目标<\/a>/);assert.doesNotMatch(performance,/data-action="target"/);
  assert.doesNotMatch(renderPage(s,{view:'intake'}),/data-guide="targets"/);
  const own=(await f.request('/state',{actor:sales})).body;assert.match(formContent(own,'target',2),/无权设置/);assert.doesNotMatch(renderPage(own,{view:'performance'}),/data-action="target"/);
});
