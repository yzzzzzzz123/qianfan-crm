import test from 'node:test';
import assert from 'node:assert/strict';
import {mountOpportunityForm,activityPlanPayload,opportunityEditPayload} from '../public/modules/opportunity-controller.js';
import {formActivities} from '../public/modules/activities.js';
import {formOpportunities} from '../public/modules/opportunities.js';

function state(){
  return {actor:{id:2,name:'销售甲',role:'sales'},today:'2026-11-10',stages:['线索','需求','方案','商务','赢单','输单','搁置'],users:[],customers:[{id:1,name:'隔离客户'}],opportunities:[
    {id:1,customer_id:1,owner_id:2,name:'隔离商机一',stage:'需求',amount:100001,product_amount:40001,sale_type:'新签自建',order_type:'千帆',next_action:'现行计划一',follow_date:'2026-11-12',updated_at:'2026-11-10T01:00:00Z'},
    {id:2,customer_id:1,owner_id:2,name:'隔离商机二',stage:'方案',amount:null,product_amount:null,sale_type:'续费',order_type:'代销',next_action:'现行计划二',follow_date:null,updated_at:'2026-11-10T02:00:00Z'},
    {id:3,customer_id:1,owner_id:3,name:'他人商机',stage:'商务',next_action:'他人安排',follow_date:'2026-11-14',updated_at:'2026-11-10T03:00:00Z'},
  ]};
}

const field=(name,value='',extra={})=>Object.assign(new EventTarget(),{name,value,...extra});
function event(form,type,target){
  const e=new Event(type);Object.defineProperty(e,'target',{value:target});form.dispatchEvent(e);
}
function activityForm(S,id=1){
  const o=S.opportunities.find(o=>o.id===id),preview={innerHTML:''},form=new EventTarget();
  Object.assign(form,{dataset:{form:'activity',contextOpportunity:String(id)},elements:{
    opportunity_id:field('opportunity_id',String(id)),activity_date:field('activity_date',S.today),
    update_plan:field('update_plan','on',{checked:false,disabled:false}),action:field('action',o?.next_action||''),follow_date:field('follow_date',o?.follow_date||S.today),
  },querySelector:selector=>selector==='[data-activity-plan-preview]'?preview:null});
  return {form,preview};
}

test('跟进日期切到历史日默认保留现行计划，今日选项仍可显式关闭',()=>{
  const S=state(),{form,preview}=activityForm(S);mountOpportunityForm(form,S);
  assert.equal(form.elements.update_plan.checked,true);assert.equal(form.elements.update_plan.disabled,false);
  form.elements.activity_date.value='2026-10-01';event(form,'change',form.elements.activity_date);
  assert.equal(form.elements.update_plan.checked,false);assert.match(preview.innerHTML,/仅保存沟通记录/);
  let body=activityPlanPayload(form,{summary:'补录真实沟通',action:'历史动作',follow_date:'2026-10-03'});
  assert.equal(body.update_plan,false);assert.equal(Object.hasOwn(body,'expected_plan'),false);
  form.elements.update_plan.checked=true;event(form,'change',form.elements.update_plan);
  body=activityPlanPayload(form,{summary:'明确同时更新计划',action:'最新客户反馈后的安排',follow_date:'2026-11-15'});
  assert.equal(body.update_plan,true);assert.equal(body.plan_confirmed,true);assert.equal(body.expected_plan.follow_date,'2026-11-12');
  form.elements.activity_date.value=S.today;event(form,'change',form.elements.activity_date);
  form.elements.update_plan.checked=false;event(form,'change',form.elements.update_plan);
  event(form,'input',form.elements.action);
  assert.equal(activityPlanPayload(form,{summary:'仅记本次通话'}).update_plan,false,'editing summary/action must not silently re-check an explicitly disabled plan update');
});

