import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase,all,one,run} from '../server/database.mjs';
import {seedDemo} from '../server/seed.mjs';
import {createMinutesService} from '../server/modules/minutes/service.mjs';
import {minutesIncrementalFrom,minutesSourceSchedule} from '../server/modules/minutes/schedule.mjs';
import {minutesPage} from '../public/modules/minutes.js';

const minute=60000,day=86400000,at=Date.parse('2026-11-11T02:00:00Z');
const ready=()=>Object.fromEntries(['summary','speaker_insights','quality','transcript'].map(k=>[k,{state:'ready',content:k==='summary'?'接口更新后的总结':'完整来源正文',reason:''}]));
async function context(t,options={}){
  t.mock.timers.enable({apis:['Date','setInterval'],now:at});
  const db=openDatabase(':memory:');seedDemo(db);
  const upstream={calls:[],items:[],fail:new Set(),hold:null,artifacts:ready};
  const clientFactory=s=>({
    async verify(){upstream.calls.push({kind:'verify',source:s.id});if(upstream.fail.has(s.id))throw new Error('isolated provider unavailable');},
    async list(q){upstream.calls.push({kind:'list',source:s.id,...q});if(upstream.hold)await upstream.hold;return upstream.respond?upstream.respond(q,s):{items:upstream.items,next:null};},
    async artifacts(id){upstream.calls.push({kind:'artifacts',source:s.id,id});return upstream.artifacts(id);},
    async audio(){return {state:'unavailable',reason:'源未提供录音'};},
  });
  const settings={enabled:true,deployment:'production',clientFactory,...options};
  let service=createMinutesService(db,settings);
  t.after(async()=>{await service.shutdown();db.close();});
  const add=(member=2,extra={})=>{const id=randomUUID();run(db,"INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at) VALUES(?,?,?,?,?,?,?,'connected',?,?)",id,member,'dingIsolated'+member,'account'+member,'隔离账号'+member,'隔离组织',randomUUID(),extra.collect_from||'2026-10-01T00:00:00.000Z',new Date(at-day).toISOString());return id;};
  const actor=member=>one(db,'SELECT * FROM users WHERE id=?',member);
  const item=(id='new-note',start=at-minute)=>({uuid:id,title:'接口测试听记',startTime:start,durationMicros:60000000});
  const restart=async()=>{await service.shutdown();service=createMinutesService(db,settings);service.recover();return service;};
  return {db,upstream,add,actor,item,restart,get service(){return service;}};
}

test('定时执行不依赖浏览器登录，启动补拉且重复启动和同周期调用不会重复采集',async t=>{
  const f=await context(t),id=f.add();f.upstream.items=[f.item()];
  const stop=f.service.startScheduler();f.service.startScheduler();await f.service.scheduledSync();
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,1);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sync_runs').n,1);
  assert.equal(one(f.db,"SELECT user_id FROM audit WHERE action IN('听记接口采集','听记历史接口采集')").user_id,null);
  await f.service.scheduledSync();t.mock.timers.tick(minute);await f.service.scheduledSync();assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sync_runs').n,1);
  t.mock.timers.tick(4*minute);await f.service.scheduledSync();assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sync_runs').n,2);
  assert.equal(f.service.summary(f.actor(2)).sources[0].schedule.state,'scheduled');stop();
  const before=f.upstream.calls.length;t.mock.timers.tick(20*minute);await f.service.scheduledSync();assert.equal(f.upstream.calls.length,before);
  assert.equal(one(f.db,'SELECT source_id FROM minutes_records').source_id,id);
});

