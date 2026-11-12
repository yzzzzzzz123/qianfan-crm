import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,opp,contract} from './helpers/fixture.mjs';
import {one,run} from '../server/database.mjs';
import {today,dateAdd,now} from '../server/domain.mjs';

const current=(f,id)=>one(f.db,'SELECT * FROM opportunities WHERE id=?',id);
const plan=o=>({next_action:o.next_action??'',follow_date:o.follow_date||null,updated_at:o.updated_at});
const patch=(f,actor,id,body)=>f.request('/opportunities/'+id,{actor,method:'PATCH',body});
const count=(f,table)=>one(f.db,'SELECT COUNT(*) n FROM '+table).n;
const activity=(id,extra={})=>({opportunity_id:id,activity_type:'手动跟进',activity_date:today(),summary:'已向客户核对本次问题',...extra});
async function fresh(f,actor){
  const result=await f.request('/opportunities',{actor,method:'POST',body:opp(1)});
  assert.equal(result.status,200,JSON.stringify(result.body));return result.body.id;
}

test('普通相邻推进可保存，跨级回退及搁置须原因并原子保留阶段历史',async t=>{
  const f=await fixture(t),sales=await f.login(2),id=await fresh(f,sales);
  const first=await patch(f,sales,id,{stage:'需求'});assert.equal(first.status,200);
  let before=current(f,id),history=count(f,'stage_history');
  const skipped=await patch(f,sales,id,{stage:'商务',next_action:'不应保存'});
  assert.equal(skipped.status,400);assert.equal(current(f,id).stage,'需求');
  assert.equal(current(f,id).next_action,before.next_action);assert.equal(count(f,'stage_history'),history);
  const reason='客户已完成验证并确认进入采购谈判';
  assert.equal((await patch(f,sales,id,{stage:'商务',reason})).status,200);
  assert.equal((await patch(f,sales,id,{stage:'线索'})).status,400);
  assert.equal((await patch(f,sales,id,{stage:'搁置'})).status,400);
  assert.equal((await patch(f,sales,id,{stage:'搁置',reason:'客户预算窗口延期',next_action:'预算恢复后复查',follow_date:dateAdd(14)})).status,200);
  assert.equal(current(f,id).stage,'搁置');
  assert.equal((await patch(f,sales,id,{stage:'需求'})).status,200,'搁置恢复可继续推进');
  assert.equal(current(f,id).next_action,'预算恢复后复查');
  const audit=JSON.parse(one(f.db,"SELECT detail FROM audit WHERE action='更新商机' AND entity_id=? ORDER BY id DESC",id).detail);
  assert.equal(audit.before.stage,'搁置');assert.equal(audit.after.stage,'需求');
});

test('金额和预计签约日修正保留前后值，销售不能直接伪造赢单或重开输单',async t=>{
  const f=await fixture(t),sales=await f.login(2),id=await fresh(f,sales),before=current(f,id);
  assert.equal((await patch(f,sales,id,{amount:120000,expected_date:dateAdd(20),reason:'按客户确认范围调整预计金额'})).status,200);
  const audit=JSON.parse(one(f.db,"SELECT detail FROM audit WHERE action='更新商机' AND entity_id=? ORDER BY id DESC",id).detail);
  assert.equal(audit.before.amount,before.amount);assert.equal(audit.after.amount,12000000);
  assert.equal(audit.before.expected_date,before.expected_date);assert.equal(audit.after.expected_date,dateAdd(20));
  const manualWon=await patch(f,sales,id,{stage:'赢单'});assert.equal(manualWon.status,400);assert.match(manualWon.body.error,/保存后自动赢单.*附件可后补/);
  assert.equal((await patch(f,sales,id,{stage:'输单'})).status,400);
  assert.equal((await patch(f,sales,id,{stage:'输单',lost_reason:'客户采购计划取消'})).status,200);
  assert.equal((await patch(f,sales,id,{stage:'需求',reason:'随意重开'})).status,400);
});

test('登记已签合同仍自动赢单、附件可缺，冻结客户标记保持不变',async t=>{
  const f=await fixture(t),sales=await f.login(2),id=await fresh(f,sales);
  assert.equal((await f.request('/customers/1',{actor:sales,method:'PATCH',body:{management_status:'冻结'}})).status,200);
  const created=await f.request('/contracts',{actor:sales,method:'POST',body:contract(id)});
  assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(current(f,id).stage,'赢单');
  assert.equal(one(f.db,'SELECT archive_attachment_id FROM contracts WHERE id=?',created.body.id).archive_attachment_id,null);
  assert.equal(one(f.db,'SELECT status FROM customers WHERE id=1').status,'冻结');
});

test('历史补录默认仅进入时间线，旧行动和日期不覆盖当前计划',async t=>{
  const f=await fixture(t),sales=await f.login(2),id=await fresh(f,sales),before=current(f,id),events=count(f,'activity_events');
  const result=await f.request('/activities',{actor:sales,method:'POST',body:activity(id,{activity_date:dateAdd(-30),summary:'补录上个月真实沟通',action:'上月已经完成的动作',follow_date:dateAdd(-20)})});
  assert.equal(result.status,200);assert.equal(result.body.plan_updated,false);
  const after=current(f,id);assert.equal(after.next_action,before.next_action);assert.equal(after.follow_date,before.follow_date);
  assert.equal(count(f,'activity_events'),events+1);
  assert.equal(one(f.db,'SELECT action FROM activities WHERE id=?',result.body.id).action,'上月已经完成的动作');
});

