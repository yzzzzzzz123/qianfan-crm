import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {all,one,run} from '../server/database.mjs';
import {today,dateAdd} from '../server/domain.mjs';
import {migrateCollectionLedger} from '../server/collection-ledger-schema.mjs';
import {fixture} from './helpers/fixture.mjs';

const file={name:'测试签章件.pdf',base64:Buffer.from('%PDF-1.4\n% isolated signed fixture only\n').toString('base64')};
async function setup(t,extra={}){
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
  const result=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:1,owner_id:2,name:'核销链路隔离合同',sign_date:today(),contract_no:'LEDGER-'+randomUUID(),items:[{name:'授权',kind:'标品',amount:60000,margin:12000},{name:'交付',kind:'交付',amount:40000,margin:8000}],...extra}});
  assert.equal(result.status,200,JSON.stringify(result.body));const id=result.body.id;
  assert.equal((await f.request(`/contracts/${id}/archive`,{actor:admin,method:'POST',body:{both_stamped:true,file}})).status,200);
  const post=(p,body,options={})=>f.request(p,{actor:admin,method:'POST',body,...options});
  const state=async()=>(await f.request('/state',{actor:admin})).body.contracts.find(c=>c.id===id);
  const plan=async(amount,extra={})=>{const r=await post('/payments',{contract_id:id,amount,status:'待到账',promise_date:dateAdd(2),...extra});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id;};
  return {...f,admin,sales,id,post,state,plan};
}

test('直接上传签章件不依赖AI，归档失败时附件及合同一起回滚',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
  const make=()=>f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:1,owner_id:2,name:'直接归档',sign_date:today(),items:[{name:'授权',kind:'标品',amount:10000}]}});
  const id=(await make()).body.id;run(f.db,"UPDATE contracts SET lifecycle='草稿' WHERE id=?",id);
  assert.equal((await f.request(`/contracts/${id}/attachments`,{actor:await f.login(3),method:'POST',body:{file}})).status,403);
  const bad=await f.request(`/contracts/${id}/archive`,{actor:admin,method:'POST',body:{both_stamped:true,file:{name:'不是真实PNG.png',base64:Buffer.from('not an image').toString('base64')}}});
  assert.equal(bad.status,400);assert.equal(one(f.db,'SELECT COUNT(*) n FROM attachments WHERE entity_id=?',id).n,0);
  const big={name:'可直接上传的大合同.pdf',base64:Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(1100000,32)]).toString('base64')};
  const upload=await f.request(`/contracts/${id}/attachments`,{actor:admin,method:'POST',body:{file:big}});
  assert.equal(upload.status,200,JSON.stringify(upload.body));
  assert.equal((await f.request(`/contracts/${id}/archive`,{actor:admin,method:'POST',body:{both_stamped:true,archive_attachment_id:upload.body.id}})).status,200);
  const next=(await make()).body.id;
  run(f.db,"UPDATE contracts SET sign_date=?,lifecycle='草稿' WHERE id=?",dateAdd(2),next);
  const failed=await f.request(`/contracts/${next}/archive`,{actor:admin,method:'POST',body:{both_stamped:true,file}});
  assert.equal(failed.status,400);assert.equal(one(f.db,"SELECT COUNT(*) n FROM attachments WHERE entity='contract' AND entity_id=?",next).n,0);
  assert.equal(one(f.db,'SELECT lifecycle FROM contracts WHERE id=?',next).lifecycle,'草稿');
});

test('部分到账保留原计划，以独立实收核销；重复提交与收齐均保持账务一致',async t=>{
  const f=await setup(t),plan=await f.plan(100000),key=randomUUID();
  const body={amount:30000,pay_date:today(),product_amount:18000,remaining_promise_date:dateAdd(5),reference_no:'BANK-FIRST'};
  const a=await f.post(`/payments/${plan}/receive`,body,{key}),again=await f.post(`/payments/${plan}/receive`,body,{key});
  assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(again.body.id,a.body.id);assert.notEqual(a.body.id,plan);
  let c=await f.state();assert.equal(c.collected,3000000);assert.equal(c.outstanding,7000000);assert.equal(c.plans[0].amount,10000000);assert.equal(c.plans[0].settled_amount,3000000);assert.equal(c.plans[0].remaining_amount,7000000);assert.equal(c.plans[0].promise_date,dateAdd(5));
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM payment_plan_links WHERE plan_id=?',plan).n,1);
  const over=await f.post(`/payments/${plan}/receive`,{...body,amount:80000});assert.equal(over.status,400);
  const last=await f.post(`/payments/${plan}/receive`,{amount:70000,pay_date:today(),product_amount:42000,reference_no:'BANK-LAST'});assert.equal(last.status,200,JSON.stringify(last.body));
  c=await f.state();assert.equal(c.collected,10000000);assert.equal(c.outstanding,0);assert.equal(c.collection_status,'已结清');assert.equal(c.plans[0].status,'已核销');assert.equal(c.next_expected_at,null);
  assert.equal((await f.post(`/payments/${plan}/receive`,{pay_date:today()})).status,409);
});

