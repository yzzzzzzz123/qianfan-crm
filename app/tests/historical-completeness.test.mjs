import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';

test('历史合同缺明细时毛利未知，缺签约日不被算进当月签约',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const before=(await f.request('/state',{actor})).body;
  const inserted=f.db.prepare("INSERT INTO contracts(customer_id,owner_id,name,amount,sign_date,created_at,lifecycle,commission_policy) VALUES(1,1,'原表缺明细和签约日',1234500,'','2026-10-01','历史登记','pending')").run();
  const after=(await f.request('/state',{actor})).body;
  const c=after.contracts.find(c=>c.id===Number(inserted.lastInsertRowid));
  assert.equal(c.sign_date,'');assert.equal(c.items.length,0);assert.equal(c.margin_unknown,true);assert.equal(c.margin,null);
  assert.equal(after.team.find(u=>u.id===1).signed,before.team.find(u=>u.id===1).signed);
});
