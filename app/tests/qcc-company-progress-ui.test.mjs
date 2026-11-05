import test from 'node:test';
import assert from 'node:assert/strict';
import {companyProfileDetails,companyProfileProgress,customers} from '../public/modules/customers.js';

const profile=(extra={})=>({id:10,company_profile:{state:'ready',provider:'企查查 MCP',can_refresh:true,details:{company_name:'隔离企业',company_scale:'大型',employee_scale:'100-199人',insured_count:0},...extra}});
const progress=(extra={})=>({configured:true,automatic:true,counts:{total:268,complete:120,pending:100,running:1,partial:20,mismatch:3,not_found:2,failed:12,waiting_quota:10},pause_reason:null,next_retry_at:null,estimated_remaining_credits:592,...extra});
const state=(extra={})=>({actor:{id:1,name:'管理员',role:'admin'},users:[{id:1,name:'管理员',role:'admin',active:1}],customers:[],contacts:[],opportunities:[],rules:{customer_levels:['A','B','C']},company_profiles:progress(),...extra});
const visible=html=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const noQueryLabels=html=>{
  assert.doesNotMatch(html,/class="[^"]*\bbadge\b/);
  assert.doesNotMatch(html,/待手动查询|此任务仅在手动查询后处理|已读取资料保留|正在手动查询|正在读取|已排队|已完整读取|部分资料已读取|工商已成功|企业简介待补充|等待额度|读取失败|资料待更新|主体待核对|未查询到|下次尝试|新增客户自动查询|自动查询未开启|预计剩余查询消耗|重新读取/);
};
const onlyManualButton=html=>{
  assert.equal(visible(html),'手动查询');
  assert.equal((html.match(/<button\b/g)||[]).length,1);
  assert.doesNotMatch(html,/company-profile-progress-notes|role="status"/);
  noQueryLabels(html);
};
const keptProfile=html=>{
  assert.match(html,/企业名称<\/dt><dd>隔离企业<\/dd>/);
  assert.match(html,/参保人数<\/dt><dd>0<\/dd>/);
  noQueryLabels(html);
};

test('管理员客户列表仅保留手动查询按钮，运行中禁用且不展示任务计数',()=>{
  const S=state(),html=customers(S,{}),action=companyProfileProgress(S);
  onlyManualButton(action);
  assert.match(html,/customer-list-summary/);assert.match(html,/company-profile-progress/);
  assert.doesNotMatch(html,/\sstyle=/,'真实页面CSP禁止inline style');
  assert.match(action,/<button[^>]+disabled[^>]*>手动查询<\/button>/);
  assert.doesNotMatch(html,/data-action="query-all-company-profiles"|120\/268|排队 100|读取中 1|部分完成 20|失败 12|等待额度 10|592|账户余额|剩余积分/);
});

test('全量手动查询入口只对管理员展示，销售与PM不泄露全局计数和暂停原因',()=>{
  for(const role of ['sales','pm']) {
    const S=state({actor:{id:2,role},company_profiles:progress({pause_reason:'隐藏的管理员队列原因'})});
    assert.equal(companyProfileProgress(S),'');
    assert.doesNotMatch(customers(S,{}),/120\/268|隐藏的管理员|query-all-company-profiles|预计剩余查询消耗|company-profile-progress/);
  }
});

test('已配置且有客户时提供一个空闲批量入口，未配置零客户或缺元数据不提供动作',()=>{
  const idle=progress({counts:{total:268,complete:0},automatic:false});
  const html=companyProfileProgress(state({company_profiles:idle}));
  onlyManualButton(html);
  assert.equal((html.match(/data-action="query-all-company-profiles"/g)||[]).length,1);
  assert.doesNotMatch(html,/\sdisabled/);
  for(const p of [{...idle,configured:false},{...idle,counts:{total:0,complete:0}},undefined])assert.equal(companyProfileProgress(state({company_profiles:p})),'');
});

test('自动排队及正在执行时仅禁用同名按钮，已有企业资料和明确零值仍保留',()=>{
  for(const status of ['pending','queued','running']) {
    const html=companyProfileDetails(profile({job:{status,stage:'registration',attempts:1}}),true);
    assert.match(html,/<button[^>]+disabled[^>]*>手动查询<\/button>/);
    assert.match(html,/aria-busy="true"/);
    assert.doesNotMatch(html,/data-action="refresh-company-profile"/);
    keptProfile(html);
  }
});