test('独立登记实收自动匹配有效计划，跨两期核销不会留下结清后的逾期',async t=>{
  const f=await setup(t),first=await f.plan(30000,{promise_date:dateAdd(-3)}),last=await f.plan(70000,{promise_date:dateAdd(-1)});
  let r=await f.post('/payments',{contract_id:f.id,amount:40000,status:'已到账',pay_date:today(),product_amount:24000,reference_no:'AUTO-1'});assert.equal(r.status,200);
  let c=await f.state();assert.equal(c.plans.find(p=>p.id===first).remaining_amount,0);assert.equal(c.plans.find(p=>p.id===last).remaining_amount,6000000);
  r=await f.post('/payments',{contract_id:f.id,amount:60000,status:'已到账',pay_date:today(),product_amount:36000,reference_no:'AUTO-2'});assert.equal(r.status,200);
  c=await f.state();assert.equal(c.outstanding,0);assert.ok(c.plans.every(p=>p.status==='已核销'));
  const global=(await f.request('/state',{actor:f.admin})).body;
  assert.equal(global.contractDashboard.overdue_amount,12000000); // Only the untouched seeded overdue contract remains.
});

test('计划不能超配；作废仅移除余款催收，不改到账、核销及历史',async t=>{
  const f=await setup(t),plan=await f.plan(100000);
  assert.equal((await f.post('/payments',{contract_id:f.id,amount:1,status:'待到账',promise_date:dateAdd(1)})).status,409);
  await f.post(`/payments/${plan}/receive`,{amount:30000,product_amount:18000,pay_date:today()});
  assert.equal((await f.post(`/payments/${plan}/void-plan`,{confirmed:true,reason:'测试'},{actor:await f.login(3)})).status,403);
  assert.equal((await f.post(`/payments/${plan}/void-plan`,{confirmed:true,reason:'双方重排付款阶段'})).status,200);
  let c=await f.state();assert.equal(c.collected,3000000);assert.equal(c.plans[0].status,'已作废');assert.equal(c.plans[0].settled_amount,3000000);assert.equal(c.planned_remaining,0);
  await f.plan(70000);c=await f.state();assert.equal(c.planned_remaining,7000000);assert.equal(c.unplanned_amount,0);
});

test('历史残留计划可用已有实收核销，不新增现金；跨合同关系被拒绝',async t=>{
  const f=await setup(t);
  const receipt=await f.post('/payments',{contract_id:f.id,amount:100000,status:'已到账',pay_date:today(),product_amount:60000});assert.equal(receipt.status,200);
  const plan=Number(run(f.db,"INSERT INTO payments(contract_id,amount,status,promise_date,created_at) VALUES(?,10000000,'逾期',?,?)",f.id,dateAdd(-3),new Date().toISOString()).lastInsertRowid);
  let c=await f.state();assert.equal(c.needs_plan_review,true);assert.equal(c.collected,10000000);
  assert.equal((await f.post(`/payments/${plan}/reconcile`,{receipt_id:1,amount:100,reason:'不能跨合同'})).status,400);
  const key=randomUUID(),body={receipt_id:receipt.body.id,amount:100000,reason:'核对旧计划与原银行回单'};
  assert.equal((await f.post(`/payments/${plan}/reconcile`,body,{key})).status,200);assert.equal((await f.post(`/payments/${plan}/reconcile`,body,{key})).status,200);
  c=await f.state();assert.equal(c.collected,10000000);assert.equal(c.needs_plan_review,false);assert.equal(c.plans[0].status,'已核销');
});

