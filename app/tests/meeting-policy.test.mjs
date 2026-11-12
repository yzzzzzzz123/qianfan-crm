import {historicalCommission} from './helpers/historical-commission.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,customer,archiveContract} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {commissionPreview} from '../server/modules/incentives.mjs';
import {renderPage,formContent} from '../public/views.js';
import {processScore} from '../server/domain.mjs';
import {salesPolicyFromForm} from '../public/modules/commission-policy.js';

async function context(t) {
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,11,15,3)});
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
  // Fixture-only confirmation of the scope; this never modifies the user's local workspace.
  const policy=JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value).commission.sales_policy;
  policy.service_scope_confirmed=true;policy.service_aggregation='month';
  assert.equal((await f.request('/rules',{actor:admin,method:'PATCH',body:{commission:{sales_policy:policy}}})).status,200);
  const c=await f.request('/customers',{actor:admin,method:'POST',body:customer({name:'听记提成验收客户',owner_id:2})});
  const create=async(product,service,date='2026-11-05')=>{
    const items=[...(product?[{name:'产品授权',kind:'标品',amount:product,margin:product}]:[]),...(service?[{name:'项目服务',kind:'定开',amount:service,margin:service*.5}]:[])];
    const r=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:c.body.id,name:'听记验收合同',owner_id:2,sign_date:date,items}});
    assert.equal(r.status,200,JSON.stringify(r.body));await archiveContract(f,admin,r.body.id);return r.body.id;
  };
  const pay=async(id,amount,product_amount)=>{
    const r=await f.request('/payments',{actor:admin,method:'POST',body:{contract_id:id,amount,status:'已到账',pay_date:'2026-11-10',...(product_amount!==undefined?{product_amount}:{})}});
    assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id;
  };
  const review=async(score=80)=>{const r=await f.request('/performance/review',{actor:admin,method:'POST',body:{user_id:2,month:'2026-11',final_score:score,reason:'按已核对的月度绩效评定',status:'confirmed'}});assert.equal(r.status,200,JSON.stringify(r.body));};
  const state=async()=>(await f.request('/state?commissionPeriod=2026-11&month=2026-11',{actor:admin})).body;
  const preview=async()=>(await state()).commission.previews.find(p=>p.sales_id===2&&p.kind==='personal');
  return {...f,admin,sales,create,pay,review,state,preview,customerId:c.body.id};
}

test('两套提成：产品按回款毛利，服务按当月回款；拆分展示及历史快照、补差与锁定',async t=>{
  const f=await context(t),id=await f.create(60000,40000),payment=await f.pay(id,40000,30000);
  let p=await f.preview();assert.equal(p.blocked,true);assert.match(p.issues.join('；'),/绩效/);
  assert.equal((await f.request('/commissions/confirm',{actor:f.admin,method:'POST',body:p})).status,410);
  await f.review();p=await f.preview();assert.equal(p.grade,'B');assert.equal(p.blocked,false);
  assert.deepEqual(p.components.map(c=>[c.base,c.total]),[[3000000,300000],[1000000,50000]]);
  assert.equal(p.total,350000);assert.equal(p.lines.reduce((s,l)=>s+l.amount,0),p.due);
  const confirmed=historicalCommission(f,p);assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));
  const snapshot=one(f.db,'SELECT snapshot FROM commission_batches WHERE id=?',confirmed.body.id).snapshot;
  assert.deepEqual(all(f.db,'SELECT component FROM commission_lines WHERE batch_id=? ORDER BY id',confirmed.body.id).map(l=>l.component),['product','service']);
  assert.equal((await f.preview()).due,0);
  assert.equal((await f.request(`/payments/${payment}/allocation`,{actor:f.admin,method:'POST',body:{product_amount:31000,reason:'不可改已确认依据'}})).status,409);
  await f.pay(id,20000,20000);
  assert.equal((await f.request('/commissions/confirm',{actor:f.admin,method:'POST',body:p})).status,410);
  const changed=await f.preview();assert.equal(changed.components[0].rate,.12);assert.equal(changed.total,650000);assert.equal(changed.due,300000);
  assert.equal(changed.lines.reduce((s,l)=>s+l.amount,0),300000);
  historicalCommission(f,changed);
  assert.equal(one(f.db,'SELECT snapshot FROM commission_batches WHERE id=?',confirmed.body.id).snapshot,snapshot);
  assert.equal((await f.request('/commissions/confirm',{actor:f.sales,method:'POST',body:changed})).status,403);
});