test('partial与旧ready不完整结果保留已读资料，不展示部分状态或任务说明',()=>{
  for(const extra of [
    {state:'ready',job:{status:'partial',stage:'profile'}},
    {state:'partial',job:{status:'ready',stage:'profile'}},
    {state:'ready',complete:false},
  ]) {
    const html=companyProfileDetails(profile(extra),true);
    keptProfile(html);
    assert.match(html,/data-action="refresh-company-profile"/);assert.match(html,/手动查询/);
    assert.match(html,/企业规模<\/dt><dd>大型<\/dd>/);
    assert.match(html,/企业简介<\/dt><dd>源接口未提供<\/dd>/);
  }
});

test('等待额度及失败仅保留入口和已有资料，不显示原因重试日期或伪造简介',()=>{
  for(const status of ['waiting_quota','failed']) {
    const html=companyProfileDetails(profile({state:'partial',reason:'资料任务原因',job:{status,stage:'profile',reason:'积分不足任务暂停',next_retry_at:'2026-11-03T02:00:00.000Z'}}),true);
    keptProfile(html);
    assert.doesNotMatch(html,/资料任务原因|积分不足任务暂停|2026-11-03|\sdisabled/);
    assert.match(html,/data-action="refresh-company-profile"/);
    assert.match(html,/企业简介<\/dt><dd>源接口未提供<\/dd>/);
  }
});

test('完整结果及主体失效均使用手动查询按钮，保留资料和来源读取时间',()=>{
  for(const extra of [{job:{status:'complete'}},{job:{status:'ready'}},{state:'stale',job:{status:'complete'}}]) {
    const html=companyProfileDetails(profile({checked_at:'2026-11-02T06:00:00.000Z',...extra}),true);
    keptProfile(html);
    assert.match(html,/data-action="refresh-company-profile"/);assert.match(html,/手动查询/);
    assert.doesNotMatch(html,/来源：|企查查 MCP/);assert.match(html,/读取时间：2026-11-02 06:00:00 UTC/);
  }
});

test('共享档案隐藏企业资料，无权限或未配置不生成查询按钮，空资料不留空状态段',()=>{
  const c=profile({job:{status:'failed',reason:'不可公开的任务原因'}});
  assert.equal(companyProfileDetails({...c,shared:true},true),'');
  for(const [record,allowed] of [[c,false],[profile({can_refresh:false}),true],[profile({state:'not_configured',job:{status:'running'}}),true]]) {
    const html=companyProfileDetails(record,allowed);
    assert.doesNotMatch(html,/<button\b|data-action="refresh-company-profile"/);noQueryLabels(html);
  }
  const empty=companyProfileDetails({id:11},true);
  assert.match(empty,/手动查询/);
  assert.doesNotMatch(empty,/company-profile-meta|<dl\b|role="status"|<p[^>]*>\s*<\/p>/);
});

test('资料和来源时间元数据严格转义，队列原因及预估完全不进入页面',()=>{
  const p=progress({counts:{total:268,running:0},pause_reason:'<img src=x onerror=alert(1)>',next_retry_at:'<script>任务日期</script>',estimated_remaining_credits:null});
  for(const estimated_remaining_credits of [null,0,592]) {
    const html=companyProfileProgress(state({company_profiles:{...p,estimated_remaining_credits}}));
    onlyManualButton(html);assert.doesNotMatch(html,/<img|<script>|任务日期|alert|NaN|undefined|592/);
  }
  const detail=companyProfileDetails(profile({provider:'<img src=x>',checked_at:'<script>元数据日期</script>',details:{company_name:'<svg onload=alert(1)>',main_products:['<b>产品甲</b>','产品乙'],insured_count:0},job:{status:'failed',reason:'<script>任务原因</script>',next_retry_at:'任务重试日期'}}),true);
  assert.doesNotMatch(detail,/<script>|<img|<svg\s+onload|<b>产品甲|任务原因|任务重试日期/);
  assert.doesNotMatch(detail,/来源：|&lt;img src=x&gt;/);
  assert.match(detail,/读取时间：&lt;script&gt;元数据日期&lt;\/script&gt;/);
  assert.match(detail,/&lt;svg onload=alert\(1\)&gt;/);
  assert.match(detail,/&lt;b&gt;产品甲&lt;\/b&gt;；产品乙/);
  noQueryLabels(detail);
});

test('手动与自动待处理数量均不展示，只有实际运行中禁止批量重复点击',()=>{
  const p=progress({counts:{total:268,complete:120,pending:100,running:0,partial:20,waiting_quota:28,manual:148},pause_reason:'额度不足队列暂停',next_retry_at:'2026-11-03T02:05:00.000Z'});
  const before=structuredClone(p);
  for(const automatic of [true,false]) {
    const html=companyProfileProgress(state({company_profiles:{...p,automatic}}));
    onlyManualButton(html);assert.match(html,/data-action="query-all-company-profiles"/);
    assert.doesNotMatch(html,/268|148|120|额度不足|2026-11-03|\sdisabled/);
  }
  const running=companyProfileProgress(state({company_profiles:{...p,counts:{...p.counts,running:1}}}));
  onlyManualButton(running);assert.match(running,/<button[^>]+disabled/);
  assert.doesNotMatch(running,/data-action="query-all-company-profiles"/);
  assert.deepEqual(p,before,'渲染不修改队列元数据');
});

