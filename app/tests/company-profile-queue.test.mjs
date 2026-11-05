import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,one,all,run} from '../server/database.mjs';
import {createCompanyProfileQueue,nextCompanyQuotaRetry} from '../server/company-profile-queue.mjs';
import {migrateCompanyProfileQueue} from '../server/company-profile-queue-schema.mjs';
import {companyIdentity} from '../server/company-profile.mjs';

const checkpoint=customer=>({version:1,provider:'qcc-mcp',identity:{name:customer.name,credit_code:customer.credit_code},registration:{state:'ready',details:{company_name:customer.name,business_scope:'工商登记范围'},checked_at:'2026-11-02T00:00:00Z'}});
const ready=customer=>({state:'ready',complete:true,details:{company_name:customer.name,main_products:'已返回的产品'},reason:'源资料已完整核验'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,{filename=':memory:',...options}={}) {
  const db=openDatabase(filename);t.after(()=>db.close());
  run(db,"INSERT INTO users(id,name,username,role,created_at) VALUES(1,'隔离销售','queue-test','sales','2026-11-02T00:00:00Z')");
  let clock=Date.parse('2026-11-02T00:00:00Z');const commits=[];
  const provider={configured:true,lookup:async customer=>ready(customer)};
  const q=createCompanyProfileQueue({db,provider,clock:()=>clock,commitResult:(customer,result)=>commits.push({customer,result}),...options});
  const insert=(name='隔离企业')=>Number(run(db,"INSERT INTO customers(name,normalized,owner_id,created_at,updated_at) VALUES(?,?,1,'2026-11-02T00:00:00Z','2026-11-02T00:00:00Z')",name,name).lastInsertRowid);
  return {db,q,provider,insert,commits,time:value=>{clock=typeof value==='string'?Date.parse(value):value;}};
}

test('客户直SQL新增及主体实质变化入队，格式变化/普通资料更新不重复排队',t=>{
  const f=fixture(t),id=f.insert('测试（上海）有限公司');assert.equal(f.q.read(id).status,'pending');assert.equal(f.q.read(id).identity_version,1);
  run(f.db,'UPDATE customers SET name=?,note=? WHERE id=?',' 测试(上海)有限公司 ','普通维护',id);assert.equal(f.q.read(id).identity_version,1);
  run(f.db,'UPDATE customers SET credit_code=? WHERE id=?','913ABC',id);assert.equal(f.q.read(id).identity_version,2);
  run(f.db,'UPDATE customers SET credit_code=? WHERE id=?',' 913abc ',id);assert.equal(f.q.read(id).identity_version,2);
  run(f.db,'UPDATE customers SET name=? WHERE id=?','另一个真实主体',id);assert.equal(f.q.read(id).identity_version,3);f.q.enqueueAll();f.q.enqueueAll();assert.equal(f.q.summary().total,1);
});

test('本地默认不自动运行，只有显式manual或完整已核验授权例外允许，生产允许自动',async t=>{
  const f=fixture(t);f.insert();assert.equal((await f.q.runNext()).state,'disabled');assert.equal(f.q.read(1).attempts,0);
  for(const localAutomation of [{authorized:true},{authorized:true,scope:'qianfan-company-profile'},{authorized:true,runtimeChecked:true,scope:'other'}]) {
    const q=createCompanyProfileQueue({db:f.db,provider:f.provider,localAutomation});assert.equal((await q.runNext()).state,'disabled');
  }
  const allowed=createCompanyProfileQueue({db:f.db,provider:f.provider,localAutomation:{authorized:true,runtimeChecked:true,scope:'qianfan-company-profile'}});assert.equal((await allowed.runNext()).job.status,'complete');
  f.insert('正式环境隔离企业');const production=createCompanyProfileQueue({db:f.db,provider:f.provider,deployment:'production'});assert.equal((await production.runNext()).job.status,'complete');
  f.insert('手动隔离企业');assert.equal((await f.q.runNext({manual:true})).job.status,'complete');
});

test('同主体任务持久去重；单个租约覆盖并行worker，回调仅在同步短事务内',async t=>{
  const entered=deferred(),done=deferred();let calls=0;const f=fixture(t);const id=f.insert();
  f.provider.lookup=async customer=>{calls++;entered.resolve();await done.promise;return ready(customer);};
  const other=createCompanyProfileQueue({db:f.db,provider:f.provider,clock:()=>Date.parse('2026-11-02T00:00:00Z'),commitResult:()=>assert.equal(f.db.isTransaction,true)});
  const running=other.runNext({manual:true});await entered.promise;assert.equal((await f.q.runNext({manual:true})).state,'busy');done.resolve();assert.equal((await running).job.status,'complete');assert.equal(calls,1);
  f.q.enqueueAll();assert.equal((await f.q.runNext({manual:true})).state,'idle');assert.equal(f.q.read(id).attempts,1);
});

test('额度不足全局暂停；工商checkpoint落盘，重开数据库次日只补简介',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qf-queue-'));
  const filename=path.join(directory,'isolated.sqlite'),f=fixture(t,{filename});f.insert();f.insert('下一企业');let calls=0;
  f.provider.lookup=async(customer,{onCheckpoint})=>{calls++;const saved=checkpoint(customer);await onCheckpoint(saved);throw Object.assign(new Error('Bearer should-not-be-stored'),{code:'QCC_QUOTA_EXHAUSTED',checkpoint:saved,partialResult:{state:'partial',details:saved.registration.details}});};
  const first=await f.q.runNext({manual:true});assert.equal(first.job.status,'waiting_quota');assert.equal(first.job.stage,'profile');assert.equal(f.q.summary().estimated_remaining_credits,5);assert.equal(f.commits[0].result.state,'partial');
  assert.equal((await f.q.runNext({manual:true})).state,'waiting_quota');assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(all(f.db,'SELECT * FROM company_profile_jobs')),/Bearer|should-not/);
  const reopened=openDatabase(filename);t.after(()=>reopened.close());t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let resumed=0;
  const q=createCompanyProfileQueue({db:reopened,clock:()=>Date.parse('2026-11-02T18:05:01Z'),provider:{configured:true,lookup:async(customer,{checkpoint:prior,onCheckpoint})=>{resumed++;assert.equal(prior.registration.state,'ready');const next={...prior,profile:{state:'ready',details:{main_products:'简介产品'}}};await onCheckpoint(next);return {...ready(customer),checkpoint:next};}}});
  assert.equal((await q.runNext({manual:true})).job.status,'complete');assert.equal(resumed,1);assert.equal(q.summary().estimated_remaining_credits,4);assert.equal(nextCompanyQuotaRetry('2026-11-02T15:59:59Z'),'2026-11-02T18:05:00.000Z');
});

