import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDatabase,all,one,run} from '../server/database.mjs';
import {legacyDatabase} from './helpers/legacy-database.mjs';

test('真实旧版结构升级保留开发者授权、原业务与钉钉会话，开发者不参与业务',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qianfan-developer-migration-'));
  const filename=path.join(directory,'crm.sqlite');
  let db=legacyDatabase(filename,3);
  t.after(()=>{if(db)db.close();for(const suffix of ['','-wal','-shm'])if(fs.existsSync(filename+suffix))fs.unlinkSync(filename+suffix);fs.rmdirSync(directory);});
  run(db,"INSERT INTO users(id,name,username,role,developer_admin,performance_enabled,created_at) VALUES(4,'迁移开发者','migration-developer','admin',1,1,?)",new Date().toISOString());
  run(db,"INSERT INTO sessions(token,user_id,csrf,expires,auth_method) VALUES('isolated-test-session-hash',4,'isolated-test-csrf',?,'dingtalk')",Date.now()+60000);
  assert.equal(one(db,'SELECT MAX(version) n FROM schema_version').n,3);
  assert.equal(all(db,'PRAGMA table_info(users)').some(c=>c.name==='business_member'),false);
  const tables=['users','customers','contacts','contracts','contract_items','payments','activities','activity_events','targets','sessions','ding_identities','commission_batches','commission_lines','performance_reviews'];
  const before=Object.fromEntries(tables.map(table=>[table,all(db,'SELECT * FROM '+table)]));
  db.close();db=null;db=openDatabase(filename);
  assert.equal(one(db,'SELECT COUNT(*) n FROM schema_version WHERE version=4').n,1);
  assert.equal(one(db,'SELECT MAX(version) n FROM schema_version').n,36);
  const addedTables=['customer_profiles','contract_attachment_analyses'];
  for(const table of addedTables)assert.equal(one(db,'SELECT COUNT(*) n FROM '+table).n,0,table+' 不自动生成旧数据');
  const queueTables=['company_profile_jobs','company_profile_queue_control'];
  assert.deepEqual(all(db,'SELECT customer_id FROM company_profile_jobs ORDER BY customer_id').map(row=>row.customer_id),before.customers.map(row=>row.id).sort((a,b)=>a-b),'原客户只建立待查询任务，不生成企业资料');
  for(const row of all(db,'SELECT status,attempts,retry_count,checkpoint,identity_fingerprint,manual_only FROM company_profile_jobs'))assert.deepEqual({...row},{status:'pending',attempts:0,retry_count:0,checkpoint:'{}',identity_fingerprint:'',manual_only:0});
  assert.deepEqual({...one(db,'SELECT id,paused_until,pause_reason,lease_token,lease_until FROM company_profile_queue_control')},{id:1,paused_until:null,pause_reason:'',lease_token:null,lease_until:null});
  for(const row of all(db,'SELECT renewal_tag,payment_type,project_status,delivery_staff,project_note FROM contracts'))assert.ok(Object.values(row).every(value=>value===null),'新增合同资料未知值保持 NULL');
  const developer=one(db,'SELECT role,active,developer_admin,business_member,performance_enabled FROM users WHERE id=4');
  assert.deepEqual({...developer},{role:'admin',active:1,developer_admin:1,business_member:0,performance_enabled:0});
  assert.ok(all(db,'SELECT business_member FROM users WHERE id!=4').every(u=>u.business_member===1));
  // Retired password/PPL/free-text attachment columns are intentionally removed.
  // Every remaining historical column and row must survive byte-for-byte.
  const retired={users:['password'],customers:['ppl_id','level'],contracts:['quote_file','accept_status','recurring_amount','auto_renew']};
  for(const [table,rows] of Object.entries(before)){
    const currentColumns=new Set(all(db,'PRAGMA table_info('+table+')').map(c=>c.name));
    const columns=Object.keys(rows[0]);
    assert.ok(columns.filter(c=>!currentColumns.has(c)).every(c=>(retired[table]||[]).includes(c)),table+' unexpected column removal');
    const kept=columns.filter(c=>currentColumns.has(c));
    const expected=rows.map(row=>Object.fromEntries(kept.map(c=>[c,table==='users'&&row.id===4&&c==='performance_enabled'?0:row[c]])));
    assert.deepEqual(all(db,'SELECT '+kept.map(c=>'"'+c+'"').join(',')+' FROM '+table).map(row=>({...row})),expected,table);
  }
  for(const [table,field] of [['customers','level'],['contracts','accept_status']])for(const row of before[table].filter(row=>row[field]!==null)){
    const archived=one(db,"SELECT payload FROM source_records WHERE source='schema24字段精简' AND source_table=? AND source_id=?",table,String(row.id)+':'+field);
    assert.ok(archived,table+' 原值归档');assert.deepEqual(JSON.parse(archived.payload),{id:row.id,[field]:row[field]});
  }
  for(const row of before.contracts){
    const archived=one(db,"SELECT payload FROM source_records WHERE source='schema30续约字段清理' AND source_table='contracts' AND source_id=?",String(row.id)+':renewal_fields');
    assert.ok(archived,'旧续约字段原值归档');assert.deepEqual(JSON.parse(archived.payload),{id:row.id,recurring_amount:row.recurring_amount,auto_renew:row.auto_renew});
  }
  assert.deepEqual({...one(db,'SELECT id,customer_id,owner_id,amount,stage FROM opportunities WHERE id=1')},{id:1,customer_id:1,owner_id:2,amount:100000,stage:'赢单'});
  assert.equal(one(db,'PRAGMA integrity_check').integrity_check,'ok');assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
  const after=Object.fromEntries([...tables,...addedTables,...queueTables].map(table=>[table,all(db,'SELECT * FROM '+table)]));
  db.close();db=null;db=openDatabase(filename);
  for(const [table,rows] of Object.entries(after))assert.deepEqual(all(db,'SELECT * FROM '+table),rows,table+' restart');
});
