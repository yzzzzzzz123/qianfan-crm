import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,customer,opp,contract} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {today,dateAdd,now} from '../server/domain.mjs';
import {signedOpportunitySummary,opportunityForecast,currentQuoteIds,quoteVersion} from '../server/modules/opportunity-summary.mjs';

const state=async(f,actor)=>(await f.request('/state',{actor})).body;
const createOpportunity=async(f,actor,extra={})=>{
  const c=await f.request('/customers',{actor,method:'POST',body:customer({name:'商机取数隔离企业'+crypto.randomUUID(),owner_id:2})});
  assert.equal(c.status,200);
  const result=await f.request('/opportunities',{actor,method:'POST',body:opp(c.body.id,{owner_id:2,expected_date:dateAdd(14),...extra})});
  assert.equal(result.status,200,JSON.stringify(result.body));return result.body.id;
};

test('商机预计值与签约事实分别取数，未知拆分不猜零且汇总不修改输入',()=>{
  const contracts=[
    {id:1,opportunity_id:8,lifecycle:'已归档',amount:10000,product_amount:0,service_amount:10000,collected:2000},
    {id:2,opportunity_id:8,lifecycle:'历史登记',amount:20000,product_amount:null,service_amount:null,collected:0},
    {id:3,opportunity_id:8,lifecycle:'草稿',amount:999999},
    {id:4,opportunity_id:8,lifecycle:'已归档',amount:888888,terminated_at:'2026-01-01'},
    {id:5,opportunity_id:8,lifecycle:'已归档',amount:777777,retired_at:'2026-01-01'},
    {id:6,opportunity_id:9,lifecycle:'已归档',amount:666666},
  ];
  const before=JSON.stringify(contracts),summary=signedOpportunitySummary(8,contracts);
  assert.deepEqual(summary,{scope:'authorized_contracts',count:2,contract_ids:[1,2],amount:30000,product_amount:null,service_amount:null,collected:2000,outstanding:28000});
  assert.equal(JSON.stringify(contracts),before);
  assert.deepEqual(signedOpportunitySummary(9,[]),{scope:'authorized_contracts',count:0,contract_ids:[],amount:0,product_amount:0,service_amount:0,collected:0,outstanding:0});
  assert.deepEqual(opportunityForecast({stage:'赢单',amount:120000,initial_amount:100000,product_amount:60000}),{forecast_amount:100000,forecast_product_amount:60000,forecast_service_amount:40000,forecast_source:'initial_snapshot',forecast_product_source:'stored_estimate'});
  const unknown=opportunityForecast({stage:'赢单',amount:120000,initial_amount:null,product_amount:60000});
  assert.equal(unknown.forecast_amount,null);assert.equal(unknown.forecast_product_amount,null);
  assert.equal(opportunityForecast({stage:'赢单',initial_amount:50000,product_amount:60000}).forecast_product_amount,null);
});

test('签约后修正合同金额和终止删除，商机实际签约汇总实时变化而预测与数据库旧值保留',async t=>{
  const f=await fixture(t),actor=await f.login(1),oid=await createOpportunity(f,actor,{amount:100000,product_amount:60000});
  const saved=await f.request('/contracts',{actor,method:'POST',body:contract(oid,{items:[{name:'纯交付',kind:'交付',amount:100000}]})});assert.equal(saved.status,200,JSON.stringify(saved.body));
  let s=await state(f,actor),o=s.opportunities.find(o=>o.id===oid);
  assert.equal(o.stage,'赢单');assert.equal(o.forecast_amount,10000000);assert.equal(o.forecast_product_amount,6000000);
  assert.equal(o.signed_summary.amount,10000000);assert.equal(o.signed_summary.product_amount,0);assert.equal(o.signed_summary.service_amount,10000000);
  const item=one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',saved.body.id);
  const revised=await f.request('/contracts/'+saved.body.id,{actor,method:'PATCH',body:{reason:'核对实际合同额',data_correction:true,items:[{id:item.id,name:'纯交付',kind:'交付',amount:80000,margin_before_expense:80000,business_expense:0}]}});assert.equal(revised.status,200,JSON.stringify(revised.body));
  s=await state(f,actor);o=s.opportunities.find(o=>o.id===oid);
  assert.equal(o.signed_summary.amount,8000000);assert.equal(o.signed_summary.service_amount,8000000);assert.equal(o.signed_summary.product_amount,0);
  assert.equal(o.forecast_amount,10000000);assert.equal(one(f.db,'SELECT amount FROM opportunities WHERE id=?',oid).amount,10000000,'read projection must not silently rewrite the stored old total');
  run(f.db,'UPDATE contract_items SET retired_at=? WHERE id=?',now(),item.id);
  o=(await state(f,actor)).opportunities.find(o=>o.id===oid);assert.equal(o.signed_summary.amount,8000000);assert.equal(o.signed_summary.product_amount,null);assert.equal(o.signed_summary.service_amount,null,'missing actual contract split must not fall back to the opportunity forecast');
  run(f.db,'UPDATE contract_items SET retired_at=NULL WHERE id=?',item.id);
  const terminated=await f.request('/contracts/'+saved.body.id+'/termination',{actor,method:'POST',body:{reason:'停止本次交付',confirmed:true}});assert.equal(terminated.status,200);
  o=(await state(f,actor)).opportunities.find(o=>o.id===oid);
  assert.equal(o.stage,'赢单');assert.equal(o.signed_summary.count,0);assert.equal(o.signed_summary.amount,0);assert.ok(o.diagnostics.some(d=>d.code==='won_no_visible_signed_contract'));assert.equal(o.risk.level,'normal');
  const retired=await f.request('/contracts/'+saved.body.id,{actor,method:'DELETE',body:{reason:'核对重复合同退出',confirmed:true,data_correction:true}});assert.equal(retired.status,200);
  o=(await state(f,actor)).opportunities.find(o=>o.id===oid);assert.equal(o.signed_summary.count,0);assert.equal(o.signed_summary.amount,0);assert.equal(o.forecast_amount,10000000);
});