test('非额度错误退避有上限，人工主体/授权/响应问题不自动无限重试',async t=>{
  const f=fixture(t);f.insert();let calls=0;f.provider.lookup=async()=>{calls++;throw Object.assign(new Error('private upstream'),{code:'QCC_TRANSIENT'});};
  assert.equal((await f.q.runNext({manual:true})).job.status,'failed');assert.equal(f.q.read(1).retry_count,1);assert.equal((await f.q.runNext({manual:true})).state,'idle');
  f.time('2026-11-02T00:01:01Z');await f.q.runNext({manual:true});f.time('2026-11-02T00:06:02Z');await f.q.runNext({manual:true});assert.equal(calls,3);assert.equal(f.q.read(1).next_retry_at,null);f.time('2026-11-10T00:00:00Z');assert.equal((await f.q.runNext({manual:true})).state,'idle');
  for(const code of ['QCC_IDENTITY_REQUIRED','QCC_AUTH_INVALID','QCC_RESPONSE_INVALID']) {f.q.enqueueAll({retryAuth:true});f.q.enqueueCustomer(1,{retry:true});f.provider.lookup=async()=>{throw Object.assign(new Error('secret-value'),{code});};const r=await f.q.runNext({manual:true});assert.equal(r.job.next_retry_at,null);assert.equal((await f.q.runNext({manual:true})).state,code==='QCC_AUTH_INVALID'?'paused':'idle');assert.doesNotMatch(JSON.stringify(r),/secret-value/);}
});