test('本地定时入口与执行器都拒绝真实自动采集，连接器缺失也不启动任务',async t=>{
  const f=await context(t,{deployment:'local'}),id=f.add();f.service.startScheduler();assert.equal((await f.service.scheduledSync()).status,'skipped');
  await assert.rejects(()=>f.service.sync(f.actor(2),id,{automatic:true}),/本地禁止/);t.mock.timers.tick(day);assert.equal(f.upstream.calls.length,0);
  const summary=f.service.summary(f.actor(2));assert.equal(summary.automatic,false);assert.equal(summary.sources[0].schedule.state,'local');assert.equal(summary.sources[0].schedule.next_update_at,null);
  const disabled=createMinutesService(f.db,{enabled:false,deployment:'production',clientFactory:()=>{assert.fail('disabled connector was invoked');}});disabled.startScheduler();assert.equal((await disabled.scheduledSync()).status,'skipped');await disabled.shutdown();
});

test('全量完成后的增量复核覆盖连接前近期听记，更新原记录并保留人工关联',async t=>{
  const f=await context(t),id=f.add(2,{collect_from:new Date(at-minute).toISOString()});
  f.upstream.items=[f.item('before-connection',at-2*day)];await f.service.scheduledSync();
  const saved=one(f.db,'SELECT * FROM minutes_records');assert.ok(saved);run(f.db,'UPDATE minutes_records SET customer_id=3,opportunity_id=1,revision=9 WHERE id=?',saved.id);
  f.upstream.artifacts=()=>Object.fromEntries(Object.entries(ready()).map(([k,a])=>[k,{...a,content:'连接前听记的后续正文'}]));
  t.mock.timers.tick(5*minute);await f.service.scheduledSync();
  const call=f.upstream.calls.filter(c=>c.kind==='list').at(-1);assert.equal(call.from,'2026-11-08T16:00:00.000Z');
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,1);const kept=one(f.db,'SELECT * FROM minutes_records');assert.equal(kept.id,saved.id);assert.equal(kept.revision,9);assert.equal(kept.opportunity_id,1);
  assert.equal(one(f.db,"SELECT content FROM minutes_artifacts WHERE record_id=? AND kind='summary'",saved.id).content,'连接前听记的后续正文');
});

test('失败分页自动续读原窗口及游标，重启保留页面和水位，后续周期追上停机后的新数据',async t=>{
  const f=await context(t),id=f.add();let fail=true;
  f.upstream.respond=q=>{if(q.cursor&&fail)throw new Error('isolated page outage');return q.cursor?{items:[f.item('second')],next:null}:{items:[f.item('first')],next:'next-page'};};
  await f.service.scheduledSync();const failed=one(f.db,'SELECT * FROM minutes_sync_runs');assert.equal(failed.status,'failed');assert.equal(failed.pages,1);assert.equal(failed.cursor,'next-page');assert.equal(one(f.db,'SELECT synced_until FROM minutes_sources').synced_until,null);
  run(f.db,"UPDATE minutes_sync_runs SET status='running',finished_at=NULL,error_message='' WHERE id=?",failed.id); // Simulate a crash after a committed page.
  await f.restart();assert.match(one(f.db,'SELECT error_message FROM minutes_sync_runs').error_message,/已保存进度/);fail=false;t.mock.timers.tick(5*minute);const before=f.upstream.calls.length;await f.service.scheduledSync();
  const call=f.upstream.calls.slice(before).find(c=>c.kind==='list');assert.equal(call.cursor,'next-page');assert.equal(call.from,failed.mode==='history'?null:failed.from_time);assert.equal(call.to,failed.to_time);
  const rows=all(f.db,'SELECT * FROM minutes_sync_runs ORDER BY rowid');assert.equal(rows.length,2);assert.equal(rows[0].status,'failed');assert.equal(rows[1].status,'success');assert.equal(rows[1].pages,2);assert.equal(rows[1].fetched,2);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,2);assert.equal(one(f.db,'SELECT synced_until FROM minutes_sources').synced_until,failed.to_time);
  f.upstream.respond=null;f.upstream.items=[f.item('after-outage',Date.now()-minute)];t.mock.timers.tick(5*minute);await f.service.scheduledSync();assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,3);assert.equal(one(f.db,'SELECT synced_until FROM minutes_sources').synced_until,new Date().toISOString());
});

