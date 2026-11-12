import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,customer} from './helpers/fixture.mjs';
import {one,all,run} from '../server/database.mjs';
import {today,dateAdd} from '../server/domain.mjs';
import {customers,customerDetail,formCustomers,customerBusinessTotals} from '../public/modules/customers.js';
import {formContent} from '../public/views.js';
import {customerEditPayload} from '../public/modules/customer-controller.js';

const state=async(f,actor)=>(await f.request('/state',{actor})).body;
const preview=async(f,actor,id=1,ownerId=3)=>{
  const result=await f.request(`/customers/${id}/transfer-preview?owner_id=${ownerId}`,{actor});
  assert.equal(result.status,200,JSON.stringify(result.body));return result.body;
};
const patch=(f,actor,body,id=1)=>f.request('/customers/'+id,{actor,method:'PATCH',body});

test('客户默认交接仅改后续维护负责人，保留既有商机、合同和同笔回款归属',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
  const opps=all(f.db,'SELECT id,owner_id FROM opportunities WHERE customer_id=1 ORDER BY id');
  const contracts=all(f.db,'SELECT id,owner_id FROM contracts WHERE customer_id=1 ORDER BY id');
  assert.ok(opps.length&&contracts.length,'fixture must include linked business');
  const before=await state(f,sales),cash=before.commission.receipt_review.filter(r=>r.contract_id===contracts[0].id);
  assert.ok(cash.length,'fixture must include actual receipts');
  const result=await patch(f,admin,{owner_id:3,reason:'仅交接后续客户维护'});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(one(f.db,'SELECT owner_id FROM customers WHERE id=1').owner_id,3);
  assert.deepEqual(all(f.db,'SELECT id,owner_id FROM opportunities WHERE customer_id=1 ORDER BY id'),opps);
  assert.deepEqual(all(f.db,'SELECT id,owner_id FROM contracts WHERE customer_id=1 ORDER BY id'),contracts);
  const after=await state(f,sales);
  assert.deepEqual(after.commission.receipt_review.filter(r=>r.contract_id===contracts[0].id),cash);
  assert.equal(after.customers.find(c=>c.id===1).shared,true);
  assert.ok(after.contracts.some(c=>c.id===contracts[0].id));
  assert.ok(after.opportunities.some(o=>o.id===opps[0].id));
  const detail=JSON.parse(one(f.db,"SELECT detail FROM audit WHERE entity='customer' AND entity_id=1 AND action='更新客户' ORDER BY id DESC").detail);
  assert.equal(detail.ownership_transfer.scope,'customer_only');
  assert.deepEqual(detail.ownership_transfer.contract_ids,[]);
});

test('连带调整关联业务须当前影响预览和明确确认，不修改回款本身',async t=>{
  const f=await fixture(t),admin=await f.login(1),p=await preview(f,admin);
  assert.equal(p.from_owner.id,2);assert.equal(p.to_owner.id,3);
  assert.equal(p.can_transfer_linked,true);assert.ok(p.contracts.length&&p.opportunities.length);
  assert.equal(p.totals.contracts,p.contracts.length);
  assert.equal(p.totals.collected,p.contracts.reduce((s,c)=>s+c.collected,0));
  const payments=all(f.db,'SELECT * FROM payments ORDER BY id');
  const body={owner_id:3,reason:'经核对明确调整既有业务归属',ownership_scope:'linked_records'};
  const unconfirmed=await patch(f,admin,{...body,transfer_preview_token:p.preview_token});
  assert.equal(unconfirmed.status,400);assert.equal(one(f.db,'SELECT owner_id FROM customers WHERE id=1').owner_id,2);
  const noPreview=await patch(f,admin,{...body,ownership_confirmed:true});
  assert.equal(noPreview.status,409);assert.equal(one(f.db,'SELECT owner_id FROM customers WHERE id=1').owner_id,2);
  const result=await patch(f,admin,{...body,ownership_confirmed:true,transfer_preview_token:p.preview_token});
  assert.equal(result.status,200,JSON.stringify(result.body));
  for(const c of p.contracts)assert.equal(one(f.db,'SELECT owner_id FROM contracts WHERE id=?',c.id).owner_id,3);
  for(const o of p.opportunities)assert.equal(one(f.db,'SELECT owner_id FROM opportunities WHERE id=?',o.id).owner_id,3);
  assert.deepEqual(all(f.db,'SELECT * FROM payments ORDER BY id'),payments,'handover must not rewrite receipt amounts, dates or allocation');
});

