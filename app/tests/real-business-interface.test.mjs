import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {renderPage,formContent,contractDetail,opportunityDetail} from '../public/views.js';
import {pipeline,oppTable} from '../public/modules/shared.js';
import {dashboardScope,dashboard} from '../public/modules/dashboards.js';

test('商机界面使用真实表业务字段，空分类与未知销售不猜补',async t=>{
  const f=await fixture(t),actor=await f.login(1),S=(await f.request('/state',{actor})).body;
  const form=formContent(S,'opportunity','');
  for(const field of ['name','owner_id','amount','product_amount','sale_type','order_type','expected_date','collaborator_pm'])assert.match(form,new RegExp(`name="${field}"`),field);
  assert.doesNotMatch(form,/name="(?:est_margin|product_type|source|nature|products|deal_type)"/);
  assert.match(form,/name="sale_type" required/);assert.match(form,/name="order_type" required/);
  assert.match(form,/预计产品金额（元）/);assert.match(form,/<input[^>]*name="product_amount"[^>]*required/);
  assert.match(form,/<input[^>]*name="product_amount"[^>]*value=""/);
  assert.doesNotMatch(form,/<option value="赢单"/);
  const o={...S.opportunities[0],owner_id:null,product_amount:null,forecast_product_amount:null,sale_type:null,order_type:null};
  const html=opportunityDetail({...S,opportunities:[o]},o.id);
  assert.match(html,/销售 未分配/);assert.match(html,/预计产品金额<\/span><strong>未提供/);
  const list=oppTable({...S,opportunities:[o]},[o]);
  assert.match(list,/预计产品 未提供/);assert.doesNotMatch(list,/预计产品 ¥0/);
  assert.match(html,/销售类型<\/dt><dd>待补充/);assert.doesNotMatch(html,/PPL|镜像|申请骨架变更|预估毛利/);
});
test('金额漏斗按金额缩放，赢单输单和搁置不混入在跟进金额',()=>{
  const S={stages:['线索','需求','方案','商务','赢单','输单','搁置'],opportunities:[{stage:'线索',amount:100},{stage:'需求',amount:900},...['赢单','输单','搁置'].map(stage=>({stage,amount:1000000}))]};
  const html=pipeline(S);
  assert.match(html,/data-id="线索"[^]*?band-1/);assert.match(html,/data-id="需求"[^]*?band-10/);
  assert.doesNotMatch(html,/data-id="(?:赢单|输单|搁置)"|<small>个<\/small>/);
});
test('合同草稿先选已有签章附件确认归档，整体收款与单笔状态分别展示',async t=>{
  const f=await fixture(t),actor=await f.login(1),S=(await f.request('/state',{actor})).body;
  const c={...S.contracts[0],lifecycle:'草稿',collection_status:'部分回款',attachments:[{id:991,filename:'双方签章.pdf',mime_type:'application/pdf',size:1000,created_at:S.today}],items:[{...S.contracts[0].items[0],margin:null}]},state={...S,contracts:[c]};
  const html=contractDetail(state,c.id);
  assert.equal((html.match(/data-action="archive-contract"/g)||[]).length,1);
  assert.doesNotMatch(html,/data-action="new-payment"/);assert.match(html,/未收金额/);assert.match(html,/部分回款/);assert.match(html,/待核对/);
  const archive=formContent(state,'archive-contract',c.id);
  assert.match(archive,/name="archive_attachment_id"/);assert.match(archive,/name="both_stamped" required/);assert.match(archive,/type="file"/);
  assert.doesNotMatch(contractDetail({...state,contracts:[{...c,lifecycle:'已归档'}]},c.id),/data-action="archive-contract"/);
  assert.doesNotMatch(formContent({...state,contracts:[{...c,attachments:[]}]},'archive-contract',c.id),/type="file"[^>]*required/);
  assert.match(formContent(S,'contract',''),/保存合同/);assert.doesNotMatch(formContent(S,'contract',''),/保存后商机变为成交|name="source"|name="nature"/);
});
test('报价使用数量原价折扣明细，历史资料独立入口保持退役',async t=>{
  const f=await fixture(t),actor=await f.login(1),S=(await f.request('/state',{actor})).body;
  const quote=formContent(S,'quote',1);
  for(const field of ['quantity','list_price','discount_percent'])assert.match(quote,new RegExp(`data-field="${field}"`));
  assert.doesNotMatch(quote,/name="amount"/);
  const html=renderPage(S,{view:'intake',sourceHistory:{records:[{source_file:'QFCRM.xlsx',source_sheet:'商机',source_row:8,status:'pending',reason:'缺少合同总额',raw:{备注:'<img src=x onerror=bad()>'},imported_at:'2026-10-29T08:00:00Z'}],total:1,counts:[],offset:0,limit:50}});
  assert.doesNotMatch(html,/历史资料|source-history|缺少合同总额|第 8 行/);
  assert.doesNotMatch(html,/<img src=x|data-action="source-history"|PPL连接|骨架变更/);
});

test('合同分类独立展示与筛选，优先合同自身分类，旧空值可回退关联商机',async t=>{
  const f=await fixture(t),actor=await f.login(1),S=(await f.request('/state',{actor})).body;
  const base=S.contracts[0],opportunity=S.opportunities.find(row=>row.id===base.opportunity_id)||S.opportunities[0];
  const make=(id,name,sale_type,opportunity_id)=>({...base,id,name,sale_type,order_type:'经销',opportunity_id,lifecycle:'历史登记',payments:[{id,amount:10000,status:'待到账',promise_date:'2026-10-30',checkpoint_date:null,overdue_days:0}],renewal_due:false});
  const contracts=[make(991,'独立续费合同','续费',null),make(992,'合同分类优先','续费',opportunity.id),make(993,'沿用商机分类',null,opportunity.id),make(994,'历史分类未知',null,null),{...make(995,'草稿续费不统计','续费',null),lifecycle:'草稿'}];
  const state={...S,contracts,opportunities:[{...opportunity,sale_type:'新签自建'}]};
  assert.deepEqual(dashboardScope(state,{view:'analytics',saleType:'续费'}).contracts.map(c=>c.id),[991,992]);
  assert.deepEqual(dashboardScope(state,{view:'analytics',saleType:'新签自建'}).contracts.map(c=>c.id),[993]);
  const collections=renderPage({...state,collections:contracts},{view:'collections',saleType:'续费'});
  assert.match(collections,/独立续费合同/);assert.match(collections,/合同分类优先/);assert.doesNotMatch(collections,/沿用商机分类|历史分类未知|草稿续费不统计/);
  assert.match(contractDetail(state,991),/销售类型<\/dt><dd>续费/);assert.match(contractDetail(state,991),/订单类型<\/dt><dd>经销/);
  assert.match(contractDetail({...state,contracts:[{...contracts[0],sale_type:null,order_type:null}]},991),/销售类型<\/dt><dd>未提供/);
});
