import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {one,all,run} from '../server/database.mjs';
import {today} from '../server/domain.mjs';
import {activityLegacyVersion} from '../server/modules/activity-corrections.mjs';

async function setup(t,date=today()) {
  const f=await fixture(t),sales=await f.login(2),admin=await f.login(1),other=await f.login(3);
  const before=one(f.db,'SELECT * FROM opportunities WHERE id=1');
  const response=await f.request('/activities',{actor:sales,method:'POST',body:{opportunity_id:1,activity_type:'现场拜访',source:'手动',summary:'纠错验收原始记录',action:'原始下一步',activity_date:date,update_plan:false}});
  assert.equal(response.status,200,JSON.stringify(response.body));
  const event=one(f.db,'SELECT * FROM activity_events WHERE activity_id=? ORDER BY id DESC',response.body.id);
  return {...f,sales,admin,other,before,event,version:event.updated_at||event.created_at};
}
test('原始事件纠错同步归并内容，保留登记者和计分人且不改当前计划，审计有前后值',async t=>{
  const f=await setup(t),r=await f.request('/activity-events/'+f.event.id,{actor:f.sales,method:'PATCH',body:{expected_updated_at:f.version,summary:'核对后的客户结论',activity_type:'线上会议',reason:'原类型选择错误'}});
  assert.equal(r.status,200,JSON.stringify(r.body));
  const e=one(f.db,'SELECT * FROM activity_events WHERE id=?',f.event.id),a=one(f.db,'SELECT * FROM activities WHERE id=?',e.activity_id),o=one(f.db,'SELECT * FROM opportunities WHERE id=1');
  assert.equal(e.user_id,2);assert.equal(e.credited_user_id,f.event.credited_user_id);assert.equal(e.updated_by,2);assert.ok(e.updated_at);assert.ok(a.summary.includes('核对后的客户结论'));assert.ok(!a.summary.includes('纠错验收原始记录'));
  assert.equal(o.next_action,f.before.next_action);assert.equal(o.follow_date,f.before.follow_date);
  const audit=JSON.parse(one(f.db,"SELECT detail FROM audit WHERE entity='activity_event' AND entity_id=? ORDER BY id DESC",e.id).detail);
  assert.equal(audit.before.summary,f.event.summary);assert.equal(audit.after.summary,e.summary);assert.equal(audit.reason,'原类型选择错误');assert.equal(audit.current_plan_updated,false);
});
test('纠错必须有原因与版本，其他销售不可修改，过期表单不覆盖新值',async t=>{
  const f=await setup(t),path='/activity-events/'+f.event.id,b={expected_updated_at:f.version,summary:'允许的纠错',reason:'已核对'};
  assert.equal((await f.request(path,{actor:f.other,method:'PATCH',body:b})).status,403);
  assert.equal((await f.request(path,{actor:f.sales,method:'PATCH',body:{...b,reason:''}})).status,400);
  assert.equal((await f.request(path,{actor:f.sales,method:'PATCH',body:{...b,expected_updated_at:''}})).status,409);
  assert.equal((await f.request(path,{actor:f.admin,method:'PATCH',body:b})).status,200);
  assert.equal((await f.request(path,{actor:f.sales,method:'PATCH',body:{...b,summary:'过期覆盖'}})).status,409);
  assert.equal(one(f.db,'SELECT summary FROM activity_events WHERE id=?',f.event.id).summary,'允许的纠错');
});
test('更正发生日期移动原始事件到对应日期组，不产生遗留时间线或重复事件',async t=>{
  const f=await setup(t,'2025-09-16'),before=one(f.db,'SELECT count(*) count FROM activity_events').count;
  const r=await f.request('/activity-events/'+f.event.id,{actor:f.sales,method:'PATCH',body:{expected_updated_at:f.version,activity_date:'2025-10-16',reason:'原发生月份录错'}});
  assert.equal(r.status,200,JSON.stringify(r.body));
  const e=one(f.db,'SELECT * FROM activity_events WHERE id=?',f.event.id),a=one(f.db,'SELECT * FROM activities WHERE id=?',e.activity_id);
  assert.notEqual(e.activity_id,f.event.activity_id);assert.equal(e.activity_date,'2025-10-16');assert.equal(a.activity_date,e.activity_date);assert.equal(one(f.db,'SELECT count(*) count FROM activity_events').count,before);
  const s=(await f.request('/state?month=2025-10',{actor:f.sales})).body;
  assert.ok(!s.activities.some(a=>a.id===f.event.activity_id));assert.ok(s.activityEvents.some(x=>x.id===e.id));
});
test('作废保留原始依据与审计，移出有效列表和自动计分，不能重复作废',async t=>{
  const f=await setup(t,'2025-09-16'),path='/activity-events/'+f.event.id+'/void',body={expected_updated_at:f.version,reason:'同一次拜访重复登记',confirmed:true};
  const before=(await f.request('/state?month=2025-09',{actor:f.sales})).body.performance.find(p=>p.user_id===2).process.visit;
  assert.equal((await f.request(path,{actor:f.sales,method:'POST',body:{...body,confirmed:false}})).status,400);
  assert.equal((await f.request(path,{actor:f.sales,method:'POST',body})).status,200);
  const e=one(f.db,'SELECT * FROM activity_events WHERE id=?',f.event.id);assert.ok(e.voided_at);assert.equal(e.summary,f.event.summary);
  const s=(await f.request('/state?month=2025-09',{actor:f.sales})).body;
  assert.equal(s.performance.find(p=>p.user_id===2).process.visit,before-1);assert.ok(!s.activities.some(a=>a.id===f.event.activity_id));assert.ok(s.activityEvents.some(x=>x.id===e.id&&x.voided_at));
  assert.equal((await f.request(path,{actor:f.sales,method:'POST',body})).status,409);
});
test('同日再次记录不会复活此前作废摘要或计分',async t=>{
  const f=await setup(t,'2025-09-16');
  await f.request('/activity-events/'+f.event.id+'/void',{actor:f.sales,method:'POST',body:{expected_updated_at:f.version,reason:'原记录无效',confirmed:true}});
  const r=await f.request('/activities',{actor:f.sales,method:'POST',body:{opportunity_id:1,activity_type:'线上会议',activity_date:'2025-09-16',summary:'独立发生的有效会议',update_plan:false}});
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.id,f.event.activity_id);
  const a=one(f.db,'SELECT * FROM activities WHERE id=?',r.body.id);assert.equal(a.summary,'独立发生的有效会议');assert.equal(a.activity_type,'线上会议');
});
test('已锁月份补录或纠错明确提示，历史快照完全不变',async t=>{
  const f=await setup(t,'2025-09-16');
  await f.request('/targets',{actor:f.admin,method:'POST',body:{user_id:2,quarter:'2025Q3',amount:900000}});
  const lock=await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month:'2025-09',status:'confirmed'}});assert.equal(lock.status,200,JSON.stringify(lock.body));
  const snapshot=one(f.db,"SELECT snapshot FROM performance_reviews WHERE user_id=2 AND month='2025-09'").snapshot;
  const edit=await f.request('/activity-events/'+f.event.id,{actor:f.sales,method:'PATCH',body:{expected_updated_at:f.version,summary:'锁定月事实纠错',reason:'核对原始纪要'}});
  assert.equal(edit.status,200);assert.match(edit.body.message,/2025-09绩效已锁定/);
  const add=await f.request('/activities',{actor:f.sales,method:'POST',body:{opportunity_id:1,activity_date:'2025-09-17',summary:'锁定月补录',update_plan:false}});assert.match(add.body.message,/已锁定评分/);
  assert.equal(one(f.db,"SELECT snapshot FROM performance_reviews WHERE user_id=2 AND month='2025-09'").snapshot,snapshot);
});
test('纠错不允许修改归属、关联对象和未来日期，数据库完整',async t=>{
  const f=await setup(t),path='/activity-events/'+f.event.id,body={expected_updated_at:f.version,reason:'校验字段'};
  for(const extra of [{credited_user_id:3},{opportunity_id:2},{activity_date:'2999-01-01'},{activity_type:'系统'}])assert.equal((await f.request(path,{actor:f.admin,method:'PATCH',body:{...body,...extra}})).status,400);
  assert.equal(all(f.db,'PRAGMA foreign_key_check').length,0);assert.equal(one(f.db,'PRAGMA integrity_check').integrity_check,'ok');
});
test('历史汇总仅保存时物化原始事件，保留旧计分归属，旧表单并发提交被拒绝',async t=>{
  const f=await fixture(t),sales=await f.login(2),admin=await f.login(1);
  const a=one(f.db,"SELECT * FROM activities WHERE user_id=2 AND activity_type='现场拜访' AND event_managed=0 AND minutes_record_id IS NULL ORDER BY id LIMIT 1");assert.ok(a);
  const month=a.activity_date.slice(0,7),before=(await f.request('/state?month='+month,{actor:sales})).body;
  const stateRecord=before.activities.find(x=>x.id===a.id);assert.equal(stateRecord.can_edit,true);assert.equal(stateRecord.legacy_version,activityLegacyVersion(a));
  const oldScore=before.performance.find(p=>p.user_id===2).process.visit,eventCount=one(f.db,'SELECT count(*) count FROM activity_events').count;
  const body={expected_updated_at:stateRecord.legacy_version,summary:'历史原文更正但保留原计分',reason:'迁移记录核对'},r=await f.request('/activities/'+a.id,{actor:sales,method:'PATCH',body});
  assert.equal(r.status,200,JSON.stringify(r.body));const e=one(f.db,'SELECT * FROM activity_events WHERE id=?',r.body.id);
  assert.equal(e.activity_id,a.id);assert.equal(e.user_id,a.user_id);assert.equal(e.credited_user_id,a.user_id);assert.equal(one(f.db,'SELECT count(*) count FROM activity_events').count,eventCount+1);
  const after=(await f.request('/state?month='+month,{actor:sales})).body;assert.equal(after.performance.find(p=>p.user_id===2).process.visit,oldScore);assert.equal(after.activityEvents.find(x=>x.id===e.id).summary,body.summary);
  assert.equal((await f.request('/activities/'+a.id,{actor:admin,method:'PATCH',body})).status,409);
});
test('历史汇总作废和无效请求不会遗留半物化记录',async t=>{
  const f=await fixture(t),sales=await f.login(2),a=one(f.db,"SELECT * FROM activities WHERE user_id=2 AND activity_type='现场拜访' AND event_managed=0 AND minutes_record_id IS NULL ORDER BY id LIMIT 1");
  const count=one(f.db,'SELECT count(*) count FROM activity_events').count,body={expected_updated_at:activityLegacyVersion(a),reason:'重复导入的历史拜访',confirmed:true};
  assert.equal((await f.request('/activities/'+a.id,{actor:sales,method:'PATCH',body:{...body,activity_date:'2999-01-01',confirmed:undefined}})).status,400);
  assert.equal(one(f.db,'SELECT count(*) count FROM activity_events').count,count);assert.equal(one(f.db,'SELECT event_managed FROM activities WHERE id=?',a.id).event_managed,0);
  const r=await f.request('/activities/'+a.id+'/void',{actor:sales,method:'POST',body});assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(one(f.db,'SELECT voided_at FROM activity_events WHERE id=?',r.body.id).voided_at);
  assert.equal(all(f.db,'PRAGMA foreign_key_check').length,0);
});
test('新增跟进归并旧记录时，旧记录维持登记者计分而新事件采用当前商机归属',async t=>{
  const f=await fixture(t),admin=await f.login(1),date='2025-09-16';
  run(f.db,"INSERT INTO activities(opportunity_id,user_id,source,activity_type,summary,activity_date,created_at) VALUES(1,1,'手动','现场拜访','管理员历史代录',?,'2025-09-16T00:00:00Z')",date);
  const id=one(f.db,"SELECT id FROM activities WHERE summary='管理员历史代录'").id;
  const r=await f.request('/activities',{actor:admin,method:'POST',body:{opportunity_id:1,activity_type:'现场拜访',source:'手动',activity_date:date,summary:'本次新登记的拜访',update_plan:false}});
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.id,id);
  const events=all(f.db,'SELECT * FROM activity_events WHERE activity_id=? ORDER BY id',id);assert.equal(events.length,2);assert.equal(events[0].credited_user_id,1);assert.equal(events[1].credited_user_id,2);
});
test('日期更正并入历史汇总时，目的记录物化不改变旧计分归属',async t=>{
  const f=await setup(t,'2025-09-16');
  run(f.db,"UPDATE opportunities SET owner_id=3 WHERE id=1");
  run(f.db,"INSERT INTO activities(opportunity_id,user_id,source,activity_type,summary,activity_date,created_at) VALUES(1,2,'手动','线上会议','移交前原始会议','2025-10-16','2025-10-16T00:00:00Z')");
  const r=await f.request('/activity-events/'+f.event.id,{actor:f.sales,method:'PATCH',body:{expected_updated_at:f.version,activity_date:'2025-10-16',reason:'原始凭证日期核对'}});
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(one(f.db,"SELECT credited_user_id FROM activity_events WHERE summary='移交前原始会议'").credited_user_id,2);
  assert.equal(all(f.db,'PRAGMA foreign_key_check').length,0);
});
