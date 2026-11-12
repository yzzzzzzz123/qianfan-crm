import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/fixture.mjs';
import {all,one,run,transaction} from '../server/database.mjs';
import {syncMinutesFollowup} from '../server/modules/minutes/followup.mjs';
import {salesAdviceSnapshot} from '../server/sales-advice.mjs';
import {activities as activityPage} from '../public/modules/activities.js';

async function setup(t) {
  const upstream={summary:{state:'ready',content:'隔离听记的原始摘要',reason:''},start:Date.parse('2026-10-15T17:30:00Z')};
  const client={async verify(){},async list(){return {items:[{uuid:'followup-round1',title:'隔离业务听记',startTime:upstream.start,durationMicros:120000000}],next:null};},
    async artifacts(){return {summary:upstream.summary,transcript:{state:'empty',content:'',reason:''},speaker_insights:{state:'empty',content:'',reason:''},quality:{state:'empty',content:'',reason:''}};},
    async audio(){return {state:'unavailable',reason:'尚未提供录音'};}};
  const f=await fixture(t,{minutesOptions:{enabled:true,clientFactory:()=>client}}),admin=await f.login(1),sales=await f.login(2),sourceId=randomUUID(),now=new Date().toISOString();
  run(f.db,"INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at) VALUES(?,2,'dingFollowup','followup-user','隔离听记账号','隔离组织',?,'connected','2026-10-01T00:00:00Z',?)",sourceId,randomUUID(),now);
  const id=Number(run(f.db,"INSERT INTO minutes_records(source_id,external_id,title,start_time,duration_ms,media_state,synced_at) VALUES(?,'followup-round1','隔离业务听记',?,120000,'unavailable',?)",sourceId,new Date(upstream.start).toISOString(),now).lastInsertRowid);
  const refresh=()=>f.request(`/minutes/records/${id}/refresh`,{actor:admin,method:'POST',body:{}});
  const associate=async opportunity_id=>{
    const revision=one(f.db,'SELECT revision FROM minutes_records WHERE id=?',id).revision;
    return f.request(`/minutes/records/${id}/association`,{actor:admin,method:'POST',body:{opportunity_id,revision,reason:'核对听记业务归属'}});
  };
  assert.equal((await refresh()).status,200);assert.equal((await associate(1)).status,200);
  return {...f,admin,sales,sourceId,id,upstream,refresh,associate};
}

test('待生成和失败摘要更换商机仍同步唯一摘要投影，日期使用北京时间且不改当前计划',async t=>{
  const f=await setup(t),before=one(f.db,'SELECT * FROM opportunities WHERE id=2'),old=one(f.db,'SELECT * FROM activities WHERE minutes_record_id=?',f.id);
  assert.equal(old.activity_date,'2026-10-16');
  for(const state of ['pending','failed']) {
    f.upstream.summary={state,content:'',reason:'隔离源状态'};assert.equal((await f.refresh()).status,200);
    const response=await f.associate(state==='pending'?2:1);assert.equal(response.status,200,JSON.stringify(response.body));
    const record=one(f.db,'SELECT * FROM minutes_records WHERE id=?',f.id),activity=one(f.db,'SELECT * FROM activities WHERE minutes_record_id=?',f.id);
    assert.equal(activity.id,old.id);assert.equal(activity.opportunity_id,record.opportunity_id);assert.equal(activity.summary,old.summary);
    const s=(await f.request('/state',{actor:f.admin})).body,a=s.activities.find(a=>a.id===old.id);
    assert.equal(a.source_state,state);assert.equal(a.source_stale,true);assert.equal(a.source_current,false);assert.match(a.source_notice,/上次成功读取/);
  }
  const after=one(f.db,'SELECT * FROM opportunities WHERE id=2');assert.equal(after.next_action,before.next_action);assert.equal(after.follow_date,before.follow_date);assert.equal(after.updated_at,before.updated_at);
  assert.equal(one(f.db,'SELECT count(*) n FROM activities WHERE minutes_record_id=?',f.id).n,1);
  assert.equal(one(f.db,'SELECT count(*) n FROM activity_events WHERE activity_id=?',old.id).n,0);
});

test('源起始时间变化时更新自动摘要发生日期，同步重跑不复制跟进或改变手工过程分',async t=>{
  const f=await setup(t),before=(await f.request('/state?month=2026-10',{actor:f.admin})).body.performance.find(p=>p.user_id===2).process,old=one(f.db,'SELECT * FROM activities WHERE minutes_record_id=?',f.id);
  f.upstream.start=Date.parse('2026-10-17T17:30:00Z');
  for(let i=0;i<2;i++)assert.equal((await f.request(`/minutes/sources/${f.sourceId}/sync`,{actor:f.admin,method:'POST',body:{}})).status,200);
  const after=one(f.db,'SELECT * FROM activities WHERE minutes_record_id=?',f.id);assert.equal(after.id,old.id);assert.equal(after.activity_date,'2026-10-18');
  assert.equal(one(f.db,'SELECT count(*) n FROM activities WHERE minutes_record_id=?',f.id).n,1);
  assert.deepEqual((await f.request('/state?month=2026-10',{actor:f.admin})).body.performance.find(p=>p.user_id===2).process,before);
});

