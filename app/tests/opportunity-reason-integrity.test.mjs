import test from 'node:test';
import assert from 'node:assert/strict';
import { one, run } from '../server/database.mjs';
import { fixture } from './helpers/fixture.mjs';

test('已输单商机可单独更正输单原因并保留前后审计，不重复生成阶段里程碑', async t => {
  const f = await fixture(t), actor = await f.login(2);
  assert.equal((await f.request('/opportunities/8', { actor, method: 'PATCH', body: { stage: '输单', lost_reason: '预算延期' } })).status, 200);
  const historyCount = one(f.db, 'SELECT COUNT(*) n FROM stage_history WHERE opportunity_id=8').n;
  const activityCount = one(f.db, 'SELECT COUNT(*) n FROM activities WHERE opportunity_id=8').n;
  for (const body of [
    { lost_reason: '经核实为竞品中标' },
    { stage: '输单', lost_reason: '客户确认采购另一产品' },
  ]) {
    const before = one(f.db, 'SELECT lost_reason FROM opportunities WHERE id=8').lost_reason;
    const result = await f.request('/opportunities/8', { actor, method: 'PATCH', body });
    assert.equal(result.status, 200);
    const row = one(f.db, 'SELECT stage,lost_reason FROM opportunities WHERE id=8');
    assert.equal(row.stage, '输单');
    assert.equal(row.lost_reason, body.lost_reason);
    const detail = JSON.parse(one(f.db, "SELECT detail FROM audit WHERE action='更新商机' AND entity_id=8 ORDER BY id DESC LIMIT 1").detail);
    assert.deepEqual(detail.lost_reason, { before, after: body.lost_reason });
    assert.equal(one(f.db, 'SELECT COUNT(*) n FROM stage_history WHERE opportunity_id=8').n, historyCount);
    assert.equal(one(f.db, 'SELECT COUNT(*) n FROM activities WHERE opportunity_id=8').n, activityCount);
  }
  assert.equal((await f.request('/opportunities/8', { actor, method: 'PATCH', body: { lost_reason: ' ' } })).status, 400);
  assert.equal(one(f.db, 'SELECT lost_reason FROM opportunities WHERE id=8').lost_reason, '客户确认采购另一产品');
});

test('非输单商机单填输单原因明确拒绝且关联修改整体回滚', async t => {
  const f = await fixture(t), actor = await f.login(2);
  const before = one(f.db, 'SELECT stage,lost_reason,next_action FROM opportunities WHERE id=8');
  const result = await f.request('/opportunities/8', {
    actor, method: 'PATCH', body: { lost_reason: '当前并未输单', next_action: '此字段不应保存' },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /仅输单商机/);
  assert.deepEqual(one(f.db, 'SELECT stage,lost_reason,next_action FROM opportunities WHERE id=8'), before);
});

test('历史输单商机可直接补充原因，保留当前阶段', async t => {
  const f = await fixture(t), actor = await f.login(2);
  run(f.db, "UPDATE opportunities SET stage='输单',lost_reason='' WHERE id=8");
  const result = await f.request('/opportunities/8', { actor, method: 'PATCH', body: { lost_reason: '总表输单结果核对后补充丢单原因' } });
  assert.equal(result.status, 200);
  const row = one(f.db, 'SELECT stage,lost_reason FROM opportunities WHERE id=8');
  assert.equal(row.stage, '输单');
  assert.equal(row.lost_reason, '总表输单结果核对后补充丢单原因');
});
