import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {legacyDatabase} from './helpers/legacy-database.mjs';
import {openDatabase,all,one} from '../server/database.mjs';
import {migrateRetiredRenewalFields} from '../server/retired-renewal-schema.mjs';

function oldDatabase(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qf-schema30-')),filename=path.join(dir,'isolated.sqlite');
  const legacy=legacyDatabase(filename);
  legacy.exec("UPDATE contracts SET recurring_amount=4321,auto_renew=1; CREATE TRIGGER fail30 BEFORE INSERT ON schema_version WHEN NEW.version=30 BEGIN SELECT RAISE(ABORT,'forced30');END;");legacy.close();
  assert.throws(()=>openDatabase(filename),/forced30/);
  const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON; DROP TRIGGER fail30');
  assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,29);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});return db;
}
const snapshot=db=>Object.fromEntries(all(db,"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(({name})=>[name,all(db,'SELECT * FROM '+name)]));

test('schema30归档非零续约原值后删列，保留全部业务及原约束并且幂等',t=>{
  const db=oldDatabase(t),before=snapshot(db);
  migrateRetiredRenewalFields(db);
  assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,30);
  const evidence=all(db,"SELECT * FROM source_records WHERE source='schema30续约字段清理'");
  assert.equal(evidence.length,1);assert.deepEqual(JSON.parse(evidence[0].payload),{id:1,recurring_amount:4321,auto_renew:1});
  assert.equal(evidence[0].entity_id,1);assert.equal(evidence[0].status,'archived');
  for(const [table,rows] of Object.entries(before)) {
    if(['source_records','schema_version','workspace_revision','sqlite_sequence'].includes(table))continue;
    const expected=rows.map(row=>{const copy={...row};if(table==='contracts'){delete copy.recurring_amount;delete copy.auto_renew;}return copy;});
    assert.deepEqual(all(db,'SELECT * FROM '+table).map(row=>({...row})),expected,table);
  }
  for(const old of before.source_records)assert.deepEqual(one(db,'SELECT * FROM source_records WHERE id=?',old.id),old);
  assert.throws(()=>db.exec("UPDATE contracts SET valid_until='2000-01-01' WHERE id=1"),/field integrity/);
  assert.throws(()=>db.exec('UPDATE contracts SET amount=49999 WHERE id=1'),/amount integrity/);
  assert.throws(()=>db.exec('UPDATE contracts SET customer_id=999 WHERE id=1'),/field integrity/);
  const after=snapshot(db);migrateRetiredRenewalFields(db);assert.deepEqual(snapshot(db),after);
  assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);assert.equal(one(db,'PRAGMA integrity_check').integrity_check,'ok');
});

test('schema30提交失败完整回滚原值、归档、触发器与版本，修复后可重试',t=>{
  const db=oldDatabase(t);db.exec("CREATE TRIGGER fail30 BEFORE INSERT ON schema_version WHEN NEW.version=30 BEGIN SELECT RAISE(ABORT,'forced30');END;");
  const before=snapshot(db),schema=all(db,'SELECT * FROM sqlite_master ORDER BY type,name');
  assert.throws(()=>migrateRetiredRenewalFields(db),/forced30/);
  assert.deepEqual(snapshot(db),before);assert.deepEqual(all(db,'SELECT * FROM sqlite_master ORDER BY type,name'),schema);assert.equal(db.isTransaction,false);
  db.exec('DROP TRIGGER fail30');migrateRetiredRenewalFields(db);assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,30);
});

test('schema30拒绝覆盖同来源不同原值，保留旧列及全部证据',t=>{
  const db=oldDatabase(t);
  db.prepare("INSERT INTO source_records(source,source_table,source_id,entity,entity_id,payload,source_file,sheet_name,row_number,imported_at,fingerprint,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run('schema30续约字段清理','contracts','1:renewal_fields','contract',1,JSON.stringify({id:1,recurring_amount:9876,auto_renew:0}),'旧证据','contracts',1,'2026-10-01','conflicting-schema30','archived','原证据');
  const before=snapshot(db);assert.throws(()=>migrateRetiredRenewalFields(db),/已有来源与当前旧值不一致/);assert.deepEqual(snapshot(db),before);
});