test('空摘要撤下旧有效结论，原听记和账号保留，审计保存旧原文；再次ready可重建唯一投影',async t=>{
  const f=await setup(t),old=one(f.db,'SELECT * FROM activities WHERE minutes_record_id=?',f.id),source=one(f.db,'SELECT * FROM minutes_sources WHERE id=?',f.sourceId);
  f.upstream.summary={state:'empty',content:'',reason:'源平台确认空摘要'};assert.equal((await f.refresh()).status,200);
  assert.equal(one(f.db,'SELECT * FROM activities WHERE minutes_record_id=?',f.id),undefined);
  assert.ok(one(f.db,'SELECT id FROM minutes_records WHERE id=?',f.id));assert.deepEqual(one(f.db,'SELECT * FROM minutes_sources WHERE id=?',f.sourceId),source);
  const audit=JSON.parse(one(f.db,"SELECT detail FROM audit WHERE entity='minutes' AND entity_id=? AND action='撤下听记自动摘要' ORDER BY id DESC",f.id).detail);
  assert.equal(audit.before.summary,old.summary);assert.equal(audit.before.activity_date,old.activity_date);assert.equal(audit.before.opportunity_id,old.opportunity_id);
  f.upstream.summary={state:'ready',content:'重新核对后的有效摘要',reason:''};assert.equal((await f.refresh()).status,200);assert.equal((await f.refresh()).status,200);
  assert.equal(one(f.db,'SELECT count(*) n FROM activities WHERE minutes_record_id=?',f.id).n,1);assert.equal(one(f.db,'SELECT summary FROM activities WHERE minutes_record_id=?',f.id).summary,'重新核对后的有效摘要');
});

test('非当前听记摘要明显标注并排除销售AI上下文，读取失败不撤销已发生的接触，手工记录不受影响',async t=>{
  const f=await setup(t),old=one(f.db,'SELECT * FROM activities WHERE minutes_record_id=?',f.id),manual=all(f.db,'SELECT * FROM activities WHERE minutes_record_id IS NULL ORDER BY id');
  // Make the projection the newest business contact, then lose current source text.
  run(f.db,'UPDATE minutes_records SET start_time=? WHERE id=?',new Date().toISOString(),f.id);transaction(f.db,()=>syncMinutesFollowup(f.db,f.id));
  let state=(await f.request('/state',{actor:f.admin})).body;assert.equal(state.activities.find(a=>a.id===old.id).source_current,true);
  f.upstream.summary={state:'failed',content:'',reason:'读取超时'};assert.equal((await f.refresh()).status,200);
  state=(await f.request('/state',{actor:f.admin})).body;const a=state.activities.find(a=>a.id===old.id);assert.equal(a.source_current,false);
  const advice=salesAdviceSnapshot({state:()=>state,scoped:()=>one(f.db,'SELECT * FROM opportunities WHERE id=1')},one(f.db,'SELECT * FROM users WHERE id=1'),1);
  assert.ok(!advice.context.followups.some(x=>x.id===old.id));assert.match(activityPage(state,{}),/activity-source-notice/);assert.match(activityPage(state,{}),/上次成功读取的版本/);
  assert.deepEqual(all(f.db,'SELECT * FROM activities WHERE minutes_record_id IS NULL ORDER BY id'),manual);
  const expected=state.activities.find(x=>x.opportunity_id===1&&x.source_withdrawn!==true&&x.activity_type!=='系统')?.activity_date||null;
  assert.equal(state.opportunities.find(o=>o.id===1).last_interaction,expected);
  assert.equal(expected,a.activity_date);
});

test('带独立事件引用的旧投影撤下时保留事件与源记录，标明历史状态且重复刷新不重复审计',async t=>{
  const f=await setup(t),old=one(f.db,'SELECT * FROM activities WHERE minutes_record_id=?',f.id);
  run(f.db,"INSERT INTO activity_events(activity_id,opportunity_id,user_id,credited_user_id,source,activity_type,activity_date,summary,created_at) VALUES(?,1,2,2,'手动','线上会议','2026-10-16','独立历史依据','2026-10-16T00:00:00Z')",old.id);
  const events=all(f.db,'SELECT * FROM activity_events WHERE activity_id=?',old.id);
  f.upstream.summary={state:'empty',content:'',reason:'空摘要'};assert.equal((await f.refresh()).status,200);assert.equal((await f.refresh()).status,200);
  assert.deepEqual(all(f.db,'SELECT * FROM activity_events WHERE activity_id=?',old.id),events);assert.ok(one(f.db,'SELECT id FROM activities WHERE id=?',old.id));
  assert.equal(one(f.db,"SELECT count(*) n FROM audit WHERE entity='minutes' AND entity_id=? AND action='撤下听记自动摘要'",f.id).n,1);
  const state=(await f.request('/state',{actor:f.admin})).body,a=state.activities.find(a=>a.id===old.id);assert.equal(a.source_withdrawn,true);assert.equal(a.source_current,false);assert.match(a.source_notice,/历史版本/);
  assert.deepEqual(all(f.db,'PRAGMA foreign_key_check'),[]);
});

test('取消关联只撤下自动投影，源记录及手工跟进保持原样',async t=>{
  const f=await setup(t),manual=all(f.db,'SELECT * FROM activities WHERE minutes_record_id IS NULL ORDER BY id');
  const revision=one(f.db,'SELECT revision FROM minutes_records WHERE id=?',f.id).revision;
  const response=await f.request(`/minutes/records/${f.id}/association`,{actor:f.admin,method:'POST',body:{revision,customer_id:null,opportunity_id:null,reason:'取消错误业务关联'}});assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(one(f.db,'SELECT * FROM activities WHERE minutes_record_id=?',f.id),undefined);assert.ok(one(f.db,'SELECT id FROM minutes_records WHERE id=?',f.id));assert.deepEqual(all(f.db,'SELECT * FROM activities WHERE minutes_record_id IS NULL ORDER BY id'),manual);
  assert.deepEqual(all(f.db,'PRAGMA foreign_key_check'),[]);
});
