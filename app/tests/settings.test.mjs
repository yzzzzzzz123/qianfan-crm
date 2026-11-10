import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/fixture.mjs";
import { formSettings } from "../public/modules/settings.js";
import {renderPage} from '../public/views.js';

test("M10-A01 新建销售通过已核验钉钉登录，停用后已建立会话失效", async (t) => {
  const f = await fixture(t,{identityProvider:{loginConfigured:true,identity:async()=>({unionId:'isolated-member-union',seconds:3600})}});
  const actor = await f.login(1);
  const r = await f.request("/users", {
    actor,
    method: "POST",
    body: { name: "验收销售", username: "case_sales", role: "sales",dingtalk_only:true,ding_user_id:'isolated-member-user',ding_union_id:'isolated-member-union' },
  });
  assert.equal(r.status, 200);
  const signed = await f.request("/auth/dingtalk/callback", {
    method: "POST",
    body: { code:'isolated-member-code' },
  });
  assert.equal(signed.status, 200);
  assert.equal(signed.body.actor.role, "sales");
  const member = {
    cookie: signed.cookie.split(";")[0],
    csrf: signed.body.csrf,
  };
  assert.equal((await f.request("/state", { actor: member })).status, 200);
  assert.equal(
    (
      await f.request(`/users/${r.body.id}`, {
        actor,
        method: "PATCH",
        body: { active: false },
      })
    ).status,
    200,
  );
  assert.equal((await f.request("/state", { actor: member })).status, 401);
});
test("M10-A02 成员创建拒绝未知角色、任何密码字段和重复账号", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const b = {
    name: "验收成员",
    username: "case_member",
    role: "sales",
    dingtalk_only:true,
  };
  for (const extra of [
    { role: "unknown" },
    { password: "short" },
    { username: "中文账号" },
  ])
    assert.equal(
      (
        await f.request("/users", {
          actor,
          method: "POST",
          body: { ...b, ...extra },
        })
      ).status,
      400,
    );
  assert.equal(
    (await f.request("/users", { actor, method: "POST", body: b })).status,
    200,
  );
  assert.equal(
    (await f.request("/users", { actor, method: "POST", body: b })).status,
    409,
  );
});

test("M10-A03 停用账号立即撤销会话，最后管理员与当前账号受保护", async (t) => {
  const f = await fixture(t);
  const admin = await f.login(1);
  const sales = await f.login(2);
  assert.equal(
    (
      await f.request("/users/2", {
        actor: admin,
        method: "PATCH",
        body: { active: false },
      })
    ).status,
    200,
  );
  assert.equal((await f.request("/state", { actor: sales })).status, 401);
  assert.equal(
    (
      await f.request("/users/1", {
        actor: admin,
        method: "PATCH",
        body: { active: false },
      })
    ).status,
    400,
  );
});

test("M10-A04 管理员规则与目标保存可回读，提成绩效按PRD启用", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(1);
  const before = (await f.request("/state", { actor })).body;
  assert.equal(
    (
      await f.request("/rules", {
        actor,
        method: "PATCH",
        body: {
          thresholds: { 线索: 2 },
          sop: { 线索: "先确认业务需求和预算窗口" },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/targets", {
        actor,
        method: "POST",
        body: { user_id: 2, quarter: before.quarter, amount: 1800000 },
      })
    ).status,
    200,
  );
  const after = (await f.request("/state", { actor })).body;
  assert.equal(after.rules.thresholds.线索, 2);
  assert.equal(after.rules.sop.线索, "先确认业务需求和预算窗口");
  assert.equal(after.rules.commission_visible, true);
  assert.equal(after.rules.result_visible, true);
  assert.equal(after.team.find((u) => u.id === 2).target, 180000000);
  assert.equal(
    (
      await f.request("/rules", {
        actor,
        method: "PATCH",
        body: { thresholds: { 线索: 0 } },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request("/state", { actor })).body.rules.thresholds.线索,
    2,
  );
});

test("退役毛利比例拒绝写入且整次规则变更回滚，历史原值与有效参数保留", async (t) => {
  const f=await fixture(t),actor=await f.login(1);
  const stored=()=>f.db.prepare("SELECT value FROM settings WHERE key='rules'").get().value;
  const before=stored(),previous=JSON.parse(before).commission;
  const revision=()=>f.db.prepare('SELECT revision FROM workspace_revision WHERE id=1').get().revision;
  const initialRevision=revision();
  const retired=['standard_self_new','standard_distributed_new','standard_renewal','implementation'];
  for(const key of retired) {
    const result=await f.request('/rules',{actor,method:'PATCH',body:{thresholds:{线索:1},commission:{high_rate:0.95,[key]:0.2}}});
    assert.equal(result.status,400);
    assert.match(result.body.error,/旧毛利比例已停用/);
    assert.equal(stored(),before,'被拒绝的旧配置不能同时保存其他参数');
    assert.equal(revision(),initialRevision);
  }
  const changed=await f.request('/rules',{actor,method:'PATCH',body:{commission:{threshold:100000000,low_rate:0.07,high_rate:0.08}}});
  assert.equal(changed.status,200,JSON.stringify(changed.body));
  const after=(await f.request('/state',{actor})).body;
  for(const key of retired)assert.equal(after.rules.commission[key],previous[key],'只保留历史原值，不删除或改写');
  assert.equal(after.rules.commission.threshold,100000000);
  assert.equal(after.rules.commission.low_rate,0.07);
  assert.equal(after.rules.commission.high_rate,0.08);
  assert.ok(after.commission.previews.length);
  for(const preview of after.commission.previews.filter(p=>p.scheme==='legacy'))assert.equal(preview.rate,preview.base>100000000?0.08:0.07);
});

test("提成结算内维护团队规则，不重复个人梯度或绩效配置", async (t) => {
  const f=await fixture(t),actor=await f.login(1),state=(await f.request('/state',{actor})).body;
  const page=renderPage(state,{view:'commissions'}),form=formSettings(state,'finance-rules');
  assert.match(page,/调整个人提成梯度/);assert.match(page,/调整团队提成规则/);
  assert.doesNotMatch(form,/rate:product|rate:service|performance:|service_aggregation/);
  for(const key of ['standard_self_new','standard_distributed_new','standard_renewal','implementation'])assert.ok(!form.includes('commission:'+key));
  for(const key of ['threshold','low_rate','high_rate','manager_id'])assert.ok(form.includes('commission:'+key));
  assert.doesNotMatch(form,/name="commission:(?:period|unlock_by_payment)"/);assert.match(form,/月度按其他销售的实际回款毛利/);
  const before=structuredClone(state.rules.commission.sales_policy);
  assert.equal((await f.request('/rules',{actor,method:'PATCH',body:{commission:{low_rate:0.04}}})).status,200);
  assert.deepEqual((await f.request('/state',{actor})).body.rules.commission.sales_policy,before);
});
