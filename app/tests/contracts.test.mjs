import test from "node:test";
import assert from "node:assert/strict";
import { one } from "../server/database.mjs";
import { fixture, contract,archiveContract } from "./helpers/fixture.mjs";
import { today } from "../server/domain.mjs";

test("M06-A01 手工混合合同按行项合计，未知毛利留空，不额外创建商机", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const before = (await f.request("/state", { actor })).body;
  const r = await f.request("/contracts", {
    actor,
    method: "POST",
    body: {
      customer_id: 1,
      name: "混合合同验收",
      sign_date: today(),
      items: [
        { name: "标品授权", kind: "标品", amount: 60000 },
        { name: "实施服务", kind: "实施", amount: 40000 },
      ],
    },
  });
  assert.equal(r.status, 200);
  const s = (await f.request("/state", { actor })).body;
  const c = s.contracts.find((c) => c.id === r.body.id);
  assert.equal(c.amount, 10000000);
  assert.equal(c.items.find(i=>i.kind==='标品').margin,null);assert.equal(c.items.find(i=>i.kind==='实施').margin,4000000);assert.ok(c.items.every(i=>i.rate===null));
  assert.equal(c.lifecycle,'已归档');
  assert.equal(c.opportunity_id, null);
  assert.equal(s.opportunities.length, before.opportunities.length);
});

test("M06-A02 履约状态与行项日期可维护，毛利改判必须给理由并留审计", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const old = one(f.db, "SELECT * FROM contract_items WHERE id=1");
  assert.equal(
    (
      await f.request("/items/1", {
        actor,
        method: "PATCH",
        body: { margin: 10000 },
      })
    ).status,
    400,
  );
  assert.equal(
    one(f.db, "SELECT margin FROM contract_items WHERE id=1").margin,
    old.margin,
  );
  assert.equal(
    (
      await f.request("/items/1", {
        actor,
        method: "PATCH",
        body: {
          margin: 10000,
          reason: "确认实际成本",
          payment_date: today(),
          valid_until: "2027-10-23",
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/contracts/1", {
        actor,
        method: "PATCH",
        body: { project_status: "已验收未结算", scope: "验收范围已确认" },
      })
    ).status,
    200,
  );
  const s = (await f.request("/state", { actor })).body;
  const c = s.contracts.find((c) => c.id === 1);
  assert.equal(c.project_status, "已验收未结算");
  assert.equal(c.items.find((i) => i.id === 1).margin, 1000000);
  assert.equal(c.items.find((i) => i.id === 1).payment_date, today());
  assert.equal(c.amount, 51700000);
  assert.ok(
    s.audit.some(
      (a) =>
        a.action === "更新合同行项" &&
        JSON.parse(a.detail).reason === "确认实际成本",
    ),
  );
});

test("M06-A03 创建草稿后明确归档盖章合同才赢单，并防止重复合同", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const r = await f.request("/contracts", {
    actor,
    method: "POST",
    body: contract(1),
  });
  assert.equal(r.status, 200);
  await archiveContract(f,actor,r.body.id);
  const s = (await f.request("/state", { actor })).body;
  const c = s.contracts.find((c) => c.id === r.body.id);
  assert.equal(c.amount, 10000000);
  assert.equal(c.items[0].margin, null);
  assert.equal(s.opportunities.find((o) => o.id === 1).stage, "赢单");
  assert.equal(s.customers.find((c) => c.id === 3).status, "成交");
  assert.ok(
    s.activities.some(
      (a) => a.opportunity_id === 1 && a.source === "系统里程碑",
    ),
  );
  assert.equal(
    (
      await f.request("/contracts", {
        actor,
        method: "POST",
        body: contract(1),
      })
    ).status,
    409,
  );
});

test("M06-A04 多表关联写入失败时整体回滚，不留下半套合同", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const before = one(f.db, "SELECT COUNT(*) n FROM contracts").n;
  f.db.exec(
    "CREATE TRIGGER reject_audit BEFORE INSERT ON audit WHEN NEW.action='创建合同' BEGIN SELECT RAISE(ABORT,'test audit failure'); END;",
  );
  const r = await f.request("/contracts", {
    actor,
    method: "POST",
    body: contract(1),
  });
  assert.equal(r.status, 500);
  assert.equal(one(f.db, "SELECT COUNT(*) n FROM contracts").n, before);
  assert.equal(
    one(f.db, "SELECT stage FROM opportunities WHERE id=1").stage,
    "商务",
  );
  assert.equal(
    one(f.db, "SELECT status FROM customers WHERE id=3").status,
    "潜在",
  );
});
