import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openDatabase,all,one} from '../server/database.mjs';
import {seedDemo} from '../server/seed.mjs';
import {migrateRetiredFields} from '../server/retired-fields-schema.mjs';
import {fixture} from './helpers/fixture.mjs';

function restorePre24Columns(db){
  // Reconstruct the migration boundary, including version markers introduced later.
  // This suite invokes migrateRetiredFields directly and must still end at 24.
  db.exec("DELETE FROM schema_version WHERE version>=24; DROP INDEX IF EXISTS opportunities_customer; DROP INDEX IF EXISTS contracts_customer; ALTER TABLE customers ADD COLUMN level TEXT; ALTER TABLE contracts ADD COLUMN accept_status TEXT; UPDATE customers SET level='A' WHERE id=1; UPDATE customers SET level='' WHERE id=2; UPDATE contracts SET accept_status='已验收' WHERE id=1;");
}
function oldDatabase(){const db=openDatabase(':memory:');seedDemo(db);restorePre24Columns(db);return db;}
const snapshot=db=>Object.fromEntries(all(db,"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(({name})=>[name,all(db,'SELECT * FROM '+name)]));
const fields=db=>Object.fromEntries(['customers','contracts'].map(table=>[table,all(db,'PRAGMA table_info('+table+')').map(c=>c.name)]));

test('schema24仅删除旧等级与旧验收列，非NULL旧值完整归档，现行值和全部其他行保持且重跑幂等',()=>{
  const db=oldDatabase();try{
    db.exec("UPDATE customers SET manual_level='重点客户' WHERE id=1; UPDATE contracts SET project_status='运维中' WHERE id=1");
    const before=snapshot(db);migrateRetiredFields(db);
    assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,24);
    for(const table of ['opportunities','contracts'])assert.match(one(db,'EXPLAIN QUERY PLAN SELECT id FROM '+table+' WHERE customer_id=1').detail,new RegExp('SEARCH '+table+' USING (?:COVERING )?INDEX '+table+'_customer'));
    assert.equal(all(db,"PRAGMA index_list(contract_items)").filter(index=>all(db,'PRAGMA index_info("'+index.name+'")')[0]?.name==='contract_id').length,1,'不重复添加既有行项索引');
    assert.equal(fields(db).customers.includes('level'),false);assert.equal(fields(db).contracts.includes('accept_status'),false);
    const archived=all(db,"SELECT * FROM source_records WHERE source='schema24字段精简' ORDER BY source_table,source_id");assert.equal(archived.length,3);
    for(const [table,field] of [['customers','level'],['contracts','accept_status']])for(const row of before[table].filter(row=>row[field]!==null)){
      const record=archived.find(s=>s.source_table===table&&s.source_id===String(row.id)+':'+field);assert.ok(record);
      assert.deepEqual(JSON.parse(record.payload),{id:row.id,[field]:row[field]});assert.equal(record.entity_id,row.id);assert.equal(record.entity,table==='customers'?'customer':'contract');
      assert.equal(record.fingerprint,createHash('sha256').update(`schema24:${table}:${record.source_id}:${record.payload}`).digest('hex'));assert.equal(record.status,'archived');
    }
    for(const [table,rows] of Object.entries(before)){
      if(['source_records','workspace_revision','schema_version','sqlite_sequence'].includes(table))continue;
      const expected=rows.map(row=>{const copy={...row};if(table==='customers')delete copy.level;if(table==='contracts')delete copy.accept_status;return copy;});
      assert.deepEqual(all(db,'SELECT * FROM '+table).map(row=>({...row})),expected,table);
    }
    assert.equal(one(db,'SELECT manual_level FROM customers WHERE id=3').manual_level,null);assert.equal(one(db,'SELECT project_status FROM contracts WHERE id=2').project_status,null);
    const after=snapshot(db);migrateRetiredFields(db);assert.deepEqual(snapshot(db),after);
    assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);assert.equal(one(db,'PRAGMA integrity_check').integrity_check,'ok');
  }finally{db.close();}
});

