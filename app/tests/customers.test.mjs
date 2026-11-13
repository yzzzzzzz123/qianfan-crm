import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, customer } from "./helpers/fixture.mjs";

test("M02-A01 新增联系人可回读角色态度，他人销售不能维护", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const r = await f.request("/contacts", {
    actor,
    method: "POST",
    body: {
      customer_id: 1,
      name: "验收联系人",
      title: "采购负责人",
      role: "决策人",
      attitude: "支持",
      phone: "测试号码",
    },
  });
  assert.equal(r.status, 200);
  const state = (await f.request("/state", { actor })).body;
  assert.equal(state.contacts.find((c) => c.id === r.body.id).role, "决策人");
  assert.equal(state.contacts.find((c) => c.id === r.body.id).attitude, "支持");
  assert.equal(
    (
      await f.request("/contacts", {
        actor,
        method: "POST",
        body: { customer_id: 2, name: "越权", role: "决策人" },
      })
    ).status,
    403,
  );
});

test("M02-A02 销售可更新本人客户档案，不能自行改归属", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  assert.equal(
    (
      await f.request("/customers/1", {
        actor,
        method: "PATCH",
        body: { industry: "测试行业", manual_level: "C", note: "业务备注中文" },
      })
    ).status,
    200,
  );
  const c = (await f.request("/state", { actor })).body.customers.find(
    (c) => c.id === 1,
  );
  assert.equal(c.industry, "测试行业");
  assert.equal(c.manual_level, "C");
  assert.equal(c.note, "业务备注中文");
  assert.equal(
    (
      await f.request("/customers/1", {
        actor,
        method: "PATCH",
        body: { owner_id: 3, reason: "越权调整" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/state", { actor })).body.customers.find(
      (c) => c.id === 1,
    ).owner_id,
    2,
  );
});

test("M02-A03 中文客户创建后可回读，重复客户与信用代码被拒绝", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const r = await f.request("/customers", {
    actor,
    method: "POST",
    body: customer({ credit_code: "DEMO-ONLY-123" }),
  });
  assert.equal(r.status, 200);
  const state = (await f.request("/state", { actor })).body;
  assert.equal(
    state.customers.find((c) => c.id === r.body.id).name,
    "核验客户有限公司",
  );
  assert.equal(
    (await f.request("/customers", { actor, method: "POST", body: customer() }))
      .status,
    409,
  );
  assert.equal(
    (
      await f.request("/customers", {
        actor,
        method: "POST",
        body: customer({ name: "另一个客户", credit_code: "DEMO-ONLY-123" }),
      })
    ).status,
    409,
  );
});

test("疑似同名返回可确认的冲突，勾选后可用原操作编号重试", async (t) => {
  const f = await fixture(t);
  const admin = await f.login(1);
  const actor = await f.login(2);
  const existingName = "深圳蓝海数字科技有限公司";
  const body = { name: "深圳蓝海数智科技有限公司" };
  const key = randomUUID();
  const create = (data) => f.request("/customers", { actor, method: "POST", body: data, key });

  assert.equal((await f.request("/customers", {
    actor: admin, method: "POST", body: customer({ name: existingName }),
  })).status, 200);
  const conflict = await create(body);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "CUSTOMER_SIMILAR_NAME");
  assert.ok(conflict.body.error.includes(existingName));

  const confirmed = { ...body, duplicate_ack: true };
  const saved = await create(confirmed);
  assert.equal(saved.status, 200);
  assert.equal((await create(confirmed)).body.id, saved.body.id);
  const state = (await f.request("/state", { actor })).body;
  assert.equal(state.customers.find(c => c.id === saved.body.id).owner_id, 2);
});

test("M02-A04 明确核对后连带移交业务，并撤销原销售可见范围", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const preview = await f.request("/customers/1/transfer-preview?owner_id=3", { actor });
  assert.equal(preview.status, 200);
  assert.equal(
    (
      await f.request("/customers/1", {
        actor,
        method: "PATCH",
        body: { owner_id: 3, reason: "分工调整", ownership_scope: "linked_records", ownership_confirmed: true, transfer_preview_token: preview.body.preview_token },
      })
    ).status,
    200,
  );
  const sales = await f.login(2);
  const s = (await f.request("/state", { actor: sales })).body;
  assert.ok(!s.opportunities.some((o) => o.customer_id === 1));
  assert.ok(!s.contracts.some((c) => c.customer_id === 1));
  assert.equal(s.customers.find((c) => c.id === 1).shared, true);
});