test('纠正已核销到账金额会同步恢复计划余款；审计失败整体回滚',async t=>{
  const f=await setup(t),plan=await f.plan(100000);
  const receipt=await f.post(`/payments/${plan}/receive`,{amount:30000,pay_date:today(),product_amount:18000});
  const edit=body=>f.request(`/payments/${receipt.body.id}/details`,{actor:f.admin,method:'PATCH',body:{amount:20000,product_amount:12000,status:'已到账',pay_date:today(),reason:'核对回单，原录入偏大',...body}});
  assert.equal((await edit({})).status,200);
  let c=await f.state();assert.equal(c.collected,2000000);assert.equal(c.plans[0].remaining_amount,8000000);
  const before=all(f.db,'SELECT * FROM payment_plan_links');
  f.db.exec("CREATE TRIGGER ledger_audit_failure BEFORE INSERT ON audit WHEN NEW.action='维护回款' BEGIN SELECT RAISE(ABORT,'audit unavailable');END;");
  assert.equal((await edit({amount:10000,product_amount:6000})).status,500);
  assert.deepEqual(all(f.db,'SELECT * FROM payment_plan_links'),before);c=await f.state();assert.equal(c.collected,2000000);assert.equal(c.plans[0].remaining_amount,8000000);
});

test('疑似重复需显式确认与依据，不阻止具有不同银行凭证的同额款项',async t=>{
  const f=await setup(t),body={contract_id:f.id,amount:1000,status:'已到账',pay_date:today(),product_amount:600};
  assert.equal((await f.post('/payments',body)).status,200);
  const duplicate=await f.post('/payments',body);assert.equal(duplicate.status,409);assert.equal(duplicate.body.code,'PAYMENT_DUPLICATE');
  assert.equal((await f.post('/payments',{...body,duplicate_confirmed:true})).status,400);
  assert.equal((await f.post('/payments',{...body,duplicate_confirmed:true,duplicate_reason:'两张独立银行回单，已人工核对'})).status,200);
  const a={...body,amount:2000,product_amount:1200,reference_no:'BANK-A'};assert.equal((await f.post('/payments',a)).status,200);
  assert.equal((await f.post('/payments',{...a,reference_no:'BANK-B'})).status,200);
});

test('计划余款作废后纠正原实收，已核销历史同步减少且计划仍作废',async t=>{
  const f=await setup(t),plan=await f.plan(100000),receipt=await f.post(`/payments/${plan}/receive`,{amount:30000,product_amount:18000,pay_date:today()});
  await f.post(`/payments/${plan}/void-plan`,{confirmed:true,reason:'后续余款改为新计划'});
  const result=await f.request(`/payments/${receipt.body.id}/details`,{actor:f.admin,method:'PATCH',body:{amount:20000,product_amount:12000,status:'已到账',pay_date:today(),reason:'原到账录入错误，核对后减少一万元'}});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const c=await f.state();assert.equal(c.collected,2000000);assert.equal(c.plans[0].status,'已作废');assert.equal(c.plans[0].settled_amount,2000000);assert.equal(c.plans[0].remaining_amount,0);
});

test('销售不能删除已收款合同，终止申请经管理员处理后账务仍可查',async t=>{
  const f=await setup(t);await f.post('/payments',{contract_id:f.id,amount:1000,status:'已到账',pay_date:today(),product_amount:600});
  for(const actor of [f.admin,f.sales])assert.equal((await f.request(`/contracts/${f.id}`,{actor,method:'DELETE',body:{confirmed:true,reason:'测试'}})).status,409);
  const request=await f.post(`/contracts/${f.id}/termination-request`,{reason:'客户终止后续合作，申请保留现有账务'},{actor:f.sales});assert.equal(request.status,200);
  assert.equal((await f.post(`/contracts/${f.id}/termination`,{confirmed:true,reason:'越权'},{actor:await f.login(3)})).status,403);
  assert.equal((await f.post(`/contracts/${f.id}/termination`,{confirmed:true,reason:'已核对合同、实收及未收，保留账务'})).status,200);
  const c=await f.state();assert.ok(c.terminated_at);assert.equal(c.amount,10000000);assert.equal(c.collected,100000);assert.equal(c.outstanding,9900000);
  assert.equal((await f.post('/payments',{contract_id:f.id,amount:1000,status:'待到账',promise_date:dateAdd(2)})).status,409);
  assert.equal((await f.request('/contracts/history',{actor:await f.login(3)})).status,200);
  const history=await f.request(`/contracts/${f.id}/history`,{actor:f.admin});assert.equal(history.status,200);assert.equal(history.body.read_only,true);assert.equal(history.body.collected,100000);
});

