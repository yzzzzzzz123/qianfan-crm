import test from 'node:test';
import assert from 'node:assert/strict';
import {opportunities,opportunityDetail} from '../public/modules/opportunities.js';
import {selectOpportunities,opportunityActualAmount,opportunityActualProduct} from '../public/modules/opportunity-view-model.js';
import {formContent} from '../public/views.js';
import {dashboard} from '../public/modules/dashboards.js';

const stages=['线索','需求','方案','商务','赢单','输单','搁置'];
const signed=(extra={})=>({scope:'authorized_contracts',count:0,amount:0,product_amount:0,service_amount:0,collected:0,outstanding:0,contract_ids:[],...extra});
const opportunity=(id,extra={})=>({
  id,customer_id:10,owner_id:2,name:`项目产品 ${id}`,code:`SJ-ROUND-${id}`,stage:'需求',
  amount:100000,product_amount:20000,forecast_amount:100000,forecast_product_amount:20000,forecast_service_amount:80000,forecast_source:'current_estimate',
  signed_summary:signed(),sale_type:'新签自建',order_type:'千帆',created_at:'2026-11-05T00:00:00Z',
  expected_date:'2026-11-25',next_action:'与客户核对业务验收范围',follow_date:'2026-11-11',
  risk:{level:'normal',label:'正常推进',days:1,overdue:0},risk_reasons:[],diagnostics:[],...extra,
});
function state(rows=[]){
  return {
    actor:{id:1,name:'管理员',role:'admin'},today:'2026-11-10',stages,
    users:[{id:1,name:'管理员',role:'admin',active:true},{id:2,name:'销售甲',role:'sales',active:true},{id:3,name:'销售乙',role:'sales',active:true},{id:4,name:'协作PM',role:'pm',active:true}],
    customers:[{id:10,name:'海川数字科技有限公司',short_name:'海川数科',industry:'数字服务',region:'上海',manual_level:'A',owner_id:2},{id:11,name:'远山制造有限公司',short_name:'远山制造',manual_level:'B',owner_id:3}],
    contacts:[],contracts:[],quotes:[],activities:[],activityEvents:[],team:[],ai:{configured:false},
    rules:{customer_levels:['A','B','C'],sop:{线索:'确认真实需求',需求:'核对范围',方案:'确认方案',商务:'明确签约安排'}},
    opportunities:rows,
  };
}
const ids=rows=>rows.map(o=>o.id).sort((a,b)=>a-b);
const tableIds=html=>[...html.matchAll(/<tr data-opportunity-id="(\d+)"/g)].map(match=>Number(match[1]));
const ledgerIds=html=>[...html.matchAll(/<tr class="record-row"[^>]*data-action="opportunity" data-id="(\d+)"/g)].map(match=>Number(match[1]));
const region=(html,name)=>html.match(new RegExp(`<section class="${name}">[\\s\\S]*?<\\/section>`))?.[0]||'';

test('默认推进视图仅展示进行中，销售范围不受他人owner或混入状态数据扩大',()=>{
  const rows=[opportunity(1),opportunity(2,{owner_id:3}),opportunity(3,{stage:'赢单'}),opportunity(4,{stage:'输单'}),opportunity(5,{stage:'搁置'})],S=state(rows);
  const before=JSON.stringify(S);
  assert.deepEqual(ids(selectOpportunities(S)),[1,2]);
  const html=opportunities(S);assert.deepEqual(tableIds(html).sort(),[1,2]);assert.match(html,/data-action="opportunity-view" data-id="work" aria-pressed="true"/);
  S.actor={id:2,name:'销售甲',role:'sales'};
  assert.deepEqual(ids(selectOpportunities(S)),[1]);
  assert.deepEqual(selectOpportunities(S,{owner:'3',risk:'all'}),[]);
  assert.deepEqual(ids(selectOpportunities(S,{opportunityView:'ledger',owner:'3',risk:'all'})),[1,3,4,5]);
  assert.doesNotMatch(opportunities(S,{opportunityView:'ledger',risk:'all'}),/data-action="opportunity" data-id="2"/);
  S.actor={id:1,name:'管理员',role:'admin'};assert.equal(JSON.stringify(S),before,'rendering and selection must not mutate rows');
});

test('商机搜索同时支持客户全称、独立简称、商机编号及组合词',()=>{
  const S=state([opportunity(1),opportunity(2,{customer_id:11,name:'工厂设备维保'})]);
  for(const q of ['海川数字科技有限公司','海川数科','SJ-ROUND-1','海川数科 项目产品','ｓｊ-ｒｏｕｎｄ-１'])assert.deepEqual(ids(selectOpportunities(S,{q})),[1],q);
  assert.deepEqual(selectOpportunities(S,{q:'不存在的客户'}),[]);
  const html=opportunities(S,{q:'海川数字科技有限公司'});assert.deepEqual(tableIds(html),[1]);assert.match(html,/海川数字科技有限公司/);
});

