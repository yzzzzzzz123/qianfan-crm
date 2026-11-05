import test from "node:test";
import assert from "node:assert/strict";
import { fixture, opp } from "./helpers/fixture.mjs";
import { dateAdd } from "../server/domain.mjs";

test("M03-A01 推进阶段留里程碑，输单原因必填且结束后不可直接重开", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  assert.equal(
    (
      await f.request("/opportunities/8", {
        actor,
        method: "PATCH",
        body: { stage: "需求" },
      })
    ).status,
    200,
  );
  let s = (await f.request("/state", { actor })).body;
  assert.ok(
    s.activities.some(
      (a) =>
        a.opportunity_id === 8 &&
        a.activity_type === "系统" &&
        a.summary.includes("需求"),
    ),
  );
  assert.equal(
    (
      await f.request("/opportunities/8", {
        actor,
        method: "PATCH",
        body: { stage: "输单" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request("/state", { actor })).body.opportunities.find(
      (o) => o.id === 8,
    ).stage,
    "需求",
  );
  assert.equal(
    (
      await f.request("/opportunities/8", {
        actor,
        method: "PATCH",
        body: { stage: "输单", lost_reason: "客户预算暂停" },
      })
    ).status,
    200,
  );
  s = (await f.request("/state", { actor })).body;
  assert.equal(
    s.opportunities.find((o) => o.id === 8).lost_reason,
    "客户预算暂停",
  );
  assert.equal(
    (
      await f.request("/opportunities/8", {
        actor,
        method: "PATCH",
        body: { stage: "线索" },
      })
    ).status,
    400,
  );
});

test("M03-A02 同时创建商机编号唯一，销售不能借字段指定其他负责人", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const results = await Promise.all(
    [1, 2].map((i) =>
      f.request("/opportunities", {
        actor,
        method: "POST",
        body: opp(1, {
          name: "并发编号验收" + i,
          owner_id: 3,
          follow_date: dateAdd(2),
        }),
      }),
    ),
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.notEqual(results[0].body.id, results[1].body.id);
  const s = (await f.request("/state", { actor })).body;
  const list = s.opportunities.filter((o) =>
    results.some((r) => r.body.id === o.id),
  );
  assert.equal(new Set(list.map((o) => o.code)).size, 2);
  assert.ok(list.every((o) => o.owner_id === 2));
});

test("M03-A03 金额、日期与阶段在服务端校验，拒绝非法输入", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  for (const data of [
    { amount: -1 },
    { amount: "12.123" },
    { amount: "abc" },
    { follow_date: "2026-02-31" },
    { stage: "不存在" },
    { stage: "赢单" },
  ]) {
    const r = await f.request("/opportunities", {
      actor,
      method: "POST",
      body: opp(1, { owner_id: 2, ...data }),
    });
    assert.equal(r.status, 400, JSON.stringify(data));
  }
});
