import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {one,run} from '../server/database.mjs';
import {businessDate,processLedger} from '../server/performance-ledger.mjs';
import {performanceFor} from '../server/modules/incentives.mjs';

const month='2025-10';
const rules=f=>JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value);
const performance=(f,id=2,m=month)=>performanceFor(f.db,rules(f),one(f.db,'SELECT * FROM users WHERE id=?',id),m);
async function setup(t){
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),other=await f.login(3);
  await f.request('/targets',{actor:admin,method:'POST',body:{user_id:2,quarter:'2025Q4',amount:900000}});
  return {...f,admin,sales,other};
}
async function activity(f,extra={},actor=f.sales){
  const r=await f.request('/activities',{actor,method:'POST',body:{opportunity_id:1,activity_type:'线上会议',activity_date:'2025-10-15',summary:'发生时归属的有效会议',update_plan:false,...extra}});
  assert.equal(r.status,200,JSON.stringify(r.body));
  return one(f.db,'SELECT * FROM activity_events WHERE activity_id=? ORDER BY id DESC',r.body.id);
}

test('北京时间月份统一：UTC月末创建归入次月，纯日期历史来源不做时区偏移',()=>{
  assert.equal(businessDate('2025-10-31T18:30:00Z'),'2025-11-01');
  assert.equal(businessDate('2025-11-01T02:30:00+08:00'),'2025-11-01');
  assert.equal(businessDate('2025-10-31'),'2025-10-31');
  assert.equal(businessDate('2025-11-01 02:30:00'),'2025-11-01');
  const opps=[{id:1,owner_id:2,amount:10000000,created_at:'2025-10-31T18:30:00Z'}],quotes=[{id:1,user_id:2,opportunity_id:1,created_at:'2025-10-31T18:30:00Z'}],events=[{id:1,activity_id:1,opportunity_id:1,user_id:2,credited_user_id:2,activity_date:'2025-11-01',activity_type:'对客报价'}];
  const oct=processLedger(opps,events,quotes,2,'2025-10'),nov=processLedger(opps,events,quotes,2,'2025-11');
  assert.equal(oct.process.raw,0);assert.equal(nov.process.funnelCount,1);assert.equal(nov.process.quote,1);assert.equal(nov.score_ledger.filter(x=>x.category==='quote'&&x.counted).length,1);
});

test('报价依据和计分同源：同日事件保留不计分说明，多份报价记录政策保持原状',()=>{
  const opps=[{id:1,owner_id:2,created_at:'2025-01-01',amount:10000000}];
  const events=[1,2].map(id=>({id,activity_id:1,opportunity_id:1,user_id:2,credited_user_id:2,activity_type:'对客报价',activity_date:'2025-10-15'}));
  const a=processLedger(opps,events,[],2,month);
  assert.equal(a.process.quote,1);assert.equal(a.category_scores.find(x=>x.key==='quote').record_count,2);assert.equal(a.score_ledger.filter(x=>x.counted).length,1);assert.match(a.score_ledger.find(x=>!x.counted).reason,/不重复计分/);
  const quotes=[1,2].map(id=>({id,user_id:2,opportunity_id:1,created_at:'2025-10-15T12:00:00Z'}));
  const b=processLedger(opps,events,quotes,2,month);assert.equal(b.process.quote,2);assert.equal(b.score_ledger.filter(x=>x.kind==='activity'&&x.counted).length,0);
});

