import test from "node:test";
import assert from "node:assert/strict";
import { fixture, customer } from "./helpers/fixture.mjs";
import { today } from "../server/domain.mjs";

test("M09-A01 看板数据源只计实际到账，新增回款后余额和合计一致", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const before = (await f.request("/state", { actor })).body;
  assert.equal(
    before.opportunities
      .filter((o) => !["赢单", "输单", "搁置"].includes(o.stage))
      .reduce((s, o) => s + o.amount, 0),
    123800000,
  );
  assert.equal(
    before.contracts.reduce((s, c) => s + c.collected, 0),
    69700000,
  );
  assert.equal(
    (
      await f.request("/payments", {
        actor,
        method: "POST",
        body: {
          contract_id: 1,
          amount: 10000,
          status: "已到账",
          pay_date: today(),
        },
      })
    ).status,
    200,
  );
  const after = (await f.request("/state", { actor })).body;
  assert.equal(
    after.contracts.reduce((s, c) => s + c.collected, 0),
    70700000,
  );
  assert.equal(after.contracts.find((c) => c.id === 1).outstanding, 7000000);
  assert.ok(
    after.contracts.every((c) => c.amount === c.collected + c.outstanding),
  );
});
test("M09-A02 管理员能追溯新操作，销售读取不暴露团队审计", async (t) => {
  const f = await fixture(t);
  const admin = await f.login(1);
  const created = await f.request("/customers", {
    actor: admin,
    method: "POST",
    body: customer(),
  });
  const s = (await f.request("/state", { actor: admin })).body;
  const event = s.audit.find(
    (a) =>
      a.entity === "customer" &&
      a.entity_id === created.body.id &&
      a.action === "创建客户",
  );
  assert.ok(event);
  assert.equal(event.user_name, "王宏");
  assert.equal(JSON.parse(event.detail).name, "核验客户有限公司");
  const sales = await f.login(2);
  assert.deepEqual(
    (await f.request("/state", { actor: sales })).body.audit,
    [],
  );
});