test('schema24最终版本提交失败会回滚归档、删列和revision，修复后可重试',()=>{
  const db=oldDatabase();try{
    db.exec("CREATE TRIGGER fail_schema24 BEFORE INSERT ON schema_version WHEN NEW.version=24 BEGIN SELECT RAISE(ABORT,'forced schema24 failure'); END");
    const before=snapshot(db),columns=fields(db),schema=all(db,'SELECT * FROM sqlite_master ORDER BY type,name');
    assert.throws(()=>migrateRetiredFields(db),/forced schema24 failure/);assert.deepEqual(snapshot(db),before);assert.deepEqual(fields(db),columns);assert.deepEqual(all(db,'SELECT * FROM sqlite_master ORDER BY type,name'),schema);
    assert.equal(db.isTransaction,false);assert.equal(one(db,'PRAGMA foreign_keys').foreign_keys,1);
    db.exec('DROP TRIGGER fail_schema24');migrateRetiredFields(db);assert.equal(one(db,'SELECT MAX(version) n FROM schema_version').n,24);
  }finally{db.close();}
});

test('schema24已有相同归档复用原时间，冲突证据拒绝迁移且不覆盖',()=>{
  const db=oldDatabase();try{
    const payload=JSON.stringify({id:1,level:'A'}),fingerprint=createHash('sha256').update('schema24:customers:1:level:'+payload).digest('hex');
    const insert=db.prepare("INSERT INTO source_records(source,source_table,source_id,entity,entity_id,payload,source_file,sheet_name,row_number,imported_at,fingerprint,status,reason) VALUES('schema24字段精简','customers','1:level','customer',1,?,'旧证据','customers',1,'2026-10-01T00:00:00Z',?,'archived','既有证据')");
    insert.run(JSON.stringify({id:1,level:'B'}),fingerprint);const before=snapshot(db);
    assert.throws(()=>migrateRetiredFields(db),/历史证据冲突/);assert.deepEqual(snapshot(db),before);assert.ok(fields(db).customers.includes('level'));
    db.prepare('UPDATE source_records SET payload=? WHERE fingerprint=?').run(payload,fingerprint);migrateRetiredFields(db);
    const evidence=all(db,'SELECT * FROM source_records WHERE fingerprint=?',fingerprint);assert.equal(evidence.length,1);assert.equal(evidence[0].imported_at,'2026-10-01T00:00:00Z');assert.equal(evidence[0].reason,'既有证据');
  }finally{db.close();}
});

test('退役字段不能从HTTP写入口恢复，现行手动等级和项目状态正常，历史值按原来源权限读取',async t=>{
  const f=await fixture(t),admin=await f.login(1),owner=await f.login(2),other=await f.login(3);
  restorePre24Columns(f.db);migrateRetiredFields(f.db);
  const beforeCustomer=one(f.db,'SELECT * FROM customers WHERE id=1'),beforeContract=one(f.db,'SELECT * FROM contracts WHERE id=1');
  assert.equal((await f.request('/customers',{actor:admin,method:'POST',body:{name:'不应建立客户',owner_id:2,level:'B'}})).status,400);
  assert.equal((await f.request('/customers/1',{actor:admin,method:'PATCH',body:{level:'B',note:'不应部分保存'}})).status,400);
  assert.equal((await f.request('/contracts/1',{actor:admin,method:'PATCH',body:{accept_status:'待交付',scope:'不应部分保存'}})).status,400);
  assert.deepEqual(one(f.db,'SELECT * FROM customers WHERE id=1'),beforeCustomer);assert.deepEqual(one(f.db,'SELECT * FROM contracts WHERE id=1'),beforeContract);
  assert.equal((await f.request('/customers/1',{actor:owner,method:'PATCH',body:{manual_level:'C'}})).status,200);
  assert.equal((await f.request('/contracts/1',{actor:admin,method:'PATCH',body:{project_status:'暂停'}})).status,200);
  const sources=await f.request('/source-records?entity=customer&id=1',{actor:owner});assert.equal(sources.status,200);assert.deepEqual(sources.body.records.find(r=>r.source==='schema24字段精简').raw,{id:1,level:'A'});
  assert.equal((await f.request('/source-records?entity=customer&id=1',{actor:other})).status,403);
  const contractSources=await f.request('/source-records?entity=contract&id=1',{actor:admin});assert.equal(contractSources.status,200);assert.deepEqual(contractSources.body.records.find(r=>r.source==='schema24字段精简').raw,{id:1,accept_status:'已验收'});
  const state=(await f.request('/state',{actor:admin})).body;assert.equal(Object.hasOwn(state.customers[0],'level'),false);assert.equal(Object.hasOwn(state.contracts[0],'accept_status'),false);
});
