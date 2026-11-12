import test from 'node:test';
import assert from 'node:assert/strict';
import {commissions} from '../public/modules/incentives.js';
import {selectCommissionRows,selectCommissionHistory,buildCommissionExport,commissionIssueRows} from '../public/modules/commission-view-model.js';

export function managerPersonalViewState(){
 const policy={effective_month:'2026-11',service_aggregation:'month',service_scope_confirmed:true,product:[{min:0,rates:{A:null,B:0}},{min:2000000,rates:{A:.12,B:.1}}],service:[{min:0,rates:{A:.05,B:.04}},{min:2000000,rates:{A:.1,B:.08}}]};
 const personal=(id,name,amount)=>({sales_id:id,name,kind:'personal',period:'2026-11',scheme:'sales-receipt-margin-v2',policy,grade:id===1?'A':'B',grade_source:id===1?'fixed_A':'performance',estimated_total:amount,calculated_total:amount,total:amount,components:[{type:'product',label:'产品回款毛利',base:2500000,rate:id===1?.12:.1,total:id===1?300000:250000},{type:'service',label:'开发运维回款',base:id===1?3000000:0,rate:.1,total:id===1?300000:0}],lines:[{contract_id:id*10,contract_name:name+'产品合同',component:'product',base:2500000,rate:id===1?.12:.1,entitlement:id===1?300000:250000}],contract_issues:[],notices:[]});
 const manager=personal(1,'王宏',600000),sales=personal(2,'销售甲',250000);
 const team={sales_id:1,name:'王宏',kind:'management',period:'2026-11',scheme:'sales-receipt-margin-v2',calculation_scope:'monthly-team-receipt-margin',base:18000000,rate:.03,total:540000,estimated_total:540000,calculated_total:540000,received_amount:20000000,components:[{type:'product',label:'产品回款毛利',base:12000000,rate:.03,total:360000},{type:'service',label:'开发运维回款毛利',base:6000000,rate:.03,total:180000}],lines:[{contract_id:20,contract_name:'销售甲开发合同',component:'service',base:6000000,rate:.03,entitlement:180000}],evidence:[{payment_id:101,contract_id:20}],contract_issues:[]};
 const oldPersonal={sales_id:1,name:'王宏',kind:'personal',period:'2026Q4',scheme:'legacy-realtime',base:4000000,rate:.03,total:120000,estimated_total:120000,calculated_total:120000,lines:[],contract_issues:[]};
 const oldTeam={sales_id:1,name:'王宏',kind:'management',period:'2026Q4',scheme:'legacy-realtime',base:30000000,rate:.05,total:1500000,estimated_total:1500000,calculated_total:1500000,lines:[],contract_issues:[]};
 const teamReceipt={payment_id:101,contract_id:20,contract_no:'HT-SALES',sales_id:2,sales_name:'销售甲',date:'2026-11-03',amount:20000000,product_amount:13000000,service_received:7000000,issues:[]};
 return {actor:{id:1,name:'王宏',role:'admin'},today:'2026-11-10',users:[{id:1,name:'王宏',role:'admin',active:1,business_member:1},{id:2,name:'销售甲',role:'sales',active:1,business_member:1}],contracts:[{id:10,name:'王宏产品合同',contract_no:'HT-OWN',owner_id:1},{id:20,name:'销售甲产品合同',contract_no:'HT-SALES',owner_id:2}],rules:{commission:{period:'quarter',threshold:20000000,low_rate:.03,high_rate:.05,sales_policy:policy}},commission:{period:'2026-11',legacy_mode:'quarter',realtime_previews:[manager,sales,team,oldPersonal,oldTeam],receipt_review:[teamReceipt],batches:[{id:7,sales_id:1,kind:'personal',period:'2026Q4',amount:123456,status:'paid',snapshot:{grade:'A',lines:[]}}]}};
}

