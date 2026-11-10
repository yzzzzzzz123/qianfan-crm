import {historicalCommission} from './helpers/historical-commission.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {commissionPreview} from '../server/modules/incentives.mjs';
import {receiptMarginLedger,RECEIPT_MARGIN_SCHEME} from '../server/modules/receipt-margins.mjs';
import {itemSignature,paymentSignature} from '../server/qfcrm-source-fields.mjs';

async function setup(t){
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,11,15,3)});
 const f=await fixture(t),admin=await f.login(1);
 const rules=()=>JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value);
 const actor=one(f.db,'SELECT * FROM users WHERE id=1');
 const preview=(month='2026-11')=>commissionPreview(f.db,rules(),actor,month);
 const personal=(id=2,month='2026-11')=>preview(month).previews.find(p=>p.sales_id===id&&p.kind==='personal');
 const team=()=>preview().previews.find(p=>p.kind==='management');
 async function create(items,owner_id=2,date='2026-10-01'){
  const r=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:1,owner_id,name:'回款毛利专项合同',sign_date:date,items}});
  assert.equal(r.status,200,JSON.stringify(r.body));run(f.db,"UPDATE contracts SET lifecycle='历史登记' WHERE id=?",r.body.id);return r.body.id;
 }
 async function pay(contract_id,amount,product_amount,date='2026-11-10'){
  const r=await f.request('/payments',{actor:admin,method:'POST',body:{contract_id,amount,status:'已到账',pay_date:date,...(product_amount!==undefined?{product_amount}:{})}});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id;
 }
 async function review(id=2,score=80){const r=await f.request('/performance/review',{actor:admin,method:'POST',body:{user_id:id,month:'2026-11',final_score:score,reason:'隔离专项验收',status:'confirmed'}});assert.equal(r.status,200,JSON.stringify(r.body));}
 return {...f,admin,rules,preview,personal,team,create,pay,review};
}
const product=(amount,margin)=>({name:'产品授权',kind:'标品',amount,margin});
const service=(amount,margin,kind='定开')=>({name:'开发运维',kind,amount,margin});

test('十万产品到账×25%毛利率=2.5万毛利，B级10%计2500；历史快照、补差及已发放依据保留',async t=>{
 const f=await setup(t),id=await f.create([product(100000,25000)]);await f.pay(id,100000);await f.review();
 const p=f.personal();assert.equal(p.scheme,RECEIPT_MARGIN_SCHEME);assert.equal(p.policy_version,'sales-20261101');assert.equal(p.components[0].base,2500000);assert.equal(p.components[0].rate,.1);assert.equal(p.total,250000);assert.equal(p.blocked,false);
 assert.equal(p.evidence[0].product_margin_rate,.25);assert.equal(p.evidence[0].product_commission,250000);
 const r=historicalCommission(f,p);assert.equal(r.status,200,JSON.stringify(r.body));
 const original=one(f.db,'SELECT snapshot FROM commission_batches WHERE id=?',r.body.id).snapshot;
 assert.equal(f.personal().due,0);assert.equal((await f.request('/commissions/confirm',{actor:f.admin,method:'POST',body:f.personal()})).status,410);
 run(f.db,"UPDATE commission_batches SET status='paid',paid_at='2026-12-01' WHERE id=?",r.body.id);
 assert.equal(one(f.db,'SELECT snapshot FROM commission_batches WHERE id=?',r.body.id).snapshot,original);
});

test('多合同分别使用20%和50%，按毛利合计选档；合同、回款、提成展示同一毛利率',async t=>{
 const f=await setup(t),a=await f.create([product(50000,10000)]),b=await f.create([product(50000,25000)]);await f.pay(a,50000);await f.pay(b,50000);await f.review();
 const p=f.personal();assert.equal(p.components[0].base,3500000);assert.equal(p.total,350000);assert.equal(p.product_margin_rates_multiple,true);assert.equal(p.product_margin_rate,null);
 const s=(await f.request('/state?commissionPeriod=2026-11',{actor:f.admin})).body;
 for(const id of [a,b]){const c=s.contracts.find(c=>c.id===id),r=s.commission.receipt_review.find(p=>p.contract_id===id);assert.equal(c.product_margin_rate,r.product_margin_rate);}
});

test('开发运维按当月跨合同实际服务到账选档；未回款合同及签约月份不产生服务计提',async t=>{
 const f=await setup(t),a=await f.create([service(15000,3000)]),b=await f.create([service(15000,7500,'运维')]);await f.create([service(100000,50000)]);
 await f.pay(a,15000);await f.pay(b,15000);await f.review();
 const p=f.personal();assert.equal(p.components[1].base,3000000);assert.equal(p.components[1].rate,.08);assert.equal(p.total,240000);assert.equal(p.lines.length,2);assert.equal(p.blocked,false);
 assert.deepEqual(p.scenarios.find(s=>s.grade==='A'),{grade:'A',product:0,service:300000});
 assert.equal(f.team().components[1].base,1050000);assert.equal(f.team().total,31500);
});

