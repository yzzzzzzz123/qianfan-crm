import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,one,all,run} from '../server/database.mjs';
import {createCompanyProfileQueue} from '../server/company-profile-queue.mjs';
import {migrateCompanyProfileQueue,migrateManualCompanyProfileQueue} from '../server/company-profile-queue-schema.mjs';
import {companyIdentity} from '../server/company-profile.mjs';

const saved=customer=>({version:1,provider:'qcc-mcp',identity:{name:customer.name,credit_code:customer.credit_code},registration:{state:'ready',details:{company_name:customer.name,business_scope:'已核验范围'},checked_at:'2026-11-02T00:00:00Z'}});
const ready=customer=>({state:'ready',complete:true,details:{company_name:customer.name},reason:'来源已核验'});
function fixture(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());
  run(db,"INSERT INTO users(id,name,username,role,created_at) VALUES(1,'隔离成员','manual-queue-fixture','sales','2026-11-02')");
  let clock=Date.parse('2026-11-02T06:00:00Z');const calls=[],provider={configured:true,lookup:async customer=>{calls.push(customer.id);return ready(customer);}};
  const queue=createCompanyProfileQueue({db,provider,deployment:'production',clock:()=>clock});
  const insert=name=>Number(run(db,"INSERT INTO customers(name,normalized,owner_id,created_at,updated_at) VALUES(?,?,1,'2026-11-02','2026-11-02')",name,name).lastInsertRowid);
  return {db,queue,provider,calls,insert,time:value=>{clock=Date.parse(value);}};
}

test('schema26只标记旧MANUAL_REQUIRED，原状态/检查点全保留，迁移失败可回滚',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(24);CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,credit_code TEXT);INSERT INTO customers VALUES(1,'历史手动主体',''),(2,'未来自动主体','');CREATE TABLE workspace_revision(id INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO workspace_revision VALUES(1,1);CREATE TABLE customer_profiles(customer_id INTEGER PRIMARY KEY,state TEXT,provider TEXT,source_url TEXT,details TEXT,reason TEXT,checked_at TEXT,identity_fingerprint TEXT);");
    migrateCompanyProfileQueue(db);
    run(db,"UPDATE company_profile_jobs SET status='failed',error_code='MANUAL_REQUIRED',checkpoint=?,next_retry_at=NULL WHERE customer_id=1",JSON.stringify(saved({name:'历史手动主体',credit_code:''})));
    const before=all(db,'SELECT * FROM company_profile_jobs ORDER BY customer_id');
    db.exec("CREATE TRIGGER reject_v26 BEFORE INSERT ON schema_version WHEN NEW.version=26 BEGIN SELECT RAISE(ABORT,'reject-v26'); END;");
    assert.throws(()=>migrateManualCompanyProfileQueue(db),/reject-v26/);assert.deepEqual(all(db,'SELECT * FROM company_profile_jobs ORDER BY customer_id'),before);assert.ok(!all(db,'PRAGMA table_info(company_profile_jobs)').some(c=>c.name==='manual_only'));
    db.exec('DROP TRIGGER reject_v26');migrateManualCompanyProfileQueue(db);migrateManualCompanyProfileQueue(db);
    const after=all(db,'SELECT * FROM company_profile_jobs ORDER BY customer_id');assert.deepEqual(after.map(({manual_only,...row})=>row),before.map(row=>({...row})));assert.deepEqual(after.map(row=>row.manual_only),[1,0]);
    assert.throws(()=>run(db,'UPDATE company_profile_jobs SET manual_only=2 WHERE customer_id=1'),/CHECK/);
    run(db,"UPDATE customers SET name='历史手动新主体' WHERE id=1");assert.equal(one(db,'SELECT status FROM company_profile_jobs WHERE customer_id=1').status,'failed');assert.equal(one(db,'SELECT error_code FROM company_profile_jobs WHERE customer_id=1').error_code,'MANUAL_REQUIRED');
    run(db,"UPDATE customers SET name='自动新主体' WHERE id=2");assert.equal(one(db,'SELECT status FROM company_profile_jobs WHERE customer_id=2').status,'pending');
  }finally{db.close();}
});