test('当前计划快照在打开表单时捕获，提交不取后来刷新的状态值',()=>{
  const S=state(),{form}=activityForm(S),opened={next_action:S.opportunities[0].next_action,follow_date:S.opportunities[0].follow_date,updated_at:S.opportunities[0].updated_at};
  mountOpportunityForm(form,S);
  S.opportunities[0].next_action='另一位操作者刚保存的计划';S.opportunities[0].follow_date='2026-11-20';S.opportunities[0].updated_at='2026-11-10T04:00:00Z';
  const values={summary:'当前用户输入的沟通',action:'我填写的新动作',follow_date:''},before=JSON.stringify(values),body=activityPlanPayload(form,values);
  assert.equal(body.update_plan,true);assert.deepEqual(body.expected_plan,opened);assert.equal(JSON.stringify(values),before);
  assert.notEqual(body.expected_plan.updated_at,S.opportunities[0].updated_at,'old UI snapshot must reach backend optimistic concurrency checks');
});

test('换商机时重设计划快照与默认动作，未保存的自填动作保留但不借用旧机会令牌',()=>{
  const S=state(),{form,preview}=activityForm(S);mountOpportunityForm(form,S);
  form.elements.opportunity_id.value='2';event(form,'change',form.elements.opportunity_id);
  assert.equal(form.dataset.contextOpportunity,2);assert.equal(form.elements.action.value,'现行计划二');assert.equal(form.elements.follow_date.value,S.today);
  let body=activityPlanPayload(form,{summary:'第二商机沟通'});
  assert.deepEqual(body.expected_plan,{next_action:'现行计划二',follow_date:null,updated_at:'2026-11-10T02:00:00Z'});
  form.elements.action.value='已输入但尚未保存的本次动作';form.elements.follow_date.value='2026-11-22';
  form.elements.opportunity_id.value='1';event(form,'change',form.elements.opportunity_id);
  assert.equal(form.elements.action.value,'已输入但尚未保存的本次动作');assert.equal(form.elements.follow_date.value,'2026-11-22');
  body=activityPlanPayload(form,{summary:'回到第一商机'});assert.equal(body.expected_plan.updated_at,'2026-11-10T01:00:00Z');
  form.elements.opportunity_id.value='3';event(form,'change',form.elements.opportunity_id);
  assert.equal(form.elements.update_plan.disabled,true);assert.equal(form.elements.update_plan.checked,false);assert.match(preview.innerHTML,/由商机负责人维护/);
  assert.equal(activityPlanPayload(form,{summary:'协作沟通'}).update_plan,false);
});

test('协作PM与未选商机不能更新负责人计划，管理员可更新授权商机',()=>{
  const S=state();S.actor={id:4,role:'pm',name:'协作PM'};const pm=activityForm(S);mountOpportunityForm(pm.form,S);
  pm.form.elements.update_plan.checked=true;assert.equal(activityPlanPayload(pm.form,{}).update_plan,false);assert.equal(pm.form.elements.update_plan.disabled,true);
  // Imported data may retain a PM's ID as owner. UI and backend must still
  // agree that the PM role is for communication, not owner-plan maintenance.
  S.opportunities[0].owner_id=4;const imported=activityForm(S);mountOpportunityForm(imported.form,S);
  assert.equal(imported.form.elements.update_plan.disabled,true);
  S.actor={id:1,role:'admin'};const admin=activityForm(S);mountOpportunityForm(admin.form,S);assert.equal(admin.form.elements.update_plan.checked,true);
  admin.form.elements.opportunity_id.value='';event(admin.form,'change',admin.form.elements.opportunity_id);
  assert.equal(admin.form.elements.update_plan.disabled,true);assert.equal(activityPlanPayload(admin.form,{}).update_plan,false);
});