test('王宏个人固定A级无需绩效，低于2万毛利的A级空白比例保持待核对，明确0毛利有效',async t=>{
 const f=await setup(t),id=await f.create([product(100000,25000)],1);await f.pay(id,100000);
 let p=f.personal(1);assert.equal(p.grade,'A');assert.equal(p.grade_source,'fixed_A');assert.equal(p.review_id,null);assert.equal(p.blocked,false);assert.equal(p.total,300000);assert.equal(one(f.db,'SELECT COUNT(*) n FROM performance_reviews WHERE user_id=1').n,0);
 const item=one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',id);
 run(f.db,'UPDATE contract_items SET margin=1000000 WHERE id=?',item.id);p=f.personal(1);assert.equal(p.blocked,true);assert.equal(p.amount_pending,true);assert.equal(p.components[0].rate,null);
 run(f.db,'UPDATE contract_items SET margin=0 WHERE id=?',item.id);p=f.personal(1);assert.equal(p.total,0);assert.equal(p.blocked,false);assert.equal(p.components[0].base,0);
});

test('团队仅其他销售当月回款毛利，20万含等于3%，超过20万全额5%，王宏订单完全排除',async t=>{
 const f=await setup(t),other=await f.create([product(400002,200001)]),own=await f.create([product(1000000,1000000)],1);await f.pay(other,400000);await f.pay(own,1000000);
 let p=f.team();assert.equal(p.base,20000000);assert.equal(p.rate,.03);assert.equal(p.total,600000);assert.ok(p.evidence.every(e=>e.sales_id!==1));assert.equal(p.blocked,false);
 const r=historicalCommission(f,p);assert.equal(r.status,200,JSON.stringify(r.body));
 const snapshot=one(f.db,'SELECT snapshot FROM commission_batches WHERE id=?',r.body.id).snapshot;assert.equal(f.team().due,0);
 await f.pay(other,1);p=f.team();assert.equal(p.base,20000050);assert.equal(p.rate,.05);assert.equal(p.total,1000003);assert.equal(p.due,400003);assert.equal(p.lines.reduce((s,l)=>s+l.amount,0),p.due);
 historicalCommission(f,p);assert.equal(f.team().due,0);assert.equal(one(f.db,'SELECT snapshot FROM commission_batches WHERE id=?',r.body.id).snapshot,snapshot);
});

test('产品和服务分期跨月累计取分币差额，同一流水反复读取不重复计毛利',async t=>{
 const f=await setup(t),id=await f.create([product(.03,.01),service(.03,.01)]);
 await f.pay(id,.02,.01,'2026-10-10');await f.pay(id,.02,.01,'2026-11-10');await f.pay(id,.02,.01,'2026-12-10');
 const rows=['2026-10','2026-11','2026-12'].map(m=>receiptMarginLedger(f.db,m).rows.find(r=>r.contract_id===id));
 assert.deepEqual(rows.map(r=>r.product_gross_margin),[0,1,0]);assert.deepEqual(rows.map(r=>r.service_gross_margin),[0,1,0]);
 assert.equal(receiptMarginLedger(f.db,'2026-11').rows.find(r=>r.contract_id===id).gross_margin,2);
 assert.equal(all(f.db,'SELECT * FROM payments WHERE contract_id=?',id).length,3);
 const half=await f.create([product(.06,.01)]);await f.pay(half,.03,undefined,'2026-10-10');await f.pay(half,.03,undefined,'2026-11-10');
 assert.equal(receiptMarginLedger(f.db,'2026-10').rows.find(r=>r.contract_id===half).product_gross_margin,1);
 assert.equal(receiptMarginLedger(f.db,'2026-11').rows.find(r=>r.contract_id===half).product_gross_margin,0);
});

test('混合回款缺分配不猜，实施交付未分类不自动当开发运维，缺毛利不默认为零',async t=>{
 const f=await setup(t),a=await f.create([product(100000,25000),service(10000,5000)]),b=await f.create([service(10000,5000,'实施')]),c=await f.create([product(10000,null)]);
 await f.pay(a,10000);await f.pay(b,10000);await f.pay(c,10000);await f.review();
 const p=f.personal();assert.equal(p.blocked,true);assert.equal(p.amount_pending,true);assert.match(p.issues.join(';'),/分配未填写/);assert.match(p.issues.join(';'),/服务分类待核对/);assert.match(p.issues.join(';'),/产品毛利率缺失/);assert.equal(p.components[1].base,0);
 assert.equal((await f.request('/commissions/confirm',{actor:f.admin,method:'POST',body:p})).status,410);
});

