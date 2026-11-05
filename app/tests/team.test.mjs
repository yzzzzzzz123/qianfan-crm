import test from "node:test";
import assert from "node:assert/strict";
import { today, now, processScore } from "../server/domain.mjs";
import { fixture } from "./helpers/fixture.mjs";

test("M08-A01 目标配置拒绝错误季度、负金额与非销售对象", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const s = (await f.request("/state", { actor })).body;
  for (const extra of [{ quarter: "2026Q9" }, { amount: -1 }, { user_id: 1 }])
    assert.equal(
      (
        await f.request("/targets", {
          actor,
          method: "POST",
          body: { user_id: 2, quarter: s.quarter, amount: 1500000, ...extra },
        })
      ).status,
      400,
    );
  assert.equal(
    (await f.request("/state", { actor })).body.team.find((u) => u.id === 2)
      .target,
    150000000,
  );
});

test("M08-A02 过程计分在9800与50000元边界正确，原始分封顶50并折算70", () => {
  const month = today().slice(0, 7);
  const opps = [980000, 5000000, 5000001].map((amount, i) => ({
    id: i + 1,
    owner_id: 2,
    amount,
    created_at: now(),
  }));
  assert.equal(processScore(opps, [], [], 2, month).raw, 7);
  const visits = Array.from({ length: 100 }, () => ({
    opportunity_id: 1,
    activity_date: today(),
    activity_type: "现场拜访",
  }));
  const score = processScore(opps, visits, [], 2, month);
  assert.equal(score.raw, 50);
  assert.equal(score.weighted, 70);
});
