import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {one,all,run} from '../server/database.mjs';
import {contractFields,collectionFields} from '../public/modules/contract-fields.js';
import {contractList,contractFacts,collectionDetail,collectionsPage,formWorkflow} from '../public/modules/contract-workflow.js';
import {contractDetail} from '../public/modules/contracts.js';
import {contractSourceFields,importedCollections,itemSignature,paymentSignature} from '../server/qfcrm-source-fields.mjs';

async function setup(t){
 const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),other=await f.login(3);
 const r=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:1,owner_id:2,name:'合同回款一对多',sign_date:'2026-10-05',items:[{name:'产品',kind:'标品',amount:600,margin:120},{name:'服务',kind:'交付',amount:400,margin:80}]}});
 assert.equal(r.status,200,JSON.stringify(r.body));const id=r.body.id;
 run(f.db,"UPDATE contracts SET lifecycle='历史登记' WHERE id=?",id);
 return {...f,admin,sales,other,id};
}
const body=(amount,product_amount,date='2026-10-10')=>({amount,product_amount,pay_date:date,status:'已到账'});

test('多笔到账维护更新同一合同汇总和十月取数，计划不计到账，越权及超额均回滚',async t=>{
 const f=await setup(t);
 const pay=async b=>f.request('/payments',{actor:f.admin,method:'POST',body:{contract_id:f.id,...b}});
 let r=await pay(body(200,100));assert.equal(r.status,200);const pid=r.body.id;
 assert.equal((await pay(body(300,200,'2026-10-20'))).status,200);
 assert.equal((await pay({amount:500,status:'待到账',promise_date:'2026-12-01'})).status,200);
 let s=(await f.request('/state?commissionPeriod=2026-10',{actor:f.admin})).body,c=s.contracts.find(c=>c.id===f.id);
 assert.equal(c.collected,50000);assert.equal(c.outstanding,50000);assert.equal(c.payments.length,3);
 const audit=s.commission.receipt_review.filter(r=>r.contract_id===f.id);assert.equal(audit.length,2);assert.equal(audit.reduce((n,r)=>n+r.amount,0),50000);assert.equal(audit.reduce((n,r)=>n+r.product_amount,0),30000);
 const before=one(f.db,'SELECT * FROM payments WHERE id=?',pid);
 assert.equal((await f.request(`/payments/${pid}/details`,{actor:f.sales,method:'PATCH',body:{...body(100,100),reason:'越权'}})).status,403);
 assert.equal((await f.request(`/payments/${pid}/details`,{actor:f.admin,method:'PATCH',body:{...body(800,400),reason:'超额'}})).status,409);
 assert.deepEqual(one(f.db,'SELECT * FROM payments WHERE id=?',pid),before);
 r=await f.request(`/payments/${pid}/details`,{actor:f.admin,method:'PATCH',body:{...body(250,150),note:'核对原件',reason:'修正实际到账'}});assert.equal(r.status,200,JSON.stringify(r.body));
 s=(await f.request('/state?commissionPeriod=2026-10',{actor:f.admin})).body;c=s.contracts.find(c=>c.id===f.id);assert.equal(c.collected,55000);assert.equal(c.outstanding,45000);
 const trial=s.commission.previews.find(p=>p.sales_id===2);assert.equal(trial.components[0].base,35000);assert.equal(trial.trial_only,true);assert.equal(trial.blocked,true);
 assert.equal((await f.request('/commissions/confirm',{actor:f.admin,method:'POST',body:trial})).status,409);
 assert.equal(one(f.db,'SELECT count(*) n FROM commission_batches').n,0);
 const own=(await f.request('/state?commissionPeriod=2026-10',{actor:f.other})).body.commission;assert.ok(own.receipt_review.every(p=>p.sales_id===3));
});