test('运行时主体改变拒绝旧checkpoint和旧结果，下一任务从新主体开始',async t=>{
  const entered=deferred(),done=deferred(),f=fixture(t);const id=f.insert('旧企业');
  f.provider.lookup=async(customer,{onCheckpoint})=>{entered.resolve();await done.promise;await onCheckpoint(checkpoint(customer));return ready(customer);};
  const first=f.q.runNext({manual:true});await entered.promise;run(f.db,'UPDATE customers SET name=? WHERE id=?','新企业',id);done.resolve();await first;assert.equal(f.commits.length,0);assert.equal(f.q.read(id).status,'pending');
  f.provider.lookup=async(customer,{checkpoint:prior})=>{assert.equal(customer.name,'新企业');assert.deepEqual(prior,{});return ready(customer);};await f.q.runNext({manual:true});assert.equal(f.commits.length,1);assert.equal(f.q.read(id).identity_fingerprint,companyIdentity({name:'新企业',credit_code:''}));
});

test('租约过期可以恢复持久checkpoint，旧租约迟到结果不覆盖新任务',async t=>{
  const f=fixture(t,{leaseMs:1000}),entered=deferred(),done=deferred();f.insert();
  f.provider.lookup=async(customer,{onCheckpoint})=>{await onCheckpoint(checkpoint(customer));entered.resolve();await done.promise;return ready(customer);};
  const first=f.q.runNext({manual:true});await entered.promise;f.time('2026-11-02T00:00:02Z');
  const other=createCompanyProfileQueue({db:f.db,clock:()=>Date.parse('2026-11-02T00:00:02Z'),provider:{configured:true,lookup:async(customer,{checkpoint:prior})=>{assert.equal(prior.registration.state,'ready');return ready(customer);}},commitResult:(customer,result)=>f.commits.push({customer,result})});
  await other.runNext({manual:true});done.resolve();await first;assert.equal(f.commits.length,1);assert.equal(other.read(1).status,'complete');
});

test('主体冲突和未找到是明确终态，部分结果不能冒充完整读取',async t=>{
  const f=fixture(t);f.insert();
  for(const state of ['mismatch','not_found','partial']) {f.q.enqueueCustomer(1,{retry:true});f.provider.lookup=async()=>({state,complete:false,details:{},reason:'需要核对'});const r=await f.q.runNext({manual:true});assert.equal(r.job.status,state);assert.equal(r.job.complete,false);assert.equal((await f.q.runNext({manual:true})).state,'idle');assert.equal(f.q.summary().estimated_remaining_credits,0);}
});

test('持久checkpoint拒绝凭据字段，异步落库callback被拒绝且事务回滚',async t=>{
  const f=fixture(t);f.insert();f.provider.lookup=async(customer,{onCheckpoint})=>{await onCheckpoint({...checkpoint(customer),apiKey:'private-secret'});return ready(customer);};await f.q.runNext({manual:true});assert.equal(one(f.db,'SELECT checkpoint FROM company_profile_jobs').checkpoint,'{}');assert.doesNotMatch(JSON.stringify(all(f.db,'SELECT * FROM company_profile_jobs')),/private-secret/);
  f.q.enqueueCustomer(1,{retry:true});const bad=createCompanyProfileQueue({db:f.db,provider:{configured:true,lookup:async customer=>ready(customer)},commitResult:()=>{run(f.db,"UPDATE customers SET note='must-roll-back' WHERE id=1");return Promise.resolve();}});await bad.runNext({manual:true});assert.notEqual(one(f.db,'SELECT note FROM customers WHERE id=1').note,'must-roll-back');
});

test('schema25迁移保留已有企业详情、全量客户入队并支持partial，失败完整回滚',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(24);CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,credit_code TEXT);INSERT INTO customers VALUES(1,'原企业','');CREATE TABLE workspace_revision(id INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO workspace_revision VALUES(1,1);CREATE TABLE customer_profiles(customer_id INTEGER PRIMARY KEY REFERENCES customers(id),state TEXT,provider TEXT,source_url TEXT,details TEXT,reason TEXT,checked_at TEXT,identity_fingerprint TEXT);INSERT INTO customer_profiles VALUES(1,'ready','原来源','原链接','{\"name\":\"原企业\"}','原说明','2026-10-01','原指纹');CREATE TRIGGER forced_v25 BEFORE INSERT ON schema_version WHEN NEW.version=25 BEGIN SELECT RAISE(ABORT,'forced-v25'); END;");
    const before=all(db,'SELECT * FROM customer_profiles');assert.throws(()=>migrateCompanyProfileQueue(db),/forced-v25/);assert.deepEqual(all(db,'SELECT * FROM customer_profiles'),before);assert.equal(one(db,"SELECT name FROM sqlite_master WHERE name='company_profile_jobs'"),undefined);
    db.exec('DROP TRIGGER forced_v25');migrateCompanyProfileQueue(db);assert.deepEqual(all(db,'SELECT * FROM customer_profiles'),before);assert.equal(one(db,'SELECT COUNT(*) n FROM company_profile_jobs').n,1);run(db,"UPDATE customer_profiles SET state='partial' WHERE customer_id=1");migrateCompanyProfileQueue(db);assert.equal(one(db,'SELECT COUNT(*) n FROM company_profile_jobs').n,1);
  }finally{db.close();}
});

