import test from 'node:test';
import assert from 'node:assert/strict';
import { one, run } from '../server/database.mjs';
import { fixture } from './helpers/fixture.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('停用PPL拉取在网络调用前拒绝，不触发外部读取或写入', async t => {
  let calls=0;
  const identityProvider = {
    loginConfigured: false, pplConfigured: true,
    pull: async () => { calls++; throw new Error('retired route must not call provider'); },
  };
  const f = await fixture(t, { identityProvider });
  const actor = await f.login(1);
  const customerCount=one(f.db,'SELECT COUNT(*) n FROM customers').n;
  const result = await f.request('/integrations/ppl/pull', { actor, method: 'POST', body: {} });
  assert.equal(result.status, 410);
  assert.match(result.body.error, /PPL.*停用/);
  assert.equal(calls,0);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM customers').n,customerCount);
  assert.equal(one(f.db,"SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='sync_runs'").n,0);
});

test('AI解析期间退出登录后不保存草稿或附件，重新登录可正常重试', async t => {
  const started = deferred(), reply = deferred();
  const prepared = {
    summary: '独立权限校验资料', questions: [], model: 'isolated-test', usage: {},
    operations: [{ type: 'customer', action: 'create', ref: 'customer1', data: { name: '解析权限校验客户', owner_id: 2 }, source_file: '独立资料.md' }],
  };
  const aiProvider = {
    configured: true, model: 'isolated-test',
    prepare: async () => { started.resolve(); return reply.promise; },
  };
  const f = await fixture(t, { aiProvider }), actor = await f.login(1);
  const body = { text: '权限竞态隔离资料', files: [{ name: '独立资料.md', base64: Buffer.from('解析权限校验客户').toString('base64') }] };
  const pending = f.request('/ai/intake', { actor, method: 'POST', body });
  await started.promise;
  assert.equal((await f.request('/auth/logout', { actor, method: 'POST', body: {} })).status, 200);
  reply.resolve(prepared);
  const result = await pending;
  assert.equal(result.status, 401);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM ai_import_batches').n, 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM ai_uploads').n, 0);
  assert.equal(one(f.db, "SELECT COUNT(*) n FROM customers WHERE name='解析权限校验客户'").n, 0);
  aiProvider.prepare = async () => prepared;
  const current = await f.login(1);
  const retry = await f.request('/ai/intake', { actor: current, method: 'POST', body });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.valid, true);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM ai_import_batches').n, 1);
});

test('商机归属调整的必填原因写入审计记录', async t => {
  const f = await fixture(t), actor = await f.login(1);
  const opportunity = one(f.db, 'SELECT * FROM opportunities WHERE id=1');
  const nextOwner = opportunity.owner_id === 2 ? 3 : 2;
  const reason = '客户业务线调整，负责人经管理者确认后移交';
  const result = await f.request('/opportunities/1', { actor, method: 'PATCH', body: { owner_id: nextOwner, reason } });
  assert.equal(result.status, 200);
  assert.equal(one(f.db, 'SELECT owner_id FROM opportunities WHERE id=1').owner_id, nextOwner);
  const audit = one(f.db, "SELECT detail FROM audit WHERE action='更新商机' AND entity_id=1 ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(audit.detail).reason, reason);
});

test('开发者解析期间所选成员被停用时阻止落库，保留实际登录会话', async t => {
  const started = deferred(), reply = deferred();
  const aiProvider = {
    configured: true, model: 'isolated-test',
    prepare: async () => { started.resolve(); return reply.promise; },
  };
  const f = await fixture(t, {
    localIdentitySwitch: true, aiProvider,
    identityProvider: { loginConfigured: true, identity: async () => ({ unionId: 'async-test-developer', seconds: 3600 }) },
  });
  run(f.db, "INSERT INTO users(id,name,username,role,developer_admin,business_member,performance_enabled,created_at) VALUES(4,'隔离开发者','async_test_developer','admin',1,0,0,?)", new Date().toISOString());
  run(f.db, 'INSERT INTO ding_identities VALUES(?,?)', 4, 'async-test-developer');
  const login = await f.request('/auth/dingtalk/callback', { method: 'POST', body: { code: 'isolated-test-code' } });
  assert.equal(login.status, 200);
  const operator = { cookie: login.cookie.split(';')[0], csrf: login.body.csrf };
  const admin = await f.login(1);
  const pending = f.request('/ai/intake', {
    actor: operator, method: 'POST', headers: { 'X-CRM-Act-As': '2' }, body: { text: '模拟成员权限变化校验' },
  });
  await started.promise;
  const disabled = await f.request('/users/2', { actor: admin, method: 'PATCH', body: { active: false } });
  reply.resolve({
    summary: '模拟成员权限变化', questions: [], model: 'isolated-test', usage: {},
    operations: [{ type: 'customer', action: 'create', ref: 'customer1', data: { name: '失效模拟成员客户', owner_id: 2 } }],
  });
  assert.equal(disabled.status, 200);
  const response = await pending;
  assert.equal(response.status, 403);
  assert.match(response.body.error, /所选成员.*变化/);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM ai_import_batches').n, 0);
  assert.equal((await f.request('/auth/me', { actor: operator })).status, 200);
});