test('预览后关联业务变化会原子拒绝旧移交令牌，刷新后可重新核对',async t=>{
  const f=await fixture(t),admin=await f.login(1),p=await preview(f,admin);
  run(f.db,'UPDATE contracts SET amount=amount+100 WHERE id=?',p.contracts[0].id);
  const result=await patch(f,admin,{owner_id:3,reason:'业务变化后不能沿用旧核对',ownership_scope:'linked_records',ownership_confirmed:true,transfer_preview_token:p.preview_token});
  assert.equal(result.status,409);assert.match(result.body.error,/变化|刷新|预览/);
  assert.equal(one(f.db,'SELECT owner_id FROM customers WHERE id=1').owner_id,2);
  assert.ok(all(f.db,'SELECT owner_id FROM contracts WHERE customer_id=1').every(c=>c.owner_id===2));
  assert.notEqual((await preview(f,admin)).preview_token,p.preview_token);
});

test('历史锁阻止连带调整业绩归属，但允许只交接客户后续维护',async t=>{
  const f=await fixture(t),admin=await f.login(1),contract=one(f.db,'SELECT id FROM contracts WHERE customer_id=1');
  run(f.db,"INSERT INTO performance_reviews(user_id,month,status,snapshot,updated_at) VALUES(?,?,'confirmed',?,?)",2,today().slice(0,7),JSON.stringify({evidence:{contracts:[{id:contract.id}]}}),new Date().toISOString());
  const p=await preview(f,admin);assert.equal(p.can_transfer_linked,false);
  assert.equal(p.contracts.find(c=>c.id===contract.id).locked,true);
  const blocked=await patch(f,admin,{owner_id:3,reason:'历史业绩归属受保护',ownership_scope:'linked_records',ownership_confirmed:true,transfer_preview_token:p.preview_token});
  assert.equal(blocked.status,409);assert.equal(one(f.db,'SELECT owner_id FROM customers WHERE id=1').owner_id,2);
  const handover=await patch(f,admin,{owner_id:3,reason:'保留历史，仅交接后续维护',ownership_scope:'customer_only'});
  assert.equal(handover.status,200,JSON.stringify(handover.body));
  assert.equal(one(f.db,'SELECT owner_id FROM contracts WHERE id=?',contract.id).owner_id,2);
});

test('移交影响仅管理员可读写，目标负责人必须明确且有效',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
  assert.equal((await f.request('/customers/1/transfer-preview?owner_id=3',{actor:sales})).status,403);
  assert.equal((await patch(f,sales,{owner_id:3,reason:'销售不能自行移交',ownership_scope:'customer_only'})).status,403);
  for(const route of ['/customers/1/transfer-preview','/customers/1/transfer-preview?owner_id=2','/customers/1/transfer-preview?owner_id=999999'])
    assert.equal((await f.request(route,{actor:admin})).status,400,route);
  run(f.db,'UPDATE users SET active=0 WHERE id=3');
  assert.equal((await f.request('/customers/1/transfer-preview?owner_id=3',{actor:admin})).status,400);
});

test('签约事实与人工管理状态独立，新增合同不清掉冻结或流失',async t=>{
  const f=await fixture(t),admin=await f.login(1);
  for(const management of ['冻结','流失']){
    const created=await f.request('/customers',{actor:admin,method:'POST',body:customer({name:'管理状态隔离企业'+management,owner_id:2})});
    assert.equal(created.status,200);const cid=created.body.id;
    assert.equal((await patch(f,admin,{management_status:management},cid)).status,200);
    const before=(await state(f,admin)).customers.find(c=>c.id===cid);
    assert.equal(before.management_status,management);assert.equal(before.relationship_status,'未合作');
    const signed=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:cid,name:'已签署服务合同'+management,sign_date:today(),items:[{name:'实施服务',kind:'实施',amount:1000}]}});
    assert.equal(signed.status,200,JSON.stringify(signed.body));
    const after=(await state(f,admin)).customers.find(c=>c.id===cid);
    assert.equal(after.management_status,management);assert.equal(after.status,management);assert.equal(after.relationship_status,'已合作');
    assert.equal((await patch(f,admin,{management_status:'正常'},cid)).status,200);
    const normal=(await state(f,admin)).customers.find(c=>c.id===cid);
    assert.equal(normal.management_status,'正常');assert.equal(normal.relationship_status,'已合作');assert.equal(normal.status,'成交');
    assert.equal((await patch(f,admin,{status:'潜在'},cid)).status,200);
    assert.equal((await state(f,admin)).customers.find(c=>c.id===cid).relationship_status,'已合作','legacy manual status cannot erase signed business facts');
  }
});

