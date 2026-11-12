import test from 'node:test';
import assert from 'node:assert/strict';
import {performance,performanceQuoteDetail,selectPerformanceRows,syncPerformanceReviewPreview,formIncentives} from '../public/modules/incentives.js';
import {performanceDefaults} from '../public/modules/performance-policy.js';

const grades=[{min:85,grade:'A',factor:1},{min:75,grade:'B',factor:.9},{min:60,grade:'C',factor:.6},{min:0,grade:'D',factor:.4}];
function state(){
  const p={user_id:2,name:'销售甲',month:'2026-11',eligible:true,status:'draft',process:{raw:10,meeting:0,visit:3,quote:2,funnelCount:2},automatic_raw:10,uncapped_raw:10,raw:10,processPoints:14,resultPoints:0,system_total:14,automatic_total:14,total:14,grade:'D',salary_factor:.4,monthly_target:50000000,actual:0,achievement:0,adjustment:null,final_score:null,reason:'',category_scores:[{key:'meeting',label:'线上会议',count:0,points:0,rate:.5},{key:'visit',label:'现场拜访',count:3,points:3,rate:1},{key:'quote',label:'对客报价',count:2,points:1,rate:.5},{key:'funnel',label:'新增商机',count:2,points:6,rate:null}],score_ledger:[],evidence:{meetings:[],visits:[],quotes:[],opportunities:[],contracts:[]}};
  return {actor:{id:1,role:'admin'},today:'2026-11-10',period:'2026-11',updated_at:'2026-11-10T02:00:00Z',rules:{performance:{...performanceDefaults,grades}},users:[],opportunities:[],contracts:[],performance:[p]};
}
test('销售只显示本人当前参考等级，管理者筛选与导出使用相同口径并保留停用人员',()=>{
  const S=state();S.performance.push({...structuredClone(S.performance[0]),user_id:3,name:'历史同事',inactive:true,status:'confirmed',adjustment:15});
  let html=performance(S,{performanceStatus:'manual'});
  assert.match(html,/历史同事/);assert.match(html,/已停用/);assert.doesNotMatch(html,/<h2>销售甲/);
  assert.deepEqual(selectPerformanceRows(S,{performanceStatus:'manual'}).map(p=>p.user_id),[3]);
  assert.deepEqual(selectPerformanceRows(S,{performanceOwner:'',owner:'3',performanceQ:'销售'}).map(p=>p.user_id),[2]);
  S.actor={id:2,role:'sales'};html=performance(S,{});
  assert.match(html,/本月进行中 · 当前参考等级/);assert.match(html,/当前参考工资系数/);assert.doesNotMatch(html,/历史同事|data-action="performance-rules"|data-action="performance-review"/);
  assert.equal(selectPerformanceRows(S,{performanceOwner:'3'}).length,0);
});
test('得分依据展示真实计分次数、归并不计分原因和精确原始事件入口，文本转义',()=>{
  const S=state(),p=S.performance[0];
  p.score_ledger=[{kind:'activity',event_id:51,source_id:51,category:'quote',title:'<img src=x onerror=alert(1)>',date:'2026-11-01',counted:true,points:.5,recorder_name:'协作人',credited_name:'销售甲'},{kind:'activity',event_id:52,source_id:52,category:'quote',title:'同日报价补充',date:'2026-11-01',counted:false,points:0,reason:'同商机同日已计分'}];
  const html=performance(S,{});
  assert.match(html,/1 次计分 · 2 条依据/);assert.match(html,/data-action="activity-event-detail" data-id="51" data-user-id="2"/);
  assert.match(html,/计入 0.5 分/);assert.match(html,/同商机同日已计分/);assert.match(html,/登记人 协作人 · 计分归属 销售甲/);
  assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img/);
});
test('已锁定历史卡使用当月规则并明确旧版缺少阈值，不拿当前规则解释历史',()=>{
  const S=state(),p=S.performance[0];S.period=p.month='2025-10';p.status='confirmed';p.calculation_rules={...performanceDefaults,meeting:2,cap:20};
  S.rules.performance.meeting=8;S.rules.performance.cap=10;
  let html=performance(S,{}),card=html.split('data-performance-user="2"')[1].split('</section></div><details class="panel performance-current-rules"')[0];
  assert.match(card,/原始分上限 20 分/);assert.doesNotMatch(card,/原始分上限 10 分/);assert.match(card,/历史快照未保存当月等级阈值/);
  p.grade_rules_snapshot=grades;html=performance(S,{});assert.match(html,/工资系数 100%/);
});
test('人工评分清楚区分系统分、采用过程分后的合计与最终分，超额自动分不伪装满分100',()=>{
  const S=state(),p=S.performance[0];Object.assign(p,{system_total:180,automatic_total:170,adjustment:5,final_score:60,total:60,grade:'C',reason:'核对原始材料',review_meta:{user_name:'管理员乙',updated_at:'2026-11-09T02:00:00Z'}});
  let html=performance(S,{});assert.match(html,/系统计算 180 分 → 采用设置的过程分后 170 分 → 人工最终分 60 分/);assert.match(html,/管理员乙/);assert.match(html,/核对原始材料/);
  Object.assign(p,{adjustment:null,final_score:null,total:180,automatic_total:180});html=performance(S,{});assert.match(html,/180<small>分<\/small>/);assert.doesNotMatch(html,/<small>\/ 100<\/small>/);
  p.monthly_target=0;p.total=null;p.grade=null;html=performance(S,{});assert.match(html,/data-action="performance-target" data-id="2" data-month="2026-11" data-quarter="2026Q4"/);
  p.eligible=false;html=performance(S,{});assert.match(html,/不参与绩效/);assert.doesNotMatch(html,/缺少 2026Q4 季度目标/);
});
test('评分预览计算采用分与等级，恢复自动仍需原因，报价详情限制当前角色和月份',()=>{
  const S=state(),p=S.performance[0],preview={innerHTML:''};
  const form={dataset:{id:'2',form:'performance-review'},querySelector:()=>preview,elements:{adjustment:{value:'50'},final_score:{value:'90'},reason:{required:false}}};
  assert.doesNotThrow(()=>syncPerformanceReviewPreview(null,S));
  assert.doesNotThrow(()=>syncPerformanceReviewPreview({dataset:{form:'activity'}},S));
  syncPerformanceReviewPreview(form,S);assert.match(preview.innerHTML,/最终总分 <b>90 分<\/b> · 等级 A/);assert.equal(form.elements.reason.required,true);
  p.adjustment=30;form.elements.adjustment.value='';form.elements.final_score.value='';syncPerformanceReviewPreview(form,S);assert.equal(form.elements.reason.required,true);assert.match(preview.innerHTML,/恢复自动评分也需填写原因/);
  assert.match(formIncentives(S,'performance-review',2),/data-performance-review-preview/);
  p.score_ledger=[{kind:'quote',source_id:81,title:'历史报价',date:'2026-11-03',amount:100000,points:.5,counted:true}];
  assert.match(performanceQuoteDetail(S,81,2),/历史报价/);S.actor={id:3,role:'sales'};assert.doesNotMatch(performanceQuoteDetail(S,81,2),/历史报价/);
});
test('历史活动依据只打开匹配的旧汇总或原事件，已经物化的旧ID不冒充原事件ID',()=>{
  const S=state(),p=S.performance[0];
  p.score_ledger=[{kind:'activity',source_id:71,activity_id:71,event_id:null,category:'visit',title:'历史拜访',counted:true,points:1}];
  S.activities=[{id:71,event_managed:0}];S.activityEvents=[];
  assert.match(performance(S,{}),/data-action="activity-legacy-detail" data-id="71" data-user-id="2"/);
  S.activities[0].event_managed=1;S.activityEvents=[{id:91,activity_id:71}];
  assert.doesNotMatch(performance(S,{}),/data-action="activity-(?:event|legacy)-detail" data-id="71"/);
  delete p.score_ledger;p.evidence.visits=[{id:91,activity_id:71,activity_type:'现场拜访',summary:'旧快照原事件'}];
  assert.match(performance(S,{}),/data-action="activity-event-detail" data-id="91" data-user-id="2"/);
});
