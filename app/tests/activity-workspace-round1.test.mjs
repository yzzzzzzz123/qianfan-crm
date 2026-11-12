import test from 'node:test';
import assert from 'node:assert/strict';
import {activities,selectActivityGroups,activityEventDetail,formActivities,mountActivityForm} from '../public/modules/activities.js';

const event=(id,extra={})=>({id,activity_id:100,opportunity_id:10,user_id:2,credited_user_id:2,source:'手动',activity_type:'现场拜访',activity_date:'2026-11-09',summary:`拜访客户记录 ${id}`,action:'核对实施范围',created_at:'2026-11-09T00:00:00Z',score:{counted:true,points:1,reason:'有效拜访',month:'2026-11',locked:false},...extra});
const state=(events=[])=>({actor:{id:1,role:'admin'},today:'2026-11-10',users:[{id:1,name:'管理员',active:1},{id:2,name:'销售甲',active:1},{id:3,name:'销售乙',active:1},{id:4,name:'项目经理',active:1}],customers:[{id:20,name:'海川数字科技有限公司',short_name:'海川数科'},{id:21,name:'远山科技'}],opportunities:[{id:10,name:'协同平台建设',customer_id:20,owner_id:3},{id:11,name:'设备运维',customer_id:21,owner_id:3}],activities:[{id:100,opportunity_id:10,user_id:2,activity_date:'2026-11-09',summary:'合并后摘要含拜访及报价',source:'多源',activity_type:'综合跟进'}],activityEvents:events,performanceLocks:[]});
const ids=groups=>groups.flatMap(g=>g.events.map(e=>e.id));

test('逐次类型筛选只显示命中内容，不混入同组其他行为；来源与类型独立',()=>{
  const S=state([event(1),event(2,{activity_type:'对客报价',summary:'报价专属记录',score:{counted:false,points:0,reason:'同日归并不重复计分'}}),event(3,{activity_type:'线上会议',source:'AI听记',summary:'会议专属记录'})]);
  assert.deepEqual(ids(selectActivityGroups(S,{activityType:'现场拜访'})),[1]);
  assert.deepEqual(ids(selectActivityGroups(S,{activitySource:'手动',activityType:'线上会议'})),[]);
  const html=activities(S,{activityType:'对客报价'});
  assert.match(html,/报价专属记录/);assert.doesNotMatch(html,/拜访客户记录|会议专属记录|合并后摘要/);assert.match(html,/该组共 3 次/);assert.match(html,/同日归并不重复计分/);
  assert.deepEqual(ids(selectActivityGroups(S,{source:'线上会议'})),[3],'旧来源栏类型别名不能误匹配其他手动行为');
});

test('日期人员客户商机与关键词组合过滤；登记人与计分归属均可检索',()=>{
  const S=state([event(1,{user_id:4,summary:'客户采购希望周五确认'}),event(2,{activity_id:101,opportunity_id:11,activity_date:'2026-10-31'})]);
  assert.deepEqual(ids(selectActivityGroups(S,{activityFrom:'2026-11-01',activityTo:'2026-11-10',activityOwner:'2',activityCustomer:'20',activityOpportunity:'10',activityQ:'海川数科 采购'})),[1]);
  assert.deepEqual(ids(selectActivityGroups(S,{activityOwner:'4'})),[1]);
  assert.deepEqual(ids(selectActivityGroups(S,{activityQ:'项目经理'})),[1]);
  assert.deepEqual(ids(selectActivityGroups(S,{activityFrom:'2026-11-10',activityTo:'2026-11-01'})),[]);
  assert.match(activities(S,{activityFrom:'2026-11-10',activityTo:'2026-11-01'}),/开始日期晚于结束日期/);
});

test('默认排除作废，包含作废和仅作废可追溯；锁定快照提示不被作废标记遮蔽',()=>{
  const S=state([event(1),event(2,{voided_at:'2026-11-10',void_reason:'重复登记',score:{counted:false,points:0,reason:'已作废',locked:true}})]);
  assert.deepEqual(ids(selectActivityGroups(S)),[1]);
  assert.deepEqual(ids(selectActivityGroups(S,{activityStatus:'all'})),[1,2]);
  assert.deepEqual(ids(selectActivityGroups(S,{activityStatus:'voided'})),[2]);
  const html=activities(S,{activityStatus:'voided'});assert.match(html,/重复登记/);assert.match(html,/历史评分保持快照/);assert.doesNotMatch(html,/data-action="activity-event-edit"/);
  const historic=activities(state([event(3,{score:{counted:true,points:null,reason:'已纳入历史依据，单条分值未保存',locked:true}})]));
  assert.match(historic,/已纳入历史依据/);assert.match(historic,/单条分值未保存/);assert.doesNotMatch(historic,/计分 null 分/);
});

test('移交或归档后的个人历史事件可见，但不会生成无权商机链接或暴露他人事件',()=>{
  const S=state([event(1,{activity_id:999,opportunity_id:999,opportunity_name:'原负责的历史项目',customer_name:'历史客户',opportunity_archived:true}),event(2,{user_id:3,credited_user_id:3})]);
  S.actor={id:2,role:'sales'};S.activities=[];
  assert.deepEqual(ids(selectActivityGroups(S)),[1]);
  const html=activities(S);assert.match(html,/原负责的历史项目/);assert.match(html,/商机已归档/);assert.doesNotMatch(html,/data-action="opportunity" data-id="999"|拜访客户记录 2|id="activity-owner"/);
});

