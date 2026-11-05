import test from 'node:test';
import assert from 'node:assert/strict';
import {all,one} from '../server/database.mjs';
import {migrateIntakeTrace} from '../server/intake-trace-schema.mjs';
import {legacyDatabase} from './helpers/legacy-database.mjs';

const snapshot=db=>Object.fromEntries(all(db,"SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_version' ORDER BY name").map(({name})=>[name,all(db,'SELECT * FROM '+name)]));

test('独立追溯升级保留全部旧业务与会话，视图复用历史JSON且重复执行不改数据',t=>{
  const db=legacyDatabase(':memory:',7);t.after(()=>db.close());
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO ai_import_batches(user_id,source_hash,state,summary,questions,operations,errors,model,usage,base_revision,created_at,confirmed_at,result,source_role) VALUES(1,'legacy-trace','confirmed','旧批次','[]',?,'[]','old','{}',0,?,?,?,'admin')`).run(JSON.stringify([{type:'customer',ref:'c',action:'create',source_file:'历史客户.md',data:{name:'旧客户'}}]),now,now,JSON.stringify([{type:'customer',ref:'c',id:1,message:'完成'}]));
  const before=snapshot(db);
  migrateIntakeTrace(db);
  assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,8);
  assert.equal(all(db,"SELECT name FROM sqlite_master WHERE type='view' AND name='ai_import_records'").length,1);
  const record=one(db,"SELECT * FROM ai_import_records WHERE source_file='历史客户.md'");
  assert.equal(record.table_name,'customers');assert.equal(record.record_id,1);assert.equal(record.imported_at,now);assert.equal(record.received_at,now);
  assert.deepEqual(snapshot(db),before);
  assert.equal(one(db,'PRAGMA integrity_check').integrity_check,'ok');assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
  migrateIntakeTrace(db);assert.deepEqual(snapshot(db),before);
  assert.equal(one(db,'SELECT COUNT(*) n FROM schema_version WHERE version=8').n,1);
});
test('追溯视图创建失败时整体回滚，修复冲突后可重新升级',t=>{
  const db=legacyDatabase(':memory:',7);t.after(()=>db.close());
  db.exec('CREATE TABLE ai_import_records(conflict TEXT)');
  const before=snapshot(db);
  assert.throws(()=>migrateIntakeTrace(db),/already exists/);
  assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,7);
  for(const name of ['ai_uploads_sha256','ai_batches_user_recent'])assert.equal(one(db,'SELECT name FROM sqlite_master WHERE name=?',name),undefined);
  assert.deepEqual(snapshot(db),before);
  db.exec('DROP TABLE ai_import_records');migrateIntakeTrace(db);
  assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,8);
  assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
});