test('多合同回款毛利和服务回款各按月合计，旧签约新回款仍进入到账月',async t=>{
  const f=await context(t),a=await f.create(15000,15000),b=await f.create(15000,15000),old=await f.create(10000,0,'2026-10-10');
  await f.pay(a,30000,15000);await f.pay(b,30000,15000);await f.pay(old,10000);
  await f.review();const p=await f.preview();
  assert.equal(p.components[0].base,4000000);assert.equal(p.components[0].rate,.12);assert.equal(p.components[0].total,480000);
  assert.equal(p.components[1].base,3000000);assert.equal(p.components[1].total,240000);
  assert.ok(!p.lines.some(l=>l.contract_id===old&&l.component==='service'));
});

test('产品金额各档边界整额跳档，确认D级5%和12%，其余空白格仍阻止结算',async t=>{
  const f=await context(t),id=await f.create(200000,0);await f.review();
  const payment=await f.pay(id,1);
  const expected=[[19999.99,0],[20000,.10],[39999.99,.10],[40000,.12],[79999.99,.12],[80000,.18],[159999.99,.18],[160000,.20]];
  for(const [amount,rate] of expected) {
    run(f.db,'UPDATE payments SET amount=?,product_amount=? WHERE id=?',Math.round(amount*100),Math.round(amount*100),payment);
    const p=await f.preview();assert.equal(p.components[0].rate,rate,String(amount));assert.equal(p.total,Math.round(amount*100*rate));assert.equal(p.blocked,false);
  }
  const rules=JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value);
  const actor=one(f.db,'SELECT * FROM users WHERE id=1');
  for(const [score,amount,rate] of [[50,20000,.05],[50,39999.99,.05],[50,160000,.12],[50,200000,.12],[90,10000,null]]) {
    run(f.db,'UPDATE payments SET amount=?,product_amount=? WHERE id=?',amount*100,amount*100,payment);
    run(f.db,"UPDATE performance_reviews SET snapshot=json_set(snapshot,'$.grade',?) WHERE user_id=2 AND month='2026-11'",score===50?'D':'A');
    const p=commissionPreview(f.db,rules,actor,'2026-11').previews.find(p=>p.sales_id===2);assert.equal(p.components[0].rate,rate);
    if(rate===null){assert.equal(p.blocked,true);assert.match(p.issues.join('；'),/比例待核实/);}
    else{assert.equal(p.blocked,false);assert.equal(p.total,Math.round(amount*100*rate));}
  }
});

test('混合回款缺分配不猜金额，超额分配拒绝、纯服务明确0有效',async t=>{
  const f=await context(t),id=await f.create(20000,30000),payment=await f.pay(id,30000);await f.review();
  assert.match((await f.preview()).issues.join('；'),/产品回款分配未填写/);
  for(const product of [30001,21000])assert.equal((await f.request(`/payments/${payment}/allocation`,{actor:f.admin,method:'POST',body:{product_amount:product,reason:'分配核对'}})).status,400);
  const r=await f.request(`/payments/${payment}/allocation`,{actor:f.admin,method:'POST',body:{product_amount:0,reason:'本次全额服务费'}});assert.equal(r.status,200,JSON.stringify(r.body));
  const p=await f.preview();assert.equal(p.blocked,false);assert.equal(p.components[0].base,0);assert.equal(p.components[1].total,240000);
});

