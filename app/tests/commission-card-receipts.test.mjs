import test from 'node:test';
import assert from 'node:assert/strict';
import {commissions} from '../public/modules/incentives.js';

const policy={
  effective_month:'2026-10',service_aggregation:'month',service_scope_confirmed:true,
  product:[{min:0,rates:{D:0,C:0,B:0,A:null}},{min:4000000,rates:{D:.1,C:.12,B:.15,A:.15}}],
  service:[{min:0,rates:{D:0,C:0,B:0,A:0}},{min:2000000,rates:{D:.08,C:.1,B:.12,A:.15}}],
};
function state(){
  const personal={
    sales_id:1,name:'管理者',kind:'personal',period:'2026-10',grade:'A',grade_source:'fixed_A',policy,
    estimated_total:1821626,calculated_total:1821626,total:1821626,
    components:[
      {type:'product',label:'产品回款毛利',base:7664171,rate:.15,total:1149626},
      {type:'service',label:'开发运维回款',base:4480000,rate:.15,total:672000},
    ],lines:[],contract_issues:[],notices:[],evidence:[],
  };
  const sales={...structuredClone(personal),sales_id:2,name:'销售甲',grade:'B',grade_source:'performance'};
  const management={sales_id:1,name:'管理者',kind:'management',period:'2026Q4',base:1000000,rate:.03,total:30000,estimated_total:30000,calculated_total:30000,lines:[],contract_issues:[],notices:[]};
  return {
    actor:{id:1,name:'管理者',role:'admin'},today:'2026-11-10',
    users:[{id:1,name:'管理者',role:'admin',active:1,business_member:1},{id:2,name:'销售甲',role:'sales',active:1,business_member:1}],
    contracts:[],rules:{commission:{period:'quarter',threshold:20000000,low_rate:.03,high_rate:.05,sales_policy:policy}},
    commission:{period:'2026-10',legacy_mode:'quarter',realtime_previews:[personal,sales,management],receipt_review:[],batches:[]},
  };
}
const receipt=(payment_id,amount,extra={})=>({payment_id,contract_id:10,contract_name:'测试合同',sales_id:1,date:'2026-10-10',amount,product_amount:amount,service_received:0,allocation_valid:true,issues:[],...extra});
function card(html,sales_id=1,kind='personal'){
  const match=[...html.matchAll(/<article class="commission-person-card"[^>]*>[\s\S]*?<\/article>/g)]
    .find(([value])=>value.includes(`data-sales-id="${sales_id}"`)&&value.includes(`data-commission-kind="${kind}"`));
  assert.ok(match,`missing ${sales_id}/${kind} card`);return match[0];
}
const cashBlock=html=>html.match(/<div class="commission-receipt-total">[\s\S]*?<\/div>/)?.[0]||'';
const component=(html,type)=>html.split(`data-component="${type}">`)[1]?.split('</div>')[0]||'';

test('个人卡区分提成、回款毛利和实际现金，不把基数或实收当提成',()=>{
  const S=state();
  S.commission.receipt_review=[receipt(101,29480000,{product_amount:25000000,service_received:4480000})];
  const before=JSON.stringify(S),html=card(commissions(S,{owner:'1'}));
  const product=component(html,'product'),service=component(html,'service');
  assert.match(product,/<span>产品提成<\/span><b>¥11,496\.26<\/b>/);
  assert.match(product,/产品实际回款 ¥250,000/);
  assert.match(product,/产品回款毛利合计 ¥76,641\.71/);
  assert.match(product,/提成比例 15%/);
  assert.match(service,/<span>开发运维提成<\/span><b>¥6,720<\/b>/);
  assert.match(service,/开发运维回款合计 ¥44,800/);
  assert.doesNotMatch(product,/<span>产品回款毛利<\/span>|基数 ¥/);
  assert.doesNotMatch(service,/<span>开发运维回款<\/span>|基数 ¥/);
  assert.match(cashBlock(html),/本月实际回款总额<\/span><strong>¥294,800<\/strong>/);
  assert.equal(JSON.stringify(S),before,'rendering must not change financial state');
});

test('月实收独立于毛利、分配与旧算法计提排除，并正确限定人员、日期和唯一流水',()=>{
  const S=state();S.today='2026-10-20';
  const personal=S.commission.realtime_previews[0];
  personal.evidence=[receipt(101,1000000)];
  personal.excluded_contracts=[{contract_id:11,scheme:'legacy-history'}];
  S.commission.receipt_review=[
    receipt(101,1000000),receipt(101,1000000),
    receipt(102,2000000,{contract_id:11,product_amount:null,service_received:null,allocation_valid:false,issues:['混合分配待补']}),
    receipt(103,3000000,{contract_id:12,product_gross_margin:null,issues:['产品毛利率待补']}),
    receipt(104,9000000,{sales_id:2}),
    receipt(105,8000000,{date:'2026-09-10'}),
    receipt(106,7000000,{date:null}),
    receipt(107,6000000,{date:'2026-10-25'}),
    receipt(108,5000000,{status:'待到账'}),
  ];
  const html=card(commissions(S,{owner:'1'}));
  assert.match(cashBlock(html),/<strong>¥60,000<\/strong>/);
  assert.doesNotMatch(cashBlock(html),/¥10,000|¥70,000|¥90,000/);
  assert.match(component(html,'product'),/产品实际回款 待核对分配/);
});

test('缺少实收来源或金额未知不显示0，明确没有流水时才显示0',()=>{
  const S=state();delete S.commission.receipt_review;
  let html=card(commissions(S,{owner:'1'}));
  assert.match(cashBlock(html),/<strong>待核对<\/strong>/);assert.doesNotMatch(cashBlock(html),/¥0/);
  S.commission.receipt_review=[receipt(101,null)];
  html=card(commissions(S,{owner:'1'}));
  assert.match(cashBlock(html),/<strong>待核对<\/strong>/);assert.doesNotMatch(cashBlock(html),/¥0/);
  S.commission.receipt_review=[];
  html=card(commissions(S,{owner:'1'}));
  assert.match(cashBlock(html),/<strong>¥0<\/strong>/);
  assert.match(component(html,'product'),/产品实际回款 ¥0/);
});

test('历史季度不显示月度实收，销售只能看到本人实收卡',()=>{
  const S=state();S.commission.receipt_review=[receipt(101,1000000),receipt(102,2300000,{sales_id:2})];
  assert.doesNotMatch(commissions(S),/data-commission-kind="management"/);
  S.commission.period='2026Q4';
  S.commission.realtime_previews.push({sales_id:1,name:'管理者',kind:'personal',period:'2026Q4',base:1000000,rate:.03,total:30000,estimated_total:30000,calculated_total:30000,lines:[],contract_issues:[],notices:[]});
  const history=commissions(S,{owner:'1'});assert.equal(cashBlock(card(history,1,'management')), '');assert.doesNotMatch(history,/本月实际回款总额/);
  S.commission.period='2026-10';S.actor={id:2,name:'销售甲',role:'sales'};
  const own=commissions(S,{owner:'1'});assert.doesNotMatch(own,/data-sales-id="1"/);
  assert.match(cashBlock(card(own,2)),/<strong>¥23,000<\/strong>/);
  assert.doesNotMatch(cashBlock(card(own,2)),/¥10,000|¥33,000/);
});