test('历史手动余项保持可主动查询及已有零值，不展示待办标签和明日重试承诺',()=>{
  for(const status of ['pending','partial','failed','waiting_quota']) {
    const html=companyProfileDetails(profile({state:'partial',reason:'明天自动恢复',job:{status,stage:'profile',manual_only:true,awaiting_manual:true,reason:'明天自动重试',next_retry_at:'2026-11-03T02:05:00.000Z'}}),true);
    keptProfile(html);
    assert.match(html,/data-action="refresh-company-profile"[^>]*>[\s\S]*?手动查询/);
    assert.match(html,/aria-busy="false"/);assert.doesNotMatch(html,/明天|2026-11-03|\sdisabled/);
  }
});

test('手动运行与自动排队均禁用按钮，终态仍可查询且全程不打状态标签',()=>{
  for(const job of [{status:'running',manual_only:true,stage:'registration'},{status:'pending',manual_only:false,stage:'registration'}]) {
    const html=companyProfileDetails(profile({job}),true);
    noQueryLabels(html);assert.match(html,/aria-busy="true"/);
    assert.match(html,/<button[^>]+disabled[^>]*>手动查询<\/button>/);
    assert.doesNotMatch(html,/data-action="refresh-company-profile"/);
  }
  for(const status of ['complete','ready','not_found','mismatch']) {
    const html=companyProfileDetails(profile({job:{status,manual_only:true,stage:'complete'}}),true);
    noQueryLabels(html);assert.match(html,/data-action="refresh-company-profile"/);
    assert.match(html,/手动查询/);assert.doesNotMatch(html,/\sdisabled/);
  }
});

test('旧MANUAL_REQUIRED标记继续允许手动查询，不泄露原因并保留真实资料',()=>{
  const html=companyProfileDetails(profile({state:'partial',job:{status:'failed',error_code:'MANUAL_REQUIRED',stage:'profile',reason:'明天自动恢复',next_retry_at:'2026-11-03T02:05:00.000Z'}}),true);
  keptProfile(html);assert.match(html,/data-action="refresh-company-profile"/);
  assert.doesNotMatch(html,/MANUAL_REQUIRED|明天|2026-11-03|\sdisabled/);
});

test('新旧API是否携带manual计数不影响单一按钮，不显示普通或手动失败数',()=>{
  const legacy=profile({job:{status:'failed',error_code:'MANUAL_REQUIRED'}}),customers=[legacy,{...legacy,id:11},{...legacy,id:12,shared:true},profile({job:{status:'failed',error_code:'QCC_AUTH_INVALID'}}),profile({job:{status:'complete',error_code:'MANUAL_REQUIRED'}})];
  const p=progress({counts:{total:268,complete:120,failed:3},next_retry_at:'2026-11-03T02:05:00.000Z'});
  const html=companyProfileProgress(state({customers,company_profiles:p}));
  const current=companyProfileProgress(state({customers,company_profiles:{...p,counts:{...p.counts,manual:1}}}));
  onlyManualButton(html);assert.equal(current,html);
  assert.doesNotMatch(html,/失败|268|120|2026-11-03/);
  assert.equal(companyProfileProgress(state({customers,actor:{role:'sales'},company_profiles:p})),'' );
});

test('121个历史手动标记及混合真实失败不泄漏标签或失败数量，批量入口保留',()=>{
  const customers=Array.from({length:121},(_,i)=>({...profile({job:{status:'failed',manual_only:true,error_code:'MANUAL_REQUIRED'}}),id:i+1}));
  const p=progress({counts:{total:268,complete:147,manual:121,failed:121},next_retry_at:null});
  const S=state({customers,company_profiles:p}),before=structuredClone(S),html=companyProfileProgress(S);
  onlyManualButton(html);assert.match(html,/data-action="query-all-company-profiles"/);
  assert.doesNotMatch(html,/失败|121|147|268|MANUAL_REQUIRED/);
  const actualFailures=[...customers,{...profile({job:{status:'failed',manual_only:true,error_code:'QCC_TRANSIENT'}}),id:122}];
  const mixed=companyProfileProgress(state({customers:actualFailures,company_profiles:{...p,counts:{...p.counts,manual:122,failed:122}}}));
  assert.equal(mixed,html);assert.deepEqual(S,before,'隐藏展示不删除客户或任务');
});
