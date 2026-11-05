import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {renderPage} from '../public/views.js';

function source(db,entity,id,at,{related=[],status='imported',sheet='业务总表'}={}) {
  const key=entity+'-'+id+'-'+at+'-'+status;
  db.prepare('INSERT INTO source_records(source,source_table,source_id,entity,entity_id,payload,source_file,sheet_name,row_number,imported_at,fingerprint,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('QFCRM',sheet,key,entity,id,JSON.stringify({values:{名称:'真实结构测试',备注:'<script>不可执行</script>'},cell_metadata:[],source_sha256:'synthetic-sha',related}),'QFCRM.xlsx',sheet,8,at,key,status,'');
}
const dates=history=>Object.fromEntries(history.map(row=>[row.type,row.imported_at]));
const guideRow=(state,id)=>renderPage(state,{view:'intake',guideTable:id}).match(new RegExp('<article[^>]*data-guide="'+id+'">[^]*?</article>'))?.[0]||'';

test('真实来源和AI回执按实际业务类型合并最近入库，合同不会冒充回款，来源字段与日期可见',async t=>{
  const f=await fixture(t),admin=await f.login(1);
  const c=f.db.prepare('SELECT * FROM contracts WHERE owner_id=2 LIMIT 1').get();
  const o=f.db.prepare('SELECT * FROM opportunities WHERE owner_id=2 LIMIT 1').get();
  const a=f.db.prepare('SELECT * FROM activities WHERE opportunity_id=? LIMIT 1').get(o.id);
  const p=f.db.prepare('SELECT * FROM payments WHERE contract_id=? LIMIT 1').get(c.id);
  assert.ok(a&&p);
  source(f.db,'customer',o.customer_id,'2026-10-20T02:00:00Z');
  source(f.db,'opportunity',o.id,'2026-10-21T02:00:00Z');
  source(f.db,'contract',c.id,'2026-10-22T02:00:00Z');
  source(f.db,'activity',a.id,'2026-10-23T02:00:00Z');
  let state=(await f.request('/state',{actor:admin})).body;
  assert.deepEqual(dates(state.ai.importHistory),{customer:'2026-10-20T02:00:00Z',opportunity:'2026-10-21T02:00:00Z',contract:'2026-10-22T02:00:00Z',activity:'2026-10-23T02:00:00Z'});
  assert.match(guideRow(state,'customers'),/2026\/10\/20 10:00:00/);
  assert.match(guideRow(state,'opportunities'),/2026\/10\/21 10:00:00/);
  assert.match(guideRow(state,'activities'),/2026\/10\/23 10:00:00/);
  assert.match(guideRow(state,'contracts'),/2026\/10\/22 10:00:00/);
  assert.match(guideRow(state,'payments'),/暂无/);

  source(f.db,'contract',c.id,'2026-10-24T02:00:00Z',{sheet:'项目回款计划',related:[{entity:'payment',id:p.id}]});
  source(f.db,'contract',c.id,'2099-01-01T02:00:00Z',{status:'archived'});
  source(f.db,'customer',o.customer_id,'2099-01-02T02:00:00Z',{status:'pending'});
  const op={type:'contract',ref:'contract1',action:'update',source_file:'合同补充.md',data:{scope:'补充范围'}};
  f.db.prepare(`INSERT INTO ai_import_batches(user_id,source_hash,state,summary,questions,operations,errors,model,usage,base_revision,created_at,confirmed_at,result,source_role) VALUES(1,'history-regression','confirmed','合同补充','[]',?,'[]','test','{}',0,?,?,?,'admin')`).run(JSON.stringify([op]),'2026-10-25T01:00:00Z','2026-10-25T02:00:00Z',JSON.stringify([{type:'contract',ref:'contract1',id:c.id}]));
  state=(await f.request('/state',{actor:admin})).body;
  assert.equal(dates(state.ai.importHistory).contract,'2026-10-25T02:00:00Z');
  assert.equal(dates(state.ai.importHistory).payment,'2026-10-24T02:00:00Z');
  assert.equal(dates(state.ai.importHistory).customer,'2026-10-20T02:00:00Z');
  assert.match(guideRow(state,'contracts'),/2026\/10\/25 10:00:00/);
  assert.match(guideRow(state,'payments'),/2026\/10\/24 10:00:00/);
  assert.match(guideRow(state,'contracts'),/已有或本批新建合同/);
  const imported=(await f.request('/source-records?sheet='+encodeURIComponent('项目回款计划'),{actor:admin})).body;
  assert.equal(imported.records.length,1);assert.ok(imported.records[0].imported_at);
});

test('来源入库时间按当前角色可见记录过滤，共享客户和其他销售的AI回执不泄漏',async t=>{
  const f=await fixture(t),sales=await f.login(2),other=await f.login(3),admin=await f.login(1);
  for(const owner of [2,3]){
    const c=f.db.prepare('SELECT * FROM customers WHERE owner_id=? LIMIT 1').get(owner);
    const o=f.db.prepare('SELECT * FROM opportunities WHERE owner_id=? LIMIT 1').get(owner);
    const contract=f.db.prepare('SELECT * FROM contracts WHERE owner_id=? LIMIT 1').get(owner);
    source(f.db,'customer',c.id,`2026-10-${owner}0T02:00:00Z`);
    source(f.db,'opportunity',o.id,`2026-10-${owner}0T03:00:00Z`);
    source(f.db,'contract',contract.id,`2026-10-${owner}0T04:00:00Z`);
  }
  const owned=f.db.prepare('SELECT id FROM opportunities WHERE owner_id=2 LIMIT 1').get();
  const op={type:'opportunity',ref:'o',action:'update',data:{name:'当前销售的记录'}};
  // A receipt owned by another user must not expose a newer import timestamp,
  // even when the target record is now visible to the current sales member.
  f.db.prepare(`INSERT INTO ai_import_batches(user_id,source_hash,state,summary,questions,operations,errors,model,usage,base_revision,created_at,confirmed_at,result,source_role) VALUES(3,'other-history','confirmed','旧归属操作','[]',?,'[]','test','{}',0,?,?,?,'sales')`).run(JSON.stringify([op]),'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z',JSON.stringify([{type:'opportunity',ref:'o',id:owned.id}]));
  const ownState=(await f.request('/state',{actor:sales})).body;
  assert.ok(ownState.customers.some(c=>c.shared));
  assert.deepEqual(dates(ownState.ai.importHistory),{customer:'2026-10-20T02:00:00Z',opportunity:'2026-10-20T03:00:00Z',contract:'2026-10-20T04:00:00Z'});
  const otherState=(await f.request('/state',{actor:other})).body;
  assert.equal(dates(otherState.ai.importHistory).opportunity,'2026-10-30T03:00:00Z','the former owner no longer sees the target receipt');
  const adminState=(await f.request('/state',{actor:admin})).body;
  assert.equal(dates(adminState.ai.importHistory).opportunity,'2099-01-01T02:00:00Z');
  assert.ok(ownState.ai.importHistory.every(row=>Object.keys(row).sort().join(',')==='imported_at,type'));
});
