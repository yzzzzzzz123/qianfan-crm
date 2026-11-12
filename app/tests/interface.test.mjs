import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/fixture.mjs";
import {dashboardScope} from '../public/modules/dashboards.js';
import {
  pages,
  shell,
  renderPage,
  formContent,
  contractDetail,
  customerDetail,
  opportunityDetail,
} from "../public/views.js";

test('移除设置页面，原有必要规则入口位于对应业务模块',async t=>{
  const f=await fixture(t),actor=await f.login(1),s=(await f.request('/state',{actor})).body;
  assert.equal(Object.hasOwn(pages,'settings'),false);assert.doesNotMatch(shell(s,'workbench'),/href="#settings"/);
  assert.match(renderPage(s,{view:'settings'}),/页面不存在/);
  for(const [view,action] of [['customers','customer-levels'],['opportunities','stage-rules'],['contracts','document-templates'],['commissions','finance-rules'],['commissions','sales-commission-policy'],['performance','performance-rules']])
    assert.match(renderPage(s,{view}),new RegExp(`data-action="${action}"`),view+' '+action);
  for(const [type,id] of [['customer-levels',''],['rules',''],['document-templates',''],['finance-rules',''],['sales-commission-policy',''],['performance-rules','']])
    assert.match(formContent(s,type,id),new RegExp(`data-form="${type}"`),type);
});

test("M11-A04 各业务模块支持手动填写新建，文档上传统一保留AI接收", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const s = (await f.request("/state", { actor })).body;
  for (const view of Object.keys(pages)) {
    const html = renderPage(s, {
      view,
      q: "",
      owner: "",
      stage: "",
      level: "",
      risk: "",
      source: "",
      sort: "",
      desc: false,
      tab: "members",
    });
    assert.match(html, /<h1>/, view);
    assert.doesNotMatch(html, /\b(?:undefined|NaN)\b/, view);
  }
  for (const [type, id] of [
    ["customer", ""],
    ["contact", 1],
    ["opportunity", 1],
    ["activity", 1],
    ["quote", 1],
    ["contract", ""],
    ["convert", 1],
    ["payment", 1],
    ["rules", ""],
  ])
    {const html=formContent(s,type,id);assert.ok(html.includes(`data-form="${type}"`),type);assert.doesNotMatch(html,/type="password"/,type);if(type!=='quote')assert.doesNotMatch(html,/type="file"/,type);}
  assert.match(renderPage(s,{view:'intake'}),/data-form="ai-intake"/);
  assert.match(renderPage(s,{view:'analytics',tab:'members'}),/data-action="manual-entry"/);
  assert.match(renderPage(s,{view:'activities'}),/data-action="new-activity"/);
  assert.match(renderPage(s,{view:'contracts'}),/data-action="new-contract"/);
  assert.match(renderPage(s,{view:'collections'}),/data-action="new-payment"/);
  assert.match(renderPage(s,{view:'collections'}),/data-action="new-payment-plan"/);
  for(const view of ['team'])assert.doesNotMatch(renderPage(s,{view,tab:'members'}),/data-action="manual-entry"|data-action="new-user"/,view);
  assert.doesNotMatch(formContent(s,'user',''),/data-form="user"|name="ding_user_id"|name="username"/);
  for(const view of Object.keys(pages))assert.doesNotMatch(renderPage(s,{view,tab:'members'}),/data-action="mirror-import"/);
  assert.match(renderPage(s,{view:'customers'}),/data-action="new-customer"/);
  assert.match(renderPage(s,{view:'opportunities'}),/data-action="new-opportunity"/);
  assert.match(formContent(s,'edit-customer',1),/data-form="edit-customer"/);
});
test("M11-A05 销售可编辑本人合同及回款，管理页面和归档仍受限", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const s = (await f.request("/state", { actor })).body;
  for (const view of ["analytics", "audit"])
    assert.match(renderPage(s, { view }), /无权访问/);
  const html = contractDetail(s, 1);
  assert.match(html, /data-action="contract-maintain"/);
  assert.doesNotMatch(
    html,
    /data-action="(?:data-review|settlement-review)"/,
  );
});

