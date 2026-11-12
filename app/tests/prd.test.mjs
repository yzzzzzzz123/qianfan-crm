import {historicalCommission} from './helpers/historical-commission.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,customer,opp,archiveContract } from './helpers/fixture.mjs';
import { today,quarter,dateAdd } from '../server/domain.mjs';
import {one,run} from '../server/database.mjs';
async function participant(f,admin,role='sales') {
  const r=await f.request('/users',{actor:admin,method:'POST',body:{name:'验收'+role,username:'prd_'+role,dingtalk_only:true,role}});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id;
}
async function account(f,admin,user,extra={}) {
  const r=await f.request('/customers',{actor:admin,method:'POST',body:customer({owner_id:user,...extra})});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id;
}
async function deal(f,admin,customerId,amount,extra={}) {
  const {historicalRates,...fields}=extra;
  const r=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:customerId,name:'PRD验收合同',sign_date:today(),items:[{name:'实施服务',kind:'实施',amount}],...fields}});assert.equal(r.status,200,JSON.stringify(r.body));
  await archiveContract(f,admin,r.body.id);
  // Explicit historical financial fixtures exercise preserved settlement calculations.
  // Current contracts never receive these legacy rates from the runtime API.
  if(historicalRates){
    run(f.db,"UPDATE contracts SET commission_policy='legacy' WHERE id=?",r.body.id);
    const items=f.db.prepare('SELECT id,amount FROM contract_items WHERE contract_id=? ORDER BY id').all(r.body.id);
    items.forEach((item,i)=>run(f.db,'UPDATE contract_items SET rate=?,margin=? WHERE id=?',historicalRates[i],Math.round(item.amount*historicalRates[i]),item.id));
  }
  return r.body.id;
}
const state=async(f,actor,query='?commissionPeriod='+quarter())=>(await f.request('/state'+query,{actor})).body;
test('PRD-M5 季度20万边界、全额跳档补差、历史锁定及退役发放入口',async t=>{
  const f=await fixture(t),admin=await f.login(1),uid=await participant(f,admin),cid=await account(f,admin,uid);
  const first=await deal(f,admin,cid,400000,{historicalRates:[0.5]});
  let s=await state(f,admin),p=s.commission.previews.find(p=>p.sales_id===uid);
  assert.equal(p.period,quarter());assert.equal(p.base,20000000);assert.equal(p.rate,0.03);assert.equal(p.due,600000);
  const confirmed=historicalCommission(f,p);assert.equal(confirmed.status,200);
  assert.equal((await f.request(`/items/${s.contracts.find(c=>c.id===first).items[0].id}`,{actor:admin,method:'PATCH',body:{margin:1,reason:'锁定校验'}})).status,409);
  await deal(f,admin,cid,2,{historicalRates:[0.5]});
  assert.equal((await f.request('/commissions/confirm',{actor:admin,method:'POST',body:p})).status,410);
  s=await state(f,admin);p=s.commission.previews.find(p=>p.sales_id===uid);
  assert.equal(p.base,20000100);assert.equal(p.rate,0.05);assert.equal(p.total,1000005);assert.equal(p.due,400005);assert.equal(p.lines.reduce((s,l)=>s+l.amount,0),p.due);
  historicalCommission(f,p);
  run(f.db,"UPDATE commission_batches SET status='paid',paid_at='2026-12-01' WHERE id=?",confirmed.body.id);
  assert.equal((await f.request(`/commissions/${confirmed.body.id}/pay`,{actor:admin,method:'POST',body:{paid_at:today()}})).status,410);
  const sales=await f.login(uid),own=await state(f,sales);
  assert.ok(own.commission.previews.every(p=>p.sales_id===uid));assert.ok(own.commission.batches.every(p=>p.sales_id===uid));assert.equal(own.commission.previews[0].due,0);
  assert.equal((await f.request('/commissions/confirm',{actor:sales,method:'POST',body:p})).status,403);
});
test('PRD-M5 混合合同返点、续签及王宏管理提成排除个人单',async t=>{
  const f=await fixture(t),admin=await f.login(1),uid=await participant(f,admin),cid=await account(f,admin,uid);
  const before=(await state(f,admin)).commission.previews.find(p=>p.kind==='management').base;
  const id=await deal(f,admin,cid,10000,{historicalRates:[0.35,0.5],items:[{name:'标品',kind:'标品',amount:10000},{name:'实施',kind:'实施',amount:10000}]});
  let s=await state(f,admin);assert.deepEqual(s.contracts.find(c=>c.id===id).items.map(i=>i.margin),[350000,500000]);
  assert.equal(s.commission.previews.find(p=>p.kind==='management').base-before,850000);
  const owner=await account(f,admin,1,{name:'负责人个人客户'});await deal(f,admin,owner,10000,{historicalRates:[0.25],items:[{name:'续费',kind:'标品',amount:10000}]});
  s=await state(f,admin);assert.equal(s.commission.previews.find(p=>p.kind==='management').base-before,850000);assert.ok(s.commission.previews.find(p=>p.sales_id===1&&p.kind==='personal').base>=250000);
});
test('PRD-M4 70/30、无目标不评D、调整理由和负责人无绩效工资',async t=>{
  const f=await fixture(t),admin=await f.login(1),uid=await participant(f,admin),cid=await account(f,admin,uid);
  assert.equal((await state(f,admin)).performance.find(p=>p.user_id===uid).grade,null);await deal(f,admin,cid,50000);
  await f.request('/targets',{actor:admin,method:'POST',body:{user_id:uid,quarter:quarter(),amount:150000}});
  assert.equal((await f.request('/performance/review',{actor:admin,method:'POST',body:{user_id:uid,adjustment:50}})).status,400);
  assert.equal((await f.request('/performance/review',{actor:admin,method:'POST',body:{user_id:uid,adjustment:50,reason:'已核验现场记录'}})).status,200);
  const s=await state(f,admin),p=s.performance.find(p=>p.user_id===uid);
  assert.equal(p.processPoints,70);assert.equal(p.resultPoints,30);assert.equal(p.total,100);assert.equal(p.grade,'A');assert.equal(p.salary_factor,1);assert.ok(!s.performance.some(p=>p.user_id===1));
  assert.equal((await f.request('/performance/review',{actor:admin,method:'POST',body:{user_id:uid,status:'confirmed'}})).status,400);
});
test('直接设置绩效校验权限和分数，重复保存不新增，清空恢复自动计分并保留审计',async t=>{
  const f=await fixture(t),admin=await f.login(1),uid=await participant(f,admin),sales=await f.login(uid);
  const save=(body,actor=admin)=>f.request('/performance/review',{actor,method:'POST',body:{user_id:uid,...body}});
  assert.equal((await save({adjustment:40,reason:'本人不能评定'},sales)).status,403);
  for(const adjustment of [-0.5,50.5,'abc'])assert.equal((await save({adjustment,reason:'越界测试'})).status,400);
  assert.equal((await save({adjustment:0})).status,400);
  for(const adjustment of [0,37.5]) {
    assert.equal((await save({adjustment,reason:'核对业务记录后设置'})).status,200);
    const row=one(f.db,'SELECT * FROM performance_reviews WHERE user_id=?',uid);
    assert.equal(row.adjustment,adjustment);assert.equal(row.reviewed_by,1);assert.equal(row.status,'draft');
  }
  assert.equal(one(f.db,'SELECT count(*) n FROM performance_reviews WHERE user_id=?',uid).n,1);
  assert.equal((await save({adjustment:''})).status,400);
  for(const adjustment of ['',null]) {
    assert.equal((await save({adjustment,reason:'恢复系统自动计分'})).status,200);
    const p=(await state(f,admin)).performance.find(p=>p.user_id===uid);
    assert.equal(p.adjustment,null);assert.equal(p.raw,p.process.raw);assert.equal(p.reason,'恢复系统自动计分');
  }
  assert.equal(one(f.db,"SELECT count(*) n FROM audit WHERE entity='performance' AND entity_id=(SELECT id FROM performance_reviews WHERE user_id=?)",uid).n,4);
  for(const field of ['performance_enabled','active']) {
    run(f.db,`UPDATE users SET ${field}=0 WHERE id=?`,uid);
    assert.equal((await save({adjustment:25,reason:'不可评定成员'})).status,400);
    run(f.db,`UPDATE users SET ${field}=1 WHERE id=?`,uid);
  }
  assert.equal((await save({user_id:1,adjustment:25,reason:'负责人不参与'})).status,400);
});

