import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,all,one} from '../server/database.mjs';
import {legacyDatabase} from './helpers/legacy-database.mjs';
import {migrateConfirmedProductRates} from '../server/meeting-schema.mjs';
import {migrateMinutesOrganizations} from '../server/minutes-organizations-schema.mjs';
import {migrateVerifiedMinutesProfiles} from '../server/minutes-profiles-schema.mjs';
import {migrateMinutesHistory} from '../server/minutes-history-schema.mjs';

function assertLatestAdditions(db,present){
  for(const table of ['customer_profiles','contract_attachment_analyses']){
    assert.equal(Boolean(one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",table)),present,table);
    if(present)assert.equal(one(db,'SELECT COUNT(*) n FROM '+table).n,0,table+' 不自动生成旧数据');
  }
  for(const table of ['company_profile_jobs','company_profile_queue_control'])assert.equal(Boolean(one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",table)),present,table);
  for(const name of ['company_profile_customer_insert','company_profile_customer_identity'])assert.equal(Boolean(one(db,"SELECT name FROM sqlite_master WHERE type='trigger' AND name=?",name)),present,name);
  if(present){
    assert.deepEqual(all(db,'SELECT customer_id FROM company_profile_jobs ORDER BY customer_id').map(row=>row.customer_id),all(db,'SELECT id FROM customers ORDER BY id').map(row=>row.id),'每个历史客户仅建立一个待查询任务');
    for(const row of all(db,'SELECT status,attempts,retry_count,checkpoint,manual_only FROM company_profile_jobs'))assert.deepEqual({...row},{status:'pending',attempts:0,retry_count:0,checkpoint:'{}',manual_only:0});
    assert.deepEqual({...one(db,'SELECT id,paused_until,pause_reason,lease_token,lease_until FROM company_profile_queue_control')},{id:1,paused_until:null,pause_reason:'',lease_token:null,lease_until:null});
  }
  const columns=new Set(all(db,'PRAGMA table_info(contracts)').map(c=>c.name));
  const additions=['renewal_tag','payment_type','project_status','delivery_staff','project_note'];
  for(const name of additions)assert.equal(columns.has(name),present,name);
  if(present)for(const row of all(db,'SELECT '+additions.join(',')+' FROM contracts'))assert.ok(Object.values(row).every(value=>value===null),'未知合同资料保持 NULL');
}

test('历史听记升级只增加任务模式和续读游标，失败回滚并完整保留既有连接、记录及任务',()=>{
 const db=openDatabase(':memory:');try{
  db.exec("ALTER TABLE minutes_sync_runs DROP COLUMN mode; ALTER TABLE minutes_sync_runs DROP COLUMN cursor; DELETE FROM schema_version WHERE version=20;");
  db.exec("INSERT INTO users(id,name,username,role,created_at) VALUES(1,'隔离管理员','history-admin','admin','2026-11-01T00:00:00Z')");
  db.exec("INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at) VALUES('existing-history',1,'dingHistory','123','本人','已核验组织','11111111-1111-4111-a111-111111111111','connected','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')");
  db.exec("INSERT INTO minutes_sync_runs(id,source_id,status,from_time,to_time,created_at) VALUES('old-run','existing-history','success','2026-11-01T00:00:00Z','2026-11-01T01:00:00Z','2026-11-01T01:00:00Z')");
  const before=Object.fromEntries(['minutes_sources','minutes_records','minutes_sync_runs'].map(table=>[table,all(db,'SELECT * FROM '+table)]));
  db.exec("CREATE TRIGGER fail_history_schema BEFORE INSERT ON schema_version WHEN NEW.version=20 BEGIN SELECT RAISE(ABORT,'forced history migration failure'); END");
  assert.throws(()=>migrateMinutesHistory(db),/forced history migration failure/);assert.equal(all(db,'PRAGMA table_info(minutes_sync_runs)').some(c=>c.name==='mode'||c.name==='cursor'),false);
  for(const [table,rows] of Object.entries(before))assert.deepEqual(all(db,'SELECT * FROM '+table),rows);
  db.exec('DROP TRIGGER fail_history_schema');migrateMinutesHistory(db);migrateMinutesHistory(db);
  for(const [table,rows] of Object.entries(before))for(const row of rows){const actual=one(db,'SELECT * FROM '+table+' WHERE id=?',row.id);for(const [key,value] of Object.entries(row))assert.equal(actual[key],value);}
  const job=one(db,"SELECT * FROM minutes_sync_runs WHERE id='old-run'");assert.equal(job.mode,'incremental');assert.equal(job.cursor,null);assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
 }finally{db.close();}
});

test('真实旧库存在超额到账时升级整体回滚且关闭连接，修正后可原位重新升级',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'crm-rollback-')),filename=path.join(root,'db.sqlite');
  let db=legacyDatabase(filename,5);
  t.after(()=>{if(db)db.close();assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(root).startsWith('crm-rollback-'));fs.rmSync(root,{recursive:true,force:true});});
  const paid=one(db,"SELECT id,amount FROM payments WHERE status='已到账' LIMIT 1");
  db.prepare('UPDATE payments SET amount=999999999 WHERE id=?').run(paid.id);
  const before=Object.fromEntries(all(db,"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(({name})=>[name,all(db,'SELECT * FROM '+name)]));
  db.close();db=null;
  assert.throws(()=>openDatabase(filename),/升级前需核对/);
  db=new DatabaseSync(filename);
  assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,5);
  assertLatestAdditions(db,false);
  assert.equal(one(db,"SELECT name FROM sqlite_master WHERE name='ai_import_batches'"),undefined);
  assert.equal(all(db,'PRAGMA table_info(opportunities)').some(c=>c.name==='ppl_amount'),false);
  for(const [table,rows] of Object.entries(before))assert.deepEqual(all(db,'SELECT * FROM '+table),rows,table+' rollback');
  db.prepare('UPDATE payments SET amount=? WHERE id=?').run(paid.amount,paid.id);
  db.close();db=null;db=openDatabase(filename);
  assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,35);
  assertLatestAdditions(db,true);
  assert.equal(one(db,'SELECT amount FROM payments WHERE id=?',paid.id).amount,paid.amount);
  assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
});