test('一个账号失败不阻挡其他账号，失败退避保存在运行记录且重启后不重置',async t=>{
  const f=await context(t),bad=f.add(2),good=f.add(3);f.upstream.fail.add(bad);f.upstream.items=[f.item()];
  await f.service.scheduledSync();assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records WHERE source_id=?',good).n,1);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records WHERE source_id=?',bad).n,0);
  t.mock.timers.tick(5*minute);await f.service.scheduledSync();assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sync_runs WHERE source_id=?',bad).n,2);
  await f.restart();t.mock.timers.tick(5*minute);await f.service.scheduledSync();assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sync_runs WHERE source_id=?',bad).n,2);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sync_runs WHERE source_id=?',good).n,3);
  const status=f.service.summary(f.actor(2));assert.equal(status.sources.length,1);assert.equal(status.sources[0].schedule.state,'retrying');assert.match(status.sources[0].schedule.last_error,/未完成/);assert.ok(!JSON.stringify(status).includes(good));
  f.upstream.fail.delete(bad);t.mock.timers.tick(5*minute);await f.service.scheduledSync();assert.equal(one(f.db,'SELECT status FROM minutes_sync_runs WHERE source_id=? ORDER BY rowid DESC LIMIT 1',bad).status,'success');
});

test('上游分页游标持续失效时自动重读原窗口，已保存听记不丢失也不重复',async t=>{
  const f=await context(t),id=f.add();let expired=true;
  f.upstream.respond=q=>{if(q.cursor&&expired)throw new Error('isolated expired cursor');return q.cursor?{items:[f.item('second')],next:null}:{items:[f.item('first')],next:expired?'expired-checkpoint':'fresh-checkpoint'};};
  await f.service.scheduledSync();t.mock.timers.tick(5*minute);await f.service.scheduledSync();assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,1);
  expired=false;t.mock.timers.tick(10*minute);const before=f.upstream.calls.length;await f.service.scheduledSync();
  const lists=f.upstream.calls.slice(before).filter(c=>c.kind==='list');assert.equal(lists[0].cursor,null);assert.equal(lists[1].cursor,'fresh-checkpoint');
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,2);assert.equal(one(f.db,'SELECT status FROM minutes_sync_runs WHERE source_id=? ORDER BY rowid DESC LIMIT 1',id).status,'success');
});

test('已导入的较早听记仍轮流补齐正文，每轮有上限并保留人工关联及唯一跟进',async t=>{
  const f=await context(t),id=f.add(),old='2026-09-01T00:00:00.000Z';
  for(let n=0;n<6;n++){
    const r=Number(run(f.db,"INSERT INTO minutes_records(source_id,external_id,title,start_time,duration_ms,media_state,customer_id,opportunity_id,revision,synced_at) VALUES(?,?,?,?,0,'unavailable',3,1,2,?)",id,'old-'+n,'历史听记',old,old).lastInsertRowid);
    run(f.db,"INSERT INTO minutes_artifacts(record_id,kind,state,content,reason,checked_at) VALUES(?,'summary','pending','','生成中',?)",r,old);
  }
  await f.service.scheduledSync();assert.equal(f.upstream.calls.filter(c=>c.kind==='artifacts').length,5);assert.equal(one(f.db,"SELECT COUNT(*) n FROM minutes_artifacts WHERE kind='summary' AND state='ready'").n,5);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM activities WHERE minutes_record_id IS NOT NULL').n,5);assert.ok(all(f.db,'SELECT * FROM minutes_records').every(r=>r.customer_id===3&&r.opportunity_id===1&&r.revision===2));
  t.mock.timers.tick(5*minute);await f.service.scheduledSync();assert.equal(one(f.db,"SELECT COUNT(*) n FROM minutes_artifacts WHERE kind='summary' AND state='ready'").n,6);assert.equal(one(f.db,'SELECT COUNT(*) n FROM activities WHERE minutes_record_id IS NOT NULL').n,6);
});