test('商机移交和归档保留发生时贡献，原销售仅能看到本人历史事件而非接手者后续内容',async t=>{
  const f=await setup(t),event=await activity(f),before=performance(f).process.meeting;
  const moved=await f.request('/opportunities/1',{actor:f.admin,method:'PATCH',body:{owner_id:3,reason:'验证历史贡献不会移交'}});assert.equal(moved.status,200,JSON.stringify(moved.body));
  const follow=await activity(f,{summary:'新负责人后续内部沟通，请勿泄露'},f.other);
  assert.equal(performance(f).process.meeting,before);assert.equal(performance(f,3).process.meeting,1);
  run(f.db,"UPDATE opportunities SET archived_at='2025-11-01T00:00:00Z' WHERE id=1");
  assert.equal(performance(f).process.meeting,before);
  const s=(await f.request('/state?month='+month,{actor:f.sales})).body;
  assert.ok(!s.opportunities.some(o=>o.id===1));assert.ok(s.activityEvents.some(e=>e.id===event.id));assert.ok(!s.activityEvents.some(e=>e.id===follow.id));
  assert.ok(s.activities.some(a=>a.historical_only&&a.summary.includes(event.summary)));assert.ok(!JSON.stringify(s.activities).includes('新负责人后续内部沟通，请勿泄露'));
  const row=s.performance.find(p=>p.user_id===2).score_ledger.find(x=>x.event_id===event.id);assert.equal(row.counted,true);assert.equal(row.credited_user_id,2);assert.equal(row.recorder_name,s.users.find(u=>u.id===2).name);
});

test('新增商机初始归属可由最早移交前审计恢复，活动实际登记者和计分人独立保留',async t=>{
  const f=await setup(t);
  run(f.db,"UPDATE opportunities SET owner_id=2,created_at='2025-10-15T12:00:00Z' WHERE id=1");
  const event=await activity(f,{summary:'管理员代录，销售贡献保留'},f.admin);
  const before=performance(f),entry=before.score_ledger.find(x=>x.event_id===event.id);assert.equal(entry.recorded_user_id,1);assert.equal(entry.credited_user_id,2);assert.notEqual(entry.recorder_name,entry.credited_name);
  await f.request('/opportunities/1',{actor:f.admin,method:'PATCH',body:{owner_id:3,reason:'移交商机维护'}});
  assert.equal(performance(f).process.funnelCount,before.process.funnelCount);
  assert.equal(performance(f,3).score_ledger.filter(x=>x.kind==='opportunity'&&x.source_id===1).length,0);
});

test('停用销售历史快照仍可查，快照规则和等级阈值保留且新规则不改历史',async t=>{
  const f=await setup(t);await activity(f);
  const saved=await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month,status:'confirmed'}});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const frozen=one(f.db,'SELECT snapshot FROM performance_reviews WHERE user_id=2 AND month=?',month).snapshot;
  run(f.db,'UPDATE users SET active=0 WHERE id=2');
  await f.request('/rules',{actor:f.admin,method:'PATCH',body:{performance:{meeting:2,cap:20}}});
  const s=(await f.request('/state?month='+month,{actor:f.admin})).body,p=s.performance.find(x=>x.user_id===2);
  assert.ok(p);assert.equal(p.inactive,true);assert.equal(p.calculation_rules.meeting,.5);assert.ok(p.grade_rules_snapshot.some(g=>g.grade==='A'));assert.ok(p.review_meta.user_name);assert.equal(p.status,'confirmed');assert.equal(one(f.db,'SELECT snapshot FROM performance_reviews WHERE user_id=2 AND month=?',month).snapshot,frozen);
});

test('恢复人工评分要求说明，审计保留评分等级前后值与完全系统参考分',async t=>{
  const f=await setup(t);await activity(f);
  const save=body=>f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month,...body}});
  assert.equal((await save({final_score:90,reason:'按已核实工作情况设置'})).status,200);
  const p=performance(f);assert.equal(p.total,90);assert.notEqual(p.system_total,90);assert.equal(p.grade,'A');
  assert.equal((await save({final_score:''})).status,400);
  assert.equal((await save({final_score:'',reason:'原始依据补齐，恢复自动计算'})).status,200);
  const row=JSON.parse(one(f.db,"SELECT detail FROM audit WHERE entity='performance' ORDER BY id DESC").detail);
  assert.equal(row.restored_automatic,true);assert.equal(row.before.total,90);assert.equal(row.before.grade,'A');assert.equal(row.after.final_score,null);assert.equal(row.after.total,performance(f).system_total);
});

