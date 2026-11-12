import test from 'node:test';
import assert from 'node:assert/strict';
import {minutesPage,listTable} from '../public/modules/minutes-workspace.js';
import {minuteArtifact} from '../public/modules/minutes-artifacts.js';

const sources=[
  {id:'source-sales',member_id:2,member_name:'销售甲',account_name:'甲的听记',corp_name:'示例组织',connection_state:'connected',member_active:true,can_sync:true,can_disconnect:false,health:{state:'retrying',label:'最近同步失败',reason:'网络读取未完成'}},
  {id:'source-self',member_id:1,member_name:'管理者',account_name:'本人的听记',connection_state:'connected',member_active:true,can_sync:true,can_disconnect:true,health:{state:'local',label:'本地手动读取'}},
  {id:'source-stopped',member_id:3,member_name:'销售乙',account_name:'乙的听记',connection_state:'disconnected',member_active:true,can_sync:false,can_disconnect:false,health:{state:'stopped',label:'已停止连接'}},
];
function state(role='admin'){
  return {today:'2026-11-10',actor:{id:role==='admin'?1:2,name:role==='admin'?'管理者':'销售甲',role},customers:[{id:1,name:'示例客户'},{id:2,name:'共享客户',shared:true}],opportunities:[{id:1,customer_id:1,name:'实施项目'}],minutes:{enabled:true,sources:role==='admin'?sources:[sources[0]],coverage:{members:[{member_id:4,member_name:'销售丙',state:'unconnected',source_count:0}]},records:[{id:21,title:'客户预算与试用安排',start_time:'2026-11-09T01:00:00Z',duration_ms:61000,account_name:'甲的听记',member_name:'销售甲',customer_id:1,customer_name:'示例客户',opportunity_id:1,opportunity_name:'实施项目',content_state:'failed',content_label:'正文读取失败',media_state:'available',recognized_type:'demo'}],count:1,page:1,page_size:10,totals:{total:1,linked:1,unlinked:0,content_pending:0,content_failed:1},runs:[]}};
}
test('管理者能定位来源异常和未接入成员，只对本人显示停止和授权确认',()=>{
  const S=state(),html=minutesPage(S,{});
  assert.match(html,/data-minutes-connections/);assert.match(html,/待本人关联 1 人/);assert.match(html,/销售丙/);assert.match(html,/最近同步失败/);assert.match(html,/已停止连接/);
  assert.match(html,/data-action="minutes-disconnect" data-id="source-self"/);assert.doesNotMatch(html,/data-action="minutes-disconnect" data-id="source-sales"/);assert.doesNotMatch(html,/data-action="minutes-disconnect" data-id="source-stopped"/);
  assert.match(html,/data-form="minutes-start"/);assert.doesNotMatch(html,/name="member_id"/);
  const sales=minutesPage(state('sales'),{});assert.match(sales,/我的听记与待处理/);assert.doesNotMatch(sales,/销售丙|乙的听记|source-self/);assert.match(sales,/仅展示本人已授权来源/);
});
test('列表直接展示业务与读取状态，筛选保持所选客户商机和正文条件',()=>{
  const S=state(),html=minutesPage(S,{minutesQ:'预算',minutesCustomer:'1',minutesOpportunity:'1',minutesContentState:'failed',minutesLinkState:'linked',minutesMediaState:'available'});
  for(const name of ['q','source_id','customer_id','opportunity_id','link_state','content_state','media_state','page_size'])assert.ok(html.includes(`name="${name}"`),name);
  assert.match(html,/示例客户/);assert.match(html,/实施项目/);assert.match(html,/正文读取失败/);assert.match(html,/录音可回放/);assert.match(html,/不代表已计入过程绩效/);assert.match(html,/<option value="failed" selected>正文读取失败/);
  assert.doesNotMatch(html,/>共享客户<\/option>/);assert.match(html,/value="预算"/);
});
test('关联上下文完整传递给标题、查看及回放，恶意内容只按文字呈现',()=>{
  const data=state().minutes;data.records[0]={...data.records[0],title:'<img src=x onerror=alert(1)>',customer_name:'<script>x</script>'};
  const html=listTable(data,'customer_id=1&opportunity_id=2');assert.equal((html.match(/data-context="customer_id=1&amp;opportunity_id=2"/g)||[]).length,3);assert.match(html,/&lt;img/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img/);
});
test('同步日志不再截前八条，部分未完成和失败均保留明确恢复操作及分页',()=>{
  const S=state(),runs=Array.from({length:12},(_,i)=>({id:'run-'+i,source_id:'source-sales',member_name:'销售甲',account_name:'甲的听记',mode:'history',status:i===0?'partial':i===1?'failed':'success',can_retry:i<2,from_time:'2026-10-01T00:00:00Z',to_time:'2026-10-02T00:00:00Z',created_at:'2026-11-01T00:00:00Z',fetched:5,pages:1}));
  const html=minutesPage(S,{minutesTab:'runs',minutesRunsData:{runs,count:22,page:1,page_size:12}});
  assert.match(html,/列表已保存 · 正文待补齐/);assert.match(html,/data-action="minutes-run-retry" data-id="run-0"/);assert.match(html,/data-action="minutes-run-retry" data-id="run-1"/);assert.match(html,/执行于/);assert.equal((html.match(/执行于/g)||[]).length,12);assert.doesNotMatch(html,/当前连接不可重试/);assert.match(html,/共 22 次任务/);assert.match(html,/data-action="minutes-run-page" data-id="2"/);assert.match(html,/name="run_status"/);assert.doesNotMatch(html,/待补齐 undefined|NaN/);
});
test('未配置、待授权与确认归属均给出明确下一步，不暴露不安全授权链接',()=>{
  const S=state();S.minutes={enabled:false,sources:[],records:[],count:0};let html=minutesPage(S,{});assert.match(html,/当前环境尚未配置听记接入/);assert.doesNotMatch(html,/data-form="minutes-start"/);
  S.minutes.enabled=true;S.minutes.authorization={id:'auth',status:'pending_confirmation',can_confirm:true,candidate:{accountName:'我的听记',corpName:'示例组织',preview:[{title:'<script>坏内容</script>'}]}};
  html=minutesPage(S,{});assert.match(html,/data-form="minutes-confirm" data-id="auth"/);assert.match(html,/name="accepted" required/);assert.match(html,/&lt;script&gt;/);
  S.minutes.authorization={id:'auth',status:'awaiting',prompt:{url:'javascript:alert(1)',code:'123456'}};html=minutesPage(S,{});assert.doesNotMatch(html,/href="javascript/);assert.match(html,/等待本人完成钉钉授权/);
});
test('失败正文保留旧内容及重读入口，明确不支持的来源不伪装为正在读取',()=>{
  let html=minuteArtifact('transcript',{state:'failed',content:'上次成功逐字稿',reason:'网络未完成'},21,true,'transcript');assert.match(html,/上次成功读取/);assert.match(html,/上次成功逐字稿/);assert.match(html,/data-action="minutes-artifact-retry" data-id="transcript" data-record-id="21"/);
  html=minuteArtifact('speaker_insights',{state:'unavailable',content:'',reason:'当前来源不支持发言人接口'},21,true,'speaker_insights');assert.match(html,/当前来源暂未提供/);assert.doesNotMatch(html,/正在读取|minutes-artifact-retry/);
  html=minuteArtifact('transcript',{state:'empty',content:''},21,false,'transcript',{state:'ready',content:'已有AI总结'});assert.match(html,/以下为已同步的 AI 总结/);assert.doesNotMatch(html,/minutes-artifact-retry/);
  assert.doesNotMatch(minutesPage({...state(),actor:{id:8,role:'pm'}},{}),/minutes-start|客户预算/);
});

test('停用或断连记录保留详情入口和历史录音状态，不给出不可执行的回放入口',()=>{
  const data=state().minutes;data.records[0]={...data.records[0],can_refresh:false,connection_state:'disconnected',member_active:false};
  const html=listTable(data);assert.match(html,/data-action="minutes-detail"/);assert.match(html,/历史录音 · 当前连接不可回放/);assert.doesNotMatch(html,/data-action="minutes-play"/);
  data.records[0].can_refresh=true;assert.match(listTable(data),/data-action="minutes-play"/);
});
test('同步任务页隐藏听记数量及不适用的正文业务筛选，返回听记页保留原条件',()=>{
  const S=state(),P={minutesTab:'runs',minutesQ:'预算',minutesCustomer:'1',minutesOpportunity:'1',minutesContentState:'failed'};
  let html=minutesPage(S,P);assert.match(html,/<div class="minutes-totals" hidden>/);assert.match(html,/<label class="minutes-search-label" hidden>/);
  for(const [label,name]of [['客户','customer_id'],['商机','opportunity_id'],['业务关联','link_state'],['正文状态','content_state'],['录音状态','media_state']])assert.ok(html.includes(`<label hidden data-minutes-advanced>${label}<select name="${name}"`),name);
  assert.match(html,/name="source_id"/);assert.match(html,/name="run_status"/);assert.match(html,/每页任务/);
  html=minutesPage(S,{...P,minutesTab:'notes'});assert.doesNotMatch(html,/<div class="minutes-totals" hidden>/);assert.match(html,/value="预算"/);assert.match(html,/<option value="failed" selected>正文读取失败/);
});
test('手机高级筛选默认收起且显示已选条件数，展开状态可恢复，任务页不显示开关',()=>{
  const S=state(),P={minutesCustomer:'1',minutesContentState:'failed',minutesMediaState:'all'};
  let html=minutesPage(S,P);assert.match(html,/data-action="minutes-filter-toggle" aria-expanded="false"/);assert.match(html,/已选 2 项/);assert.equal((html.match(/data-minutes-advanced(?:>| )/g)||[]).length,5);assert.match(html,/<span class="minutes-filter-more">更多筛选/);
  html=minutesPage(S,{...P,minutesFiltersOpen:true});assert.match(html,/class="minutes-workspace minutes-filters-open"/);assert.match(html,/data-action="minutes-filter-toggle" aria-expanded="true"/);
  assert.doesNotMatch(minutesPage(S,{...P,minutesTab:'runs'}),/data-action="minutes-filter-toggle"/);
});
