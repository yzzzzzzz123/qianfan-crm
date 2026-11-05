import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {itemSignature,paymentSignature} from '../server/qfcrm-source-fields.mjs';
import {commissionInputs} from '../server/modules/commission-inputs.mjs';
import {formWorkflow} from '../public/modules/contract-workflow.js';

async function setup(t){
 const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
 const r=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:1,owner_id:2,name:'字段直接维护验收',sign_date:'2026-10-01',items:[{name:'产品甲',kind:'标品',amount:600,margin:120},{name:'服务乙',kind:'交付',amount:400,margin:80}]}});assert.equal(r.status,200);
 const id=r.body.id;run(f.db,"UPDATE contracts SET lifecycle='历史登记' WHERE id=?",id);
 return {...f,admin,sales,id};
}
const itemBody=(f)=>all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',f.id).map(i=>({id:i.id,name:i.name,kind:i.kind,amount:i.amount/100,margin:i.margin/100}));

test('同一维护表单保存客户、创建时间、产品与实际到账，失败则全部回滚',async t=>{
 const f=await setup(t),items=itemBody(f),body={fields:{name:'直接修改成功',created_at:'2026-10-02T01:02:00Z'},items,payments:[{id:null,contract_id:f.id,amount:100,product_amount:60,status:'已到账',pay_date:'2026-10-10'}],reason:'隔离表单统一维护'};
 items[0].amount=800;items[0].margin=160;
 let r=await f.request(`/contracts/${f.id}/maintenance`,{actor:f.admin,method:'PATCH',body});assert.equal(r.status,200,JSON.stringify(r.body));
 let c=(await f.request('/state',{actor:f.admin})).body.contracts.find(c=>c.id===f.id);assert.equal(c.amount,120000);assert.equal(c.collected,10000);assert.equal(c.name,'直接修改成功');assert.equal(c.created_at,'2026-10-02T01:02:00.000Z');
 const before={c:one(f.db,'SELECT * FROM contracts WHERE id=?',f.id),items:all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',f.id),p:all(f.db,'SELECT * FROM payments WHERE contract_id=?',f.id),audit:one(f.db,'SELECT count(*) n FROM audit').n};
 body.fields.name='不应保存';body.payments[0].amount=2000;
 r=await f.request(`/contracts/${f.id}/maintenance`,{actor:f.admin,method:'PATCH',body});assert.equal(r.status,400,JSON.stringify(r.body));
 assert.deepEqual(one(f.db,'SELECT * FROM contracts WHERE id=?',f.id),before.c);assert.deepEqual(all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',f.id),before.items);assert.deepEqual(all(f.db,'SELECT * FROM payments WHERE contract_id=?',f.id),before.p);assert.equal(one(f.db,'SELECT count(*) n FROM audit').n,before.audit);
 assert.equal((await f.request(`/contracts/${f.id}/maintenance`,{actor:f.sales,method:'PATCH',body:{fields:{name:'越权'},reason:'禁止'}})).status,403);
});

test('新增明细需显式填写且保留全部旧行，客户关系和字段类型继续校验',async t=>{
 const f=await setup(t),items=itemBody(f);items.push({id:null,name:'新增已核对运维',kind:'运维',amount:200,margin:50});
 let r=await f.request(`/contracts/${f.id}/maintenance`,{actor:f.admin,method:'PATCH',body:{fields:{customer_id:2},items,reason:'明确调整客户与新增明细'}});assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(one(f.db,'SELECT customer_id,amount FROM contracts WHERE id=?',f.id).customer_id,2);assert.equal(all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',f.id).length,3);
 for(const fields of [{fake:1},{created_at:'2099-01-01T00:00:00Z'}])assert.equal((await f.request(`/contracts/${f.id}/maintenance`,{actor:f.admin,method:'PATCH',body:{fields,reason:'非法字段测试'}})).status,400);
});

test('维护字段仅显示一套编辑控件，金额与日期可编辑，不再重复只读总览',async t=>{
 const f=await setup(t),S=(await f.request('/state',{actor:f.admin})).body;
 for(const type of ['contract-maintain','contract-project']){
  const html=formWorkflow(S,type,f.id);assert.doesNotMatch(html,/maintenance-overview|<dl|readonly/);
  for(const field of ['customer_id','name','owner_id','order_type','created_at','project_status'])assert.equal((html.match(new RegExp(`name="${field}"`,'g'))||[]).length,1,field);
  for(const field of ['product_amount','product_margin_rate','product_margin','service_amount','service_margin','total_margin','collected','last_received_at'])assert.equal((html.match(new RegExp(`data-summary="${field}"`,'g'))||[]).length,1,field);
 }
});

function sourceClaim(f){
 const c=one(f.db,'SELECT * FROM contracts WHERE id=?',f.id),items=all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',c.id);
 const payload={format:'qfcrm-three-table-v1',contract:{contract_no:'CLAIM-TEST',amount:c.amount,sales_names:['祝天'],product_names:['产品甲','服务乙'],product_types:['标品','交付'],product_amount:60000,service_amount:40000,product_margin:12000,service_margin:8000,total_margin:20000,product_margin_rate:.2,received_at:'2026-10-10',collection_status:'已结清',item_signature:itemSignature(items),payment_signature:paymentSignature([]),issues:[]}};
 run(f.db,"UPDATE contracts SET contract_no='CLAIM-TEST' WHERE id=?",c.id);
 const cols=all(f.db,'PRAGMA table_info(source_records)');
 const row={entity:'contract',entity_id:c.id,source:'QFCRM',source_id:'claim-test',source_file:'隔离来源',sheet_name:'合同总表',row_number:1,fingerprint:'claim-test-fingerprint',payload:JSON.stringify(payload),imported_at:'2026-11-01',status:'imported',reason:''};
 for(const col of cols)if(!Object.hasOwn(row,col.name)&&col.notnull&&col.dflt_value==null&&col.name!=='id')throw new Error('source fixture missing '+col.name);
 const keys=Object.keys(row);run(f.db,`INSERT INTO source_records(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...Object.values(row));
}

test('实际到账写入对应销售基数，合同结清来源仅待核对试算，流水不重复创建',async t=>{
 const f=await setup(t),baseline=commissionInputs(f.db,'2026-10').basis.find(u=>u.sales_id===2);sourceClaim(f);
 const before=one(f.db,'SELECT count(*) n FROM payments').n;
 let inputs=commissionInputs(f.db,'2026-10'),basis=inputs.basis.find(u=>u.sales_id===2);assert.equal(basis.received_amount,baseline.received_amount);assert.equal(basis.source_claim_amount,100000);
 assert.ok(inputs.basis.every(u=>!one(f.db,'SELECT role,developer_admin,business_member FROM users WHERE id=?',u.sales_id).developer_admin));
 const s=(await f.request('/state?commissionPeriod=2026-10',{actor:f.admin})).body;
 const preview=s.commission.previews.find(p=>p.sales_id===2);assert.equal(preview.evidence.find(p=>p.contract_id===f.id).product_amount,60000);assert.equal(preview.blocked,true);assert.match(preview.issues.join('；'),/缺少逐笔到账/);assert.equal(one(f.db,'SELECT count(*) n FROM payments').n,before);
 assert.equal((await f.request('/commissions/confirm',{actor:f.admin,method:'POST',body:preview})).status,409);
 const paid=await f.request('/payments',{actor:f.admin,method:'POST',body:{contract_id:f.id,amount:100,product_amount:60,status:'已到账',pay_date:'2026-10-10'}});assert.equal(paid.status,200);
 inputs=commissionInputs(f.db,'2026-10');basis=inputs.basis.find(u=>u.sales_id===2);assert.equal(basis.received_amount,baseline.received_amount+10000);assert.equal(basis.receipt_count,baseline.receipt_count+1);assert.equal(basis.source_claim_amount,0);
 const other=(await f.request('/state?commissionPeriod=2026-10',{actor:await f.login(3)})).body.commission;assert.ok(other.sales_basis.every(p=>p.sales_id===3));
});
