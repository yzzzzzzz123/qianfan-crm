import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {historicalCommission} from './helpers/historical-commission.mjs';
import {all,one,run} from '../server/database.mjs';
import {commissionPreview} from '../server/modules/incentives.mjs';

async function setup(t){
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,11,15,3)});
 const f=await fixture(t),admin=await f.login(1),actor=one(f.db,'SELECT * FROM users WHERE id=1');
 const rules=()=>JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value);
 const model=(month='2026-11')=>commissionPreview(f.db,rules(),actor,month);
 const personal=(id=1,month='2026-11')=>model(month).realtime_previews.find(p=>p.sales_id===id&&p.kind==='personal');
 const team=()=>model().realtime_previews.find(p=>p.sales_id===1&&p.kind==='management');
 async function create(items,owner_id=1,sign_date='2026-10-01'){
  const r=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:1,owner_id,name:'个人提成规则隔离合同',sign_date,items}});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id;
 }
 async function pay(contract_id,amount,pay_date='2026-11-10'){
  const r=await f.request('/payments',{actor:admin,method:'POST',body:{contract_id,amount,status:'已到账',pay_date}});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id;
 }
 return {...f,admin,rules,model,personal,team,create,pay};
}
const product=(amount,margin)=>({name:'产品授权',kind:'标品',amount,margin});
const service=(amount,kind='定开')=>({name:'开发运维',kind,amount,margin:amount/2});

test('管理者个人实时产品按固定A级销售规则计3000元，无需绩效记录',async t=>{
 const f=await setup(t),id=await f.create([product(100000,25000)]);await f.pay(id,100000);
 const p=f.personal();assert.equal(p.kind,'personal');assert.equal(p.period,'2026-11');assert.equal(p.scheme,'sales-receipt-margin-v2');assert.equal(p.calculation_scope,'monthly-policy-only');assert.equal(p.grade,'A');assert.equal(p.grade_source,'fixed_A');assert.equal(p.performance_status,'fixed');assert.equal(p.review_id,null);
 assert.equal(p.components[0].base,2500000);assert.equal(p.components[0].rate,.12);assert.equal(p.total,300000);assert.equal(p.calculated_total,300000);assert.ok(p.lines.every(l=>l.component==='product'));assert.equal(p.contract_issues.some(i=>i.code==='performance_missing'),false);assert.equal(p.notices.some(i=>i.code==='performance_live'),false);
 assert.equal(one(f.db,'SELECT count(*) AS n FROM performance_reviews WHERE user_id=1').n,0);assert.equal(f.model().realtime_previews.filter(p=>p.sales_id===1&&p.kind==='personal').length,1);
});

test('管理者个人开发运维跨合同月到账3万元按A级10%计3000元',async t=>{
 const f=await setup(t),a=await f.create([service(15000)]),b=await f.create([service(15000,'运维')]);await f.create([service(100000)]);await f.pay(a,15000);await f.pay(b,15000);
 const p=f.personal();assert.equal(p.components[1].base,3000000);assert.equal(p.components[1].rate,.1);assert.equal(p.components[1].total,300000);assert.equal(p.total,300000);assert.equal(p.lines.length,2);assert.deepEqual(new Set(p.lines.map(l=>l.contract_id)),new Set([a,b]));
});

test('管理者跨签约季度合同按各月真实到账独立计提，重复读取不重算累计',async t=>{
 const f=await setup(t),id=await f.create([product(200000,50000)],1,'2026-09-01');await f.pay(id,100000,'2026-11-10');await f.pay(id,100000,'2026-12-10');
 for(const month of ['2026-11','2026-12']){const p=f.personal(1,month);assert.equal(p.period,month);assert.equal(p.components[0].base,2500000);assert.equal(p.total,300000);assert.equal(p.evidence.length,1);assert.ok(p.evidence.every(r=>r.date.startsWith(month)));}
 assert.equal(f.personal(1,'2026-10').total,0);assert.equal(f.personal(1,'2026-11').total,300000);assert.equal(all(f.db,'SELECT id FROM payments WHERE contract_id=?',id).length,2);
});

test('管理者个人无真实到账不按签约毛利或服务合同额生成提成',async t=>{
 const f=await setup(t);await f.create([product(100000,25000)]);await f.create([service(30000)]);
 const p=f.personal();assert.equal(p.total,0);assert.equal(p.components[0].base,0);assert.equal(p.components[1].base,0);assert.deepEqual(p.lines,[]);assert.deepEqual(p.evidence,[]);
});

