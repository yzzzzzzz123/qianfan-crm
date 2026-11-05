import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {intakeCatalog} from '../server/modules/ai-imports.mjs';

const retired=['standard_self_new','standard_distributed_new','standard_renewal','implementation'];
const active=['period','threshold','low_rate','high_rate','manager_id','unlock_by_payment','sales_policy'];
const readRules=db=>JSON.parse(db.prepare("SELECT value FROM settings WHERE key='rules'").get().value);

test('AI规则目录只暴露有效提成参数，不修改状态或数据库中的历史设置',async t=>{
  const f=await fixture(t),admin=await f.login(1),state=(await f.request('/state',{actor:admin})).body;
  const before=structuredClone(state.rules),stored=readRules(f.db);
  const catalog=intakeCatalog(state);
  assert.deepEqual(Object.keys(catalog.records.rules.commission).sort(),active.toSorted());
  for(const key of retired)assert.equal(Object.hasOwn(catalog.records.rules.commission,key),false);
  assert.deepEqual(state.rules,before);
  assert.deepEqual(readRules(f.db),stored);
  const sales=await f.login(2),own=(await f.request('/state',{actor:sales})).body;
  assert.equal(Object.hasOwn(intakeCatalog(own).records,'rules'),false);
});

test('真实AI接收调用使用过滤目录，有效规则确认保存而旧比例提案整批拒绝',async t=>{
  let captured,commission={low_rate:0.06,high_rate:0.08};
  const provider={configured:true,model:'isolated-rules-provider',prepare:async(_input,catalog)=>{
    captured=structuredClone(catalog);
    return {summary:'调整提成规则',questions:[],operations:[{type:'rules',action:'update',ref:'rules1',data:{commission},source_file:'粘贴内容',evidence:'隔离规则资料'}],model:'isolated-rules-provider',usage:{}};
  }};
  const f=await fixture(t,{aiProvider:provider}),actor=await f.login(1),before=readRules(f.db);
  const receive=text=>f.request('/ai/intake',{actor,method:'POST',body:{text}});
  const received=await receive('调整有效提成比例，低档百分之六，高档百分之八。');
  assert.equal(received.status,200,JSON.stringify(received.body));
  assert.equal(received.body.valid,true);
  assert.deepEqual(Object.keys(captured.records.rules.commission).sort(),active.toSorted());
  assert.deepEqual(readRules(f.db),before,'识别和预览不写入规则');
  const draft=(await f.request('/ai/batches/'+received.body.id,{actor})).body;
  const confirmed=await f.request(`/ai/batches/${draft.id}/confirm`,{actor,method:'POST',body:{version:draft.version,acknowledged:true}});
  assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));
  const effective=readRules(f.db);
  assert.equal(effective.commission.low_rate,0.06);
  assert.equal(effective.commission.high_rate,0.08);
  for(const key of retired)assert.equal(effective.commission[key],before.commission[key]);
  commission={low_rate:0.05,standard_self_new:0.2};
  const rejected=await receive('提交一个旧版毛利比例及低档提成比例，验证整批拒绝。');
  assert.equal(rejected.status,200);
  assert.equal(rejected.body.valid,false);
  const invalid=(await f.request('/ai/batches/'+rejected.body.id,{actor})).body;
  assert.match(invalid.errors.map(e=>e.message).join('；'),/旧毛利比例已停用/);
  assert.equal((await f.request(`/ai/batches/${invalid.id}/confirm`,{actor,method:'POST',body:{version:invalid.version,acknowledged:true}})).status,422);
  assert.deepEqual(readRules(f.db),effective,'拒绝的旧比例提案不得连带改写有效设置');
});