test('今天的跟进沿用计划更新，显式false可只记沟通，同日事件仍逐次保留',async t=>{
  const f=await fixture(t),sales=await f.login(2),id=await fresh(f,sales),events=count(f,'activity_events');
  const first=await f.request('/activities',{actor:sales,method:'POST',body:activity(id,{action:'与采购确认报价',follow_date:dateAdd(2)})});
  assert.equal(first.status,200);assert.equal(first.body.plan_updated,true);
  const second=await f.request('/activities',{actor:sales,method:'POST',body:activity(id,{summary:'补充同日沟通证据',action:'不作为当前计划',follow_date:dateAdd(-3),update_plan:false})});
  assert.equal(second.status,200);assert.equal(second.body.id,first.body.id);assert.equal(second.body.plan_updated,false);
  assert.equal(current(f,id).next_action,'与采购确认报价');assert.equal(current(f,id).follow_date,dateAdd(2));
  assert.equal(count(f,'activity_events'),events+2);
  assert.match(one(f.db,'SELECT summary FROM activities WHERE id=?',first.body.id).summary,/补充同日沟通证据/);
});

test('历史沟通显式更新须确认与最新计划，可明确清空字段且保留审计',async t=>{
  const f=await fixture(t),sales=await f.login(2),id=await fresh(f,sales),before=current(f,id),events=count(f,'activity_events');
  const body=activity(id,{activity_date:dateAdd(-5),action:'',follow_date:null,update_plan:true,expected_plan:plan(before)});
  assert.equal((await f.request('/activities',{actor:sales,method:'POST',body})).status,400);
  assert.equal(count(f,'activity_events'),events);
  const result=await f.request('/activities',{actor:sales,method:'POST',body:{...body,plan_confirmed:true}});
  assert.equal(result.status,200);assert.equal(result.body.plan_updated,true);
  assert.equal(current(f,id).next_action,'');assert.equal(current(f,id).follow_date,null);
  const audit=JSON.parse(one(f.db,"SELECT detail FROM audit WHERE entity='opportunity' AND entity_id=? AND action='记录跟进' ORDER BY id DESC",id).detail);
  assert.equal(audit.plan.before.next_action,before.next_action);assert.equal(audit.plan.after.next_action,'');assert.equal(audit.plan.explicit,true);
});

test('旧计划快照并发提交被拒绝，跟进内容和逐次事件均不部分写入',async t=>{
  const f=await fixture(t),sales=await f.login(2),id=await fresh(f,sales),snapshot=plan(current(f,id));
  assert.equal((await patch(f,sales,id,{next_action:'同事刚确认的新安排',follow_date:dateAdd(6)})).status,200);
  const events=count(f,'activity_events'),activities=count(f,'activities');
  const result=await f.request('/activities',{actor:sales,method:'POST',body:activity(id,{activity_date:dateAdd(-1),action:'旧表单安排',follow_date:dateAdd(1),update_plan:true,plan_confirmed:true,expected_plan:snapshot})});
  assert.equal(result.status,409);assert.equal(current(f,id).next_action,'同事刚确认的新安排');
  assert.equal(count(f,'activity_events'),events);assert.equal(count(f,'activities'),activities);
});

test('协作PM可记录沟通但不隐式改负责人计划，显式改计划也受服务端权限校验',async t=>{
  const f=await fixture(t),sales=await f.login(2),id=await fresh(f,sales);
  const pmId=Number(run(f.db,"INSERT INTO users(name,username,role,created_at) VALUES('隔离协作PM','round1_plan_pm','pm',?)",now()).lastInsertRowid);
  run(f.db,'UPDATE opportunities SET collaborator_pm=? WHERE id=?',pmId,id);
  const pm=await f.login(pmId),before=current(f,id),events=count(f,'activity_events');
  const record=await f.request('/activities',{actor:pm,method:'POST',body:activity(id,{action:'协作者的沟通建议',follow_date:dateAdd(-2)})});
  assert.equal(record.status,200);assert.equal(record.body.plan_updated,false);
  assert.equal(current(f,id).next_action,before.next_action);assert.equal(current(f,id).follow_date,before.follow_date);
  const result=await f.request('/activities',{actor:pm,method:'POST',body:activity(id,{action:'协作者覆盖计划',update_plan:true,plan_confirmed:true,expected_plan:plan(current(f,id))})});
  assert.equal(result.status,403);assert.equal(count(f,'activity_events'),events+1);
  const other=await f.login(3);assert.equal((await patch(f,other,id,{next_action:'越权修改'})).status,403);
});

test('无效计划控制参数不入库，未提供的计划字段保持原值',async t=>{
  const f=await fixture(t),sales=await f.login(2),id=await fresh(f,sales),before=current(f,id),events=count(f,'activity_events');
  assert.equal((await f.request('/activities',{actor:sales,method:'POST',body:activity(id,{update_plan:'true'})})).status,400);
  assert.equal(count(f,'activity_events'),events);
  const result=await f.request('/activities',{actor:sales,method:'POST',body:activity(id,{activity_date:dateAdd(-1),action:'只更新动作',update_plan:true,plan_confirmed:true,expected_plan:plan(before)})});
  assert.equal(result.status,200);assert.equal(current(f,id).next_action,'只更新动作');assert.equal(current(f,id).follow_date,before.follow_date);
});