test('本人组织选项迁移仅使用已核验来源，失败回滚且保留原连接及听记',()=>{
 const db=openDatabase(':memory:');try{
  db.exec("INSERT INTO users(id,name,username,role,created_at) VALUES(1,'隔离管理员','isolated-admin','admin','2026-11-01T00:00:00Z')");
  db.exec('ALTER TABLE minutes_authorizations DROP COLUMN verified_profiles; DELETE FROM schema_version WHERE version=19');
  db.exec("INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at) VALUES('existing',1,'dingOne','123','本人','已核验组织','11111111-1111-4111-a111-111111111111','connected','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')");
  db.exec("INSERT INTO minutes_authorizations(id,member_id,status,credential_key,source_id,expires_at,created_at) VALUES('old',1,'connected','11111111-1111-4111-a111-111111111111','existing','2026-11-01T00:10:00Z','2026-11-01T00:00:00Z'),('failed',1,'failed','22222222-2222-4222-a222-222222222222',NULL,'2026-11-01T00:10:00Z','2026-11-01T00:00:00Z')");
  db.exec("INSERT INTO minutes_records(source_id,external_id,title,start_time,duration_ms,media_state,synced_at) VALUES('existing','keep-note','保留原听记','2026-11-01T00:00:01Z',1000,'unavailable','2026-11-01T00:00:02Z')");
  const before=Object.fromEntries(['minutes_sources','minutes_records','minutes_authorizations'].map(table=>[table,all(db,'SELECT * FROM '+table)]));
  db.exec("CREATE TRIGGER fail_profiles BEFORE INSERT ON schema_version WHEN NEW.version=19 BEGIN SELECT RAISE(ABORT,'forced profiles failure'); END");assert.throws(()=>migrateVerifiedMinutesProfiles(db),/forced profiles failure/);assert.equal(all(db,'PRAGMA table_info(minutes_authorizations)').some(c=>c.name==='verified_profiles'),false);
  for(const [table,rows] of Object.entries(before))assert.deepEqual(all(db,'SELECT * FROM '+table),rows);
  db.exec('DROP TRIGGER fail_profiles');migrateVerifiedMinutesProfiles(db);migrateVerifiedMinutesProfiles(db);
  assert.equal(JSON.parse(one(db,"SELECT verified_profiles FROM minutes_authorizations WHERE id='old'").verified_profiles)[0].accountName,'本人');assert.deepEqual(JSON.parse(one(db,"SELECT verified_profiles FROM minutes_authorizations WHERE id='failed'").verified_profiles),[]);
  for(const table of ['minutes_sources','minutes_records'])assert.deepEqual(all(db,'SELECT * FROM '+table),before[table]);assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
 }finally{db.close();}
});

