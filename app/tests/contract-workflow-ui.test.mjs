import test from 'node:test';
import assert from 'node:assert/strict';
import {contractList,contractFacts,collectionsPage,collectionDetail,formWorkflow,renewalTags,paymentTypes,projectStatuses} from '../public/modules/contract-workflow.js';
import {contractDetail} from '../public/modules/contracts.js';
import {shell,renderPage,formContent} from '../public/views.js';

const clean=html=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const headers=html=>[...html.match(/<thead>(.*?)<\/thead>/s)[1].matchAll(/<th[^>]*>(.*?)<\/th>/gs)].map(match=>clean(match[1]));
const tableRows=html=>[...html.match(/<tbody>(.*?)<\/tbody>/s)[1].matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map(match=>[...match[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(cell=>clean(cell[1])));
const metrics=html=>Object.fromEntries([...html.matchAll(/<div class="metric"><div class="metric-label">(.*?)<\/div><div class="metric-value">(.*?)<\/div>/gs)].map(match=>[clean(match[1]),clean(match[2])]));
const payment=(id,extra={})=>({id,contract_id:10,amount:20000,product_amount:null,status:'待到账',promise_date:'2026-11-20',pay_date:null,checkpoint_date:null,note:'付款备注',...extra});
const contract=(extra={})=>({
  id:10,customer_id:20,owner_id:2,collaborator_pm:3,code:'HT-10',contract_no:'HT-10',name:'产品及服务合同',lifecycle:'历史登记',amount:100000,collected:30000,outstanding:70000,
  collection_status:'部分回款',received_status:'部分回款',sign_date:'2026-10-10',valid_until:'2026-11-30',last_received_at:'2026-11-05',next_expected_at:'2026-11-20',created_at:'2026-11-01T00:00:00Z',
  order_type:'千帆',renewal_tag:'新签（自建）',payment_type:'千帆收款',product_names:['产品 R1','实施服务'],product_types:['标品','交付'],product_amount:60000,service_amount:40000,product_margin_rate:0.25,product_margin:15000,service_margin:12000,total_margin:27000,
  project_status:'交付中',delivery_staff:'交付甲',project_note:'按阶段交付',scope:'交付范围',sources:[],attachments:[{id:90,filename:'合同原件.pdf',size:100,mime_type:'application/pdf',created_at:'2026-11-01'}],can_read_sources:true,can_download_attachments:true,
  items:[{id:30,contract_id:10,name:'产品 R1',kind:'标品',amount:60000,margin:15000,payment_date:'2026-11-20',valid_until:'2026-11-30'}],
  payments:[payment(40,{amount:10000,status:'已到账',pay_date:'2026-11-01',promise_date:'2026-10-31'}),payment(41,{amount:20000,status:'已到账',pay_date:'2026-11-05',promise_date:'2026-11-02'}),payment(42,{amount:70000})],
  ...extra,
});
const state=(contracts=[contract()],role='admin')=>({
  actor:{id:role==='admin'?1:role==='sales'?2:3,name:role,role},today:'2026-11-02',period:'2026-09',demo:true,
  users:[{id:1,name:'管理员',role:'admin',active:1},{id:2,name:'销售甲',role:'sales',active:1},{id:3,name:'项目经理甲',role:'pm',active:1},{id:4,name:'项目经理乙',role:'pm',active:1}],
  customers:[{id:20,name:'甲客户',owner_id:2}],opportunities:[],contacts:[],activities:[],quotes:[],stages:['线索','需求','方案','商务','赢单','输单','搁置'],rules:{},contracts,
  contractDashboard:{month:'2026-11',signed_amount:101000,received_amount:202000,outstanding_amount:303000,expiring_amount:404000,overdue_amount:505000},
});

test('合同总表完整展示业务列及操作，金额和日期各自对应字段而不从商机或其他金额推断',()=>{
  const html=contractList(state(),{tableView:'ledger'}),head=headers(html),row=tableRows(html)[0];
  assert.deepEqual(head,['客户名称 / 合同','订单类型','售卖产品','产品类型','产品续费标签','合同签订时间','回款时间','合同金额','产品金额','产品毛利率','产品毛利','项目／服务金额','项目／服务毛利','总毛利','付款类型','回款状态','已回款金额','产品到期时间','销售小二','合同附件','创建时间','操作']);
  assert.equal(row.length,22);
  assert.equal(row[2],'产品 R1、实施服务');assert.equal(row[3],'标品、交付');
  assert.deepEqual(row.slice(5,14),['2026.10.10','2026.11.05','¥1,000','¥600','25%','¥150','¥400','¥120','¥270']);
  assert.deepEqual(row.slice(14,19),['千帆收款','部分回款','¥300','2026.11.30','销售甲']);
  assert.match(row[20],/2026\.11\.01 08:00:00/);
  assert.match(html,/tabindex="0" data-action="contract" data-id="10"/);
});

test('合同五指标使用服务端当月汇总，不继承绩效历史月或按当前列表重新叠加',()=>{
  const S=state(),html=contractList(S,{q:'没有匹配合同'});
  assert.deepEqual(metrics(html),{'当月合同总额':'¥1,010','当月累计回款':'¥2,020','待回款金额':'¥3,030','当月到期合同金额':'¥4,040','逾期计划':'¥5,050'});
  assert.match(html,/2026-11 · 按合同签订日期/);assert.match(html,/按实际到账日期/);assert.match(html,/按产品到期日期/);
  assert.match(html,/已签署及历史合同减实际到账/);
  assert.doesNotMatch(html,/2026-09/);
  assert.equal(metrics(contractList({...S,contractDashboard:{month:'2026-11'}},{}))['当月合同总额'],'待核对');
});

test('合同订单与回款管理在所有可用角色的主导航中各有一个独立入口',()=>{
  for(const role of ['admin','sales','pm']) {
    const S=state([],role),html=shell(S,'collections'),nav=html.match(/<nav aria-label="主导航">(.*?)<\/nav>/s)[1];
    assert.equal((nav.match(/href="#contracts"/g)||[]).length,1);
    assert.equal((nav.match(/href="#collections"/g)||[]).length,1);
    assert.match(nav,/回款管理/);assert.match(renderPage(S,{view:'collections'}),/<h1>回款管理<\/h1>/);
  }
});

test('多笔回款共用一行合同汇总，不重复合同金额；预计与实际日期分开，草稿不进入回款表',()=>{
  const c=contract(),S=state([c,contract({id:11,lifecycle:'草稿',name:'不能回款的草稿'})]),html=collectionsPage(S,{tableView:'ledger'}),rows=tableRows(html);
  assert.equal(rows.length,1);
  assert.equal(headers(html).length,18);
  assert.deepEqual(rows[0].slice(3,12),['2026.11.20','2026.11.05','¥1,000','¥150','¥120','¥270','部分回款','¥300','¥700']);
  assert.match(html,/实际到账流水（2）/);assert.match(html,/1 份合同/);
  assert.doesNotMatch(html,/不能回款的草稿/);
  assert.equal((html.match(/>¥1,000<\/td>/g)||[]).length,1);
  const pending=contract({payments:[payment(42,{pay_date:'2027-06-22'})],last_received_at:null});
  const pendingHtml=collectionsPage(state([pending]),{tableView:'ledger'});
  assert.match(pendingHtml,/预计 2026.11.20/);
  assert.doesNotMatch(pendingHtml,/实际 2027.06.22/);
});

test('回款管理按指定合同查看并允许返回全表，未知或空合同不会导致渲染异常',()=>{
  const S=state([contract(),contract({id:11,code:'HT-11',contract_no:'HT-11'})]);
  const selected=collectionsPage(S,{contractId:'11'});
  assert.equal(tableRows(selected).length,1);assert.match(selected,/data-action="collections-clear"/);
  assert.doesNotMatch(selected,/data-action="collection" data-id="10"/);
  for(const html of [collectionsPage(S,{contractId:999}),collectionsPage(state([]),{}),collectionsPage(state([contract({lifecycle:'草稿'})]),{})])assert.match(html,/暂无可管理的合同回款/);
  assert.match(contractList(state([]),{}),/还没有合同订单/);
  assert.match(contractDetail(state([]),10),/合同不存在/);
  for(const type of ['contract-maintain','contract-project','item-margin','payment-plan','collection-receive'])assert.doesNotMatch(formWorkflow(state([]),type,999),/<form/);
  assert.match(formContent(state([]),'payment',''),/请先新建合同/);
});

test('NULL拆分金额与毛利显示待补充，明确0显示0，合同事实与回款表不将NULL转成零',()=>{
  const fields=['product_amount','product_margin_rate','product_margin','service_amount','service_margin','total_margin'];
  const unknown=contract(Object.fromEntries(fields.map(key=>[key,null]))),S=state([unknown]);
  assert.deepEqual(tableRows(contractList(S,{tableView:'ledger'}))[0].slice(8,14),Array(6).fill('待补充'));
  assert.deepEqual(tableRows(collectionsPage(S,{tableView:'ledger'}))[0].slice(6,9),Array(3).fill('待补充'));
  const facts=contractFacts(S,unknown);
  for(const label of ['产品金额','产品毛利率','产品毛利','项目／服务金额','项目／服务毛利','总毛利'])assert.match(facts,new RegExp(`<dt>${label}</dt><dd>待补充</dd>`));
  const zero=contract(Object.fromEntries(fields.map(key=>[key,0])));
  assert.deepEqual(tableRows(contractList(state([zero]),{tableView:'ledger'}))[0].slice(8,14),['¥0','0%','¥0','¥0','¥0','¥0']);
});

test('销售财务资料只读，管理员维护确认；PM仅维护本人项目资料',()=>{
  const admin=state(),sales=state(undefined,'sales'),pm=state(undefined,'pm');
  const html=collectionDetail(admin,10);
  for(const action of ['new-payment','contract-project','collection-receive','payment-plan'])assert.match(html,new RegExp(`data-action="${action}"`),action);
  assert.doesNotMatch(html,/data-action="collection-receive" data-id="4[01]"/,'已经到账的流水不能再次确认');
  for(const S of [pm]) {
    const list=collectionsPage(S,{tableView:'ledger'});
    assert.doesNotMatch(list,/data-action="(?:new-payment|collection-receive|payment-plan)"/);
    for(const type of ['contract-maintain','item-margin','payment-plan','collection-receive'])assert.doesNotMatch(formContent(S,type,type==='item-margin'?30:42),/<form/);
  }
  assert.match(collectionDetail(sales,10),/data-action="contract-project"/);assert.match(collectionDetail(sales,10),/data-action="new-payment"/);
  assert.match(collectionDetail(pm,10),/data-action="contract-project" data-id="10"/);
  const pmForm=formContent(pm,'contract-project',10);
  assert.match(pmForm,/data-form="contract-project"/);
  assert.doesNotMatch(pmForm,/name="(?:collaborator_pm|amount|margin|renewal_tag|payment_type|owner_id)"/);
  const otherPm={...pm,actor:{...pm.actor,id:4}};
  assert.doesNotMatch(collectionDetail(otherPm,10),/data-action="contract-project"/);
  assert.doesNotMatch(formContent(otherPm,'contract-project',10),/<form/);
});

test('合同附件按钮尊重下载能力标记，PM不显示附件动作与毛利数值',()=>{
  const S=state(),allowed=contractList(S,{tableView:'ledger'});
  assert.match(allowed,/data-action="record-attachment" data-id="90"/);
  assert.doesNotMatch(contractList(state([contract({can_download_attachments:false})]),{tableView:'ledger'}),/data-action="record-attachment"/);
  const pm=state([contract({can_read_sources:false,can_download_attachments:false,product_margin:null,product_margin_rate:null,service_margin:null,total_margin:null})],'pm'),html=contractList(pm,{tableView:'ledger'});
  assert.doesNotMatch(html,/data-action="record-attachment"/);
  assert.match(html,/权限受限/);
  assert.deepEqual(tableRows(html)[0].slice(9,14),['权限受限','权限受限','¥400','权限受限','权限受限']);
  const detail=contractDetail(pm,10);
  assert.doesNotMatch(detail,/data-action="(?:archive-contract|contract-maintain|item-margin|download-contract|contract-extract|record-attachment)"/);
});

test('合同维护保留新分类、项目协同和必填依据；毛利金额和毛利率可单独维护',()=>{
  const S=state(),html=formContent(S,'contract-maintain',10);
  for(const field of ['name','contract_no','sign_date','valid_until','order_type','renewal_tag','payment_type','scope','project_status','collaborator_pm','delivery_staff','project_note','reason'])assert.match(html,new RegExp(`name="${field}"`),field);
  for(const value of [...renewalTags,...paymentTypes,...projectStatuses])assert.ok(html.includes(value),value);
  assert.match(html,/textarea name="reason"[^>]*required/);
  const margin=formContent(S,'item-margin',30);
  for(const field of ['name','kind','margin_before_expense','business_expense','payment_date','valid_until','reason'])assert.match(margin,new RegExp(`name="${field}"`));
  assert.match(margin,/name="margin_before_expense"[^>]*value="150"/);
  const unknown=contract({items:[{...S.contracts[0].items[0],margin:null}]});
  assert.match(formContent(state([unknown]),'item-margin',30),/name="margin_before_expense"[^>]*value=""/);
});

test('新增回款先选已有非草稿合同，本笔金额不预填合同总额，确认到账表单必须填写实际日期',()=>{
  const S=state([contract(),contract({id:11,lifecycle:'草稿',name:'草稿不能选'})]),html=formContent(S,'payment','');
  assert.match(html,/name="contract_id" required/);
  assert.doesNotMatch(html,/草稿不能选/);
  assert.match(html,/<input name="amount"[^>]*value=""/);
  assert.match(html,/<input name="pay_date"[^>]*value="2026-11-02"/);
  const confirm=formContent(S,'collection-receive',42);
  assert.match(confirm,/data-form="collection-receive"/);assert.match(confirm,/计划余款/);
  assert.match(confirm,/<input name="pay_date"[^>]*required/);
  assert.match(confirm,/<input name="product_amount"[^>]*value=""/,'未知分配不应预填0');
  assert.match(confirm,/<input name="amount"[^>]*value=""[^>]*required/,'本次实收明确填写，避免把整笔计划当作实际金额');
  const plan=formContent(S,'payment-plan',42);
  assert.match(plan,/name="promise_date"/);assert.doesNotMatch(plan,/name="pay_date"/);
  assert.doesNotMatch(formContent(S,'collection-receive',40),/<form/);
});

test('合同名称、产品、附件名和项目备注中的HTML全部转义，表单属性也不能被注入',()=>{
  const attack='<img src=x onerror=bad()>',c=contract({name:attack,contract_no:'" autofocus onfocus="bad()',product_names:[attack],delivery_staff:attack,project_note:attack,scope:attack,attachments:[{id:90,filename:attack}],payments:[payment(42,{note:attack})]});
  c.items[0]={...c.items[0],name:attack};
  const S=state([c]);S.customers[0].name=attack;
  for(const html of [contractList(S,{tableView:'ledger'}),collectionsPage(S,{tableView:'ledger'}),contractDetail(S,10),formContent(S,'contract-maintain',10),formContent(S,'item-margin',30),formContent(S,'payment-plan',42)]) {
    assert.doesNotMatch(html,/<img src=x| autofocus onfocus="bad\(\)"/);
    assert.ok(html.includes('&lt;img src=x onerror=bad()&gt;'));
  }
});
