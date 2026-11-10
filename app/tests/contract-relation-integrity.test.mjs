import test from 'node:test';
import assert from 'node:assert/strict';
import { one, run } from '../server/database.mjs';
import { fixture, contract } from './helpers/fixture.mjs';

test('合同关联客户与商机冲突时拒绝并保留全部业务记录', async t => {
  const f = await fixture(t), actor = await f.login(1);
  const opportunity = one(f.db, 'SELECT * FROM opportunities WHERE id=1');
  const otherCustomer = one(f.db, 'SELECT id FROM customers WHERE id!=? LIMIT 1', opportunity.customer_id);
  const before = {
    contracts: one(f.db, 'SELECT COUNT(*) n FROM contracts').n,
    items: one(f.db, 'SELECT COUNT(*) n FROM contract_items').n,
    history: one(f.db, 'SELECT COUNT(*) n FROM stage_history').n,
  };
  const response = await f.request('/contracts', {
    actor, method: 'POST', body: contract(opportunity.id, { customer_id: otherCustomer.id }),
  });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /客户.*不一致/);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM contracts').n, before.contracts);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM contract_items').n, before.items);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM stage_history').n, before.history);
  assert.equal(one(f.db, 'SELECT stage FROM opportunities WHERE id=?', opportunity.id).stage, opportunity.stage);

  const valid = await f.request('/contracts', {
    actor, method: 'POST', body: contract(opportunity.id, { customer_id: String(opportunity.customer_id) }),
  });
  assert.equal(valid.status, 200);
  assert.equal(one(f.db, 'SELECT customer_id FROM contracts WHERE id=?', valid.body.id).customer_id, opportunity.customer_id);
});

test('历史来源商机直接维护本地合同草稿；停用同步不能覆盖本地进展', async t => {
  const f = await fixture(t), actor = await f.login(1);
  run(f.db,"UPDATE opportunities SET reference='SJ202610901' WHERE id=1");
  const original=one(f.db,'SELECT * FROM opportunities WHERE id=1');
  const created=await f.request('/contracts',{actor,method:'POST',body:contract(1)});
  assert.equal(created.status,200);
  assert.equal(one(f.db,'SELECT stage FROM opportunities WHERE id=1').stage,'赢单');
  assert.equal(one(f.db,'SELECT lifecycle FROM contracts WHERE id=?',created.body.id).lifecycle,'已归档');
  const count=one(f.db,'SELECT COUNT(*) n FROM activities').n;
  const retired=await f.request('/integrations/ppl/import',{actor,method:'POST',body:{customers:[],opportunities:[{ppl_ref:original.reference,stage:'赢单',amount:1}]}});
  assert.equal(retired.status,410);
  assert.equal(one(f.db,'SELECT amount FROM opportunities WHERE id=1').amount,10000000);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM activities').n,count);
  assert.equal((await f.request('/contracts',{actor,method:'POST',body:contract(1)})).status,409);
});