test('联系人可仅微信维护，未来触达被拒绝；旧缺项不阻断修改其他字段',async t=>{
  const f=await fixture(t),sales=await f.login(2);
  const created=await f.request('/contacts',{actor:sales,method:'POST',body:{customer_id:1,name:'微信联系人',wechat:'verified-wechat'}});
  assert.equal(created.status,200,JSON.stringify(created.body));const cid=created.body.id;
  assert.equal((await f.request('/contacts/'+cid,{actor:sales,method:'PATCH',body:{title:'采购负责人'}})).status,200);
  assert.equal((await f.request('/contacts/'+cid,{actor:sales,method:'PATCH',body:{phone:'',wechat:'',dingtalk:''}})).status,400);
  assert.equal((await f.request('/contacts/'+cid,{actor:sales,method:'PATCH',body:{last_contact:dateAdd(1)}})).status,400);
  assert.equal((await f.request('/contacts',{actor:sales,method:'POST',body:{customer_id:1,name:'未来日期联系人',wechat:'test',last_contact:dateAdd(1)}})).status,400);
  const legacy=one(f.db,"SELECT id FROM contacts WHERE customer_id=1 AND phone='' AND wechat='' AND dingtalk='' LIMIT 1");assert.ok(legacy);
  assert.equal((await f.request('/contacts/'+legacy.id,{actor:sales,method:'PATCH',body:{title:'只补充历史联系人职位'}})).status,200);
  assert.equal(one(f.db,'SELECT title FROM contacts WHERE id=?',legacy.id).title,'只补充历史联系人职位');
});

test('客户修正保留字段前后值与原因审计',async t=>{
  const f=await fixture(t),sales=await f.login(2),before=one(f.db,'SELECT note FROM customers WHERE id=1').note;
  const result=await patch(f,sales,{note:'核对后的客户备注',reason:'迁移资料修正'});assert.equal(result.status,200);
  const detail=JSON.parse(one(f.db,"SELECT detail FROM audit WHERE entity='customer' AND entity_id=1 AND action='更新客户' ORDER BY id DESC").detail);
  assert.equal(detail.before.note,before);assert.equal(detail.after.note,'核对后的客户备注');assert.equal(detail.reason,'迁移资料修正');
});

test('管理员与本人销售可直达编辑，普通修改保留停用负责人和旧缺值',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
  const S=await state(f,admin),own=await state(f,sales);
  assert.match(formContent(S,'edit-customer',1),/data-form="edit-customer"/);
  assert.match(formContent(own,'edit-customer',1),/data-form="edit-customer"/);
  assert.match(formContent(own,'edit-contact',1),/data-form="edit-contact"/);
  assert.doesNotMatch(formContent(own,'edit-customer',2),/data-form="edit-customer"/,'other owner shared card is not writable');
  S.users.find(u=>u.id===2).active=0;
  const html=formCustomers(S,'edit-customer',1,{});
  // Normal edits must keep the existing owner, whether represented by a hidden
  // value or a labelled disabled/inactive option; never silently select actor 1.
  assert.match(html,/(?:name="owner_id"[^>]*value="2"|value="2" selected)/);
  assert.match(html,/停用/);
});

test('销售默认本人客户且支持授权联系人搜索，共享档案不泄露联系方式或财务',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
  const unique=await f.request('/contacts',{actor:sales,method:'POST',body:{customer_id:1,name:'独有查找联系人',wechat:'owned-wechat-marker'}});assert.equal(unique.status,200);
  const hidden=await f.request('/contacts',{actor:admin,method:'POST',body:{customer_id:2,name:'其他销售私密联系人',phone:'18812345678'}});assert.equal(hidden.status,200);
  const S=await state(f,sales),mine=customers(S,{view:'customers',q:''});
  assert.ok(!mine.includes('查看'+S.customers.find(c=>c.id===2).name+'的客户档案'),'default list is my customers');
  for(const q of ['独有查找联系人','owned-wechat-marker']){
    const match=customers(S,{view:'customers',q});assert.match(match,/data-id="1"/);assert.doesNotMatch(match,/其他销售私密联系人/);
  }
  const shared=customers(S,{view:'customers',q:'',customerScope:'shared'});
  assert.match(shared,/查看元鼎智能科技有限公司的客户档案/);
  assert.doesNotMatch(shared,/其他销售私密联系人|18812345678/);
  assert.doesNotMatch(customerDetail(S,2),/其他销售私密联系人|18812345678|data-action="edit-customer"|data-action="edit-contact"/);
});


