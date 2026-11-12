import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {minutesDateRange} from '../server/modules/minutes/dates.mjs';

const coreReady=()=>({summary:{state:'ready',content:'已核对摘要',reason:''},transcript:{state:'ready',content:'已核对逐字稿',reason:''},speaker_insights:{state:'unavailable',content:'',reason:'当前通道不提供'},quality:{state:'unavailable',content:'',reason:'当前通道不提供'}});
async function context(t){
  const upstream={items:[],calls:[],respond:null,artifacts:coreReady};
  const f=await fixture(t,{deployment:'production',minutesOptions:{enabled:true,clientFactory:()=>({async verify(){},async list(q){upstream.calls.push({kind:'list',...q});return upstream.respond?upstream.respond(q):{items:upstream.items,next:null};},async audio(){if(upstream.mediaError)throw Error('隔离录音接口异常');return upstream.media||{state:'unavailable',reason:'本次未提供录音'};},async artifacts(id){upstream.calls.push({kind:'artifacts',id});return upstream.artifacts(id);}})}});
  const actor=id=>one(f.db,'SELECT * FROM users WHERE id=?',id);
  const source=(member=2)=>{const id=randomUUID();run(f.db,"INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at) VALUES(?,?,?,?,'隔离听记账号','隔离组织',?,'connected','2000-01-01T00:00:00.000Z',?)",id,member,'dingIsolated'+member,'user'+member,randomUUID(),new Date().toISOString());return id;};
  const record=(sourceId,title,date='2025-10-01T02:00:00.000Z',extra={})=>Number(run(f.db,"INSERT INTO minutes_records(source_id,external_id,title,start_time,duration_ms,media_state,customer_id,opportunity_id,synced_at) VALUES(?,?,?,?,60000,?,?,?,?)",sourceId,randomUUID(),title,date,extra.media_state||'unavailable',extra.customer_id||null,extra.opportunity_id||null,new Date().toISOString()).lastInsertRowid);
  const artifact=(id,kind,state='ready')=>run(f.db,'INSERT OR REPLACE INTO minutes_artifacts(record_id,kind,state,content,reason,checked_at) VALUES(?,?,?,?,?,?)',id,kind,state,state==='ready'?'来源正文':'','隔离状态',new Date().toISOString());
  const item=(uuid,date)=>({uuid,title:uuid,startTime:Date.parse(date),durationMicros:60000000});
  return {...f,upstream,actor,source,record,artifact,item,minutes:f.service.minutes};
}
test('停用来源成员的历史可统一读取和筛选，关联可维护但不能获取新正文、录音或同步',async t=>{
  const f=await context(t),id=f.source(),r=f.record(id,'离职前的历史','2025-10-01T02:00:00.000Z');
  // Use a valid date and explicit business link for both contextual and global reads.
  run(f.db,"UPDATE minutes_records SET start_time='2025-10-01T02:00:00.000Z',customer_id=3,opportunity_id=1 WHERE id=?",r);f.artifact(r,'summary');
  run(f.db,'UPDATE users SET active=0 WHERE id=2');
  assert.equal(f.minutes.list(f.actor(1),{source_id:id}).count,1);
  const direct=f.minutes.detail(f.actor(1),r),contextual=f.minutes.detail(f.actor(1),r,{customer_id:3,opportunity_id:1});assert.equal(direct.id,contextual.id);assert.equal(direct.can_refresh,false);assert.equal(direct.can_manage,true);
  assert.throws(()=>f.minutes.detail(f.actor(3),r),e=>e.status===404);
  await assert.rejects(()=>f.minutes.sync(f.actor(1),id),e=>e.status===403);
  await assert.rejects(()=>f.minutes.prepare(f.actor(1),'refresh',r,{},()=>{}),e=>e.status===403);
  await assert.rejects(()=>f.minutes.audio(f.actor(1),r,{},undefined,()=>{}),e=>e.status===403);
  const admin=await f.login(1),saved=await f.request('/minutes/records/'+r+'/association',{actor:admin,method:'POST',body:{revision:direct.revision,customer_id:3,opportunity_id:1,reason:'保留历史业务归属'}});assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal(f.minutes.summary(f.actor(1)).sources[0].health.state,'inactive');
});
test('核心正文已完整时可选能力缺失不算失败，不再反复补拉长期不支持的项目',async t=>{
  const f=await context(t),id=f.source();f.upstream.items=[f.item('old-complete','2025-10-01T02:00:00Z')];
  assert.equal((await f.minutes.sync(f.actor(2),id,{history:true})).status,'success');
  const r=one(f.db,'SELECT * FROM minutes_records');assert.equal(f.minutes.list(f.actor(2)).records[0].content_state,'ready');
  run(f.db,"UPDATE minutes_records SET synced_at='2000-01-01T00:00:00.000Z'");run(f.db,'UPDATE minutes_sources SET collect_from=?,synced_until=?',new Date(Date.now()-86400000).toISOString(),new Date(Date.now()-60000).toISOString());
  const before=f.upstream.calls.length;assert.equal((await f.minutes.sync(f.actor(2),id,{automatic:true})).status,'success');
  assert.deepEqual(f.upstream.calls.slice(before).filter(c=>c.kind==='artifacts'),[]);assert.equal(one(f.db,'SELECT count(*) n FROM minutes_records').n,1);
});
test('真正未完成的核心正文继续补齐，状态和筛选使用同一口径',async t=>{
  const f=await context(t),id=f.source();f.upstream.items=[f.item('old-pending','2025-10-01T02:00:00Z')];f.upstream.artifacts=()=>({...coreReady(),transcript:{state:'pending',content:'',reason:'生成中'}});
  assert.equal((await f.minutes.sync(f.actor(2),id,{history:true})).status,'partial');assert.equal(f.minutes.list(f.actor(2),{content_state:'pending'}).count,1);
  run(f.db,"UPDATE minutes_records SET synced_at='2000-01-01T00:00:00.000Z'");run(f.db,'UPDATE minutes_sources SET collect_from=?,synced_until=?',new Date(Date.now()-86400000).toISOString(),new Date(Date.now()-60000).toISOString());f.upstream.artifacts=coreReady;
  assert.equal((await f.minutes.sync(f.actor(2),id,{automatic:true})).status,'success');assert.equal(f.minutes.list(f.actor(2),{content_state:'ready'}).count,1);assert.equal(f.minutes.list(f.actor(2),{content_state:'pending'}).count,0);
});
test('全部历史不会误复用上一个失败的指定日期窗口',async t=>{
  const f=await context(t),id=f.source();let fail=true;
  f.upstream.respond=q=>{if(q.cursor){if(fail)throw Error('隔离分页故障');return {items:[],next:null};}return {items:[f.item('inside','2025-10-01T02:00:00Z'),f.item('outside','2025-09-01T02:00:00Z')],next:'checkpoint'};};
  await assert.rejects(()=>f.minutes.sync(f.actor(2),id,{history:true,range:minutesDateRange('2025-10-01','2025-10-02')}));const failed=one(f.db,'SELECT * FROM minutes_sync_runs');fail=false;
  const job=f.minutes.startHistory(f.actor(2),id);assert.notEqual(job.id,failed.id);await f.minutes.shutdown();
  const saved=one(f.db,'SELECT * FROM minutes_sync_runs WHERE id=?',job.id);assert.equal(saved.from_time,'1970-01-01T00:00:00.000Z');assert.equal(saved.status,'success');assert.equal(one(f.db,'SELECT count(*) n FROM minutes_records').n,2);
});
test('任务ID重试精确恢复原日期窗口和游标，并阻止其他成员重试及运行中重复',async t=>{
  const f=await context(t),id=f.source();let fail=true;
  f.upstream.respond=q=>{if(q.cursor){if(fail)throw Error('隔离分页故障');return {items:[f.item('second','2025-10-02T02:00:00Z')],next:null};}return {items:[f.item('first','2025-10-01T02:00:00Z')],next:'checkpoint'};};
  await assert.rejects(()=>f.minutes.sync(f.actor(2),id,{history:true,range:minutesDateRange('2025-10-01','2025-10-02')}));const prior=one(f.db,'SELECT * FROM minutes_sync_runs');
  assert.throws(()=>f.minutes.retryRun(f.actor(3),prior.id),e=>e.status===404);fail=false;const before=f.upstream.calls.length,job=f.minutes.retryRun(f.actor(2),prior.id);assert.equal(job.id,prior.id);assert.throws(()=>f.minutes.retryRun(f.actor(2),prior.id),e=>e.status===409);await f.minutes.shutdown();
  const call=f.upstream.calls.slice(before).find(c=>c.kind==='list');assert.equal(call.from,prior.from_time);assert.equal(call.to,prior.to_time);assert.equal(call.cursor,prior.cursor);assert.equal(one(f.db,'SELECT count(*) n FROM minutes_sync_runs').n,1);assert.equal(one(f.db,'SELECT status FROM minutes_sync_runs').status,'success');
});
test('部分完成任务按原固定范围新建补齐任务，保留旧任务并不重复创建听记',async t=>{
  const f=await context(t),id=f.source();f.upstream.items=[f.item('one-note','2025-10-01T02:00:00Z')];f.upstream.artifacts=()=>({...coreReady(),transcript:{state:'pending',content:'',reason:'源生成中'}});
  const original=await f.minutes.sync(f.actor(2),id,{history:true,range:minutesDateRange('2025-10-01','2025-10-02')}),before=one(f.db,'SELECT * FROM minutes_sync_runs');assert.equal(original.status,'partial');
  assert.equal(f.minutes.listRuns(f.actor(2)).runs[0].can_retry,true);f.upstream.artifacts=coreReady;
  const at=f.upstream.calls.length,job=f.minutes.retryRun(f.actor(2),before.id);assert.notEqual(job.id,before.id);await f.minutes.shutdown();
  const after=one(f.db,'SELECT * FROM minutes_sync_runs WHERE id=?',job.id);assert.equal(after.from_time,before.from_time);assert.equal(after.to_time,before.to_time);assert.equal(after.status,'success');assert.equal(after.fetched,1);assert.equal(after.pages,1);assert.equal(one(f.db,'SELECT count(*) n FROM minutes_records').n,1);assert.equal(one(f.db,'SELECT status FROM minutes_sync_runs WHERE id=?',before.id).status,'partial');
  assert.equal(f.upstream.calls.slice(at).find(c=>c.kind==='list').cursor,null);
});
test('标题客户商机检索与关联正文录音过滤组合生效，普通销售结果严格限定本人',async t=>{
  const f=await context(t),a=f.source(),b=f.source(3),r=f.record(a,'采购沟通','2025-10-01T02:00:00Z',{customer_id:3,opportunity_id:1,media_state:'available'}),pending=f.record(a,'待核对沟通'),other=f.record(b,'其他销售采购沟通');f.artifact(r,'summary');f.artifact(r,'transcript');
  const customer=one(f.db,'SELECT name FROM customers WHERE id=3').name,opportunity=one(f.db,'SELECT name FROM opportunities WHERE id=1').name;
  for(const q of ['采购沟通',customer,opportunity])assert.equal(f.minutes.list(f.actor(2),{q,link_state:'linked',content_state:'ready',media_state:'available'}).count,1);
  assert.equal(f.minutes.list(f.actor(2),{link_state:'unlinked',content_state:'pending'}).count,1);assert.equal(f.minutes.list(f.actor(2)).count,2);assert.equal(f.minutes.list(f.actor(1)).count,3);
  assert.throws(()=>f.minutes.list(f.actor(2),{source_id:b}),e=>e.status===404);assert.throws(()=>f.minutes.list(f.actor(1),{content_state:'invented'}),e=>e.status===400);
});
test('同步日志按账号状态及窗口过滤和分页，结果保留可重试权限且不泄露凭据',async t=>{
  const f=await context(t),id=f.source(),other=f.source(3),now=new Date().toISOString();
  for(let n=0;n<14;n++)run(f.db,"INSERT INTO minutes_sync_runs(id,source_id,status,from_time,to_time,pages,fetched,created_at,finished_at,mode) VALUES(?,?,'failed',?,?,1,1,?,?,'history')",randomUUID(),id,n<12?'2025-10-01T00:00:00Z':'2025-09-01T00:00:00Z',n<12?'2025-10-03T00:00:00Z':'2025-09-03T00:00:00Z',now,now);
  run(f.db,"INSERT INTO minutes_sync_runs(id,source_id,status,from_time,to_time,created_at,mode) VALUES(?,?,'success','2025-10-01T00:00:00Z','2025-10-03T00:00:00Z',?,'history')",randomUUID(),other,now);
  const first=f.minutes.listRuns(f.actor(2),{status:'failed',from:'2025-10-01',to:'2025-10-02'}),second=f.minutes.listRuns(f.actor(2),{status:'failed',from:'2025-10-01',to:'2025-10-02',page:2});assert.equal(first.count,12);assert.equal(first.runs.length,10);assert.equal(second.runs.length,2);assert.ok(first.runs.every(r=>r.can_retry));assert.doesNotMatch(JSON.stringify(first),/credential_key/);
  assert.throws(()=>f.minutes.listRuns(f.actor(2),{source_id:other}),e=>e.status===404);assert.equal(f.minutes.listRuns(f.actor(2),{page:'1.5'}).page,1);
});
test('管理者能看到未连接成员，普通销售仅能看到本人接入情况与本人连接操作',async t=>{
  const f=await context(t),id=f.source();let admin=f.minutes.summary(f.actor(1));assert.equal(admin.coverage.members.find(m=>m.member_id===3).state,'unconnected');assert.equal(admin.sources[0].can_disconnect,false);assert.equal(admin.sources[0].can_sync,true);
  const personal=f.minutes.summary(f.actor(2));assert.equal(personal.coverage.members.length,1);assert.equal(personal.sources[0].can_disconnect,true);assert.doesNotMatch(JSON.stringify(personal),/credential_key/);
  run(f.db,"UPDATE minutes_sources SET connection_state='disconnected' WHERE id=?",id);admin=f.minutes.summary(f.actor(1));assert.equal(admin.sources[0].can_sync,false);assert.equal(admin.sources[0].health.state,'stopped');assert.equal(admin.coverage.members.find(m=>m.member_id===2).state,'disconnected');
});
test('同步日志及任务重试HTTP入口保留本人权限、空参数约束与幂等响应',async t=>{
  const f=await context(t),id=f.source(),owner=await f.login(2),other=await f.login(3);f.upstream.respond=()=>{throw Error('隔离首轮故障');};
  await assert.rejects(()=>f.minutes.sync(f.actor(2),id,{history:true,range:minutesDateRange('2025-10-01','2025-10-02')}));const failed=one(f.db,'SELECT * FROM minutes_sync_runs');
  const own=await f.request('/minutes/runs?status=failed',{actor:owner}),hidden=await f.request('/minutes/runs?status=failed',{actor:other});assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.count,1);assert.equal(hidden.body.count,0);
  const route='/minutes/runs/'+failed.id+'/retry';assert.equal((await f.request(route,{actor:other,method:'POST',body:{}})).status,404);assert.equal((await f.request(route,{actor:owner,method:'POST',body:{source_id:id}})).status,400);
  f.upstream.respond=()=>({items:[f.item('recovered','2025-10-01T02:00:00Z')],next:null});const key=randomUUID(),first=await f.request(route,{actor:owner,method:'POST',body:{},key});assert.equal(first.status,200,JSON.stringify(first.body));await f.minutes.shutdown();
  const repeated=await f.request(route,{actor:owner,method:'POST',body:{},key});assert.equal(repeated.status,200);assert.deepEqual(repeated.body,first.body);assert.equal(one(f.db,'SELECT count(*) n FROM minutes_records').n,1);assert.equal(all(f.db,'PRAGMA foreign_key_check').length,0);
});
test('重新读取正文同时核对录音，失败可恢复回放且错误保留已有正文，停用或断连禁止获取',async t=>{
  const f=await context(t),id=f.source(),record=f.record(id,'录音状态恢复','2025-10-01T02:00:00Z',{media_state:'failed'}),owner=await f.login(2),admin=await f.login(1);f.artifact(record,'summary');
  f.upstream.media={state:'available',url:'https://mozi-conf-tingwu.oss-cn-beijing.aliyuncs.com/isolated.mp3',reason:''};
  let response=await f.request('/minutes/records/'+record+'/refresh',{actor:owner,method:'POST',body:{}});assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(one(f.db,'SELECT media_state FROM minutes_records WHERE id=?',record).media_state,'available');
  f.upstream.mediaError=true;f.upstream.artifacts=()=>({...coreReady(),summary:{state:'failed',content:'',reason:'源摘要读取暂未完成'}});
  response=await f.request('/minutes/records/'+record+'/refresh',{actor:owner,method:'POST',body:{}});assert.equal(response.status,200);assert.match(response.body.message,/录音本次读取未完成/);assert.equal(one(f.db,'SELECT media_state FROM minutes_records WHERE id=?',record).media_state,'failed');assert.equal(one(f.db,"SELECT content FROM minutes_artifacts WHERE record_id=? AND kind='summary'",record).content,'已核对摘要');
  run(f.db,"UPDATE minutes_sources SET connection_state='disconnected' WHERE id=?",id);assert.equal((await f.request('/minutes/records/'+record+'/refresh',{actor:owner,method:'POST',body:{}})).status,409);
  run(f.db,"UPDATE minutes_sources SET connection_state='connected' WHERE id=?",id);run(f.db,'UPDATE users SET active=0 WHERE id=2');assert.equal((await f.request('/minutes/records/'+record+'/refresh',{actor:admin,method:'POST',body:{}})).status,403);
});
