import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {one,run} from '../server/database.mjs';
import {processScore} from '../server/domain.mjs';
import {performanceFor} from '../server/modules/incentives.mjs';
import {performanceDefaults} from '../public/modules/performance-policy.js';
import {renderPage,formContent} from '../public/views.js';

async function setup(t){
 const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),month='2025-10';
 await f.request('/targets',{actor:admin,method:'POST',body:{user_id:2,quarter:'2025Q4',amount:900000}});
 return {...f,admin,sales,month,score:()=>performanceFor(f.db,JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value),one(f.db,'SELECT * FROM users WHERE id=2'),month)};
}

test('管理员配置权重与全部过程计分后实际生效，读回与审计保留修改前后参数',async t=>{
 const f=await setup(t),performance={process_weight:60,result_weight:40,cap:40,meeting:2,visit:3,quote:4,funnel_low:5,funnel_mid:6,funnel_high:7};
 run(f.db,"UPDATE opportunities SET owner_id=2,created_at='2025-10-02T00:00:00Z',initial_amount=10000 WHERE id=1");
 for(const type of ['线上会议','现场拜访','对客报价'])run(f.db,"INSERT INTO activities(opportunity_id,user_id,source,activity_type,summary,activity_date,created_at) VALUES(1,2,'隔离验收',?,'配置计分验收','2025-10-10','2025-10-10T00:00:00Z')",type);
 const response=await f.request('/rules',{actor:f.admin,method:'PATCH',body:{performance}});assert.equal(response.status,200,JSON.stringify(response.body));
 const score=f.score();assert.equal(score.process.raw,14);assert.equal(score.raw,14);assert.equal(score.processPoints,21);assert.equal(score.total,21);assert.equal(score.monthly_target,30000000);assert.deepEqual(score.calculation_rules,performance);
 const state=(await f.request('/state?month='+f.month,{actor:f.admin})).body;for(const [k,v] of Object.entries(performance))assert.equal(state.rules.performance[k],v);
 assert.doesNotMatch(renderPage(state,{view:'performance'}),/当前过程原始分上限/);assert.match(renderPage(state,{view:'performance'}),/低于 9,800 元 5 分/);
 const audit=JSON.parse(one(f.db,"SELECT detail FROM audit WHERE action='更新业务规则' ORDER BY id DESC").detail);assert.deepEqual(audit.performance_before,performanceDefaults);assert.deepEqual(audit.performance_after,performance);
 assert.equal((await f.request('/rules',{actor:f.sales,method:'PATCH',body:{performance:{process_weight:50,result_weight:50}}})).status,403);
});

test('权重不等于100、零上限、错误分值或未知字段均整次拒绝，原规则不变',async t=>{
 const f=await setup(t),before=one(f.db,"SELECT value FROM settings WHERE key='rules'").value;
 for(const performance of [{process_weight:80,result_weight:30},{cap:0},{cap:-1},{cap:101},{meeting:-1},{visit:'2'},{quote:true},{funnel_low:null},{funnel_high:101},{funnel_mid:.001},{unknown:2}]){
  assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{performance}})).status,400,JSON.stringify(performance));assert.equal(one(f.db,"SELECT value FROM settings WHERE key='rules'").value,before);
 }
 assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{performance:{process_weight:33.33,result_weight:66.67,meeting:.25}}})).status,200);
});

test('规则更新保留已确认评分快照，降低上限封顶未确认手动分但保留原设置值',async t=>{
 const f=await setup(t);
 assert.equal((await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month:f.month,adjustment:25,reason:'已核对历史过程分',status:'confirmed'}})).status,200);
 const before=one(f.db,"SELECT snapshot FROM performance_reviews WHERE user_id=2 AND month=?",f.month).snapshot;
 assert.equal((await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month:'2025-11',adjustment:45,reason:'未确认过程分'}})).status,200);
 assert.equal((await f.request('/rules',{actor:f.admin,method:'PATCH',body:{performance:{process_weight:40,result_weight:60,cap:20}}})).status,200);
 assert.equal(one(f.db,"SELECT snapshot FROM performance_reviews WHERE user_id=2 AND month=?",f.month).snapshot,before);assert.equal(f.score().raw,25);assert.equal(f.score().processPoints,35);assert.equal(f.score().calculation_rules.cap,50);
 const state=(await f.request('/state?month=2025-11',{actor:f.admin})).body,score=state.performance.find(p=>p.user_id===2);assert.equal(score.adjustment,45);assert.equal(score.raw,20);assert.equal(score.processPoints,40);assert.equal(score.adjustment_limited,true);assert.match(renderPage(state,{view:'performance'}),/原手动过程分 45 超过当前上限 20/);
 assert.equal((await f.request('/performance/review',{actor:f.admin,method:'POST',body:{user_id:2,month:'2025-11',adjustment:45,reason:'需按新上限复核',status:'confirmed'}})).status,400);
});

test('无季度目标时手动总分仍不产生等级，补齐目标后才可确认',async t=>{
 const f=await setup(t),month='2025-03';
 const body={user_id:2,month,final_score:90,reason:'先保存待核对的最终分'};assert.equal((await f.request('/performance/review',{actor:f.admin,method:'POST',body})).status,200);
 let state=(await f.request('/state?month='+month,{actor:f.admin})).body,p=state.performance.find(p=>p.user_id===2);assert.equal(p.final_score,90);assert.equal(p.total,null);assert.equal(p.grade,null);assert.equal(p.salary_factor,null);
 assert.equal((await f.request('/performance/review',{actor:f.admin,method:'POST',body:{...body,status:'confirmed'}})).status,400);
 await f.request('/targets',{actor:f.admin,method:'POST',body:{user_id:2,quarter:'2025Q1',amount:900000}});
 assert.equal((await f.request('/performance/review',{actor:f.admin,method:'POST',body:{...body,status:'confirmed'}})).status,200);
});

test('新增漏斗金额边界与自定义分值、活动分值、封顶和百分比折算一致',()=>{
 const month='2025-10',opps=[979999,980000,5000000,5000001].map((amount,i)=>({id:i+1,owner_id:2,amount,created_at:'2025-10-01'})),policy={...performanceDefaults,cap:25,process_weight:60,funnel_low:1,funnel_mid:3,funnel_high:5,meeting:2,visit:4,quote:6};
 const activities=['线上会议','现场拜访','对客报价'].map(activity_type=>({opportunity_id:1,user_id:2,activity_date:'2025-10-10',activity_type}));
 const score=processScore(opps,activities,[],2,month,policy);assert.equal(score.raw,24);assert.equal(score.weighted,57.6);assert.equal(processScore(opps,[...activities,...activities],[],2,month,policy).raw,25);
 assert.equal(processScore(opps,[],[],2,month).raw,7.5);
});

test('绩效页提供唯一规则编辑入口，销售只读，表单覆盖9项参数与月目标均分说明',async t=>{
 const f=await setup(t),admin=(await f.request('/state',{actor:f.admin})).body,sales=(await f.request('/state',{actor:f.sales})).body;
 const page=renderPage(admin,{view:'performance'});assert.equal((page.match(/data-action="performance-rules"/g)||[]).length,1);assert.doesNotMatch(renderPage(sales,{view:'performance'}),/data-action="performance-rules"/);
 const form=formContent(admin,'performance-rules');for(const k of Object.keys(performanceDefaults))assert.ok(form.includes('name="performance:'+k+'"'),k);assert.match(form,/季度目标 ÷ 3/);assert.match(form,/已确认月份保留原评分/);assert.match(formContent(sales,'performance-rules'),/无权调整绩效规则/);
});
