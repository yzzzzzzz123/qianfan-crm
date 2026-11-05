import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/fixture.mjs";
import { dateAdd } from "../server/domain.mjs";

test("M05-A01 登记报价保存金额有效期并进入过程计数，不自动改变阶段", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const before = (await f.request("/state", { actor })).body;
  const r = await f.request("/quotes", {
    actor,
    method: "POST",
    body: {
      opportunity_id: 1,
      amount: 9800,
      items: [{ name:'产品授权',kind:'标品',quantity:1,list_price:10000,discount_rate:0.98 }],
      valid_until: dateAdd(15),
      note: "报价说明",
    },
  });
  assert.equal(r.status, 200);
  const s = (await f.request("/state", { actor })).body;
  const q = s.quotes.find((q) => q.id === r.body.id);
  assert.equal(q.amount, 980000);
  assert.equal(q.list_amount, 1000000);
  assert.equal(q.discount_amount, 20000);
  assert.equal(q.items.length, 1);
  assert.equal(q.valid_until, dateAdd(15));
  assert.equal(q.note, "报价说明");
  assert.ok(q.code.startsWith("BJ"));
  assert.equal(s.team[0].process.quote, before.team[0].process.quote + 1);
  assert.equal(
    s.opportunities.find((o) => o.id === 1).stage,
    before.opportunities.find((o) => o.id === 1).stage,
  );
});
test("M05-A02 他人商机报价与非法有效日期被拒绝", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const b = { opportunity_id: 3, items: [{name:'实施服务',kind:'实施',quantity:1,list_price:10000,discount_rate:1}], valid_until: dateAdd(15) };
  assert.equal(
    (await f.request("/quotes", { actor, method: "POST", body: b })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/quotes", {
        actor,
        method: "POST",
        body: { ...b, opportunity_id: 1, valid_until: "2026-02-31" },
      })
    ).status,
    400,
  );
});