test('已锁月份的逐条计分状态来自快照，后补记录不被误标为已计分',async t=>{
  const f=await setup(t),original=await activity(f);
  await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month,status:'confirmed'}});
  const later=await activity(f,{activity_date:'2025-10-16',summary:'锁定后补记的真实会议'});
  const s=(await f.request('/state?month='+month,{actor:f.sales})).body,a=s.activityEvents.find(e=>e.id===original.id),b=s.activityEvents.find(e=>e.id===later.id);
  assert.equal(a.score.locked,true);assert.equal(a.score.counted,true);assert.equal(a.score.points,.5);assert.equal(b.score.locked,true);assert.equal(b.score.counted,false);assert.match(b.score.reason,/未纳入锁定评分/);
});

test('旧独立跟进也带同源得分与安全纠错版本，不把展示字段混入版本摘要',async t=>{
  const f=await setup(t);
  const id=Number(run(f.db,"INSERT INTO activities(opportunity_id,user_id,source,activity_type,summary,action,activity_date,created_at) VALUES(1,2,'手动','现场拜访','旧数据拜访验收','','2025-10-11','2025-10-11T00:00:00Z')").lastInsertRowid);
  const s=(await f.request('/state?month='+month,{actor:f.sales})).body,a=s.activities.find(x=>x.id===id);
  assert.equal(a.score.counted,true);assert.equal(a.score.points,1);assert.equal(a.can_edit,true);assert.equal(a.can_void,true);assert.match(a.legacy_version,/^[a-f0-9]{64}$/);
  const adminState=(await f.request('/state?month='+month,{actor:f.admin})).body;
  assert.equal(adminState.activities.find(x=>x.id===id).legacy_version,a.legacy_version);
  const detail=s.performance.find(x=>x.user_id===2).score_ledger.find(x=>x.kind==='activity'&&x.activity_id===id);
  assert.equal(detail.event_id,null);assert.equal(detail.points,a.score.points);
  run(f.db,"UPDATE opportunities SET owner_id=3,archived_at='2025-11-01T00:00:00Z' WHERE id=1");
  const historical=(await f.request('/state?month='+month,{actor:f.sales})).body,old=historical.activities.find(x=>x.id===id);
  assert.ok(old.historical_only);assert.equal(old.score.points,1);assert.equal(old.summary,'旧数据拜访验收');assert.ok(!historical.opportunities.some(o=>o.id===1));
});

test('旧快照不把碰撞报价ID当作活动依据，也不伪造旧重复报价事件的逐条得分',async t=>{
  const f=await setup(t),first=await activity(f,{activity_type:'对客报价'}),second=await activity(f,{activity_type:'对客报价',summary:'同日报价补充'});
  await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month,status:'confirmed'}});
  const snapshot=JSON.parse(one(f.db,'SELECT snapshot FROM performance_reviews WHERE user_id=2 AND month=?',month).snapshot);
  delete snapshot.score_ledger;
  snapshot.evidence.quotes=snapshot.evidence.quotes.map(x=>({id:x.source_id,activity_id:x.activity_id,opportunity_id:x.opportunity_id,activity_type:'对客报价',activity_date:x.date,summary:x.title}));
  const legacy=Number(run(f.db,"INSERT INTO activities(opportunity_id,user_id,source,activity_type,summary,activity_date,created_at) VALUES(1,2,'手动','现场拜访','编号碰撞验收','2025-10-11','2025-10-11T00:00:00Z')").lastInsertRowid);
  snapshot.evidence.quotes.push({id:legacy,opportunity_id:1,created_at:'2025-10-11T00:00:00Z',amount:5000000});
  run(f.db,'UPDATE performance_reviews SET snapshot=? WHERE user_id=2 AND month=?',JSON.stringify(snapshot),month);
  const s=(await f.request('/state?month='+month,{actor:f.sales})).body;
  for(const id of [first.id,second.id]){const e=s.activityEvents.find(x=>x.id===id);assert.equal(e.score.counted,null);assert.equal(e.score.points,null);assert.match(e.score.reason,/单条分值未保存/);}
  assert.equal(s.activities.find(x=>x.id===legacy).score.counted,false);
});
