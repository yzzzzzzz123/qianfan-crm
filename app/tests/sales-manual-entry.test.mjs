import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,customer,archiveContract} from './helpers/fixture.mjs';
import {one,run} from '../server/database.mjs';
import {renderPage,formContent} from '../public/views.js';
import {manualChoices} from '../public/modules/manual-entry.js';

async function setup(t) {
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),other=await f.login(3);
  const pmId=Number(run(f.db,"INSERT INTO users(name,username,role,created_at) VALUES('隔离项目经理','manual_entry_pm','pm',datetime('now'))").lastInsertRowid);
  const pm=await f.login(pmId);
  const ownCustomer=await f.request('/customers',{actor:sales,method:'POST',body:customer({name:'手动录入客户',owner_id:2})});
  const otherCustomer=await f.request('/customers',{actor:other,method:'POST',body:customer({name:'其他销售客户',owner_id:3})});
  assert.equal(ownCustomer.status,200,JSON.stringify(ownCustomer.body));
  assert.equal(otherCustomer.status,200,JSON.stringify(otherCustomer.body));
  const contractBody={customer_id:ownCustomer.body.id,name:'手动录入合同',sign_date:'2026-10-01',order_type:'千帆',renewal_tag:'新签（自建）',payment_type:'千帆收款',items:[{name:'产品授权',kind:'标品',amount:1000,margin_rate:0.2}]};
  return {...f,admin,sales,other,pm,contractBody,otherCustomerId:otherCustomer.body.id};
}

test('销售可手动起草合同，收款登记仅管理员显示；PM不开放',async t=>{
  const f=await setup(t),S=(await f.request('/state',{actor:f.sales})).body;
  for(const [view,type] of [['contracts','contract']]) {
    const html=renderPage(S,{view});
    assert.equal((html.match(/data-action="new-contract"/g)||[]).length,1,view);
    assert.deepEqual(manualChoices(S,{view}).map(c=>c.type),[type]);
    const form=formContent(S,type,'');
    assert.match(form,new RegExp(`data-form="${type}"`));
    assert.doesNotMatch(form,/type="file"/);
  }
  assert.doesNotMatch(renderPage(S,{view:'collections'}),/data-action="manual-entry"/);
  assert.deepEqual(manualChoices(S,{view:'collections'}).map(x=>x.type),['payment']);
  assert.match(formContent(S,'payment',''),/data-form="payment"/);
  assert.doesNotMatch(formContent(S,'contract',''),/name="owner_id"/);
  const admin=(await f.request('/state',{actor:f.admin})).body;
  assert.match(formContent(admin,'contract',''),/name="owner_id"/);
  const pm=(await f.request('/state',{actor:f.pm})).body;
  for(const [view,type] of [['contracts','contract'],['collections','payment']]) {
    assert.doesNotMatch(renderPage(pm,{view}),/data-action="manual-entry"/);
    assert.match(formContent(pm,type,''),/无权手动录入/);
  }
});

test('销售手动起草本人合同可保存分类和明细，重复提交不重复入库；归属和归档受限',async t=>{
  const f=await setup(t),before=one(f.db,'SELECT count(*) n FROM contracts').n;
  const request={actor:f.sales,method:'POST',key:randomUUID(),body:f.contractBody};
  const created=await f.request('/contracts',request);
  assert.equal(created.status,200,JSON.stringify(created.body));
  const repeated=await f.request('/contracts',request);
  assert.equal(repeated.status,200,JSON.stringify(repeated.body));
  assert.equal(repeated.body.id,created.body.id);
  assert.equal(one(f.db,'SELECT count(*) n FROM contracts').n,before+1);
  const c=one(f.db,'SELECT * FROM contracts WHERE id=?',created.body.id);
  assert.equal(c.owner_id,2);assert.equal(c.lifecycle,'已归档');assert.equal(c.amount,100000);
  assert.equal(c.renewal_tag,'新签（自建）');assert.equal(c.payment_type,'千帆收款');
  assert.equal(one(f.db,'SELECT margin FROM contract_items WHERE contract_id=?',c.id).margin,20000);
  assert.equal(one(f.db,"SELECT count(*) n FROM audit WHERE entity='contract' AND entity_id=? AND user_id=2 AND action='创建合同'",c.id).n,1);
  for(const body of [
    {...f.contractBody,owner_id:3},
    {...f.contractBody,customer_id:f.otherCustomerId},
  ]) assert.equal((await f.request('/contracts',{actor:f.sales,method:'POST',body})).status,403);
  assert.equal((await f.request('/contracts',{actor:f.pm,method:'POST',body:f.contractBody})).status,403);
  assert.equal((await f.request(`/contracts/${c.id}/archive`,{actor:f.sales,method:'POST',body:{both_stamped:true}})).status,409);
  assert.equal(one(f.db,'SELECT count(*) n FROM contracts').n,before+1);
});