test('结算锁定在状态中前置，未来回款与计划核销仍可继续',async t=>{
  const f=await setup(t),plan=await f.plan(100000);
  const first=await f.post(`/payments/${plan}/receive`,{amount:30000,pay_date:today(),product_amount:18000});
  const item=one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',f.id),batch=Number(run(f.db,"INSERT INTO commission_batches(sales_id,kind,period,base,rate,amount,status,snapshot,created_at,confirmed_by) VALUES(2,'personal','2026Q4',1200000,.03,36000,'confirmed','{}',?,1)",new Date().toISOString()).lastInsertRowid);
  run(f.db,"INSERT INTO commission_lines(batch_id,contract_id,item_id,base,rebate_rate,rate,amount,component) VALUES(?,?,?,?,?,?,?,'legacy')",batch,f.id,item.id,1200000,.2,.03,36000);
  assert.equal((await f.state()).locks.financial,true);
  assert.equal((await f.request(`/payments/${first.body.id}/details`,{actor:f.admin,method:'PATCH',body:{amount:20000,status:'已到账',product_amount:12000,pay_date:today(),reason:'锁定后不改历史'}})).status,409);
  assert.equal((await f.request(`/payments/${plan}`,{actor:f.admin,method:'PATCH',body:{promise_date:dateAdd(5),reason:'后续付款改期'}})).status,200);
  assert.equal((await f.post(`/payments/${plan}/receive`,{amount:70000,pay_date:today(),product_amount:42000})).status,200);
  assert.equal((await f.state()).outstanding,0);
});

test('核销关系在数据库层禁止跨合同、超额和将已核销计划改成实收',async t=>{
  const f=await setup(t),plan=await f.plan(100000),receipt=await f.post(`/payments/${plan}/receive`,{amount:10000,pay_date:today(),product_amount:6000});
  assert.throws(()=>run(f.db,'UPDATE payment_plan_links SET amount=2000000 WHERE receipt_id=?',receipt.body.id),/核销/);
  assert.throws(()=>run(f.db,"UPDATE payments SET status='已到账',pay_date=? WHERE id=?",today(),plan),/核销|integrity/);
  assert.throws(()=>run(f.db,'INSERT INTO payment_plan_links(plan_id,receipt_id,amount,created_at,created_by) VALUES(?,?,?,?,1)',plan,1,1,new Date().toISOString()),/核销/);
});

function oldSchema(){
  const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(31);CREATE TABLE users(id INTEGER PRIMARY KEY);INSERT INTO users VALUES(1);CREATE TABLE contracts(id INTEGER PRIMARY KEY,amount INTEGER);INSERT INTO contracts VALUES(1,10000);CREATE TABLE payments(id INTEGER PRIMARY KEY,contract_id INTEGER REFERENCES contracts(id),amount INTEGER,status TEXT);INSERT INTO payments VALUES(1,1,3000,'已到账'),(2,1,7000,'待到账');CREATE TABLE workspace_revision(id INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO workspace_revision VALUES(1,7);`);return db;
}
test('schema32不重写历史金额及状态，可重复执行，失败时回滚所有新增结构',()=>{
  const db=oldSchema();try{migrateCollectionLedger(db);assert.deepEqual(all(db,'SELECT id,amount,status FROM payments').map(r=>({...r})),[{id:1,amount:3000,status:'已到账'},{id:2,amount:7000,status:'待到账'}]);const revision=one(db,'SELECT revision FROM workspace_revision').revision;migrateCollectionLedger(db);assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,revision);}finally{db.close();}
  const failed=oldSchema();try{failed.exec("CREATE TRIGGER block32 BEFORE INSERT ON schema_version WHEN NEW.version=32 BEGIN SELECT RAISE(ABORT,'blocked32');END;");assert.throws(()=>migrateCollectionLedger(failed),/blocked32/);assert.equal(all(failed,'PRAGMA table_info(payments)').some(c=>c.name==='voided_at'),false);assert.equal(one(failed,'SELECT revision FROM workspace_revision').revision,7);assert.equal(one(failed,"SELECT COUNT(*) n FROM sqlite_master WHERE name='payment_plan_links'").n,0);}finally{failed.close();}
});