test('客户财务概览沿用有效授权合同台账，未知不当零',()=>{
  const customer={id:1,shared:false};
  const contracts=[
    {id:1,customer_id:1,lifecycle:'已归档',amount:100000,collected:30000,outstanding:70000},
    {id:2,customer_id:1,lifecycle:'草稿',amount:900000,collected:0,outstanding:900000},
    {id:3,customer_id:1,lifecycle:'已归档',terminated_at:'2026-11-01',amount:800000,collected:800000,outstanding:0},
    {id:4,customer_id:1,lifecycle:'已归档',retired_at:'2026-11-01',amount:700000,collected:0,outstanding:700000},
    {id:5,customer_id:2,lifecycle:'已归档',amount:600000,collected:0,outstanding:600000},
  ];
  assert.deepEqual(customerBusinessTotals(customer,contracts),{count:1,amount:100000,collected:30000,outstanding:70000});
  assert.deepEqual(customerBusinessTotals(customer,[]),{count:0,amount:0,collected:0,outstanding:0});
  assert.equal(customerBusinessTotals({...customer,shared:true},[]),null);
  const unknown=[...contracts,{id:6,customer_id:1,lifecycle:'历史登记',amount:null,collected:40000,outstanding:null}];
  assert.deepEqual(customerBusinessTotals(customer,unknown),{count:2,amount:null,collected:70000,outstanding:null});
});

test('仅交接客户后原销售仍可查看本人既有业务，但无联系人与私密客户资料',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
  assert.equal((await patch(f,admin,{note:'客户主档私密备注仅新负责人可见'})).status,200);
  const transferred=await patch(f,admin,{owner_id:3,reason:'仅维护交接',ownership_scope:'customer_only'});
  assert.equal(transferred.status,200);
  const S=await state(f,sales),c=S.customers.find(c=>c.id===1);
  assert.equal(c.shared,true);assert.ok(S.contracts.some(c=>c.customer_id===1));assert.ok(S.opportunities.some(o=>o.customer_id===1));
  assert.equal(S.contacts.some(p=>p.customer_id===1),false);
  const html=customerDetail(S,1),ownContract=S.contracts.find(c=>c.customer_id===1),ownOpp=S.opportunities.find(o=>o.customer_id===1);
  assert.match(html,/本人可见业务/);
  assert.ok(html.includes(ownContract.name));assert.ok(html.includes(ownOpp.name));
  assert.match(html,new RegExp('data-action="contract" data-id="'+ownContract.id+'"'));
  assert.doesNotMatch(html,/客户主档私密备注仅新负责人可见|示例联系人|data-action="edit-customer"|data-action="edit-contact"|data-action="new-contact"/);
  const totals=customerBusinessTotals(c,S.contracts);
  assert.equal(totals.amount,S.contracts.filter(row=>row.customer_id===1&&!row.retired_at&&!row.terminated_at&&row.lifecycle!=='草稿').reduce((sum,row)=>sum+row.amount,0));
});

test('普通编辑仅提交变动字段，旧缺联系方式与未定负责人不会被空值重写',()=>{
  const S={customers:[{id:1,owner_id:null,note:'旧备注',status:'潜在'}],contacts:[{id:2,name:'历史联系人',title:'旧职位',phone:null,wechat:null,dingtalk:null,last_contact:null,role:'使用人',attitude:'中立',archived_at:null,note:''}]};
  const before=JSON.stringify(S);
  const customerBody=customerEditPayload(S,'edit-customer',1,{owner_id:'3',reason:'',note:'新备注',management_status:'正常'});
  assert.deepEqual(customerBody,{note:'新备注'});
  const contactBody=customerEditPayload(S,'edit-contact',2,{name:'历史联系人',title:'新职位',phone:'',wechat:'',dingtalk:'',last_contact:'',role:'使用人',attitude:'中立',active:'true',note:''});
  assert.deepEqual(contactBody,{title:'新职位'});
  assert.equal(JSON.stringify(S),before);
});