test('管理员登记实际到账保留草稿限制、金额、幂等；销售及PM无法写入',async t=>{
  const f=await setup(t);
  const draft=await f.request('/contracts',{actor:f.sales,method:'POST',body:f.contractBody});
  assert.equal(draft.status,200,JSON.stringify(draft.body));
  run(f.db,"UPDATE contracts SET lifecycle='草稿' WHERE id=?",draft.body.id);
  const payment={contract_id:draft.body.id,amount:100,status:'已到账',pay_date:'2026-10-02'};
  assert.equal((await f.request('/payments',{actor:f.admin,method:'POST',body:payment})).status,409);
  const S=(await f.request('/state',{actor:f.admin})).body;
  const onlyDrafts={...S,contracts:[S.contracts.find(c=>c.id===draft.body.id)]};
  assert.match(formContent(onlyDrafts,'payment',''),/请先新增合同/);
  assert.doesNotMatch(formContent(onlyDrafts,'payment',''),/data-form="payment"/);
  await archiveContract(f,f.admin,draft.body.id);
  const before=one(f.db,'SELECT count(*) n FROM payments').n;
  const request={actor:f.admin,method:'POST',key:randomUUID(),body:payment};
  const paid=await f.request('/payments',request);
  assert.equal(paid.status,200,JSON.stringify(paid.body));
  assert.equal((await f.request('/payments',request)).body.id,paid.body.id);
  const saved=one(f.db,'SELECT * FROM payments WHERE id=?',paid.body.id);
  assert.equal(saved.contract_id,draft.body.id);assert.equal(saved.amount,10000);assert.equal(saved.status,'已到账');
  assert.equal(one(f.db,'SELECT count(*) n FROM payments').n,before+1);
  const audit=one(f.db,"SELECT detail FROM audit WHERE entity='contract' AND entity_id=? AND user_id=1 AND action='登记实际到账'",draft.body.id);
  assert.equal(JSON.parse(audit.detail).payment_id,paid.body.id);
  for(const actor of [f.other,f.pm]) assert.equal((await f.request('/payments',{actor,method:'POST',body:payment})).status,403);
  assert.equal((await f.request('/payments',{actor:f.admin,method:'POST',body:{...payment,amount:1001}})).status,400);
  assert.equal((await f.request('/payments',{actor:f.admin,method:'POST',body:{...payment,pay_date:''}})).status,400);
  assert.equal(one(f.db,'SELECT count(*) n FROM payments').n,before+1);
  const updated=(await f.request('/state',{actor:f.admin})).body,own=updated.contracts.find(c=>c.id===draft.body.id);
  const form=formContent({...updated,contracts:[own,{...own,id:9999,name:'其他销售合同',owner_id:3},{...own,id:9998,name:'未归档草稿',lifecycle:'草稿'}]},'payment','');
  assert.match(form,new RegExp(`<option value="${own.id}"`));
  assert.match(form,/<option value="9999"/);
  assert.doesNotMatch(form,/<option value="9998"/);
});