test('工作视图保留负责人、客户等级、类型及创建日期范围，总表仍按销售分组且不按owner隐藏',()=>{
  const S=state([
    opportunity(1),opportunity(2,{owner_id:3}),opportunity(3,{owner_id:3,created_at:'2026-10-01'}),
    opportunity(4,{owner_id:3,sale_type:'续费'}),opportunity(5,{owner_id:3,customer_id:11}),
  ]);
  const filters={owner:'3',customerLevel:'A',saleType:'新签自建',from:'2026-11-01',to:'2026-11-10'};
  assert.deepEqual(ids(selectOpportunities(S,filters)),[2]);
  const work=opportunities(S,filters);assert.deepEqual(tableIds(work),[2]);assert.match(work,/id="filter-owner"/);assert.match(work,/沿用看板筛选/);assert.match(work,/2026-11-01 至 2026-11-10/);
  const ledger=opportunities(S,{...filters,opportunityView:'ledger',risk:'all'});assert.deepEqual(ledgerIds(ledger),[1,2]);assert.match(ledger,/销售甲/);assert.match(ledger,/销售乙/);assert.match(ledger,/按销售小二分组/);assert.doesNotMatch(ledger,/id="filter-owner"/);
});

test('待跟进只包含到期或逾期的进行中商机，未来风险与无日期分别由风险视图处理',()=>{
  const S=state([
    opportunity(1,{follow_date:'2026-11-10'}),opportunity(2,{follow_date:'2026-11-08'}),
    opportunity(3,{follow_date:'2026-11-20',risk:{level:'critical',label:'长期未互动',days:30,overdue:0},risk_reasons:['长期未互动']}),
    opportunity(4,{follow_date:null,risk:{level:'attention',label:'下次跟进日期未安排',days:1,overdue:0},risk_reasons:['下次跟进日期未安排']}),
    opportunity(5,{stage:'赢单',follow_date:'2026-11-01'}),
  ]);
  assert.deepEqual(ids(selectOpportunities(S,{risk:'today'})),[1,2]);
  assert.deepEqual(ids(selectOpportunities(S,{risk:'risk'})),[3,4]);
  const html=opportunities(S,{risk:'today'});assert.deepEqual(tableIds(html).sort(),[1,2]);assert.match(html,/下一步行动 \/ 跟进时间/);assert.match(html,/预计签约/);
});

test('商机详情分别展示原始预计和实时签约，明确零与未知金额不混同',()=>{
  const o=opportunity(1,{stage:'赢单',amount:99000000,product_amount:88000000,forecast_amount:123456,forecast_product_amount:0,forecast_source:'initial_snapshot',signed_summary:signed({count:1,contract_ids:[100],amount:654321,product_amount:0,service_amount:654321,collected:12345})}),S=state([o]);
  const html=opportunityDetail(S,1),estimate=region(html,'opportunity-estimate'),actual=region(html,'opportunity-signed-summary');
  assert.match(estimate,/初始登记预估/);assert.match(estimate,/¥1,234\.56/);assert.match(estimate,/预计产品金额<\/span><strong>¥0<\/strong>/);
  assert.match(actual,/当前有效签约/);assert.match(actual,/¥6,543\.21/);assert.match(actual,/产品金额<\/span><strong>¥0<\/strong>/);assert.match(actual,/实际到账<\/span><strong>¥123\.45/);
  assert.doesNotMatch(estimate+actual,/¥990,000|¥880,000/,'legacy stored signed values must not appear as current amounts');
  o.forecast_amount=null;o.forecast_product_amount=null;o.signed_summary=signed({count:1,amount:null,product_amount:null,service_amount:null,collected:null});
  const unknown=opportunityDetail(S,1);assert.match(region(unknown,'opportunity-estimate'),/预计商机金额<\/span><strong>未提供<\/strong>/);assert.doesNotMatch(region(unknown,'opportunity-estimate'),/¥0/);assert.doesNotMatch(region(unknown,'opportunity-signed-summary'),/¥0/);
  assert.equal(opportunityActualAmount(o),null);assert.equal(opportunityActualProduct(o),null);
});