test('服务个人计提可按实际回款，团队缺服务毛利仍待核对；未知归属与非业务人员不进入团队',async t=>{
 const f=await setup(t),id=await f.create([service(15000,null)]);await f.pay(id,15000);await f.review();
 const own=f.personal();assert.equal(own.total,75000);assert.equal(own.blocked,false);assert.equal(f.team().blocked,true);assert.match(f.team().issues.join(';'),/服务毛利/);
 const unknown=await f.create([product(10000,5000)]);await f.pay(unknown,10000);
 // Model an authorized historical import only in this isolated fixture; restore its exact guard.
 const guard=one(f.db,"SELECT sql FROM sqlite_master WHERE name='contracts_required_owner_update'").sql;f.db.exec('DROP TRIGGER contracts_required_owner_update');run(f.db,'UPDATE contracts SET owner_id=NULL WHERE id=?',unknown);f.db.exec(guard);
 assert.throws(()=>run(f.db,'UPDATE contracts SET owner_id=NULL WHERE id=?',id),/known business owner/);
 assert.ok(!f.team().evidence.some(e=>e.contract_id===unknown));assert.ok(f.preview().receipt_review.find(r=>r.contract_id===unknown).issues.includes('合同销售归属未确定'));
 const privateView=(await f.request('/state?commissionPeriod=2026-11',{actor:await f.login(3)})).body.commission;assert.ok(privateView.receipt_review.every(p=>p.sales_id===3));assert.ok(privateView.previews.every(p=>p.sales_id===3));
});

test('有效来源毛利率优先且明确0有效，人工修改明细后指纹失效立即使用当前合同毛利率',async t=>{
 const f=await setup(t),id=await f.create([product(100000,25000)]);await f.pay(id,100000);await f.review();
 run(f.db,"UPDATE contracts SET contract_no='RATE-SOURCE' WHERE id=?",id);
 const c=one(f.db,'SELECT * FROM contracts WHERE id=?',id),items=all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',id),payments=all(f.db,'SELECT * FROM payments WHERE contract_id=?',id);
 const facts={contract_no:c.contract_no,amount:c.amount,product_amount:c.amount,service_amount:0,product_margin:2500000,service_margin:0,total_margin:2500000,product_margin_rate:0,received_at:'2026-11-10',collection_status:'已结清',product_names:['产品授权'],product_types:['标品'],issues:[],sales_names:['祝天'],item_signature:itemSignature(items),payment_signature:paymentSignature(payments)};
 run(f.db,"INSERT INTO source_records(entity,entity_id,source,source_id,source_file,sheet_name,row_number,fingerprint,payload,imported_at,status,reason) VALUES('contract',?,'QFCRM','rate-source','isolated','合同',1,'rate-source',?,'2026-11-01','imported','')",id,JSON.stringify({format:'qfcrm-three-table-v1',contract:facts}));
 assert.equal(f.personal().components[0].base,0);assert.equal(f.personal().evidence[0].product_margin_rate,0);
 const r=await f.request(`/items/${items[0].id}`,{actor:f.admin,method:'PATCH',body:{margin:30000,reason:'人工核对实际毛利'}});assert.equal(r.status,200,JSON.stringify(r.body));
 const s=(await f.request('/state?commissionPeriod=2026-11',{actor:f.admin})).body;
 assert.equal(s.contracts.find(c=>c.id===id).product_margin_rate,.3);assert.equal(s.commission.receipt_review.find(r=>r.contract_id===id).product_margin_rate,.3);assert.equal(f.personal().components[0].base,3000000);
});

test('同月旧算法及旧季度合同结算阻止新算法重复计提，旧快照和历史周期保持可读',async t=>{
 const f=await setup(t),id=await f.create([product(100000,25000)]);await f.pay(id,100000);await f.review();
 const item=one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',id),snapshot=JSON.stringify({scheme:'sales-20261101',old:true});
 const batch=Number(run(f.db,"INSERT INTO commission_batches(sales_id,kind,period,base,rate,amount,status,snapshot,created_at,confirmed_by) VALUES(2,'personal','2026-11',10000,.1,1000,'paid',?,'2026-12-01',1)",snapshot).lastInsertRowid);
 run(f.db,"INSERT INTO commission_lines(batch_id,contract_id,item_id,base,rebate_rate,rate,amount,component) VALUES(?,?,?,10000,NULL,.1,1000,'product')",batch,id,item.id);
 let p=f.personal();assert.equal(p.blocked,true);assert.match(p.issues.join(';'),/同月已有其他算法/);assert.equal((await f.request('/commissions/confirm',{actor:f.admin,method:'POST',body:p})).status,410);
 run(f.db,"UPDATE commission_batches SET period='2026Q4' WHERE id=?",batch);p=f.personal();assert.equal(p.blocked,true);assert.match(p.issues.join(';'),/历史结算/);
 const history=f.preview('2026Q4');assert.ok(history.previews.every(p=>p.scheme==='legacy'));assert.deepEqual(history.batches.find(b=>b.id===batch).snapshot,JSON.parse(snapshot));assert.equal(one(f.db,'SELECT snapshot FROM commission_batches WHERE id=?',batch).snapshot,snapshot);
});