test('当前报价按创建时间与ID选择，新有效报价替代旧过期版本且不伪造客户互动',async t=>{
  const f=await fixture(t),actor=await f.login(1),oid=await createOpportunity(f,actor);
  const quote=async date=>{
    const result=await f.request('/quotes',{actor,method:'POST',body:{opportunity_id:oid,valid_until:date,items:[{name:'核验产品',kind:'标品',quantity:1,list_price:100}]}});assert.equal(result.status,200,JSON.stringify(result.body));return result.body.id;
  };
  const oldId=await quote(dateAdd(-1));run(f.db,'UPDATE quotes SET created_at=? WHERE id=?',dateAdd(-2)+'T00:00:00Z',oldId);
  const newId=await quote(dateAdd(15));let s=await state(f,actor),o=s.opportunities.find(o=>o.id===oid);
  assert.equal(o.current_quote_id,newId);assert.equal(s.quotes.find(q=>q.id===oldId).quote_status,'历史版本');assert.equal(s.quotes.find(q=>q.id===newId).quote_status,'当前有效');
  assert.equal(o.diagnostics.some(d=>d.code==='current_quote_expired'),false);assert.doesNotMatch(o.aiAnalysis.risks.join(' '),/报价.*过期/);assert.equal(o.last_interaction,null,'saving an internal quotation is not a customer touch');
  run(f.db,'UPDATE quotes SET valid_until=? WHERE id=?',dateAdd(-1),newId);
  s=await state(f,actor);o=s.opportunities.find(o=>o.id===oid);assert.ok(o.diagnostics.some(d=>d.code==='current_quote_expired'));assert.equal(s.quotes.find(q=>q.id===newId).quote_status,'当前已过期');
  const tied=currentQuoteIds([{id:3,opportunity_id:1,created_at:now()},{id:4,opportunity_id:1,created_at:now()}]);assert.equal(tied.get(1),4);
  assert.equal(quoteVersion({id:3,valid_until:dateAdd(-1)},4,today()).is_current,false);
});

test('进行中商务缺少计划或预计签约过期均有独立原因，结束商机不混入推进风险',async t=>{
  const f=await fixture(t),actor=await f.login(1),oid=await createOpportunity(f,actor,{stage:'商务',amount:0,product_amount:0,next_action:'',follow_date:null,expected_date:null});
  let o=(await state(f,actor)).opportunities.find(o=>o.id===oid);
  assert.notEqual(o.risk.level,'normal');assert.ok(o.risk_reasons.includes('下一步未安排'));assert.ok(o.risk_reasons.includes('下次跟进日期未安排'));assert.ok(o.risk_reasons.includes('预计签约日待补充'));
  run(f.db,'UPDATE opportunities SET expected_date=? WHERE id=?',dateAdd(-10),oid);
  o=(await state(f,actor)).opportunities.find(o=>o.id===oid);assert.equal(o.risk.level,'warning');assert.ok(o.diagnostics.some(d=>d.code==='expected_date_overdue'));assert.ok(o.diagnostics.some(d=>d.code==='next_action_missing'));
  for(const stage of ['输单','搁置']){
    run(f.db,'UPDATE opportunities SET stage=? WHERE id=?',stage,oid);
    o=(await state(f,actor)).opportunities.find(o=>o.id===oid);assert.equal(o.risk.level,'normal');assert.deepEqual(o.risk_reasons,[]);
  }
});

test('签约汇总只来自当前角色明确可见合同，归属不同的合同金额不从机会穿透泄露',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),oid=await createOpportunity(f,admin);
  const saved=await f.request('/contracts',{actor:admin,method:'POST',body:contract(oid,{owner_id:3,items:[{name:'独立归属合同',kind:'交付',amount:123456}]})});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const adminState=await state(f,admin),salesState=await state(f,sales);
  const full=adminState.opportunities.find(o=>o.id===oid),restricted=salesState.opportunities.find(o=>o.id===oid);
  assert.equal(full.signed_summary.amount,12345600);assert.equal(full.signed_summary.count,1);
  assert.equal(salesState.contracts.some(c=>c.id===saved.body.id),false);assert.equal(restricted.signed_summary.amount,0);assert.equal(restricted.signed_summary.count,0);assert.deepEqual(restricted.signed_summary.contract_ids,[]);
  assert.ok(restricted.diagnostics.some(d=>d.code==='won_no_visible_signed_contract'));
  // The new projection itself must not mutate any persisted business record.
  const before=JSON.stringify(all(f.db,'SELECT * FROM opportunities WHERE id=?',oid));await state(f,sales);assert.equal(JSON.stringify(all(f.db,'SELECT * FROM opportunities WHERE id=?',oid)),before);
});