test('手动等级支持自定义选项，不恢复退役旧等级；最终绩效需原因且确认后不可改',async t=>{
  const f=await context(t);
  assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{customer_levels:['重点客户','普通客户']}})).status,200);
  assert.equal((await f.request('/customers/'+f.customerId,{actor:f.sales,method:'PATCH',body:{manual_level:'重点客户'}})).status,200);
  assert.equal(one(f.db,'SELECT manual_level FROM customers WHERE id=?',f.customerId).manual_level,'重点客户');assert.equal(all(f.db,'PRAGMA table_info(customers)').some(c=>c.name==='level'),false);
  assert.equal((await f.request('/customers/'+f.customerId,{actor:f.sales,method:'PATCH',body:{manual_level:'未配置'}})).status,400);
  assert.equal((await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month:'2026-11',final_score:80}})).status,400);
  await f.review();const s=await f.state(),p=s.performance.find(p=>p.user_id===2);
  assert.equal(p.final_score,80);assert.equal(p.total,80);assert.equal(p.grade,'B');assert.equal(p.status,'confirmed');assert.notEqual(p.automatic_total,80);
  assert.equal((await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month:'2026-11',final_score:90,reason:'不能改锁定月份'}})).status,409);
  assert.match(renderPage(s,{view:'customers'}),/重点客户/);assert.match(formContent(s,'customer-level',f.customerId),/客户等级/);
});

test('对客报价跟进计分，同商机同日报价资料与跟进不重复计分',()=>{
  const opps=[{id:1,owner_id:2,created_at:'2026-10-01',amount:10000}],activities=[{opportunity_id:1,user_id:2,activity_type:'对客报价',activity_date:'2026-11-10'},{opportunity_id:1,user_id:2,activity_type:'对客报价',activity_date:'2026-11-10'}];
  assert.equal(processScore(opps,activities,[],2,'2026-11').quote,1);
  assert.equal(processScore(opps,activities,[{opportunity_id:1,user_id:2,created_at:'2026-11-10T12:00:00Z'}],2,'2026-11').quote,1);
});

test('服务选档范围未确认仅可试算；管理员明确选择月合计后按月服务总额选档',async t=>{
  const f=await context(t);const a=await f.create(0,15000),b=await f.create(0,15000);await f.pay(a,15000);await f.pay(b,15000);await f.review();
  const policy=JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value).commission.sales_policy;
  policy.service_scope_confirmed=false;
  assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{commission:{sales_policy:policy}}})).status,200);
  let p=await f.preview();assert.equal(p.components[1].total,240000);assert.equal(p.blocked,true);assert.match(p.issues.join('；'),/当月实际服务回款合计选档/);
  assert.equal((await f.request('/commissions/confirm',{actor:f.admin,method:'POST',body:p})).status,410);
  policy.service_scope_confirmed=true;policy.service_aggregation='month';
  assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{commission:{sales_policy:policy}}})).status,200);
  p=await f.preview();assert.equal(p.components[1].total,240000);assert.equal(p.blocked,false);
});

test('SOP绩效85分为A级且工资系数100%，低一分仍为B级，确认快照独立保留',async t=>{
  const f=await context(t);await f.review(85);
  const s=await f.state(),p=s.performance.find(p=>p.user_id===2);
  assert.equal(p.grade,'A');assert.equal(p.salary_factor,1);
  const r=await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:3,month:'2026-11',final_score:84,reason:'SOP边界验收',status:'confirmed'}});
  assert.equal(r.status,200);
  const other=(await f.state()).performance.find(p=>p.user_id===3);assert.equal(other.grade,'B');assert.equal(other.salary_factor,.9);
});