test('赢单无当前有效合同保留历史与异常提示，零签约不会冒充缺失预计值',()=>{
  const o=opportunity(1,{stage:'赢单',forecast_amount:null,forecast_product_amount:null,signed_summary:signed(),risk_reasons:['赢单但暂无可见有效合同，请核对关联记录']}),html=opportunityDetail(state([o]),1);
  assert.match(html,/保留历史赢单/);assert.match(html,/暂无可见有效合同/);assert.match(region(html,'opportunity-signed-summary'),/合同金额<\/span><strong>¥0<\/strong>/);assert.match(region(html,'opportunity-estimate'),/预计商机金额<\/span><strong>未提供<\/strong>/);
  assert.doesNotMatch(html,/data-action="opportunity-stage"/);
});

test('报价当前版本和历史版本明确标注，保留客户档案直达且未启用AI不出现分析按钮',()=>{
  const S=state([opportunity(1)]);
  S.quotes=[{id:1,opportunity_id:1,code:'HIST-QUOTE',amount:10000,created_at:'2026-10-01',valid_until:'2026-10-15',is_current:false,quote_status:'历史版本',items:[]},{id:2,opportunity_id:1,code:'LIVE-QUOTE',amount:20000,created_at:'2026-11-10',valid_until:'2026-11-30',is_current:true,quote_status:'当前有效',items:[]}];
  const html=opportunityDetail(S,1),quotes=[...html.matchAll(/<article class="quote-record[^\"]*">[\s\S]*?<\/article>/g)].map(match=>match[0]);
  assert.equal(quotes.length,2);assert.match(quotes[0],/LIVE-QUOTE/);assert.match(quotes[0],/当前有效/);assert.match(quotes[1],/HIST-QUOTE/);assert.match(quotes[1],/历史版本/);
  assert.match(html,/data-action="customer" data-id="10"/);assert.match(html,/AI 建议暂未启用/);assert.doesNotMatch(html,/data-action="opportunity-advice"/);
});

test('管理员和本人销售可编辑及更新阶段，他人和PM不得操作，赢单预计金额只读',()=>{
  const S=state([opportunity(1),opportunity(2,{owner_id:3}),opportunity(3,{stage:'赢单',forecast_source:'initial_snapshot'})]);
  for(const actor of [S.actor,{id:2,name:'销售甲',role:'sales'}]){
    const current={...S,actor};assert.match(formContent(current,'edit-opportunity',1),/data-form="edit-opportunity"/);assert.match(formContent(current,'opportunity-stage',1),/data-form="opportunity-stage"/);assert.match(opportunityDetail(current,1),/data-action="edit-opportunity"/);assert.match(opportunityDetail(current,1),/data-action="opportunity-stage"/);
  }
  const sales={...S,actor:{id:2,name:'销售甲',role:'sales'}};
  for(const type of ['edit-opportunity','opportunity-stage'])assert.doesNotMatch(formContent(sales,type,2),/data-form=/);
  const pm={...S,actor:{id:4,name:'协作PM',role:'pm'}};
  for(const type of ['edit-opportunity','opportunity-stage'])assert.doesNotMatch(formContent(pm,type,1),/data-form=/);
  assert.doesNotMatch(opportunityDetail(pm,1),/data-action="(?:edit-opportunity|opportunity-stage)"/);
  const won=formContent(S,'edit-opportunity',3);assert.match(won,/name="amount"[^>]*disabled/);assert.match(won,/name="product_amount"[^>]*disabled/);assert.doesNotMatch(won,/name="owner_id"|name="customer_id"|name="stage"/);
  assert.doesNotMatch(formContent(S,'opportunity-stage',3),/data-form="opportunity-stage"/);
});

test('漏斗当前有效签约取实时合同汇总，不使用赢单旧金额并清楚说明日期口径',()=>{
  const o=opportunity(1,{stage:'赢单',amount:99000000,product_amount:88000000,forecast_amount:1000000,forecast_product_amount:300000,signed_summary:signed({count:1,amount:500000,product_amount:0,service_amount:500000,collected:100000})}),S=state([o]);
  const html=dashboard(S,{view:'funnel',owner:'',from:'',to:'',level:'',saleType:''}),metrics=html.match(/<section class="metrics"[\s\S]*?<\/section>/)?.[0]||'';
  assert.match(metrics,/当前有效签约/);assert.match(metrics,/¥5,000/);assert.doesNotMatch(metrics,/¥990,000/);assert.match(html,/日期按商机创建时间筛选/);assert.match(html,/赢单金额取当前可见的有效关联合同/);assert.match(html,/数量赢单率/);
  assert.equal(opportunityActualAmount(o),500000);assert.equal(opportunityActualProduct(o),0);
});