test('直接确认历史月度绩效保存快照，缺目标或未结束不落库，锁定后禁止修改',async t=>{
  const f=await fixture(t),admin=await f.login(1),uid=await participant(f,admin);
  const prev=new Date(`${today().slice(0,7)}-15T12:00:00Z`);prev.setUTCMonth(prev.getUTCMonth()-1);
  const month=prev.toISOString().slice(0,7),q=`${month.slice(0,4)}Q${Math.ceil(Number(month.slice(5,7))/3)}`;
  const body={user_id:uid,month,adjustment:40,reason:'已核验历史过程记录',status:'confirmed'};
  const save=body=>f.request('/performance/review',{actor:admin,method:'POST',body});
  assert.equal((await save(body)).status,400);
  assert.equal(one(f.db,'SELECT count(*) n FROM performance_reviews WHERE user_id=?',uid).n,0);
  assert.equal((await f.request('/targets',{actor:admin,method:'POST',body:{user_id:uid,quarter:q,amount:150000}})).status,200);
  assert.equal((await save({...body,month:today().slice(0,7)})).status,400);
  assert.equal(one(f.db,'SELECT count(*) n FROM performance_reviews WHERE user_id=?',uid).n,0);
  assert.equal((await save(body)).status,200);
  const row=one(f.db,'SELECT * FROM performance_reviews WHERE user_id=?',uid),snapshot=JSON.parse(row.snapshot);
  assert.equal(row.status,'confirmed');assert.equal(snapshot.raw,40);assert.equal(snapshot.processPoints,56);assert.equal(snapshot.total,56);assert.equal(snapshot.grade,'D');
  assert.equal((await save({...body,adjustment:50,reason:'试图改动锁定结果'})).status,409);
  assert.equal(one(f.db,'SELECT snapshot FROM performance_reviews WHERE user_id=?',uid).snapshot,row.snapshot);
  const p=(await state(f,admin,'?month='+month)).performance.find(p=>p.user_id===uid);
  assert.equal(p.status,'confirmed');assert.equal(p.total,56);assert.equal(p.reason,body.reason);
});