test('定时采集与手动采集互斥，停用成员和停止连接不再更新，shutdown等待已有任务',async t=>{
  const f=await context(t),id=f.add();let release;f.upstream.hold=new Promise(r=>release=r);
  const pending=f.service.scheduledSync();await new Promise(r=>setImmediate(r));
  assert.equal(f.service.summary(f.actor(2)).sources[0].schedule.state,'running');await assert.rejects(()=>f.service.sync(f.actor(2),id),/正在采集/);
  let closed=false;const closing=f.service.shutdown().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);release();await pending;await closing;assert.equal(closed,true);
  await f.restart();run(f.db,"UPDATE minutes_sources SET connection_state='disconnected'");t.mock.timers.tick(5*minute);const before=f.upstream.calls.length;await f.service.scheduledSync();assert.equal(f.upstream.calls.length,before);
  run(f.db,"UPDATE minutes_sources SET connection_state='connected'");run(f.db,'UPDATE users SET active=0 WHERE id=2');await f.service.scheduledSync();assert.equal(f.upstream.calls.length,before);
});

test('停止或换绑发生在接口返回期间时拒绝保存，定时任务继续遵守账号归属',async t=>{
  const f=await context(t),id=f.add();let release;f.upstream.hold=new Promise(r=>release=r);f.upstream.items=[f.item()];
  const pending=f.service.scheduledSync();await new Promise(r=>setImmediate(r));run(f.db,'UPDATE minutes_sources SET credential_key=? WHERE id=?',randomUUID(),id);release();await pending;
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,0);assert.equal(one(f.db,'SELECT status FROM minutes_sync_runs').status,'failed');
});

test('近期核对覆盖周末延迟内容及长时间停机缺口，保持首次连接时间边界',()=>{
  const monday=Date.parse('2026-11-09T02:00:00Z'),s={collect_from:'2026-10-01T00:00:00.000Z',synced_until:'2026-11-09T01:00:00.000Z'};
  assert.equal(minutesIncrementalFrom(s,monday,{automatic:true}),'2026-11-01T16:00:00.000Z');assert.equal(minutesIncrementalFrom({...s,synced_until:new Date(at-minute).toISOString()},at,{automatic:true}),'2026-11-08T16:00:00.000Z');
  assert.equal(minutesIncrementalFrom({...s,synced_until:'2026-10-10T00:00:00.000Z'},at,{automatic:true}),'2026-10-09T00:00:00.000Z');
  assert.equal(minutesIncrementalFrom({...s,collect_from:'2026-11-11T01:00:00.000Z'},at,{automatic:true}),'2026-11-11T01:00:00.000Z');
  const runs=Array.from({length:6},()=>({status:'failed',finished_at:new Date(at).toISOString()}));assert.equal(minutesSourceSchedule(runs,{automatic:true,configured:true,connected:true,at}).next_update_at,new Date(at+60*minute).toISOString());
});

test('更新状态保留在接口，日常听记页隐藏连接区域且失败记录经过转义',async t=>{
  const f=await context(t),id=f.add();f.upstream.fail.add(id);await f.service.scheduledSync();
  run(f.db,"UPDATE minutes_sync_runs SET error_message='<script>source secret</script>'");
  const S={actor:f.actor(2),users:[f.actor(2)],minutes:f.service.summary(f.actor(2))};
  let html=minutesPage(S,{minutesTab:'runs'});assert.equal(S.minutes.sources[0].schedule.state,'retrying');assert.doesNotMatch(html,/钉钉账号连接|下次更新/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
  S.minutes.sources[0].schedule={state:'local',next_update_at:null,last_error:''};html=minutesPage(S,{});assert.doesNotMatch(html,/本地预览 · 定时更新在服务器运行/);assert.doesNotMatch(html,/下次更新/);
});