test('官方02点赠送后续查，凌晨额度不足可同日02:05而非多等一天',()=>{
  assert.equal(nextCompanyQuotaRetry('2026-11-02T15:59:59Z'),'2026-11-02T18:05:00.000Z');
  assert.equal(nextCompanyQuotaRetry('2026-11-02T16:30:00Z'),'2026-11-02T18:05:00.000Z');
  assert.equal(nextCompanyQuotaRetry('2026-11-02T18:05:00Z'),'2026-11-03T18:05:00.000Z');
  assert.equal(nextCompanyQuotaRetry('2026-12-31T18:06:00Z'),'2027-01-01T18:05:00.000Z');
});

test('手动高优先级先查，partial重试保留checkpoint，complete强制刷新清checkpoint',async t=>{
  const f=fixture(t);const low=f.insert('低优先'),high=f.insert('手动高优先');f.q.enqueueCustomer(high,{priority:100});
  const visited=[];f.provider.lookup=async(customer,{onCheckpoint,checkpoint:prior})=>{visited.push({id:customer.id,prior});const saved={...checkpoint(customer),profile:{state:'ready',details:{main_products:'源产品'}}};await onCheckpoint(saved);return {...ready(customer),checkpoint:saved};};
  await f.q.runNext({manual:true});assert.equal(visited[0].id,high);assert.equal(f.q.read(low).status,'pending');f.q.enqueueAll();assert.equal(f.q.read(high).status,'complete');
  f.q.enqueueCustomer(high,{retry:true,priority:100,force:true});await f.q.runNext({manual:true});assert.deepEqual(visited[1].prior,{});
  f.q.enqueueCustomer(high,{retry:true});await f.q.runNext({manual:true});assert.equal(visited[2].prior.profile.state,'ready');
});

test('ready缺complete:true不标成完成，主体改变不显示旧工商阶段或扣减旧步骤成本',async t=>{
  const f=fixture(t);f.insert('原主体');f.provider.lookup=async(customer,{onCheckpoint})=>{await onCheckpoint(checkpoint(customer));return {state:'ready',details:{},reason:'不完整'};};
  const result=await f.q.runNext({manual:true});assert.equal(result.job.status,'partial');assert.equal(result.job.error_code,'QCC_RESPONSE_INVALID');assert.equal(result.job.complete,false);
  run(f.db,"UPDATE customers SET name='另一主体' WHERE id=1");assert.equal(f.q.read(1).stage,'registration');assert.equal(f.q.summary().estimated_remaining_credits,4);
});

test('旧主体请求返回额度不足也全局暂停，不覆盖新主体任务',async t=>{
  const f=fixture(t),entered=deferred(),done=deferred();f.insert();f.insert('其他客户');
  f.provider.lookup=async()=>{entered.resolve();await done.promise;throw Object.assign(new Error('not persisted'),{code:'QCC_QUOTA_EXHAUSTED'});};
  const running=f.q.runNext({manual:true});await entered.promise;run(f.db,"UPDATE customers SET name='更新主体' WHERE id=1");done.resolve();await running;
  assert.equal(f.q.read(1).status,'pending');assert.equal((await f.q.runNext({manual:true})).state,'waiting_quota');assert.equal(f.commits.length,0);
});

test('全量入队可加入API已有短事务，成功由外层提交，失败由外层完整回滚',t=>{
  const f=fixture(t);f.insert();run(f.db,'DELETE FROM company_profile_jobs');
  f.db.exec('BEGIN IMMEDIATE');
  try{const result=f.q.enqueueAll();assert.equal(f.db.isTransaction,true);assert.equal(result.counts.total,1);assert.equal(f.q.read(1).status,'pending');f.db.exec('ROLLBACK');}catch(error){if(f.db.isTransaction)f.db.exec('ROLLBACK');throw error;}
  assert.equal(f.q.read(1),null);
  f.db.exec('BEGIN IMMEDIATE');try{f.q.enqueueAll();assert.equal(f.db.isTransaction,true);f.db.exec('COMMIT');}catch(error){if(f.db.isTransaction)f.db.exec('ROLLBACK');throw error;}
  assert.equal(f.q.read(1).status,'pending');assert.equal(f.q.summary().counts.total,1);
});