test('PRD-M2 三源归并保留逐次计分，旧独立采集入口退役',async t=>{
  const f=await fixture(t),admin=await f.login(1),uid=await participant(f,admin),cid=await account(f,admin,uid);
  const created=await f.request('/opportunities',{actor:admin,method:'POST',body:opp(cid,{owner_id:uid,amount:9800})});assert.equal(created.status,200);
  for(const source of ['手动','AI听记'])assert.equal((await f.request('/activities',{actor:admin,method:'POST',body:{opportunity_id:created.body.id,summary:'确认需求',source,activity_type:'线上会议'}})).status,200);
  assert.equal((await f.request('/activities',{actor:admin,method:'POST',body:{opportunity_id:created.body.id,summary:'晚会复盘进展',source:'晚会复盘',activity_type:'晚会复盘'}})).status,200);
  const draft=await f.request('/capture/drafts',{actor:admin,method:'POST',body:{source:'晚会复盘',external_id:'meeting-001',entries:[{opportunity_id:created.body.id,summary:'不能重复生成'}]}});assert.equal(draft.status,410);
  assert.equal((await f.request('/capture/drafts/1/confirm',{actor:admin,method:'POST',body:{}})).status,410);
  const s=await state(f,admin),a=s.activities.filter(a=>a.opportunity_id===created.body.id);
  assert.equal(a.length,1);assert.deepEqual([...a[0].sources].sort(),['AI听记','手动','晚会复盘'].sort());assert.equal(s.performance.find(p=>p.user_id===uid).process.meeting,2);assert.equal(s.performance.find(p=>p.user_id===uid).process.raw,3);
});
test('PRD-PERM PM只读关联资料、可加跟进和更新项目状态，隐藏提成绩效毛利',async t=>{
  const f=await fixture(t),admin=await f.login(1),pm=await participant(f,admin,'pm');
  const o=await f.request('/opportunities',{actor:admin,method:'POST',body:opp(1,{owner_id:2,collaborator_pm:pm})});assert.equal(o.status,200);const cid=await deal(f,admin,1,10000,{opportunity_id:o.body.id});
  const actor=await f.login(pm),s=await state(f,actor);assert.equal(s.opportunities.length,1);assert.equal(s.contracts.length,1);assert.deepEqual(s.performance,[]);assert.deepEqual(s.commission.previews,[]);assert.ok(!Object.hasOwn(s.contracts[0].items[0],'margin'));assert.ok(!Object.hasOwn(s.contracts[0].items[0],'rate'));
  assert.equal((await f.request('/activities',{actor,method:'POST',body:{opportunity_id:o.body.id,summary:'交付进度'}})).status,200);
  assert.equal((await f.request(`/contracts/${cid}`,{actor,method:'PATCH',body:{project_status:'交付中'}})).status,200);
  assert.equal((await f.request('/activities',{actor,method:'POST',body:{opportunity_id:1,summary:'越权'}})).status,403);
});
test('PRD-PPL旧导入和外部骨架入口退役，业务不被外部快照覆盖',async t=>{
  const f=await fixture(t),admin=await f.login(1);
  const before={customers:one(f.db,'SELECT COUNT(*) n FROM customers').n,opportunities:one(f.db,'SELECT COUNT(*) n FROM opportunities').n,amount:one(f.db,'SELECT amount FROM opportunities WHERE id=1').amount};
  for(const path of ['/integrations/ppl/import','/integrations/ppl/pull','/change-requests','/change-requests/1/review'])assert.equal((await f.request(path,{actor:admin,method:'POST',body:{customers:[{name:'不能留下的客户'}],opportunities:[{amount:1}]}})).status,410);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM customers').n,before.customers);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM opportunities').n,before.opportunities);
  assert.equal(one(f.db,'SELECT amount FROM opportunities WHERE id=1').amount,before.amount);
  for(const name of ['sync_runs','change_requests','capture_drafts'])assert.equal(one(f.db,"SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?",name).n,0);
});
test('PRD-M3 同商机显式多合同、承诺付款逾期升级和检查点',async t=>{
  const f=await fixture(t),admin=await f.login(1),o=await f.request('/opportunities',{actor:admin,method:'POST',body:opp(1)});
  const id=await deal(f,admin,1,10000,{opportunity_id:o.body.id});await deal(f,admin,1,20000,{opportunity_id:o.body.id,additional:true});
  await f.request('/payments',{actor:admin,method:'POST',body:{contract_id:id,amount:10000,status:'待到账',promise_date:dateAdd(-9)}});
  let p=(await state(f,admin)).contracts.find(c=>c.id===id).payments[0];assert.equal(p.escalation,'critical');assert.equal(p.status,'逾期');
  assert.equal((await f.request(`/payments/${p.id}/checkpoint`,{actor:admin,method:'POST',body:{checkpoint_date:dateAdd(1),reason:'管理者介入'}})).status,200);
  p=(await state(f,admin)).contracts.find(c=>c.id===id).payments[0];assert.equal(p.promise_date,dateAdd(-9));assert.equal(p.checkpoint_date,dateAdd(1));
});