test('143完成4无匹配保留，剩余121转手动，跨日和重启不自动续查，新客户仍自动',async t=>{
  const f=fixture(t);for(let index=1;index<=268;index++)f.insert(`隔离企业${index}`);
  run(f.db,"UPDATE company_profile_jobs SET status='complete' WHERE customer_id<=143");run(f.db,"UPDATE company_profile_jobs SET status='not_found' WHERE customer_id BETWEEN 144 AND 147");
  const customer=one(f.db,'SELECT * FROM customers WHERE id=148'),checkpoint=JSON.stringify(saved(customer));
  run(f.db,"UPDATE company_profile_jobs SET status='waiting_quota',checkpoint=?,identity_fingerprint=?,next_retry_at='2026-11-02T18:05:00Z' WHERE customer_id=148",checkpoint,companyIdentity(customer));
  run(f.db,"UPDATE company_profile_queue_control SET paused_until='2026-11-02T18:05:00Z',pause_reason='QCC_QUOTA_EXHAUSTED'");
  const result=f.queue.markRemainingManual();assert.equal(result.marked,121);assert.equal(result.counts.complete,143);assert.equal(result.counts.not_found,4);assert.equal(result.counts.manual,121);assert.equal(result.counts.total,268);assert.equal(result.estimated_manual_credits,481);assert.equal(result.estimated_automatic_credits,0);assert.equal(result.next_retry_at,null);
  assert.equal(one(f.db,'SELECT checkpoint FROM company_profile_jobs WHERE customer_id=148').checkpoint,checkpoint);assert.equal(f.queue.read(148).stage,'profile');assert.equal(f.queue.read(148).manual_only,true);assert.equal(f.queue.read(148).awaiting_manual,true);assert.equal(f.queue.read(148).next_retry_at,null);
  f.queue.enqueueAll();f.time('2026-11-03T03:00:00Z');assert.equal((await f.queue.runNext()).state,'idle');assert.deepEqual(f.calls,[]);
  const fresh=f.insert('此后新增自动企业');assert.equal(f.queue.read(fresh).manual_only,false);assert.equal((await f.queue.runNext()).job.customer_id,fresh);assert.equal(f.queue.summary().counts.manual,121);
  const reopened=createCompanyProfileQueue({db:f.db,provider:f.provider,deployment:'production',clock:()=>Date.parse('2026-11-04T03:00:00Z')});reopened.enqueueAll();assert.equal((await reopened.runNext()).state,'idle');assert.deepEqual(f.calls,[fresh]);
});

test('标记仅影响可继续任务，不改完整/无匹配/主体冲突/运行中或无重试失败',t=>{
  const f=fixture(t);const states=['complete','not_found','mismatch','running','pending','waiting_quota','partial','failed','failed'];
  states.forEach((status,index)=>{const id=f.insert(`状态样本${index}`);run(f.db,'UPDATE company_profile_jobs SET status=?,next_retry_at=?,checkpoint=? WHERE customer_id=?',status,index===6||index===7?'2026-11-03T00:00:00Z':null,'{"preserved":true}',id);});
  assert.equal(f.queue.markRemainingManual().marked,4);const rows=all(f.db,'SELECT status,manual_only,checkpoint FROM company_profile_jobs ORDER BY customer_id');
  assert.deepEqual(rows.map(row=>row.manual_only),[0,0,0,0,1,1,1,1,0]);assert.ok(rows.every(row=>row.checkpoint==='{"preserved":true}'));assert.equal(f.queue.markRemainingManual().marked,0);
});

test('只有显式手动激活可查剩余，自动始终跳过，指定单客户不顺带查其他任务',async t=>{
  const f=fixture(t),first=f.insert('手动甲'),second=f.insert('手动乙');f.queue.markRemainingManual();
  assert.equal((await f.queue.runNext({manual:true})).state,'idle');f.queue.enqueueAll({manual:'false'});assert.equal(f.queue.read(first).status,'failed');
  f.queue.enqueueAll({manual:true,retryAuth:true});assert.equal(f.queue.read(first).status,'pending');assert.equal(f.queue.read(first).manual_only,true);assert.equal((await f.queue.runNext()).state,'idle');
  assert.equal((await f.queue.runNext({manual:true,customerId:second})).job.customer_id,second);assert.deepEqual(f.calls,[second]);assert.equal(f.queue.read(first).status,'pending');assert.equal(f.queue.read(second).manual_only,true);assert.equal(f.queue.read(second).awaiting_manual,false);
  assert.equal((await f.queue.runNext({manual:true,customerId:first})).job.status,'complete');assert.deepEqual(f.calls,[second,first]);f.queue.enqueueAll({manual:true});assert.equal((await f.queue.runNext({manual:true})).state,'idle');
});