test('月度筛选同时使用选中月份的个人提成和团队管理提成',()=>{
 const state=managerPersonalViewState();
 assert.deepEqual(selectCommissionRows(state).map(row=>[row.sales_id,row.kind,row.period]),[[1,'personal','2026-11'],[1,'management','2026-11'],[2,'personal','2026-11']]);
 const own=selectCommissionRows(state,{owner:'1'});assert.equal(own.length,2);assert.equal(own.find(row=>row.kind==='personal').estimated_total,600000);
});
test('王宏个人进入个人区和月度合计，团队管理仅在独立管理区',()=>{
 const html=commissions(managerPersonalViewState()),overview=html.split('<section class="panel commission-overview">')[1].split('<section class="panel commission-management">')[0],team=html.split('<section class="panel commission-management">')[1].split('<section class="panel commission-history">')[0];
 assert.match(overview,/data-sales-id="1" data-commission-kind="personal"/);assert.match(overview,/data-sales-id="2" data-commission-kind="personal"/);assert.doesNotMatch(overview,/data-commission-kind="management"/);
 assert.match(team,/data-sales-id="1" data-commission-kind="management"/);assert.doesNotMatch(team,/data-commission-kind="personal"/);
 assert.match(html,/个人实时提成/);assert.match(html,/¥8,500/);assert.match(html,/A级/);assert.doesNotMatch(html,/管理者个人与团队提成|服务按签约额|服务合同金额合计|绩效待完善/);
 assert.match(html,/产品按实际回款毛利、开发运维按实际回款/);
 assert.match(team,/团队管理提成 · 2026 年 11 月/);
 assert.match(team,/团队本月实际回款总额<\/span><strong>¥200,000/);
 assert.match(team,/当月回款毛利<\/span><b>¥180,000/);
 assert.match(team,/开发运维实际回款毛利 ¥60,000 × 3%/);
 assert.doesNotMatch(team,/绩效|产品档位|累计毛利/);
});
test('负责人筛选、实际到账依据和导出使用同一管理月份与毛利口径',()=>{
 const state=managerPersonalViewState(),result=buildCommissionExport(state,{owner:'1'}),html=commissions(state,{owner:'1'});
 assert.deepEqual(result.summaryRows.slice(1).map(row=>[row[0],row[1],row[2],row[3]]),[['王宏','2026-11','个人提成',6000],['王宏','2026-11','团队管理提成',5400]]);
 assert.equal(result.detailRows[1][1],'2026-11');assert.equal(result.detailRows[1][6],'产品实际回款毛利');assert.equal(result.detailRows[1][9],3000);
 assert.deepEqual(result.summaryRows[2].slice(6,12),['','','','','',180000]);
 assert.deepEqual(result.detailRows[2].slice(6,10),['开发运维实际回款毛利',60000,.03,1800]);
 assert.match(html,/¥6,000/);assert.doesNotMatch(html,/data-sales-id="2" data-commission-kind="personal"/);
 assert.match(html.split('<section class="panel commission-receipt-section">')[1],/HT-SALES/);
});
test('王宏月度待完善项与合同搜索不因管理员角色漏掉或变成管理问题',()=>{
 const state=managerPersonalViewState(),row=state.commission.realtime_previews[0];row.contract_issues=[{contract_id:10,contract_name:'王宏产品合同',code:'rate_missing',message:'产品比例待核实',pending:true}];
 const tasks=commissionIssueRows(state,{owner:'1',commissionStatus:'pending'});assert.equal(tasks.length,1);assert.equal(tasks[0].period,'2026-11');assert.equal(tasks[0].kind,'personal');assert.equal(tasks[0].action,'sales-policy');
 const result=buildCommissionExport(state,{commissionQ:'HT-OWN'});assert.equal(result.summaryRows.length,2);assert.equal(result.summaryRows[1][2],'个人提成');assert.equal(result.issueRows[1][1],'2026-11');assert.equal(result.issueRows[1][2],'个人提成');
});
test('固定A级由计算结果提供，个人行不出现补绩效，角色本身不伪造A级',()=>{
 const state=managerPersonalViewState(),row=state.commission.realtime_previews[0];delete row.grade;
 let html=commissions(state,{owner:'1'});assert.match(html,/A级/);assert.doesNotMatch(html,/绩效待完善/);assert.equal(buildCommissionExport(state,{owner:'1'}).summaryRows[1][6],'A');
 delete row.grade_source;html=commissions(state,{owner:'1'});assert.match(html,/绩效待完善/);assert.equal(buildCommissionExport(state,{owner:'1'}).summaryRows[1][6],'');
});
test('旧季度个人与团队查询继续按原周期，历史已发放快照不改',()=>{
 const state=managerPersonalViewState(),before=JSON.stringify(state.commission.batches);state.commission.period='2026Q4';
 assert.deepEqual(selectCommissionRows(state).map(row=>[row.kind,row.period]),[['personal','2026Q4'],['management','2026Q4']]);
 const history=selectCommissionHistory(state);assert.equal(history[0].amount,123456);assert.match(commissions(state),/2026 年第 4 季度/);assert.equal(JSON.stringify(state.commission.batches),before);
 assert.doesNotMatch(commissions(state),/团队本月实际回款总额/);
});
test('销售视角仍仅本人个人提成，管理员个人行不能借owner筛选越权导出',()=>{
 const state=managerPersonalViewState();state.actor={id:2,name:'销售甲',role:'sales'};
 assert.deepEqual(selectCommissionRows(state,{owner:'1'}).map(row=>row.sales_id),[2]);assert.equal(buildCommissionExport(state,{owner:'1'}).summaryRows.length,2);assert.doesNotMatch(commissions(state,{owner:'1'}),/data-sales-id="1"/);
});