test('认证错误暂停整个账号，启动不清暂停，明确人工重试恢复且保留工商检查点',async t=>{
  const f=fixture(t);f.insert();f.insert('后续客户');let calls=0;
  f.provider.lookup=async(customer,{onCheckpoint})=>{calls++;await onCheckpoint(checkpoint(customer));throw Object.assign(new Error('sensitive-auth-error'),{code:'QCC_AUTH_INVALID'});};
  assert.equal((await f.q.runNext({manual:true})).job.status,'partial');
  assert.match(f.q.summary().pause_reason,/授权无效/);assert.doesNotMatch(f.q.summary().pause_reason,/QCC_/);assert.equal(f.q.summary().next_retry_at,null);
  f.q.enqueueAll();f.time('2027-01-01T00:00:00Z');assert.equal((await f.q.runNext({manual:true})).state,'paused');assert.equal(calls,1);assert.equal(f.q.read(2).attempts,0);
  f.q.enqueueAll({retryAuth:true});assert.equal(f.q.summary().pause_reason,'');
  f.provider.lookup=async(customer,{checkpoint:prior})=>{assert.equal(prior.registration.state,'ready');return ready(customer);};
  assert.equal((await f.q.runNext({manual:true})).job.status,'complete');
});

test('认证人工恢复不越过额度暂停，429仅有限退避而不暂停其他客户',async t=>{
  const f=fixture(t);f.insert();f.insert('另一个客户');let calls=0;
  f.provider.lookup=async()=>{calls++;throw Object.assign(new Error('quota'),{code:'QCC_QUOTA_EXHAUSTED'});};
  await f.q.runNext({manual:true});const next=f.q.summary().next_retry_at;
  f.q.enqueueAll({retryAuth:true});assert.equal((await f.q.runNext({manual:true})).state,'waiting_quota');assert.equal(calls,1);assert.equal(f.q.summary().next_retry_at,next);assert.match(f.q.summary().pause_reason,/积分不足/);
  run(f.db,"UPDATE company_profile_queue_control SET pause_reason='QCC_AUTH_INVALID' WHERE id=1");
  f.q.enqueueAll({retryAuth:true});assert.equal((await f.q.runNext({manual:true})).state,'waiting_quota');assert.equal(f.q.summary().next_retry_at,next);
  f.time('2026-11-02T18:05:01Z');f.provider.lookup=async()=>{throw Object.assign(new Error('rate limit'),{code:'QCC_RATE_LIMITED'});};
  const limited=await f.q.runNext({manual:true});assert.equal(limited.job.status,'failed');assert.ok(limited.job.next_retry_at);assert.equal(f.q.summary().pause_reason,'');
  f.provider.lookup=async customer=>ready(customer);assert.equal((await f.q.runNext({manual:true})).job.customer_id,2);
});

test('外部SQLite直接导入客户无需应用函数且优先历史队列，人工任务仍优先',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qf-queue-sql-')),filename=path.join(directory,'isolated.sqlite'),f=fixture(t,{filename});
  f.insert('历史待查客户');run(f.db,'UPDATE company_profile_jobs SET priority=0');
  const external=new DatabaseSync(filename);try{external.exec("INSERT INTO customers(name,normalized,owner_id,created_at,updated_at) VALUES('SQL新客户','SQL新客户',1,'2026-11-02','2026-11-02')");}finally{external.close();}
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  assert.equal(one(f.db,'SELECT priority FROM company_profile_jobs WHERE customer_id=2').priority,50);
  assert.equal((await f.q.runNext({manual:true})).job.customer_id,2);
  const manual=f.insert('人工优先客户');f.q.enqueueCustomer(manual,{priority:100});assert.equal((await f.q.runNext({manual:true})).job.customer_id,manual);
  run(f.db,"UPDATE customers SET name='历史主体已变化' WHERE id=1");assert.equal(one(f.db,'SELECT priority FROM company_profile_jobs WHERE customer_id=1').priority,50);
});
