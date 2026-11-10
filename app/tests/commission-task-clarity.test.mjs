import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {commissionPreview} from '../server/modules/incentives.mjs';
import {commissionIssueRows,buildCommissionExport} from '../public/modules/commission-view-model.js';
import {commissions} from '../public/modules/incentives.js';

export function taskState(){
 const issue=(id,code)=>({contract_id:id,contract_name:'同名产品',code,message:'旧的内部技术提示',pending:true,responsibility:'sales',action:code==='margin_missing'?'contract-items':'payment-allocation'});
 const personal={sales_id:2,name:'米粒',kind:'personal',period:'2026-10',total:null,estimated_total:null,lines:[],contract_issues:[issue(11,'receipt_source_claim')]};
 const management={sales_id:1,name:'王宏',kind:'management',period:'2026Q4',base:300000,rate:.03,total:9000,estimated_total:9000,lines:[],contract_issues:[issue(12,'margin_missing')]};
 return {actor:{id:1,name:'王宏',role:'admin'},today:'2026-11-10',users:[{id:1,name:'王宏',role:'admin'},{id:2,name:'米粒',role:'sales'},{id:3,name:'刘国庆',role:'sales'}],contracts:[{id:11,name:'同名产品',contract_no:'HT-11',owner_id:2},{id:12,name:'同名产品',contract_no:'HT-12',owner_id:3}],rules:{commission:{period:'quarter',threshold:20000000,low_rate:.03,high_rate:.05}},commission:{period:'2026-10',legacy_mode:'quarter',realtime_previews:[personal,management],batches:[]}};
}

test('事项标明合同编号、缺失内容、受影响提成人及独立资料负责人',()=>{
 const tasks=commissionIssueRows(taskState());
 const margin=tasks.find(t=>t.code==='margin_missing');assert.equal(margin.sales_name,'王宏');assert.equal(margin.responsible_label,'刘国庆');assert.equal(margin.title,'缺少合同毛利');assert.equal(margin.contracts[0].title,'同名产品 · HT-12');assert.match(margin.impact_message,/王宏的团队管理提成/);assert.equal(margin.action_label,'补充毛利');
 const receipt=tasks.find(t=>t.code==='receipt_source_claim');assert.equal(receipt.impact,'未计入提成');assert.match(receipt.detail,/结清.*到账/);assert.match(receipt.impact_message,/米粒的个人提成/);assert.equal(receipt.action_label,'核对到账');
});
test('个人和团队事项各自在对应区域，只有一个处理按钮且不混周期',()=>{
 const html=commissions(taskState());
 const personal=html.split('<section class="panel commission-overview">')[1].split('<section class="panel commission-management">')[0],team=html.split('<section class="panel commission-management">')[1];
 assert.match(personal,/data-issue-kind="personal"/);assert.match(personal,/HT-11/);assert.doesNotMatch(personal,/HT-12|data-issue-kind="management"/);
 assert.match(team,/HT-12/);assert.match(team,/资料负责人：刘国庆 · 提成人：王宏 · 2026 年第 4 季度/);assert.equal((html.match(/>补充毛利<\/button>/g)||[]).length,1);assert.equal((html.match(/>核对到账<\/button>/g)||[]).length,1);assert.doesNotMatch(html,/旧的内部技术提示|查看管理提成口径|待完善信息 <span/);
});
test('导出与页面使用相同缺失内容和金额影响，销售范围仍只含本人',()=>{
 const state=taskState(),rows=buildCommissionExport(state).issueRows;assert.equal(rows.length,3);assert.match(rows.find(row=>row[0]==='米粒')[6],/缺少到账明细.*未计入提成/);assert.match(rows.find(row=>row[0]==='王宏')[6],/缺少合同毛利.*团队管理提成/);
 state.actor={id:2,name:'米粒',role:'sales'};assert.equal(commissionIssueRows(state,{owner:'1'}).length,1);assert.doesNotMatch(commissions(state,{owner:'1'}),/HT-12|资料负责人：刘国庆/);
});
test('已确认团队规则不受合同个人旧标记和返点空值阻塞，补齐毛利后提示自动消失',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,11,15)});
 const f=await fixture(t),admin=await f.login(1),actor=one(f.db,'SELECT * FROM users WHERE id=1');
 run(f.db,"UPDATE contracts SET retired_at='2026-12-01T00:00:00Z'");
 const created=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:1,owner_id:2,name:'团队规则验收',sign_date:'2026-10-10',items:[{name:'授权',kind:'标品',amount:100000}]}});assert.equal(created.status,200);
 const id=created.body.id,rules=JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value),beforeRules=JSON.stringify(rules),contractBefore=one(f.db,'SELECT commission_policy FROM contracts WHERE id=?',id);
 const model=()=>commissionPreview(f.db,rules,actor,'2026-11');
 const team=()=>model().realtime_previews.find(row=>row.kind==='management');
 assert.ok(team().contract_issues.some(i=>i.code==='margin_missing'));assert.ok(team().contract_issues.every(i=>!['commission_policy_pending','legacy_rate_pending'].includes(i.code)));
 const item=one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',id),fixed=await f.request('/items/'+item.id,{actor:admin,method:'PATCH',body:{margin:25000,reason:'隔离核对合同毛利'}});assert.equal(fixed.status,200,JSON.stringify(fixed.body));
 assert.equal(team().estimated_total,75000);assert.equal(team().partial,false);assert.equal(team().calculated_total,75000);assert.equal(team().contract_issues.length,0);assert.equal(JSON.stringify(rules),beforeRules);assert.deepEqual(one(f.db,'SELECT commission_policy FROM contracts WHERE id=?',id),contractBefore);assert.equal(all(f.db,'SELECT * FROM commission_batches').length,0);
});