test('管理者A级产品低于2万元毛利的空白比例保持NULL，明确零毛利不待核对',async t=>{
 const f=await setup(t),id=await f.create([product(100000,10000)]);await f.pay(id,100000);
 let p=f.personal();assert.equal(p.grade,'A');assert.equal(p.components[0].base,1000000);assert.equal(p.components[0].rate,null);assert.equal(p.components[0].total,null);assert.equal(p.total,null);assert.equal(p.amount_pending,true);assert.ok(p.contract_issues.some(i=>i.code==='rate_missing'));assert.equal(p.contract_issues.some(i=>i.code==='performance_missing'),false);
 run(f.db,'UPDATE contract_items SET margin=0,margin_before_expense=0 WHERE contract_id=?',id);p=f.personal();assert.equal(p.total,0);assert.equal(p.components[0].rate,0);assert.equal(p.amount_pending,false);
});

test('管理者个人改用销售规则不改变团队管理任何字段，本人订单始终排除',async t=>{
 const f=await setup(t),other=await f.create([product(100000,25000)],2);await f.pay(other,100000);const before=f.team();assert.equal(before.kind,'management');assert.equal(before.period,'2026Q4');assert.equal(before.scheme,'legacy-realtime');
 const own=await f.create([product(1000000,1000000)]);await f.pay(own,1000000);const after=f.team();assert.deepEqual(after,before);assert.ok(after.lines.every(l=>l.owner_id!==1&&l.contract_id!==own));assert.ok(f.personal().lines.every(l=>l.owner_id===1));
});

test('普通销售仍按本人绩效等级，管理者固定A级不扩散到其他销售',async t=>{
 const f=await setup(t),own=await f.create([product(100000,25000)]),other=await f.create([product(100000,25000)],2);await f.pay(own,100000);await f.pay(other,100000);
 assert.equal(f.personal(2).grade,'D');assert.equal(f.personal(2).components[0].rate,.05);assert.equal(f.personal(2).total,125000);assert.equal(f.personal().total,300000);
 const r=await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month:'2026-11',final_score:80,reason:'隔离测试普通销售B级',status:'draft'}});assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(f.personal(2).grade,'B');assert.equal(f.personal(2).components[0].rate,.1);assert.equal(f.personal(2).total,250000);assert.equal(f.personal().grade,'A');assert.equal(f.personal().total,300000);assert.equal(one(f.db,'SELECT count(*) AS n FROM performance_reviews WHERE user_id=1').n,0);
});

test('管理者个人已确认与已发放快照逐值保留，实时应计不扣历史确认金额',async t=>{
 const f=await setup(t),id=await f.create([product(100000,25000)]);await f.pay(id,100000);const p=f.model().previews.find(p=>p.sales_id===1&&p.kind==='personal');
 historicalCommission(f,{...p,due:100000,lines:p.lines.map(l=>({...l,amount:100000}))});historicalCommission(f,{...p,due:50000,lines:p.lines.map(l=>({...l,amount:50000}))},{paid:true});
 const batches=all(f.db,'SELECT * FROM commission_batches ORDER BY id'),lines=all(f.db,'SELECT * FROM commission_lines ORDER BY id');
 const realtime=f.personal();assert.equal(realtime.total,300000);assert.equal(realtime.lines.reduce((sum,l)=>sum+l.entitlement,0),300000);assert.equal(realtime.paid,50000);assert.equal(realtime.unpaid_amount,250000);
 f.model();assert.deepEqual(all(f.db,'SELECT * FROM commission_batches ORDER BY id'),batches);assert.deepEqual(all(f.db,'SELECT * FROM commission_lines ORDER BY id'),lines);
});

test('管理者旧季度快照与旧季度查看仍保留，月度切换不改写历史',async t=>{
 const f=await setup(t),id=await f.create([product(100000,25000)]);await f.pay(id,100000);
 const snapshot={scheme:'legacy',period:'2026Q4',sales_id:1,kind:'personal',base:2500000,rate:.03,due:75000,lines:[],note:'隔离历史原始快照'};
 const h=historicalCommission(f,snapshot,{paid:true}),before=one(f.db,'SELECT * FROM commission_batches WHERE id=?',h.body.id);
 const quarter=f.model('2026Q4'),legacy=quarter.realtime_previews.find(p=>p.sales_id===1&&p.kind==='personal');assert.equal(legacy.period,'2026Q4');assert.equal(legacy.scheme,'legacy-realtime');assert.deepEqual(quarter.batches.find(b=>b.id===h.body.id).snapshot,snapshot);
 assert.equal(f.personal().period,'2026-11');assert.equal(f.personal().total,300000);assert.deepEqual(one(f.db,'SELECT * FROM commission_batches WHERE id=?',h.body.id),before);
});