test('用户确认产品5%和12%仅填待核实格，保留自定义比例并原子回滚',()=>{
  const db=openDatabase(':memory:');
  try{
    db.exec('DELETE FROM schema_version WHERE version=16');
    const rules=JSON.parse(one(db,"SELECT value FROM settings WHERE key='rules'").value);rules.commission.sales_policy.product[1].rates.D=null;rules.commission.sales_policy.product[4].rates.D=.13;
    db.prepare("UPDATE settings SET value=? WHERE key='rules'").run(JSON.stringify(rules));
    db.exec("CREATE TRIGGER fail_confirmed_rates BEFORE INSERT ON schema_version WHEN NEW.version=16 BEGIN SELECT RAISE(ABORT,'forced rate failure'); END");
    assert.throws(()=>migrateConfirmedProductRates(db),/forced rate failure/);assert.equal(JSON.parse(one(db,"SELECT value FROM settings WHERE key='rules'").value).commission.sales_policy.product[1].rates.D,null);
    db.exec('DROP TRIGGER fail_confirmed_rates');migrateConfirmedProductRates(db);migrateConfirmedProductRates(db);
    const policy=JSON.parse(one(db,"SELECT value FROM settings WHERE key='rules'").value).commission.sales_policy;assert.equal(policy.product[1].rates.D,.05);assert.equal(policy.product[4].rates.D,.13);assert.equal(policy.product[0].rates.A,null);assert.equal(one(db,'SELECT COUNT(*) n FROM schema_version WHERE version=16').n,1);
  }finally{db.close();}
});

test('听记结构迁移失败整体回滚，新表与自动摘要关联列不残留，业务行逐列保留',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'crm-minutes-rollback-')),filename=path.join(root,'db.sqlite');let db=legacyDatabase(filename,7);
  t.after(()=>{db?.close();assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(root).startsWith('crm-minutes-rollback-'));fs.rmSync(root,{recursive:true,force:true});});
  const old=all(db,'SELECT * FROM customers');db.exec("CREATE TRIGGER fail_minutes_schema BEFORE INSERT ON schema_version WHEN NEW.version=17 BEGIN SELECT RAISE(ABORT,'forced minutes migration failure'); END");db.close();db=null;assert.throws(()=>openDatabase(filename),/forced minutes migration failure/);
  db=new DatabaseSync(filename);assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,16);assert.equal(one(db,"SELECT name FROM sqlite_master WHERE name='minutes_records'"),undefined);assert.equal(all(db,'PRAGMA table_info(activities)').some(c=>c.name==='minutes_record_id'),false);
  for(const c of old){const actual=one(db,'SELECT * FROM customers WHERE id=?',c.id);for(const [k,v] of Object.entries(c))if(Object.hasOwn(actual,k))assert.equal(actual[k],v);}
  assertLatestAdditions(db,false);
  db.exec('DROP TRIGGER fail_minutes_schema');db.close();db=null;db=openDatabase(filename);assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,35);assert.equal(one(db,'SELECT COUNT(*) n FROM minutes_records').n,0);assertLatestAdditions(db,true);assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
});

