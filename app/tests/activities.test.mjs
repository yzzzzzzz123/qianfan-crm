import test from "node:test";
import assert from "node:assert/strict";
import { today, dateAdd } from "../server/domain.mjs";
import { fixture } from "./helpers/fixture.mjs";

test("M04-A01 未来跟进、空摘要与未知类型被拒绝且不留下记录", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const before = (await f.request("/state", { actor })).body.activities.length;
  for (const extra of [
    { activity_date: dateAdd(1) },
    { summary: "" },
    { activity_type: "虚构类型" },
  ]) {
    assert.equal(
      (
        await f.request("/activities", {
          actor,
          method: "POST",
          body: {
            opportunity_id: 1,
            activity_type: "手动跟进",
            activity_date: today(),
            summary: "有效摘要",
            ...extra,
          },
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (await f.request("/state", { actor })).body.activities.length,
    before,
  );
});

test("M04-A02 跟进同日同人同源归并，下一步同步且原始内容保留", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const a = {
    opportunity_id: 1,
    activity_type: "线上会议",
    activity_date: today(),
    summary: "第一次确认",
    action: "下周确认合同",
    follow_date: dateAdd(3),
  };
  const r1 = await f.request("/activities", { actor, method: "POST", body: a });
  const r2 = await f.request("/activities", {
    actor,
    method: "POST",
    body: { ...a, summary: "第二次补充" },
  });
  assert.equal(r1.body.id, r2.body.id);
  const s = (await f.request("/state", { actor })).body;
  assert.ok(s.activities.find((a) => a.id === r1.body.id).summary.endsWith('第一次确认\n第二次补充'));
  assert.equal(
    s.opportunities.find((o) => o.id === 1).next_action,
    "下周确认合同",
  );
  assert.equal(s.team.find((u) => u.id === 2).process.meeting, 2);
});
