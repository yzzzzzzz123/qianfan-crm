import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { run } from "../server/database.mjs";
import { now } from "../server/domain.mjs";
import { fixture, customer } from "./helpers/fixture.mjs";

test("M01-A01 退出与会话过期后原Cookie不能继续访问", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  assert.equal(
    (await f.request("/auth/logout", { actor, method: "POST", body: {} }))
      .status,
    200,
  );
  assert.equal((await f.request("/state", { actor })).status, 401);
  const again = await f.login(1);
  run(f.db, "UPDATE sessions SET expires=?", Date.now() - 1);
  assert.equal((await f.request("/state", { actor: again })).status, 401);
});

test("M01-A02 连续错误登录达到限制后返回429", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await f.request("/auth/login", {
          method: "POST",
          body: { demo_user_id:9999 },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await f.request("/auth/login", {
        method: "POST",
        body: { demo_user_id:9999 },
      })
    ).status,
    429,
  );
});

test("M01-A03 未登录与伪造 x-user-id 均不能读取业务数据", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/state")).status, 401);
  assert.equal(
    (await f.request("/state", { headers: { "x-user-id": "1" } })).status,
    401,
  );
});

test("M01-A04 销售读取本人商机合同，其他客户仅返回共享字段", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const r = await f.request("/state", { actor });
  assert.equal(r.status, 200);
  assert.ok(r.body.opportunities.every((o) => o.owner_id === 2));
  assert.ok(r.body.contracts.every((c) => c.owner_id === 2));
  assert.equal(r.body.audit.length, 0);
  const c = r.body.customers.find((c) => c.owner_id === 3);
  assert.equal(c.shared, true);
  assert.equal(c.note, undefined);
  assert.ok(
    r.body.contacts.every(
      (p) =>
        r.body.customers.find((c) => c.id === p.customer_id).owner_id === 2,
    ),
  );
  assert.equal(r.body.users[0].password, undefined);
});

test("M01-A05 销售不能修改他人商机，也不能登记回款和修改规则", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  assert.equal(
    (
      await f.request("/opportunities/3", {
        actor,
        method: "PATCH",
        body: { next_action: "越权" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/payments", {
        actor,
        method: "POST",
        body: { contract_id: 2, amount: 1 },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/rules", {
        actor,
        method: "PATCH",
        body: { thresholds: { 线索: 2 } },
      })
    ).status,
    403,
  );
});

test("M01-A06 写入要求 CSRF 与同源请求，非法 JSON 被拒绝", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  assert.equal(
    (
      await f.request("/customers", {
        actor,
        method: "POST",
        body: customer(),
        headers: { "X-CSRF-Token": "fake" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/customers", {
        actor,
        method: "POST",
        body: customer(),
        headers: { Origin: "https://other.example" },
      })
    ).status,
    403,
  );
  const r = await fetch(f.base + "/api/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(r.status, 400);
});

test("M01-A07 生产仅允许核验后的钉钉身份，不开放演示或密码登录", async (t) => {
  const f = await fixture(t, { demo: false,identityProvider:{loginConfigured:true,identity:async()=>({unionId:'isolated-admin-union',seconds:3600})} });
  run(
    f.db,
    "INSERT INTO users(name,username,role,created_at) VALUES(?,?,?,?)",
    "管理员",
    "admin",
    "admin",
    now(),
  );
  run(f.db,'INSERT INTO ding_identities VALUES(1,?)','isolated-admin-union');
  const options = await f.request("/auth/options");
  assert.equal(options.body.demo, false);
  assert.equal(options.body.users.length, 0);
  assert.equal(
    (
      await f.request("/auth/login", {
        method: "POST",
        body: { demo_user_id: 1 },
      })
    ).status,
    403,
  );
  const r = await f.request("/auth/login", {
    method: "POST",
    body: { username: "admin", password: "test-only-long-password" },
  });
  assert.equal(r.status,403);
  const signed=await f.request('/auth/dingtalk/callback',{method:'POST',body:{code:'isolated-server-verified-code'}});
  assert.equal(signed.status,200);
  assert.ok(signed.cookie.includes('HttpOnly'));assert.ok(signed.cookie.includes('SameSite=Lax'));
  assert.ok(!f.db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='password'));
});

test('M01-A09 关闭钉钉开关或尚未配置钉钉也不能开放正式账号本地登录',async t=>{
  const previous=process.env.DINGTALK_ONLY;process.env.DINGTALK_ONLY='false';
  t.after(()=>{if(previous===undefined)delete process.env.DINGTALK_ONLY;else process.env.DINGTALK_ONLY=previous;});
  const f=await fixture(t,{demo:false,identityProvider:{loginConfigured:false}});
  run(f.db,'INSERT INTO users(name,username,role,created_at) VALUES(?,?,?,?)','隔离管理员','isolated-admin','admin',now());
  for(const body of [{demo_user_id:1},{username:'isolated-admin',password:'isolated-unused-value'}]){
    assert.equal((await f.request('/auth/login',{method:'POST',body})).status,403);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
});

test("M01-A08 演示入口不能指向正式账号库，生产环境不能启动演示库", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "qf-mode-"));
  try {
    const filename = path.join(folder, "formal.sqlite");
    const formal = createApp({ filename });
    run(
      formal.db,
      "INSERT INTO users(name,username,role,created_at) VALUES(?,?,?,?)",
      "管理员",
      "admin",
      "admin",
      now(),
    );
    formal.db.close();
    assert.throws(() => createApp({ filename, demo: true }), /禁止开启演示/);
    const demoPath = path.join(folder, "demo.sqlite");
    const demo = createApp({ filename: demoPath, demo: true });
    demo.db.close();
    assert.throws(
      () => createApp({ filename: demoPath, secure: true }),
      /不能作为生产/,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