test('仅客户交接带旧预览时并发拒绝，刷新核对后才能覆盖新的维护归属',async t=>{
  const f=await fixture(t),admin=await f.login(1),old=await preview(f,admin);
  const contracts=all(f.db,'SELECT id,owner_id FROM contracts WHERE customer_id=1 ORDER BY id');
  const concurrent=await patch(f,admin,{owner_id:1,reason:'另一位管理者已完成维护交接',ownership_scope:'customer_only'});
  assert.equal(concurrent.status,200);
  const stale=await patch(f,admin,{owner_id:3,reason:'本次交接仍使用过期预览',ownership_scope:'customer_only',transfer_preview_token:old.preview_token});
  assert.equal(stale.status,409);assert.equal(one(f.db,'SELECT owner_id FROM customers WHERE id=1').owner_id,1);
  assert.deepEqual(all(f.db,'SELECT id,owner_id FROM contracts WHERE customer_id=1 ORDER BY id'),contracts);
  const current=await preview(f,admin);assert.notEqual(current.preview_token,old.preview_token);
  const freshBody={owner_id:3,reason:'已重新核对新的维护负责人',ownership_scope:'customer_only',transfer_preview_token:current.preview_token};
  assert.equal((await patch(f,admin,freshBody)).status,200);
  assert.equal(one(f.db,'SELECT owner_id FROM customers WHERE id=1').owner_id,3);
  assert.equal((await patch(f,admin,freshBody)).status,409,'a stale form must not silently succeed when another request has reached the same target');
  assert.deepEqual(all(f.db,'SELECT id,owner_id FROM contracts WHERE customer_id=1 ORDER BY id'),contracts);
});

test('移交表单控制器正确切换确认状态，读取期间禁提交并只保留最新预览令牌',async t=>{
  const {mountCustomerForm}=await import('../public/modules/customer-controller.js');
  const f=await fixture(t),admin=await f.login(1),S=await state(f,admin),html=formCustomers(S,'customer-transfer',1,{});
  assert.match(html,/id="customer-transfer-preview"/);assert.match(html,/name="ownership_confirmed"/);assert.match(html,/name="transfer_preview_token"/);
  // DOM facade exercises the controller's native form/event contract without
  // adding a browser or DOM package to the application's Node test dependencies.
  const field=value=>Object.assign(new EventTarget(),{value});
  const label={hidden:true},confirm=Object.assign(field('on'),{checked:false,required:false,disabled:false,closest:()=>label});
  const box={innerHTML:''},submit={disabled:false};
  const form={dataset:{form:'customer-transfer',id:'1',previousOwner:'2'},isConnected:true,elements:{owner_id:field(''),ownership_scope:field('customer_only'),ownership_confirmed:confirm,transfer_preview_token:field('')},querySelector:selector=>selector==='#customer-transfer-preview'?box:selector==='[type="submit"]'?submit:null};
  const requests=[];
  mountCustomerForm(form,S,{api:url=>new Promise(resolve=>requests.push({url,resolve}))});
  assert.equal(submit.disabled,true);assert.equal(label.hidden,true);assert.equal(confirm.disabled,true);assert.equal(confirm.required,false);
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  const response=(token,can=true)=>({preview_token:token,can_transfer_linked:can,contracts:[],totals:{opportunities:1,contracts:1,contract_amount:100000,collected:30000}});
  form.elements.owner_id.value='3';form.elements.owner_id.dispatchEvent(new Event('change'));
  assert.equal(requests.length,1);assert.match(requests[0].url,/\/customers\/1\/transfer-preview\?owner_id=3$/);
  assert.equal(submit.disabled,true);assert.equal(form.elements.transfer_preview_token.value,'');
  requests[0].resolve(response('first-token'));await tick();
  assert.equal(form.elements.transfer_preview_token.value,'first-token');assert.equal(submit.disabled,false);assert.equal(label.hidden,true);
  form.elements.ownership_scope.value='linked_records';confirm.checked=true;form.elements.ownership_scope.dispatchEvent(new Event('change'));
  assert.equal(label.hidden,false);assert.equal(confirm.required,true);assert.equal(confirm.disabled,false);assert.equal(confirm.checked,false);
  form.elements.owner_id.value='1';form.elements.owner_id.dispatchEvent(new Event('change'));
  assert.equal(submit.disabled,true);assert.equal(form.elements.transfer_preview_token.value,'');
  form.elements.owner_id.value='3';form.elements.owner_id.dispatchEvent(new Event('change'));
  requests[2].resolve(response('latest-locked-token',false));await tick();
  assert.equal(form.elements.transfer_preview_token.value,'latest-locked-token');assert.equal(submit.disabled,true);
  requests[1].resolve(response('stale-response-token'));await tick();
  assert.equal(form.elements.transfer_preview_token.value,'latest-locked-token','slower outdated response must not replace the current target preview');
  form.elements.ownership_scope.value='customer_only';form.elements.ownership_scope.dispatchEvent(new Event('change'));
  assert.equal(label.hidden,true);assert.equal(confirm.required,false);assert.equal(confirm.disabled,true);assert.equal(submit.disabled,false,'historical business lock does not prevent maintenance-only handover');
});