test('会议规则迁移失败回滚新增列和提成行重建，重试保留旧结算快照与返点',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'crm-meeting-rollback-')),filename=path.join(root,'db.sqlite');
  let db=legacyDatabase(filename,7);
  t.after(()=>{db?.close();assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(root).startsWith('crm-meeting-rollback-'));fs.rmSync(root,{recursive:true,force:true});});
  const snapshot=one(db,'SELECT snapshot FROM commission_batches WHERE id=1').snapshot;
  db.exec("CREATE TRIGGER fail_meeting_schema BEFORE INSERT ON schema_version WHEN NEW.version=14 BEGIN SELECT RAISE(ABORT,'forced meeting migration failure'); END");
  db.close();db=null;assert.throws(()=>openDatabase(filename),/forced meeting migration failure/);
  db=new DatabaseSync(filename);
  assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,13);
  assertLatestAdditions(db,false);
  assert.equal(all(db,'PRAGMA table_info(customers)').some(c=>c.name==='manual_level'),false);
  assert.equal(all(db,'PRAGMA table_info(commission_lines)').some(c=>c.name==='component'),false);
  assert.equal(one(db,'SELECT snapshot FROM commission_batches WHERE id=1').snapshot,snapshot);
  db.exec('DROP TRIGGER fail_meeting_schema');db.close();db=null;db=openDatabase(filename);
  assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,35);
  assertLatestAdditions(db,true);
  assert.equal(one(db,'SELECT snapshot FROM commission_batches WHERE id=1').snapshot,snapshot);
  assert.equal(one(db,'SELECT rebate_rate FROM commission_lines WHERE id=1').rebate_rate,.45);
  assert.equal(one(db,'SELECT component FROM commission_lines WHERE id=1').component,'legacy');
  assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
});

test('听记多组织约束升级保留账号、授权和记录引用，失败回滚并恢复外键校验',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'crm-org-rollback-')),filename=path.join(root,'db.sqlite');let db=legacyDatabase(filename,7);
  t.after(()=>{db?.close();assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(root).startsWith('crm-org-rollback-'));fs.rmSync(root,{recursive:true,force:true});});
  db.exec("CREATE TRIGGER fail_minutes_org BEFORE INSERT ON schema_version WHEN NEW.version=18 BEGIN SELECT RAISE(ABORT,'forced organization failure'); END");db.close();db=null;assert.throws(()=>openDatabase(filename),/forced organization failure/);db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON');
  const sourceId='11111111-1111-4111-a111-111111111111',authId='22222222-2222-4222-a222-222222222222';
  db.prepare("INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at) VALUES(?,1,'dingPrimary','123','原账号','原组织',?,'connected','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')").run(sourceId,authId);
  db.prepare("INSERT INTO minutes_authorizations(id,member_id,status,source_id,expires_at,created_at) VALUES(?,1,'connected',?,'2026-11-01T00:10:00Z','2026-11-01T00:00:00Z')").run(authId,sourceId);
  db.prepare("INSERT INTO minutes_records(source_id,external_id,title,start_time,duration_ms,media_state,synced_at) VALUES(?,'real-source-id','原听记','2026-11-01T00:00:01Z',1000,'unavailable','2026-11-01T00:00:02Z')").run(sourceId);
  const before=Object.fromEntries(['minutes_sources','minutes_authorizations','minutes_records'].map(table=>[table,all(db,'SELECT * FROM '+table)]));
  assert.throws(()=>migrateMinutesOrganizations(db),/forced organization failure/);assert.equal(one(db,'PRAGMA foreign_keys').foreign_keys,1);for(const [table,rows] of Object.entries(before))assert.deepEqual(all(db,'SELECT * FROM '+table),rows);
  db.exec('DROP TRIGGER fail_minutes_org');migrateMinutesOrganizations(db);migrateMinutesOrganizations(db);
  for(const [table,rows] of Object.entries(before))for(const row of rows){const actual=one(db,'SELECT * FROM '+table+' WHERE id=?',row.id);for(const [key,value] of Object.entries(row))assert.equal(actual[key],value);}
  assert.equal(one(db,'SELECT credential_key FROM minutes_authorizations WHERE id=?',authId).credential_key,authId);
  db.prepare("INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at) SELECT 'second-source',member_id,'dingOther','456',account_name,'另一组织',credential_key,connection_state,collect_from,created_at FROM minutes_sources WHERE id=?").run(sourceId);
  assert.equal(one(db,'SELECT COUNT(*) n FROM minutes_sources WHERE member_id=1').n,2);assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
});