test('两套梯度支持管理员调整档位、A至D比例和生效月份，非法配置与越权被拒绝',async t=>{
  const f=await context(t),original=JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value).commission.sales_policy;
  const fields={effective_month:'2026-10',service_aggregation:'contract'};
  for(const type of ['product','service'])original[type].forEach((band,i)=>{
    if(i)fields[`min:${type}:${i}`]=String(band.min/100+(i===1?1000:0));
    for(const grade of ['D','C','B','A'])fields[`rate:${type}:${i}:${grade}`]=band.rates[grade]===null?'':String(band.rates[grade]*100);
  });
  fields['rate:product:1:B']='11';fields['rate:service:1:D']='3';
  const policy=salesPolicyFromForm(original,fields);
  assert.equal(policy.product[1].min,2100000);assert.equal(policy.product[1].rates.B,.11);assert.equal(policy.service[1].rates.D,.03);
  assert.equal((await f.request('/rules',{actor:f.sales,method:'PATCH',body:{commission:{sales_policy:policy}}})).status,403);
  assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{commission:{sales_policy:policy}}})).status,200);
  const saved=JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value).commission.sales_policy;
  assert.deepEqual(saved,policy);
  const audit=JSON.parse(one(f.db,"SELECT detail FROM audit WHERE action='更新业务规则' ORDER BY id DESC").detail);
  assert.deepEqual(audit.sales_policy_before,original);assert.deepEqual(audit.sales_policy_after,policy);
  for(const bad of [p=>p.product[2].min=p.product[1].min,p=>p.service[0].min=1,p=>p.product[1].rates.A=1.01,p=>p.effective_month='2026-13']){
    const invalid=structuredClone(policy);bad(invalid);assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{commission:{sales_policy:invalid}}})).status,400);
  }
  assert.deepEqual(JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value).commission.sales_policy,policy);
  const page=renderPage(await f.state(),{view:'commissions'});assert.match(page,/type="month"/);assert.match(page,/调整个人提成梯度/);
  const form=formContent(await f.state(),'sales-commission-policy');assert.match(form,/name="effective_month"/);assert.match(form,/name="min:product:1"/);assert.match(form,/name="rate:service:3:A"/);
});

test('可选择十月并从指定月份启用新梯度，重新试算保留已确认快照',async t=>{
  const f=await context(t),id=await f.create(60000,0,'2026-10-05');
  let r=await f.request('/payments',{actor:f.admin,method:'POST',body:{contract_id:id,amount:30000,status:'已到账',pay_date:'2026-10-10'}});assert.equal(r.status,200,JSON.stringify(r.body));
  r=await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month:'2026-10',final_score:80,reason:'测试十月绩效',status:'confirmed'}});assert.equal(r.status,200);
  const october=async()=>(await f.request('/state?commissionPeriod=2026-10',{actor:f.admin})).body.commission;
  let state=await october();const trial=state.previews.find(p=>p.sales_id===2);assert.equal(trial.scheme,'sales-receipt-margin-v2');assert.equal(trial.blocked,true);assert.equal(trial.total,300000);assert.equal(state.trial_only,true);
  assert.equal((await f.request('/commissions/confirm',{actor:f.admin,method:'POST',body:trial})).status,410);
  const policy=JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value).commission.sales_policy;policy.effective_month='2026-10';
  assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{commission:{sales_policy:policy}}})).status,200);
  state=await october();let preview=state.previews.find(p=>p.sales_id===2&&p.scheme==='sales-receipt-margin-v2');assert.equal(preview.components[0].base,3000000);assert.equal(preview.total,300000);assert.equal(preview.blocked,false);
  r=historicalCommission(f,preview);assert.equal(r.status,200,JSON.stringify(r.body));
  const snapshot=one(f.db,'SELECT snapshot FROM commission_batches WHERE id=?',r.body.id).snapshot;
  policy.product[1].rates.B=.11;assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{commission:{sales_policy:policy}}})).status,200);
  preview=(await october()).previews.find(p=>p.sales_id===2&&p.scheme==='sales-receipt-margin-v2');assert.equal(preview.total,330000);assert.equal(preview.due,30000);
  assert.equal(one(f.db,'SELECT snapshot FROM commission_batches WHERE id=?',r.body.id).snapshot,snapshot);
  policy.effective_month='2026-11';assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{commission:{sales_policy:policy}}})).status,400);
});

test('服务梯度未填写时展示待核实并阻止确认，不能默认为零',async t=>{
  const f=await context(t);const id=await f.create(0,15000);await f.pay(id,15000);await f.review();
  const policy=JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value).commission.sales_policy;policy.service[1].rates.B=null;
  assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{commission:{sales_policy:policy}}})).status,200);
  const p=await f.preview();assert.equal(p.blocked,true);assert.match(p.issues.join('；'),/开发运维.*比例待核实/);
  assert.equal((await f.request('/commissions/confirm',{actor:f.admin,method:'POST',body:p})).status,410);
});
