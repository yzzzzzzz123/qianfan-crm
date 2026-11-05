import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, customer, opp, contract,archiveContract} from './helpers/fixture.mjs';
import {all,one} from '../server/database.mjs';
import {migrateProduction} from '../server/production-schema.mjs';
import {today} from '../server/domain.mjs';

test('联系人可维护、停用与恢复；保留历史并隔离他人修改',async t=>{
  const f=await fixture(t),a=await f.login(2),b=await f.login(3);
  const made=await f.request('/contacts',{actor:a,method:'POST',body:{customer_id:1,name:'客户关键人',role:'决策人',phone:'13800000000'}});
  assert.equal(made.status,200);const id=made.body.id;
  const patch=body=>f.request(`/contacts/${id}`,{actor:a,method:'PATCH',body});
  assert.equal((await f.request(`/contacts/${id}`,{actor:b,method:'PATCH',body:{phone:'越权'}})).status,403);
  assert.equal((await patch({name:'已核实姓名',phone:'13800000000',last_contact:today(),active:false})).status,200);
  let row=one(f.db,'SELECT * FROM contacts WHERE id=?',id);
  assert.equal(row.name,'已核实姓名');assert.equal(row.last_contact,today());assert.ok(row.archived_at);
  assert.equal((await patch({active:true})).status,200);
  row=one(f.db,'SELECT * FROM contacts WHERE id=?',id);assert.equal(row.archived_at,null);
  assert.equal((await patch({name:''})).status,400);
  assert.ok(all(f.db,"SELECT * FROM audit WHERE action='更新联系人'").length>=2);
});

test('商机保留实际金额字段，旧毛利和人天字段已移除且接口拒绝写入',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const cid=(await f.request('/customers',{actor,method:'POST',body:customer({name:'字段校验企业'})})).body.id;
  for(const fields of [{man_days:2.25},{est_margin:123.45},{products:'重复产品说明'},{source:'自建'}]) assert.equal((await f.request('/opportunities',{actor,method:'POST',body:opp(cid,fields)})).status,400);
  const made=await f.request('/opportunities',{actor,method:'POST',body:opp(cid,{product_amount:123.45})});assert.equal(made.status,200);
  assert.equal(one(f.db,'SELECT product_amount FROM opportunities WHERE id=?',made.body.id).product_amount,12345);
  for(const column of ['man_days','est_margin','products','source','nature','product_type'])assert.ok(!all(f.db,'PRAGMA table_info(opportunities)').some(c=>c.name===column));
  assert.throws(()=>f.db.prepare('UPDATE opportunities SET product_amount=-1 WHERE id=?').run(made.body.id),/cash amount/);
});

test('多合同累计成交金额，阶段历史不重复，合同日期金额一致',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const cid=(await f.request('/customers',{actor,method:'POST',body:customer({name:'多合同校验企业'})})).body.id;
  const oid=(await f.request('/opportunities',{actor,method:'POST',body:opp(cid)})).body.id;
  const create=body=>f.request('/contracts',{actor,method:'POST',body:contract(oid,body)});
  assert.equal((await create({valid_until:'2000-01-01'})).status,400);
  assert.equal((await create({recurring_amount:100001})).status,400);
  const first=await create({contract_no:'PROD-CHECK-001'});assert.equal(first.status,200);
  await archiveContract(f,actor,first.body.id);
  const stageAt=one(f.db,'SELECT stage_at FROM opportunities WHERE id=?',oid).stage_at;
  assert.equal((await create({contract_no:'PROD-CHECK-001',additional:true})).status,409);
  const second=await create({additional:true,items:[{name:'实施',kind:'实施',amount:20000,man_days:10}]});assert.equal(second.status,200);await archiveContract(f,actor,second.body.id);
  const o=one(f.db,'SELECT * FROM opportunities WHERE id=?',oid);assert.equal(o.amount,12000000);assert.equal(o.stage_at,stageAt);
  assert.equal(one(f.db,"SELECT count(*) n FROM stage_history WHERE opportunity_id=? AND to_stage='赢单'",oid).n,1);
  assert.throws(()=>f.db.prepare('UPDATE contracts SET customer_id=2 WHERE id=?').run(first.body.id),/integrity/);
  assert.equal((await f.request(`/contracts/${first.body.id}`,{actor,method:'PATCH',body:{auto_renew:'true',recurring_amount:100}})).status,400);
  const updated=one(f.db,'SELECT * FROM contracts WHERE id=?',first.body.id);assert.equal(Object.hasOwn(updated,'auto_renew'),false);assert.equal(Object.hasOwn(updated,'recurring_amount'),false);assert.equal(Object.hasOwn(updated,'quote_file'),false);
  assert.equal((await f.request(`/contracts/${first.body.id}`,{actor,method:'PATCH',body:{auto_renew:'invalid'}})).status,400);
  const before=all(f.db,'SELECT * FROM contacts');migrateProduction(f.db);assert.deepEqual(all(f.db,'SELECT * FROM contacts'),before);
  assert.deepEqual(all(f.db,'PRAGMA foreign_key_check'),[]);
});