test('显示实际登记人及计分归属，纠错权限使用服务端flags且听记系统保留来源',()=>{
  const S=state([event(1,{user_id:4,can_edit:false,can_void:false})]);
  let html=activities(S);assert.match(html,/登记人：项目经理/);assert.match(html,/计分归属：销售甲/);assert.doesNotMatch(html,/data-action="activity-event-edit"|data-action="activity-event-void"/);
  S.activityEvents=[event(1,{minutes_record_id:1,can_edit:true,can_void:true})];html=activities(S);assert.doesNotMatch(html,/data-action="activity-event-edit"|data-action="activity-event-void"/);
  S.activityEvents=[event(1,{activity_type:'系统',source:'系统里程碑'})];html=activities(S);assert.doesNotMatch(html,/data-action="activity-event-edit"|data-action="activity-event-void"/);
});

test('更正表单保留原始来源与并发凭据，原因必填，不带更新当前计划字段',()=>{
  const S=state([event(1,{source:'现场拜访',updated_at:'2026-11-10T01:00:00Z'})]);
  const html=formActivities(S,'activity-event-edit',1);
  assert.match(html,/name="expected_updated_at" value="2026-11-10T01:00:00Z"/);assert.match(html,/<option value="现场拜访" selected>手动（原来源）/);assert.match(html,/<textarea name="reason" rows="3" required>/);assert.doesNotMatch(html,/name="update_plan"/);
  const voidHtml=formActivities(S,'activity-event-void',1);assert.match(voidHtml,/确认作废/);assert.doesNotMatch(voidHtml,/name="summary"|name="activity_type"/);
});

test('列表及详情完整转义用户输入；不可见详情不回显记录',()=>{
  const S=state([event(1,{summary:'<img src=x onerror=alert(1)>',void_reason:'<script>bad</script>'})]);
  for(const html of [activities(S),activityEventDetail(S,1),formActivities(S,'activity-event-edit',1)]){assert.doesNotMatch(html,/<img src=x|<script>bad/);assert.match(html,/&lt;img/);}
  assert.match(activityEventDetail(S,9999),/记录不存在或无权查看/);
});

test('25组分页避免长列表，数量统计仍覆盖全部筛选结果',()=>{
  const S=state(Array.from({length:27},(_,i)=>event(i+1,{activity_id:100+i})));S.activities=[];
  let html=activities(S);assert.equal((html.match(/class="activity-record" /g)||[]).length,25);assert.match(html,/匹配 <b>27<\/b>/);assert.match(html,/data-action="activity-page" data-id="2"/);
  html=activities(S,{activityPage:2});assert.equal((html.match(/class="activity-record" /g)||[]).length,2);assert.match(html,/第 2 \/ 2 页/);
});

test('历史汇总可按原记录更正或作废，使用独立ID及legacy并发版本，不与原事件混用',()=>{
  const S=state([event(100,{activity_id:101,summary:'其他原事件同号'})]);
  S.activities[0]={...S.activities[0],legacy_version:'legacy-checksum-v1',can_edit:true,can_void:true,score:{counted:true,points:1,reason:'历史有效拜访'}};
  const html=activities(S);assert.match(html,/data-action="activity-legacy-edit" data-id="100"/);assert.match(html,/data-action="activity-legacy-void" data-id="100"/);
  const detail=activityEventDetail(S,100,true);assert.match(detail,/合并后摘要含拜访及报价/);assert.doesNotMatch(detail,/其他原事件同号/);
  const edit=formActivities(S,'activity-legacy-edit',100);assert.match(edit,/name="expected_updated_at" value="legacy-checksum-v1"/);assert.match(edit,/name="summary"[^>]*>合并后摘要含拜访及报价/);
  const voiding=formActivities(S,'activity-legacy-void',100);assert.match(voiding,/确认作废/);assert.match(voiding,/name="reason" rows="3" required/);
  S.activityEvents.push(event(101,{activity_id:100}));assert.match(formActivities(S,'activity-legacy-edit',100),/记录不存在或无权维护/,'已被物化的旧表单不能继续当legacy编辑');
});

test('录入与更正随发生日期提示已锁定月份，沿用现有行动计划字段',()=>{
  const S=state([event(1)]);S.performanceLocks=[{user_id:2,month:'2026-10'}];
  const hint={textContent:'',hidden:false},score={textContent:''},handlers={};
  const form={dataset:{form:'activity-event-edit',id:'1'},elements:{activity_date:{value:'2026-10-20'},activity_type:{value:'现场拜访'}},querySelector:s=>s==='[data-activity-lock-hint]'?hint:s==='[data-activity-score-hint]'?score:null,addEventListener:(name,fn)=>handlers[name]=fn};
  mountActivityForm(form,S);assert.match(hint.textContent,/绩效已锁定/);
  form.elements.activity_date.value='2026-11-09';handlers.change();assert.equal(hint.hidden,true);
  const html=formActivities(S,'activity',10,{oppOptions:[[10,'海川 · 平台']]});assert.match(html,/name="update_plan"/);assert.match(html,/data-activity-plan-preview/);assert.match(html,/data-activity-lock-hint/);
});