test('手动任务配额不足保留工商进度但不会次日自动或隐式手动重试',async t=>{
  const f=fixture(t),id=f.insert('手动配额企业');f.queue.markRemainingManual();f.queue.enqueueAll({manual:true});let attempts=0;
  f.provider.lookup=async(customer,{onCheckpoint})=>{attempts++;const checkpoint=saved(customer);await onCheckpoint(checkpoint);throw Object.assign(new Error('private-upstream'),{code:'QCC_QUOTA_EXHAUSTED',checkpoint,partialResult:{state:'partial',details:checkpoint.registration.details}});};
  const result=await f.queue.runNext({manual:true});assert.equal(result.job.status,'waiting_quota');assert.equal(result.job.next_retry_at,null);assert.equal(result.job.stage,'profile');assert.equal(f.queue.summary().counts.manual,1);assert.equal(f.queue.summary().estimated_manual_credits,1);assert.equal(f.queue.summary().next_retry_at,null);assert.doesNotMatch(result.job.reason,/等待次日|自动/);
  f.time('2026-11-04T03:00:00Z');assert.equal((await f.queue.runNext()).state,'idle');assert.equal((await f.queue.runNext({manual:true})).state,'idle');assert.equal(attempts,1);
  f.queue.enqueueCustomer(id,{manual:true,retry:true});f.provider.lookup=async(customer,{checkpoint})=>{assert.equal(checkpoint.registration.state,'ready');return ready(customer);};assert.equal((await f.queue.runNext({manual:true,customerId:id})).job.status,'complete');
});

test('手动任务暂时错误及429不安排后台重试；认证手动恢复保持限制',async t=>{
  const f=fixture(t);f.insert('手动错误企业');f.queue.markRemainingManual();
  for(const code of ['QCC_TRANSIENT','QCC_RATE_LIMITED','QCC_RESPONSE_INVALID','QCC_AUTH_INVALID']){
    f.queue.enqueueAll({manual:true,retryAuth:true});f.provider.lookup=async()=>{throw Object.assign(new Error('never-persisted'),{code});};const result=await f.queue.runNext({manual:true});assert.equal(result.job.status,'failed');assert.equal(result.job.next_retry_at,null);assert.equal(result.job.manual_only,true);
    f.time('2026-11-20T03:00:00Z');assert.notEqual((await f.queue.runNext()).state,'processed');assert.notEqual((await f.queue.runNext({manual:true})).state,'processed');
  }
  f.queue.enqueueAll({retryAuth:true});assert.equal(f.queue.read(1).status,'failed');assert.equal(f.queue.read(1).manual_only,true);
  f.queue.enqueueAll({manual:true,retryAuth:true});f.provider.lookup=async customer=>ready(customer);assert.equal((await f.queue.runNext({manual:true})).job.status,'complete');
});

test('新客户手动刷新不改变自动资格，历史手动客户变主体仍需手动',async t=>{
  const f=fixture(t),old=f.insert('历史手动主体');f.queue.markRemainingManual();const fresh=f.insert('新自动主体');
  f.queue.enqueueCustomer(fresh,{retry:true,manual:true,priority:100});assert.equal((await f.queue.runNext({manual:true,customerId:fresh})).job.manual_only,false);
  run(f.db,"UPDATE customers SET name='新自动主体已更名' WHERE id=?",fresh);assert.equal((await f.queue.runNext()).job.customer_id,fresh);
  run(f.db,"UPDATE customers SET name='历史手动主体已更名' WHERE id=?",old);const oldJob=f.queue.read(old);assert.equal(oldJob.manual_only,true);assert.equal(oldJob.status,'failed');assert.equal(oldJob.error_code,'MANUAL_REQUIRED');assert.equal(oldJob.next_retry_at,null);assert.equal((await f.queue.runNext()).state,'idle');
});

test('手动租约中断保留检查点但不被自动或后续无激活手动调用恢复',async t=>{
  const f=fixture(t),id=f.insert('手动中断企业');f.queue.markRemainingManual();const customer=one(f.db,'SELECT * FROM customers WHERE id=?',id),checkpoint=JSON.stringify(saved(customer));
  run(f.db,"UPDATE company_profile_jobs SET status='running',checkpoint=?,identity_fingerprint=?,lease_token='old',lease_until='2026-11-02T05:00:00Z' WHERE customer_id=?",checkpoint,companyIdentity(customer),id);
  run(f.db,"UPDATE company_profile_queue_control SET lease_token='old',lease_until='2026-11-02T05:00:00Z'");
  assert.equal((await f.queue.runNext()).state,'idle');assert.equal(f.queue.read(id).status,'failed');assert.equal(f.queue.read(id).next_retry_at,null);assert.equal(f.queue.read(id).stage,'profile');assert.equal((await f.queue.runNext({manual:true})).state,'idle');assert.deepEqual(f.calls,[]);
  f.queue.enqueueCustomer(id,{manual:true,retry:true});f.provider.lookup=async(customer,{checkpoint})=>{assert.equal(checkpoint.registration.state,'ready');return ready(customer);};assert.equal((await f.queue.runNext({manual:true})).job.status,'complete');
});