test('合同明细整批维护可回读，关联金额冲突及后续字段错误使所有明细和审计回滚',async t=>{
 const f=await setup(t);let items=all(f.db,'SELECT * FROM contract_items WHERE contract_id=? ORDER BY id',f.id);
 const payload=items.map(i=>({id:i.id,name:i.name,kind:i.kind,amount:i.amount/100,margin:i.margin/100}));payload[0].amount=800;payload[0].margin=160;
 let r=await f.request(`/contracts/${f.id}`,{actor:f.admin,method:'PATCH',body:{items:payload,reason:'核对实际产品价格'}});assert.equal(r.status,200,JSON.stringify(r.body));
 let c=(await f.request('/state',{actor:f.admin})).body.contracts.find(c=>c.id===f.id);assert.equal(c.amount,120000);assert.equal(c.product_amount,80000);assert.equal(c.product_margin,16000);
 const before=all(f.db,'SELECT * FROM contract_items WHERE contract_id=? ORDER BY id',f.id),audits=one(f.db,'SELECT count(*) n FROM audit').n;
 payload[0].name='不应保存';r=await f.request(`/contracts/${f.id}`,{actor:f.admin,method:'PATCH',body:{items:payload,renewal_tag:'错误标签',reason:'事务回滚'}});assert.equal(r.status,400);
 assert.deepEqual(all(f.db,'SELECT * FROM contract_items WHERE contract_id=? ORDER BY id',f.id),before);assert.equal(one(f.db,'SELECT count(*) n FROM audit').n,audits);
 assert.equal((await f.request(`/contracts/${f.id}`,{actor:f.admin,method:'PATCH',body:{items:[payload[0],payload[0]],reason:'重复明细'}})).status,400);
});

