import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {one,all,run} from '../server/database.mjs';
import {today,dateAdd} from '../server/domain.mjs';

const reason='隔离需求验收，按真实资料纠正';
const file={name:'隔离合同.pdf',base64:Buffer.from('%PDF-1.4\n% isolated fixture\n').toString('base64')};
async function setup(t){
 const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),other=await f.login(3);
 const customer=await f.request('/customers',{actor:sales,method:'POST',body:{name:'需求验收客户'+crypto.randomUUID(),industry:'软件',region:'广东'}});
 assert.equal(customer.status,200,JSON.stringify(customer.body));
 const create=async(items=[{name:'交付',kind:'交付',amount:10000}],extra={})=>{
  const r=await f.request('/contracts',{actor:sales,method:'POST',body:{customer_id:customer.body.id,name:'无附件签署验收',sign_date:today(),items,...extra}});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id;
 };
 const request=(p,body,method='POST',actor=sales)=>f.request(p,{actor,method,body});
 return {...f,admin,sales,other,create,request,customerId:customer.body.id};
}
test('REQ-01/05 无附件签署、分笔实收、计划余款与附件后补',async t=>{
 const f=await setup(t),id=await f.create();
 const c=one(f.db,'SELECT * FROM contracts WHERE id=?',id);
 assert.equal(c.lifecycle,'已归档');for(const key of ['archive_attachment_id','archived_at','archived_by'])assert.equal(c[key],null);
 const plan=await f.request('/payments',{contract_id:id,amount:10000,status:'待到账',promise_date:dateAdd(3)});assert.equal(plan.status,200);
 const paid=await f.request(`/payments/${plan.body.id}/receive`,{amount:3000,pay_date:today()});assert.equal(paid.status,200,JSON.stringify(paid.body));
 assert.notEqual(paid.body.id,plan.body.id);
 const state=(await f.request('/state',undefined,'GET')).body.contracts.find(x=>x.id===id);
 assert.equal(state.collected,300000);assert.equal(state.plans[0].remaining_amount,700000);
 assert.equal((await f.request(`/contracts/${id}/attachments`,{file})).status,200);
 assert.equal(one(f.db,'SELECT count(*) n FROM contracts WHERE id=?',id).n,1);
});
test('REQ-01 旧草稿无附件确认、未来日期拒绝且不批量转换',async t=>{
 const f=await setup(t),id=await f.create(),other=await f.create();run(f.db,"UPDATE contracts SET lifecycle='草稿' WHERE id IN (?,?)",id,other);
 assert.equal((await f.request(`/contracts/${id}/archive`,{both_stamped:true})).status,200);
 assert.equal(one(f.db,'SELECT archived_at FROM contracts WHERE id=?',id).archived_at,null);
 assert.equal(one(f.db,'SELECT lifecycle FROM contracts WHERE id=?',other).lifecycle,'草稿');
 const r=await f.request('/contracts',{customer_id:f.customerId,name:'未来签署',sign_date:dateAdd(1),items:[{name:'交付',kind:'交付',amount:10}]});assert.equal(r.status,400);
});
test('REQ-02 毛利默认、未知值、自定义与负净毛利',async t=>{
 const f=await setup(t);
 const id=await f.create([{name:'交付',kind:'交付',amount:10000,business_expense:1000}]);
 let i=one(f.db,'SELECT * FROM contract_items WHERE contract_id=?',id);assert.equal(i.margin_before_expense,1000000);assert.equal(i.margin,900000);
 let r=await f.request(`/items/${i.id}`,{margin_before_expense:500,business_expense:1000,reason,data_correction:true},'PATCH');assert.equal(r.status,200,JSON.stringify(r.body));
 i=one(f.db,'SELECT * FROM contract_items WHERE id=?',i.id);assert.equal(i.margin,-50000);
 r=await f.request(`/items/${i.id}`,{name:'改名保留毛利',reason,data_correction:true},'PATCH');assert.equal(r.status,200);assert.equal(one(f.db,'SELECT margin FROM contract_items WHERE id=?',i.id).margin,-50000);
 const unknown=await f.create([{name:'标品',kind:'标品',amount:10000}]);assert.equal(one(f.db,'SELECT margin FROM contract_items WHERE contract_id=?',unknown).margin,null);
 const custom=await f.create([{name:'交付',kind:'交付',amount:10000,margin_before_expense:7000,business_expense:500}]);assert.equal(one(f.db,'SELECT margin FROM contract_items WHERE contract_id=?',custom).margin,650000);
});
test('REQ-03 逐笔费用、旧合计保护、过期版本与删除恢复',async t=>{
 const f=await setup(t),id=await f.create(),item=one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',id);
 const before=(await f.request(`/contracts/${id}/expenses`,undefined,'GET')).body;
 const r=await f.request(`/contracts/${id}/expenses`,{item_id:item.id,amount:1000,description:'外包成本',reason,expected_revision:before.revision});assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(one(f.db,'SELECT margin FROM contract_items WHERE id=?',item.id).margin,900000);
 assert.equal((await f.request(`/items/${item.id}`,{business_expense:500,reason,data_correction:true},'PATCH')).status,409);
 assert.equal((await f.request(`/contracts/${id}/expenses`,{item_id:item.id,amount:100,description:'过期写入',reason,expected_revision:before.revision})).status,409);
 assert.equal((await f.request(`/contract-expenses/${r.body.id}`,{reason,confirmed:true},'DELETE')).status,200);
 assert.equal(one(f.db,'SELECT margin FROM contract_items WHERE id=?',item.id).margin,1000000);
 assert.equal((await f.request(`/contract-expenses/${r.body.id}/restore`,{reason,confirmed:true})).status,200);
 assert.equal(one(f.db,'SELECT margin FROM contract_items WHERE id=?',item.id).margin,900000);
});
test('REQ-04 销售本人完整维护，其他销售与PM拒绝且修正标志不能提权',async t=>{
 const f=await setup(t),id=await f.create(),item=one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',id);
 assert.equal((await f.request(`/contracts/${id}`,{name:'本人可改',reason,data_correction:true},'PATCH')).status,200);
 assert.equal((await f.request(`/contracts/${id}`,{name:'他人越权',reason,data_correction:true},'PATCH',f.other)).status,403);
 assert.equal((await f.request(`/contracts/${id}/expenses`,{item_id:item.id,amount:1,description:'越权',reason},'POST',f.other)).status,403);
 for(const p of ['/data-review','/settlement-review'])assert.equal((await f.request(p,undefined,'GET')).status,403);
 assert.equal((await f.request('/rules',{data_correction:true,reason},'PATCH')).status,403);
 const pmId=Number(run(f.db,"INSERT INTO users(name,username,role,created_at) VALUES('验收PM','alignment_pm','pm',datetime('now'))").lastInsertRowid),pm=await f.login(pmId);
 assert.equal((await f.request('/payments',{contract_id:id,amount:1,status:'已到账',pay_date:today()},'POST',pm)).status,403);
});
test('REQ-06 跨合同凭证重复提醒不泄露他人合同详情',async t=>{
 const f=await setup(t),id=await f.create();
 const c=await f.request('/contracts',{customer_id:f.customerId,owner_id:3,name:'他人秘密合同',contract_no:'PRIVATE-SECRET',sign_date:today(),items:[{name:'服务',kind:'交付',amount:10000}]},'POST',f.admin);assert.equal(c.status,200);
 assert.equal((await f.request('/payments',{contract_id:c.body.id,amount:100,status:'已到账',pay_date:today(),reference_no:'BANK-UNIQUE'},'POST',f.admin)).status,200);
 const payload={contract_id:id,amount:100,status:'已到账',pay_date:today(),reference_no:'BANK-UNIQUE'};
 const r=await f.request('/payments',payload);assert.equal(r.status,409);assert.equal(r.body.code,'PAYMENT_DUPLICATE');assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE-SECRET|他人秘密合同/);
 assert.equal((await f.request('/payments',{...payload,duplicate_confirmed:true,duplicate_reason:'银行复用编号，确认为独立款项'})).status,200);
});
test('REQ-07 删除恢复实收保留核销关系，恢复预览在本人范围内',async t=>{
 const f=await setup(t),id=await f.create();
 const plan=await f.request('/payments',{contract_id:id,amount:10000,status:'待到账',promise_date:dateAdd(5)});
 const paid=await f.request(`/payments/${plan.body.id}/receive`,{amount:3000,pay_date:today()});assert.equal(paid.status,200);
 assert.equal((await f.request(`/payments/${paid.body.id}`,{reason,confirmed:true},'DELETE')).status,200);
 assert.equal(one(f.db,'SELECT count(*) n FROM payment_plan_links WHERE receipt_id=?',paid.body.id).n,0);
 const list=await f.request(`/records/recycle?contract_id=${id}`,undefined,'GET');assert.equal(list.status,200);
 const recycle=one(f.db,"SELECT id FROM record_recycle_bin WHERE record_id=? AND entity='payments'",paid.body.id);
 assert.ok(recycle);
 const preview=await f.request(`/records/recycle/preview?type=payment&id=${recycle.id}`,undefined,'GET');assert.equal(preview.status,200);
 assert.equal((await f.request(`/record-recycle/${recycle.id}/restore`,{reason,confirmed:true})).status,200);
 assert.equal(one(f.db,'SELECT count(*) n FROM payment_plan_links WHERE receipt_id=?',paid.body.id).n,1);
 assert.equal(one(f.db,"SELECT SUM(amount) amount FROM payments WHERE contract_id=? AND status='已到账'",id).amount,300000);
});
test('REQ-11 结构35与数据库完整性，重复迁移无破坏',async t=>{
 const f=await setup(t);assert.equal(one(f.db,'SELECT MAX(version) v FROM schema_version').v,35);
 assert.equal(one(f.db,'PRAGMA integrity_check').integrity_check,'ok');assert.deepEqual(all(f.db,'PRAGMA foreign_key_check'),[]);
});