test('绩效评定允许管理员直接设置，销售只读且已锁定月份不能再编辑',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
  const s=(await f.request('/state',{actor:admin})).body,p=s.performance.find(p=>p.eligible);
  assert.ok(p);
  assert.match(renderPage(s,{view:'performance'}),/data-action="performance-review"/);
  const html=formContent(s,'performance-review',p.user_id);
  assert.match(html,/data-form="performance-review"/);
  assert.match(html,/type="hidden" name="month"/);
  assert.doesNotMatch(html,/value="confirmed"/);
  const past={...s,today:'2026-10-29',performance:[{...p,month:'2026-09'}]};
  assert.match(formContent(past,'performance-review',p.user_id),/value="confirmed"/);
  assert.match(formContent({...past,performance:[{...past.performance[0],status:'confirmed'}]},'performance-review',p.user_id),/该月绩效已确认锁定/);
  assert.match(formContent(s,'performance-review',999999),/不参与绩效评定/);
  const own=(await f.request('/state',{actor:sales})).body;
  assert.doesNotMatch(renderPage(own,{view:'performance'}),/data-action="performance-review"/);
  assert.match(formContent(own,'performance-review',2),/无权设置绩效/);
});
test("M11-A06 客户输入的HTML按文本显示，不进入可执行标签", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const r = await f.request("/customers", {
    actor,
    method: "POST",
    body: {
      name: "<script>bad()</script>客户",
      owner_id:2,
      note: "<img src=x onerror=bad()>",
    },
  });
  assert.equal(r.status, 200);
  const s = (await f.request("/state", { actor })).body;
  const html = customerDetail(s, r.body.id);
  assert.ok(html.includes("&lt;script&gt;bad()&lt;/script&gt;客户"));
  assert.ok(html.includes("&lt;img src=x onerror=bad()&gt;"));
  assert.ok(!html.includes("<script>bad()"));
  assert.ok(!html.includes("<img src=x"));
});


test('同一记录保留唯一操作，行级设置不再叠加页面入口',async t=>{
  const f=await fixture(t),actor=await f.login(1),s=(await f.request('/state',{actor})).body;
  for(const [view,action] of [['customers','customer'],['opportunities','opportunity'],['contracts','contract']]) {
    const html=renderPage(s,{view,...(view==='opportunities'?{opportunityView:'ledger'}:{})});
    const ids=[...html.matchAll(new RegExp(`<tr[^>]*data-action="${action}" data-id="([^"]+)"`,'g'))].map(m=>m[1]);
    assert.ok(ids.length>0,view);
    assert.equal(new Set(ids).size,ids.length,view+'详情入口重复');
  }
  const members=renderPage(s,{view:'team'});
  assert.equal((members.match(/data-action="manual-entry"/g)||[]).length,0);
  assert.doesNotMatch(members,/data-action="new-user"|通过AI接收维护/);
  for(const view of ['performance','commissions'])assert.doesNotMatch(renderPage(s,{view}),/data-action="manual-entry"/);
  assert.match(renderPage(s,{view:'performance'}),/data-action="performance-review"/);
  assert.doesNotMatch(renderPage(s,{view:'team'}),/data-action="target" data-id=""/);
  const customerForm=formContent(s,'customer','');
  assert.equal((customerForm.match(/data-action="close"/g)||[]).length,2);
  assert.doesNotMatch(contractDetail(s,1),/data-action="(?:edit-item|receive-payment)"/);
  assert.doesNotMatch(opportunityDetail({...s,activities:[]},1),/data-action="new-activity"[^]*data-action="new-activity"/);
  assert.doesNotMatch(formContent({...s,customers:[]},'opportunity',''),/<form|type="submit"/);
  assert.match(formContent(s,'convert',999999),/商机不存在/);
  assert.match(formContent(s,'activity',''),/<select name="opportunity_id" required/);
});