test('合同整行删除对有权销售开放，保留明细回款，越权、未确认、已结算合同不能删除',async t=>{
 const f=await setup(t);let r=await f.request('/payments',{actor:f.admin,method:'POST',body:{contract_id:f.id,...body(100,60)}});assert.equal(r.status,200);
 const rows=all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',f.id),payments=all(f.db,'SELECT * FROM payments WHERE contract_id=?',f.id),b={confirmed:true,reason:'核对后删除隔离业务'};
 assert.equal((await f.request(`/contracts/${f.id}`,{actor:f.other,method:'DELETE',body:b})).status,403);
 assert.equal((await f.request(`/contracts/${f.id}`,{actor:f.sales,method:'DELETE',body:{reason:'未确认'}})).status,400);
 r=await f.request(`/contracts/${f.id}`,{actor:f.sales,method:'DELETE',body:b});assert.equal(r.status,200,JSON.stringify(r.body));
 assert.ok(one(f.db,'SELECT retired_at FROM contracts WHERE id=?',f.id).retired_at);
 assert.deepEqual(all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',f.id),rows);assert.deepEqual(all(f.db,'SELECT * FROM payments WHERE contract_id=?',f.id),payments);
 const s=(await f.request('/state?commissionPeriod=2026-10',{actor:f.admin})).body;assert.ok(!s.contracts.some(c=>c.id===f.id));assert.ok(!s.commission.receipt_review.some(p=>p.contract_id===f.id));
 assert.equal((await f.request(`/contracts/${f.id}`,{actor:f.sales,method:'DELETE',body:b})).status,410);
 const locked=one(f.db,'SELECT id FROM contracts WHERE retired_at IS NULL LIMIT 1').id,item=one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',locked);
 const batch=Number(run(f.db,"INSERT INTO commission_batches(sales_id,kind,period,base,rate,amount,status,snapshot,created_at,confirmed_by) VALUES(2,'personal','2026-10',100,.1,10,'confirmed','{}','2026-11-01',1)").lastInsertRowid);
 run(f.db,'INSERT INTO commission_lines(batch_id,contract_id,item_id,base,rebate_rate,rate,amount) VALUES(?,?,?,?,?,?,?)',batch,locked,item.id,100,.1,.1,10);
 assert.equal((await f.request(`/contracts/${locked}`,{actor:f.admin,method:'DELETE',body:b})).status,409);assert.equal(one(f.db,'SELECT retired_at FROM contracts WHERE id=?',locked).retired_at,null);
});

test('合同及回款列表每个字段都出现在对应详情与维护总览，经销品标识不再展示',async t=>{
 const f=await setup(t),S=(await f.request('/state',{actor:f.admin})).body,c=S.contracts.find(c=>c.id===f.id);
 for(const [fields,list,detail,form] of [[contractFields(S,c),contractList(S,{}),contractDetail(S,c.id),formWorkflow(S,'contract-maintain',c.id)],[collectionFields(S,c),collectionsPage({...S,collections:[c]},{}),collectionDetail({...S,collections:[c]},c.id),formWorkflow(S,'contract-project',c.id)]]){
  for(const [label] of fields){assert.ok(list.includes(label),label);assert.ok(detail.includes(label),label);const alias={'客户名称 / 合同':'客户名称','关联合同 / 客户名称':'合同编号','是否已回款':'回款状态','实际回款时间':'回款时间'};assert.ok(form.includes(alias[label]||label),label);}
  for(const html of [list,detail,form])assert.ok(!html.includes('经销品标识'));
 }
 assert.match(contractDetail(S,c.id),/回款明细（0）/);assert.match(formWorkflow(S,'contract-maintain',c.id),/data-contract-item/);
});

test('历史来源投影不覆盖人工维护后的合同产品与毛利',()=>{
 const c={id:1,contract_no:'A',amount:10000,renewal_tag:'续费'},items=[{id:2,contract_id:1,name:'原产品',kind:'标品',amount:10000,margin:2000}];
 const facts={contract_no:'A',amount:10000,item_signature:itemSignature(items),payment_signature:paymentSignature([]),sales_names:[]};
 const edited=contractSourceFields(c,[{...items[0],name:'新产品',margin:3000}],[],facts);
 assert.equal(edited.source_items_edited,true);assert.ok(!Object.hasOwn(edited,'dealer_product'));
 const live={...c,...edited,lifecycle:'历史登记',product_names:['新产品'],product_margin:3000,service_margin:0,total_margin:3000,payments:[]};
 const rows=importedCollections([live],[{contract_id:1,product_names:['原产品'],product_margin:2000,service_margin:0,total_margin:2000,payment_ids:[],payment_signature:paymentSignature([])}]);
 assert.equal(rows[0].product_margin,3000);assert.deepEqual(rows[0].product_names,['新产品']);
 const cleared=importedCollections([{...live,project_status:null,project_note:null,delivery_staff:null}],[{contract_id:1,project_statuses:['交付中'],note:'历史备注',delivery_names:['旧交付人员'],sales_names:['旧销售'],manager_names:['旧PM'],payment_ids:[]}],{maintainedFields:new Map([[1,new Set(['project_status','project_note','delivery_staff','owner_id','collaborator_pm'])]])});
 for(const key of ['project_status','project_note','delivery_staff'])assert.equal(cleared[0][key],null);
 assert.deepEqual(cleared[0].collection_sales_names,[]);assert.deepEqual(cleared[0].collection_manager_names,[]);
});

test('历史缺少预计日期的付款计划仍可维护备注，修改金额后必须明确预计日期',async t=>{
 const f=await setup(t);const r=await f.request('/payments',{actor:f.admin,method:'POST',body:{contract_id:f.id,amount:100,status:'待到账',promise_date:'2026-12-01'}});assert.equal(r.status,200);
 const id=r.body.id;run(f.db,'UPDATE payments SET promise_date=NULL,checkpoint_date=NULL WHERE id=?',id);
 const b={amount:100,status:'待到账',note:'补记原始付款说明',reason:'保留原日期缺失'};
 assert.equal((await f.request(`/payments/${id}/details`,{actor:f.admin,method:'PATCH',body:b})).status,200);
 assert.equal(one(f.db,'SELECT promise_date FROM payments WHERE id=?',id).promise_date,null);
 assert.equal((await f.request(`/payments/${id}/details`,{actor:f.admin,method:'PATCH',body:{...b,amount:200}})).status,400);
 assert.equal(one(f.db,'SELECT amount FROM payments WHERE id=?',id).amount,10000);
});
