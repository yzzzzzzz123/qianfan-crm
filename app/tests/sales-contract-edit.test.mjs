import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {auditView,auditChanges} from '../public/modules/audit.js';

async function setup(t){
 const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),other=await f.login(3);
 const pmId=Number(run(f.db,"INSERT INTO users(name,username,role,created_at) VALUES('隔离项目经理','isolated_sales_edit_pm','pm',datetime('now'))").lastInsertRowid),pm=await f.login(pmId);
 const result=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:1,owner_id:2,name:'销售编辑验收',sign_date:'2026-10-01',items:[{name:'产品甲',kind:'标品',amount:600,margin:120},{name:'运维乙',kind:'运维',amount:400,margin:80}]}});
 assert.equal(result.status,200,JSON.stringify(result.body));const id=result.body.id;
 run(f.db,"UPDATE contracts SET lifecycle='历史登记' WHERE id=?",id);
 const paid=await f.request('/payments',{actor:admin,method:'POST',body:{contract_id:id,amount:100,product_amount:60,status:'已到账',pay_date:'2026-10-10'}});
 assert.equal(paid.status,200,JSON.stringify(paid.body));
 return {...f,admin,sales,other,pm,id,paymentId:paid.body.id};
}
const paymentBody={amount:150,product_amount:90,status:'已到账',pay_date:'2026-10-12',note:'已核对到账',reason:'按实际银行流水修正'};

test('管理员统一编辑合同、行项与流水后，可查看同一事务的完整修改依据；重复保存不重复记账',async t=>{
 const f=await setup(t),items=all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',f.id).map(i=>({id:i.id,name:i.name,kind:i.kind,amount:i.amount/100,margin:i.margin/100}));
 items[0].amount=800;items[0].margin=160;
 const options={actor:f.admin,method:'PATCH',key:randomUUID(),body:{fields:{name:'销售修订合同',project_note:'交付计划已核对'},items,payments:[{id:f.paymentId,...paymentBody}],reason:'客户确认金额和到账修正'}};
 const before=one(f.db,'SELECT count(*) n FROM audit').n;
 for(let i=0;i<2;i++)assert.equal((await f.request(`/contracts/${f.id}/maintenance`,options)).status,200);
 const S=(await f.request('/state',{actor:f.admin})).body,c=S.contracts.find(c=>c.id===f.id);
 assert.equal(c.name,'销售修订合同');assert.equal(c.amount,120000);assert.equal(c.collected,15000);assert.equal(c.outstanding,105000);
 const logs=S.audit.filter(a=>a.user_id===1&&a.entity==='contract'&&a.entity_id===f.id&&['更新合同','维护回款'].includes(a.action));
 assert.equal(logs.length,2);assert.equal(one(f.db,'SELECT count(*) n FROM audit').n,before+2);
 const update=JSON.parse(logs.find(a=>a.action==='更新合同').detail),payment=JSON.parse(logs.find(a=>a.action==='维护回款').detail);
 assert.equal(update.before.name,'销售编辑验收');assert.equal(update.name,'销售修订合同');assert.equal(update.items[0].before.amount,60000);assert.equal(update.items[0].after.amount,80000);
 assert.equal(payment.before.amount,10000);assert.equal(payment.after.amount,15000);assert.equal(payment.payment_id,f.paymentId);assert.ok(payment.request_id);
 const html=auditView(S);for(const value of ['王宏','销售修订合同','销售编辑验收','客户确认金额和到账修正','¥100 → ¥150','明细 #'])assert.ok(html.includes(value),value);
 assert.doesNotMatch(html,/&quot;before&quot;|&quot;contract_id&quot;/,'明细以逐项中文差异展示，不重复显示原始JSON');
 const own=(await f.request('/state',{actor:f.sales})).body;assert.deepEqual(own.audit,[]);
});

test('销售可维护本人财务，PM及其他销售无权，禁止转移归属',async t=>{
 const f=await setup(t);
 assert.equal((await f.request(`/contracts/${f.id}/maintenance`,{actor:f.sales,method:'PATCH',body:{fields:{name:'本人维护'},reason:'核对合同名称'}})).status,200);
 assert.equal((await f.request(`/payments/${f.paymentId}/details`,{actor:f.sales,method:'PATCH',body:paymentBody})).status,200);
 for(const actor of [f.other,f.pm]){
  assert.equal((await f.request(`/contracts/${f.id}/maintenance`,{actor,method:'PATCH',body:{fields:{name:'越权'},reason:'越权测试'}})).status,403);
  assert.equal((await f.request(`/payments/${f.paymentId}/details`,{actor,method:'PATCH',body:paymentBody})).status,403);
 }
 assert.equal((await f.request(`/contracts/${f.id}/maintenance`,{actor:f.sales,method:'PATCH',body:{fields:{owner_id:3},reason:'非法归属调整'}})).status,403);
 assert.equal((await f.request(`/payments/${f.paymentId}/details`,{actor:f.sales,method:'PATCH',body:{...paymentBody,contract_id:2}})).status,403);
 assert.equal((await f.request(`/contracts/${f.id}`,{actor:f.sales,method:'PATCH',body:{name:'非法字段',lifecycle:'已归档',reason:'不得绕过签署'}})).status,400);
 assert.equal(one(f.db,'SELECT name FROM contracts WHERE id=?',f.id).name,'本人维护');
});

test('管理员保存失败时业务和日志全部回滚，已确认结算和超额回款仍拒绝',async t=>{
 const f=await setup(t),before=one(f.db,'SELECT count(*) n FROM audit').n;
 const failure=await f.request(`/contracts/${f.id}/maintenance`,{actor:f.admin,method:'PATCH',body:{fields:{name:'失败不得写入'},payments:[{id:f.paymentId,...paymentBody,amount:2000}],reason:'超额回款测试'}});
 assert.equal(failure.status,409,JSON.stringify(failure.body));assert.equal(one(f.db,'SELECT name FROM contracts WHERE id=?',f.id).name,'销售编辑验收');assert.equal(one(f.db,'SELECT amount FROM payments WHERE id=?',f.paymentId).amount,10000);assert.equal(one(f.db,'SELECT count(*) n FROM audit').n,before);
 const batchId=Number(run(f.db,"INSERT INTO commission_batches(sales_id,kind,period,base,rate,amount,status,snapshot,created_at,confirmed_by) VALUES(2,'personal','2026-10',10000,0.1,1000,'confirmed',?,datetime('now'),1)",JSON.stringify({evidence:[{contract_id:f.id}]})).lastInsertRowid);
 run(f.db,"INSERT INTO commission_lines(batch_id,contract_id,item_id,base,rebate_rate,rate,amount) VALUES(?,?,?,10000,0.2,0.1,1000)",batchId,f.id,one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',f.id).id);
 assert.equal((await f.request(`/payments/${f.paymentId}/details`,{actor:f.admin,method:'PATCH',body:paymentBody})).status,409);
 assert.equal(one(f.db,'SELECT count(*) n FROM audit').n,before);
});

test('管理员修改明细显示真实单位、空值和转义文本，不渲染未变字段',()=>{
 const S={users:[],customers:[],contracts:[]};
 const html=auditChanges(S,{before:{amount:10000,note:null,status:'待到账'},after:{amount:0,note:'<img src=x>',status:'待到账'},reason:'<script>依据</script>',payment_id:12});
 assert.match(html,/¥100 → ¥0/);assert.match(html,/未填写 → &lt;img src=x&gt;/);assert.match(html,/&lt;script&gt;依据&lt;\/script&gt;/);assert.doesNotMatch(html,/<img|<script|<b>回款 #12 · 状态/);
});