test('跟进类型筛选保留手动来源和同日归并的会议拜访',async t=>{
  const f=await fixture(t),actor=await f.login(1),s=(await f.request('/state',{actor})).body;
  const a={id:991,opportunity_id:1,user_id:1,activity_date:s.today,summary:'核验同日会议与拜访',activity_type:'手动跟进',source:'手动',sources:['手动']};
  const state={...s,activities:[a],activityEvents:[{activity_id:991,activity_type:'线上会议',source:'手动'},{activity_id:991,activity_type:'现场拜访',source:'手动'}]};
  for(const source of ['线上会议','现场拜访','手动'])assert.match(renderPage(state,{view:'activities',source}),/核验同日会议与拜访/);
  assert.doesNotMatch(renderPage(state,{view:'activities',source:'AI听记'}),/核验同日会议与拜访/);
});

test('规则参数保留在配置入口，提成和绩效页去除顶部说明并保留筛选',async t=>{
  const f=await fixture(t),actor=await f.login(1),s=(await f.request('/state',{actor})).body;
  const state={...s,rules:{...s.rules,performance:{...s.rules.performance,process_weight:60,result_weight:40,cap:80,meeting:2},commission:{...s.rules.commission,threshold:30000000,low_rate:0.04,high_rate:0.06}}};
  const performance=renderPage(state,{view:'performance'});
  assert.doesNotMatch(performance,/class="notice"/);
  assert.match(performance,/id="report-month"/);
  const form=formContent(state,'performance-rules');
  assert.match(form,/name="performance:process_weight"[^>]*value="60"/);
  assert.match(form,/name="performance:cap"[^>]*value="80"/);
  assert.match(performance,/线上会议 2 分\/次/);
  const commissions=renderPage(state,{view:'commissions'});
  assert.doesNotMatch(commissions,/class="notice"/);
  assert.match(commissions,/id="commission-period"/);
  const sales=await f.login(2),own=(await f.request('/state',{actor:sales})).body;
  assert.doesNotThrow(()=>renderPage(own,{view:'commissions'}));
});

test('分析按销售类型筛选商机及关联合同，跟进同范围且个人看板默认本人',async t=>{
  const f=await fixture(t),actor=await f.login(1),s=(await f.request('/state',{actor})).body;
  const base={...s,customers:[{id:90,owner_id:1,manual_level:'A'},{id:91,owner_id:2,manual_level:'B'}],opportunities:[{id:90,customer_id:90,owner_id:1,sale_type:'新签自建',created_at:'2026-10-10'},{id:91,customer_id:91,owner_id:2,sale_type:'新签自建',created_at:'2026-10-10'}],contracts:[{id:90,opportunity_id:90,customer_id:90,owner_id:1,sign_date:'2026-10-10',items:[{kind:'标品'},{kind:'实施'}]},{id:91,customer_id:90,owner_id:1,sign_date:'2026-10-10',items:[{kind:'标品'}]}],activities:[{id:90,opportunity_id:90,activity_date:'2026-10-11'},{id:91,opportunity_id:91,activity_date:'2026-10-11'},{id:92,opportunity_id:90,activity_date:'2026-09-30'}],activityEvents:[{id:90,opportunity_id:90,activity_date:'2026-10-11'},{id:91,opportunity_id:91,activity_date:'2026-10-11'}]};
  const scoped=dashboardScope(base,{view:'analytics',owner:'1',level:'A',manual_level:'A',saleType:'新签自建',from:'2026-10-01',to:'2026-10-31'});
  assert.deepEqual(scoped.opportunities.map(x=>x.id),[90]);assert.deepEqual(scoped.contracts.map(x=>x.id),[90]);
  assert.deepEqual(scoped.activities.map(x=>x.id),[90]);assert.deepEqual(scoped.activityEvents.map(x=>x.id),[90]);
  assert.deepEqual(dashboardScope(base,{view:'personal'}).opportunities.map(x=>x.id),[90]);
});