test('阶段表单在输单显示原因、其它阶段禁用；跨级回退及搁置才要求调整原因',()=>{
  const S=state(),form=new EventTarget(),label={hidden:true},lostGroup={hidden:true},hint={textContent:''};
  Object.assign(form,{dataset:{form:'opportunity-stage',id:'1'},elements:{stage:field('stage','方案'),reason:field('reason','',{required:false}),lost_reason:field('lost_reason','',{required:false,disabled:false,closest:()=>label})},querySelector:selector=>selector==='[data-stage-lost]'?lostGroup:selector==='[data-stage-reason-hint]'?hint:null});
  mountOpportunityForm(form,S);assert.equal(form.elements.reason.required,false);assert.equal(form.elements.lost_reason.disabled,true);assert.equal(lostGroup.hidden,true);
  for(const stage of ['商务','线索','搁置']){form.elements.stage.value=stage;event(form.elements.stage,'change',form.elements.stage);assert.equal(form.elements.reason.required,true,stage);}
  form.elements.stage.value='输单';event(form.elements.stage,'change',form.elements.stage);
  assert.equal(form.elements.lost_reason.required,true);assert.equal(form.elements.lost_reason.disabled,false);assert.equal(label.hidden,false);assert.equal(lostGroup.hidden,false,'the real form has an outer hidden wrapper, not only a label');
  form.elements.stage.value='需求';event(form.elements.stage,'change',form.elements.stage);
  assert.equal(form.elements.reason.required,false);assert.equal(form.elements.lost_reason.required,false);assert.equal(form.elements.lost_reason.disabled,true);assert.equal(lostGroup.hidden,true);
});

test('编辑金额按分比较只提交实际变更，缺值不误写零且不能带入归属或阶段变更',()=>{
  const S=state(),snapshot=JSON.stringify(S);
  const unchanged=opportunityEditPayload(S,'edit-opportunity',1,{owner_id:'3',customer_id:'2',stage:'商务',name:'隔离商机一',amount:'1000.01',product_amount:'400.01',expected_date:'',next_action:'现行计划一',follow_date:'2026-11-12',reason:''});
  assert.deepEqual(unchanged,{});
  const changed=opportunityEditPayload(S,'edit-opportunity',1,{amount:'1000.02',product_amount:'0',next_action:'新安排'});
  assert.deepEqual(changed,{amount:'1000.02',product_amount:'0',next_action:'新安排'});
  assert.deepEqual(opportunityEditPayload(S,'edit-opportunity',2,{amount:'',product_amount:'',expected_date:''}),{});
  assert.deepEqual(opportunityEditPayload(S,'edit-opportunity',2,{amount:'0',product_amount:'0'}),{amount:'0',product_amount:'0'},'explicit zero is a financial statement and must not be confused with missing');
  const clearingKnown=opportunityEditPayload(S,'edit-opportunity',1,{amount:'',product_amount:''});assert.deepEqual(clearingKnown,{amount:'',product_amount:''},'known values cannot be silently deleted; validation must reject clearing');
  assert.equal(JSON.stringify(S),snapshot);
});

test('已赢单金额由合同提供，阶段提交仅携带对应输单原因',()=>{
  const S=state();S.opportunities[0].stage='赢单';
  assert.deepEqual(opportunityEditPayload(S,'edit-opportunity',1,{amount:'1',product_amount:'0',name:'补正产品名称',stage:'需求',owner_id:'3'}),{name:'补正产品名称'});
  S.opportunities[0].stage='需求';
  assert.deepEqual(opportunityEditPayload(S,'opportunity-stage',1,{stage:'方案',reason:'',lost_reason:'表单遗留原因'}),{stage:'方案'});
  assert.deepEqual(opportunityEditPayload(S,'opportunity-stage',1,{stage:'输单',lost_reason:'客户取消本次采购',reason:''}),{stage:'输单',lost_reason:'客户取消本次采购'});
});

test('真实跟进与阶段表单包含控制器约定字段，已结束商机不提供普通阶段重开',()=>{
  const S=state(),activity=formActivities(S,'activity',1,{oppOptions:[[1,'隔离商机一']]});
  assert.match(activity,/name="update_plan"/);assert.match(activity,/data-activity-plan-preview/);assert.match(activity,/max="2026-11-10"/);assert.match(activity,/name="opportunity_id"/);
  const stage=formOpportunities(S,'opportunity-stage',1,{});
  for(const field of ['stage','reason','lost_reason','next_action','follow_date'])assert.match(stage,new RegExp('name="'+field+'"'));
  assert.match(stage,/data-stage-lost hidden/);assert.doesNotMatch(stage,/<option value="赢单"/);
  S.opportunities[0].stage='输单';assert.doesNotMatch(formOpportunities(S,'opportunity-stage',1,{}),/data-form="opportunity-stage"/);
  assert.match(formOpportunities(S,'edit-opportunity',1,{}),/name="lost_reason"[^>]*required/);
});
