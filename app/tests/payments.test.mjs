import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { one } from "../server/database.mjs";
import { today } from "../server/domain.mjs";
import { fixture } from "./helpers/fixture.mjs";

test("M07-A01 销售不能确认回款计划，拒绝后计划与余额不变", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const before = one(
    f.db,
    "SELECT * FROM payments WHERE contract_id=1 AND status!='已到账'",
  );
  assert.equal(
    (
      await f.request(`/payments/${before.id}/receive`, {
        actor,
        method: "POST",
        body: { pay_date: today() },
      })
    ).status,
    403,
  );
  assert.equal(
    one(f.db, "SELECT status FROM payments WHERE id=?", before.id).status,
    before.status,
  );
  assert.equal(
    (await f.request("/state", { actor })).body.contracts.find(
      (c) => c.id === 1,
    ).outstanding,
    8000000,
  );
});

test("M07-A02 回款重复提交只写一笔，内容冲突和超额到账被拒绝", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const key = randomUUID();
  const body = {
    contract_id: 1,
    amount: 10000,
    status: "已到账",
    pay_date: today(),
  };
  const a = await f.request("/payments", { actor, method: "POST", body, key });
  const b = await f.request("/payments", { actor, method: "POST", body, key });
  assert.equal(a.body.id, b.body.id);
  assert.equal(
    one(f.db, "SELECT COUNT(*) n FROM payments WHERE id=?", a.body.id).n,
    1,
  );
  assert.equal(
    (
      await f.request("/payments", {
        actor,
        method: "POST",
        body: { ...body, amount: 20000 },
        key,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("/payments", {
        actor,
        method: "POST",
        body: { ...body, amount: 80000 },
      })
    ).status,
    400,
  );
});

test("M07-A03 确认既有计划到账更新余额，重复确认不重复计入", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const p = one(
    f.db,
    "SELECT * FROM payments WHERE contract_id=2 AND status='逾期'",
  );
  assert.equal(
    (
      await f.request(`/payments/${p.id}/receive`, {
        actor,
        method: "POST",
        body: { pay_date: today() },
      })
    ).status,
    200,
  );
  const c = (await f.request("/state", { actor })).body.contracts.find(
    (c) => c.id === 2,
  );
  assert.equal(c.outstanding, 0);
  assert.equal(
    (
      await f.request(`/payments/${p.id}/receive`, {
        actor,
        method: "POST",
        body: { pay_date: today() },
      })
    ).status,
    409,
  );
});
