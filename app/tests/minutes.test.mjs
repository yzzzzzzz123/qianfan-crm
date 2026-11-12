import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fixture} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {createMinutesService} from '../server/modules/minutes/service.mjs';
import {parseMinutesSummary,parseTranscriptionPage} from '../server/modules/minutes/content.mjs';
import {createMinutesClient,readSavedMinutesIdentity,readSavedMinutesProfiles} from '../server/modules/minutes/client.mjs';
import {safeMinutesAudio,fetchMinutesAudio} from '../server/modules/minutes/recordings.mjs';
import {renderPage,shell,opportunityDetail,customerDetail} from '../public/views.js';

async function context(t){
  const start=Date.UTC(2026,10,1,10);t.mock.timers.enable({apis:['Date'],now:start});
  const upstream={items:[],calls:[],profiles:[],candidate:{corpId:'dingTestCorp',userId:'100001',profile:'dingTestCorp:100001',accountName:'隔离销售',corpName:'隔离企业'},identityMismatch:false,hold:null};
  const clientFactory=source=>({
    async verify(){},
    async employeeIdentity(expected){return {...expected,userId:upstream.identityMismatch||upstream.mismatchedProfiles?.includes(source.profile)?'another-user':expected.userId};},
    async list(query){upstream.calls.push(query);if(upstream.hold)await upstream.hold;return upstream.listResponder?upstream.listResponder(query):{items:upstream.items,next:null};},
    async artifacts(){return {summary:{state:'ready',content:'真实接口总结样例',reason:''},transcript:{state:'ready',content:'发言人：完整逐字稿',reason:''},speaker_insights:{state:'unavailable',content:'',reason:'源接口未返回'},quality:{state:'unavailable',content:'',reason:'尚未核验'}};},
    async audio(){return {state:'available',reason:'',url:'https://mozi-conf-tingwu.oss-cn-beijing.aliyuncs.com/isolated.mp3'};},
  });
  const minutesOptions={enabled:true,corpId:'dingTestCorp',clientFactory,readSavedProfiles:()=>upstream.profiles,readSavedIdentity:async(dir,profile)=>upstream.profiles.find(p=>p.profile===profile),beginDeviceFlow:async({onPrompt})=>{onPrompt({url:'https://login.dingtalk.com/oauth2/device?user_code=TEST-1234',code:'TEST-1234',expiresIn:600});return {completion:Promise.resolve(upstream.candidate),cancel(){}};},fetchImpl:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg'}})};
  const f=await fixture(t,{minutesOptions}),admin=await f.login(1),sales=await f.login(2),other=await f.login(3);
  for(const id of [1,2,3]){run(f.db,'UPDATE users SET ding_user_id=? WHERE id=?','enterprise-'+id,id);run(f.db,'INSERT OR REPLACE INTO ding_identities VALUES(?,?)',id,'verified-union-'+id);}
  const waitAuth=async(actor=sales)=>{for(let i=0;i<30;i++){const r=await f.request('/minutes/connections',{actor});if(!['starting','awaiting','verifying'].includes(r.body.authorization?.status))return r.body.authorization;await new Promise(resolve=>setImmediate(resolve));}assert.fail('authorization did not finish');};
  const connect=async(actor=sales)=>{
    const r=await f.request('/minutes/start',{actor,method:'POST',body:{}});assert.equal(r.status,200,JSON.stringify(r.body));const a=await waitAuth(actor);assert.equal(a.status,'pending_confirmation',JSON.stringify(a));
    const c=await f.request(`/minutes/authorizations/${a.id}/confirm`,{actor,method:'POST',body:{accepted:true}});assert.equal(c.status,200,JSON.stringify(c.body));return c.body.source_id;
  };
  const sync=id=>f.request(`/minutes/sources/${id}/sync`,{actor:sales,method:'POST',body:{}});
  const item=(id='new-note',at=start+500)=>({uuid:id,title:'客户沟通 <script>',startTime:at,durationMicros:60000000});
  return {...f,admin,sales,other,upstream,connect,sync,item,start,waitAuth,minutesOptions};
}

test('本人设备授权核验、明确确认后才建连接；新增采集与历史读取分别处理',async t=>{
  const f=await context(t),id=await f.connect();assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,0);
  const source=one(f.db,'SELECT * FROM minutes_sources WHERE id=?',id);assert.equal(source.member_id,2);assert.equal(source.collect_from,new Date(f.start).toISOString());
  f.upstream.items=[f.item('old-note',f.start-86400000),f.item()];t.mock.timers.tick(1000);
  const r=await f.sync(id);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.fetched,1);assert.equal(r.body.status,'success');
  assert.deepEqual(all(f.db,'SELECT external_id FROM minutes_records').map(x=>x.external_id),['new-note']);
  const state=(await f.request('/state',{actor:f.sales})).body;assert.equal(state.minutes.count,1);assert.ok(!JSON.stringify(state.minutes).includes('credential_key'));assert.ok(!JSON.stringify(state.minutes).includes('accessToken'));
  assert.match(shell(state,'minutes'),/href="#minutes"/);assert.match(renderPage(state,{view:'minutes'}),/客户沟通 &lt;script&gt;/);assert.match(opportunityDetail(state,1),/查看关联听记/);assert.match(customerDetail(state,1),/查看关联听记/);
});

test('历史任务立即返回并分页读取连接前听记，增量水位、人工关联及重复记录均保留',async t=>{
  const f=await context(t),id=await f.connect();f.upstream.items=[f.item('new-note')];t.mock.timers.tick(1000);await f.sync(id);
  const watermark=one(f.db,'SELECT synced_until FROM minutes_sources WHERE id=?',id).synced_until;
  let release;f.upstream.hold=new Promise(resolve=>release=resolve);
  const old=f.item('old-shared-note',f.start-100*86400000),future=f.item('future-note',f.start+86400000);
  f.upstream.listResponder=q=>q.cursor?{items:[f.item('new-note'),future],next:null}:{items:[old],next:'next-history-page'};
  const job=await f.request(`/minutes/sources/${id}/history`,{actor:f.sales,method:'POST',body:{}});
  assert.equal(job.status,200);assert.equal(job.body.status,'running');
  assert.equal((await f.request(`/minutes/sources/${id}/history`,{actor:f.sales,method:'POST',body:{}})).status,409);
  const busy=(await f.request('/state',{actor:f.sales})).body;assert.equal(busy.minutes.sources[0].history.status,'running');
  release();f.upstream.hold=null;await f.service.minutes.shutdown();
  const finished=one(f.db,'SELECT * FROM minutes_sync_runs WHERE id=?',job.body.id);assert.equal(finished.mode,'history');assert.equal(finished.pages,2);assert.equal(finished.fetched,2);assert.equal(finished.status,'success');assert.equal(finished.cursor,null);
  assert.equal(f.upstream.calls.at(-2).from,null);assert.equal(f.upstream.calls.at(-1).cursor,'next-history-page');
  assert.equal(one(f.db,'SELECT synced_until FROM minutes_sources WHERE id=?',id).synced_until,watermark);
  assert.deepEqual(all(f.db,'SELECT external_id FROM minutes_records ORDER BY external_id').map(r=>r.external_id),['new-note','old-shared-note']);
  const r=one(f.db,"SELECT * FROM minutes_records WHERE external_id='old-shared-note'");
  assert.equal((await f.request(`/minutes/records/${r.id}/association`,{actor:f.sales,method:'POST',body:{revision:1,customer_id:3,opportunity_id:1,reason:'历史会议核对关联'}})).status,200);
  const second=await f.request(`/minutes/sources/${id}/history`,{actor:f.sales,method:'POST',body:{}});assert.equal(second.status,200);await f.service.minutes.shutdown();
  const kept=one(f.db,'SELECT * FROM minutes_records WHERE id=?',r.id);assert.equal(kept.opportunity_id,1);assert.equal(kept.revision,2);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,2);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM activities WHERE minutes_record_id=?',r.id).n,1);
  const state=(await f.request('/state',{actor:f.sales})).body;assert.match(renderPage(state,{view:'minutes'}),/data-minutes-connections/);assert.match(renderPage(state,{view:'minutes'}),/data-action="minutes-history"/);assert.equal(state.minutes.sources[0].history.status,'success');assert.ok(!JSON.stringify(state.minutes).includes('next-history-page'));
});

test('历史读取失败保存分页游标，重新读取从上次已提交页面继续',async t=>{
  const f=await context(t),id=await f.connect();t.mock.timers.tick(1000);let fail=true;
  f.upstream.listResponder=q=>{
    if(q.cursor&&fail)throw new Error('isolated upstream unavailable');
    return q.cursor?{items:[f.item('older-page-two',f.start-86400000)],next:null}:{items:[f.item('older-page-one',f.start-2*86400000)],next:'resume-page-two'};
  };
  const start=await f.request(`/minutes/sources/${id}/history`,{actor:f.sales,method:'POST',body:{}});assert.equal(start.status,200);await f.service.minutes.shutdown();
  let job=one(f.db,'SELECT * FROM minutes_sync_runs WHERE id=?',start.body.id);assert.equal(job.status,'failed');assert.equal(job.cursor,'resume-page-two');assert.equal(job.pages,1);assert.equal(job.fetched,1);
  const state=(await f.request('/state',{actor:f.sales})).body;assert.equal(state.minutes.sources[0].history.status,'failed');assert.ok(!JSON.stringify(state.minutes).includes('resume-page-two'));
  fail=false;const before=f.upstream.calls.length;const resumed=await f.request(`/minutes/sources/${id}/history`,{actor:f.sales,method:'POST',body:{}});assert.equal(resumed.body.id,start.body.id);await f.service.minutes.shutdown();
  assert.equal(f.upstream.calls[before].cursor,'resume-page-two');assert.equal(f.upstream.calls[before].to,job.to_time);
  job=one(f.db,'SELECT * FROM minutes_sync_runs WHERE id=?',start.body.id);assert.equal(job.pages,2);assert.equal(job.fetched,2);assert.equal(job.status,'success');assert.equal(job.cursor,null);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,2);
  assert.equal(one(f.db,'SELECT synced_until FROM minutes_sources WHERE id=?',id).synced_until,null);
});

test('历史接口遵守销售本人、管理员全员及停止连接权限，不接受改读其他账号',async t=>{
  const f=await context(t),id=await f.connect();t.mock.timers.tick(1000);f.upstream.items=[f.item('old-note',f.start-86400000)];
  assert.equal((await f.request(`/minutes/sources/${id}/history`,{actor:f.other,method:'POST',body:{}})).status,404);
  assert.equal((await f.request(`/minutes/sources/${id}/history`,{actor:f.sales,method:'POST',body:{member_id:3}})).status,400);
  const job=await f.request(`/minutes/sources/${id}/history`,{actor:f.admin,method:'POST',body:{}});assert.equal(job.status,200);await f.service.minutes.shutdown();
  assert.equal((await f.request('/minutes',{actor:f.other})).body.count,0);assert.equal((await f.request('/minutes',{actor:f.sales})).body.count,1);
  assert.equal((await f.request(`/minutes/sources/${id}/disconnect`,{actor:f.sales,method:'POST',body:{}})).status,200);
  assert.equal((await f.request(`/minutes/sources/${id}/history`,{actor:f.sales,method:'POST',body:{}})).status,409);
});

test('历史任务等待时注销登录，不将上游返回内容保存到数据库',async t=>{
  const f=await context(t),id=await f.connect();t.mock.timers.tick(1000);let release;f.upstream.hold=new Promise(resolve=>release=resolve);f.upstream.items=[f.item('old-note',f.start-86400000)];
  const job=await f.request(`/minutes/sources/${id}/history`,{actor:f.sales,method:'POST',body:{}});assert.equal(job.status,200);
  await f.request('/auth/logout',{actor:f.sales,method:'POST',body:{}});release();f.upstream.hold=null;await f.service.minutes.shutdown();
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,0);assert.equal(one(f.db,'SELECT status FROM minutes_sync_runs WHERE id=?',job.body.id).status,'failed');
});

test('真实连接命令读取当前已核验profile全部有权听记，历史不带开始时间，新增保留时间范围',async()=>{
  const calls=[];const client=createMinutesClient({profile:'dingVerified:123',corpId:'dingVerified',userId:'123'},{run:async(binary,args)=>{calls.push(args);return {stdout:JSON.stringify({success:true,result:{itemList:[],hasMore:false}})};}});
  await client.list({from:null,to:'2026-11-02T00:00:00Z',cursor:'saved-page'});
  assert.deepEqual(calls[0].slice(0,5),['minutes','list','all','--limit','20']);assert.ok(!calls[0].includes('--start'));assert.equal(calls[0][calls[0].indexOf('--cursor')+1],'saved-page');assert.equal(calls[0][calls[0].indexOf('--profile')+1],'dingVerified:123');
  await client.list({from:'2026-11-01T00:00:00Z',to:'2026-11-02T00:00:00Z',cursor:null});assert.equal(calls[1][calls[1].indexOf('--start')+1],'2026-11-01T00:00:00Z');
});

test('两位成员各自连接时，管理员可读全员，销售的列表、详情、录音及正文刷新均只限本人',async t=>{
 const f=await context(t),first=await f.connect();f.upstream.candidate={...f.upstream.candidate,userId:'100003',profile:'dingTestCorp:100003',accountName:'另一销售'};const second=await f.connect(f.other);
 f.upstream.items=[f.item()];t.mock.timers.tick(1000);await f.sync(first);assert.equal((await f.request(`/minutes/sources/${second}/sync`,{actor:f.other,method:'POST',body:{}})).status,200);
 const records=all(f.db,'SELECT * FROM minutes_records');assert.equal((await f.request('/minutes',{actor:f.admin})).body.count,2);
 for(const [actor,own,other] of [[f.sales,first,second],[f.other,second,first]]){
  assert.equal((await f.request('/minutes',{actor})).body.count,1);assert.equal((await f.request('/minutes/connections',{actor})).body.sources.length,1);assert.equal((await f.request('/minutes?source_id='+other,{actor})).status,404);
  const record=records.find(r=>r.source_id===other);for(const route of [`/minutes/records/${record.id}`,`/minutes/records/${record.id}/audio`])assert.equal((await f.request(route,{actor})).status,404);
  assert.equal((await f.request(`/minutes/records/${record.id}/refresh`,{actor,method:'POST',body:{}})).status,404);
  assert.equal((await f.request('/minutes?source_id='+own,{actor:f.admin})).body.count,1);assert.equal((await f.request(`/minutes/records/${record.id}`,{actor:f.admin})).status,200);
 }
 assert.equal((await f.request('/minutes/connections',{actor:f.admin})).body.sources.length,2);
});

test('授权其他账号失败且不建立绑定，未知成员不能假借开发者或管理员账号',async t=>{
  const f=await context(t);f.upstream.identityMismatch=true;
  assert.equal((await f.request('/minutes/start',{actor:f.sales,method:'POST',body:{member_id:3}})).status,400);
  assert.equal((await f.request('/minutes/start',{actor:f.sales,method:'POST',body:{}})).status,200);
  const a=await f.waitAuth();assert.equal(a.status,'failed');assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);
  assert.equal((await f.request(`/minutes/authorizations/${a.id}/confirm`,{actor:f.sales,method:'POST',body:{accepted:true}})).status,409);
});

test('销售仅本人列表，管理员全部；关联商机后总结唯一，重复采集保留人工关联',async t=>{
  const f=await context(t),id=await f.connect();f.upstream.items=[f.item()];t.mock.timers.tick(1000);assert.equal((await f.sync(id)).status,200);
  const record=one(f.db,'SELECT * FROM minutes_records');assert.equal((await f.request('/minutes',{actor:f.other})).body.count,0);assert.equal((await f.request('/minutes',{actor:f.admin})).body.count,1);
  assert.equal((await f.request(`/minutes/records/${record.id}`,{actor:f.other})).status,404);
  const b={revision:1,customer_id:3,opportunity_id:1,reason:'已核对本次沟通对应商机'};
  assert.equal((await f.request(`/minutes/records/${record.id}/association`,{actor:f.sales,method:'POST',body:b})).status,200);
  assert.equal((await f.request(`/minutes/records/${record.id}/association`,{actor:f.sales,method:'POST',body:b})).status,409);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM activities WHERE minutes_record_id=?',record.id).n,1);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM activity_events WHERE summary=?','真实接口总结样例').n,0);
  const manual=await f.request('/activities',{actor:f.sales,method:'POST',body:{opportunity_id:1,summary:'手工跟进必须独立保留',activity_type:'手动跟进',activity_date:'2026-11-01'}});assert.equal(manual.status,200);
  const manualSummary=one(f.db,'SELECT summary FROM activities WHERE id=?',manual.body.id).summary;assert.match(manualSummary,/手工跟进必须独立保留/);assert.doesNotMatch(manualSummary,/真实接口总结样例/);
  assert.equal((await f.sync(id)).status,200);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,1);assert.equal(one(f.db,'SELECT opportunity_id FROM minutes_records').opportunity_id,1);assert.equal(one(f.db,'SELECT COUNT(*) n FROM activities WHERE minutes_record_id=?',record.id).n,1);
  assert.equal(one(f.db,'SELECT summary FROM activities WHERE id=?',manual.body.id).summary,manualSummary);
  assert.equal((await f.request(`/minutes/records/${record.id}/association`,{actor:f.sales,method:'POST',body:{revision:2,customer_id:null,opportunity_id:null,reason:'取消错误关联'}})).status,200);
  assert.equal((await f.sync(id)).status,200);assert.equal(one(f.db,'SELECT opportunity_id FROM minutes_records').opportunity_id,null);assert.equal(one(f.db,'SELECT COUNT(*) n FROM activities WHERE minutes_record_id=?',record.id).n,0);
});

test('客户转交不转移听记权限，客户或商机入口也仅限本人；管理员可看全部',async t=>{
  const f=await context(t),source=await f.connect();f.upstream.items=[f.item()];t.mock.timers.tick(1000);await f.sync(source);const r=one(f.db,'SELECT * FROM minutes_records');
  assert.equal((await f.request(`/minutes/records/${r.id}/association`,{actor:f.sales,method:'POST',body:{revision:1,customer_id:3,opportunity_id:1,reason:'核对关联'}})).status,200);
  run(f.db,'UPDATE opportunities SET owner_id=3 WHERE id=1');run(f.db,'UPDATE customers SET owner_id=3 WHERE id=3');run(f.db,'DELETE FROM customer_collaborators WHERE customer_id=3');
  assert.equal((await f.request('/minutes?customer_id=3',{actor:f.other})).body.count,0);
  assert.equal((await f.request('/minutes?opportunity_id=1',{actor:f.other})).body.count,0);
  assert.equal((await f.request(`/minutes/records/${r.id}?customer_id=3`,{actor:f.other})).status,404);
  assert.equal((await f.request(`/minutes/records/${r.id}?customer_id=3`,{actor:f.sales})).status,404);
  assert.equal((await f.request(`/minutes/records/${r.id}`,{actor:f.other})).status,404);
  assert.equal((await f.request(`/minutes/records/${r.id}`,{actor:f.sales})).status,200);
  for(const query of ['', '?customer_id=3','?opportunity_id=1']){
    const audio=await fetch(f.base+`/api/minutes/records/${r.id}/audio${query}`,{headers:{Cookie:f.other.cookie}});assert.equal(audio.status,404);await audio.arrayBuffer();
    assert.equal((await f.request(`/minutes/records/${r.id}${query}`,{actor:f.admin})).status,200);
  }
  assert.equal((await f.request(`/minutes/records/${r.id}/refresh`,{actor:f.other,method:'POST',body:{customer_id:3}})).status,404);
  assert.equal((await f.request(`/minutes/records/${r.id}/refresh`,{actor:f.admin,method:'POST',body:{customer_id:3}})).status,200);
  const adminAudio=await fetch(f.base+`/api/minutes/records/${r.id}/audio?opportunity_id=1`,{headers:{Cookie:f.admin.cookie}});assert.equal(adminAudio.status,200);await adminAudio.arrayBuffer();
  assert.equal((await f.request('/minutes?customer_id=3',{actor:f.admin})).body.count,1);
  assert.equal((await f.request('/state',{actor:f.other})).body.activities.some(a=>a.minutes_record_id===r.id),false);
  assert.equal((await f.request('/state',{actor:f.admin})).body.activities.some(a=>a.minutes_record_id===r.id),true);
  for(const query of ['customer_id=0','customer_id=','customer_id=invalid'])assert.equal((await f.request(`/minutes/records/${r.id}?${query}`,{actor:f.sales})).status,400);
  assert.equal((await f.request(`/minutes/sources/${source}/sync`,{actor:f.other,method:'POST',body:{}})).status,404);
});

test('组织选择只展示本人在线核验通过的账号；管理员身份也不允许替他人连接',async t=>{
  const f=await context(t),foreign={corpId:'dingAnotherOrg',userId:'200002',profile:'dingAnotherOrg:200002',accountName:'同一成员',corpName:'另一组织'},outsider={corpId:'dingOtherPerson',userId:'300003',profile:'dingOtherPerson:300003',accountName:'不应显示的其他人',corpName:'无关组织'};
  f.upstream.profiles=[outsider,{...f.upstream.candidate,current:true},foreign];f.upstream.mismatchedProfiles=[outsider.profile];
  await f.connect();const a=await f.waitAuth();assert.deepEqual(a.profiles.map(p=>p.profile),[f.upstream.candidate.profile,foreign.profile]);
  const state=(await f.request('/state',{actor:f.sales})).body;assert.doesNotMatch(JSON.stringify(state.minutes),/不应显示的其他人|dingOtherPerson/);assert.doesNotMatch(renderPage(state,{view:'minutes'}),/不应显示的其他人/);
  assert.equal((await f.request(`/minutes/authorizations/${a.id}/retry`,{actor:f.admin,method:'POST',body:{profile:outsider.profile}})).status,409);
  assert.equal((await f.request(`/minutes/authorizations/${a.id}/retry`,{actor:f.sales,method:'POST',body:{profile:outsider.profile}})).status,200);
  const denied=await f.waitAuth();assert.equal(denied.status,'failed');assert.deepEqual(denied.profiles,[]);assert.equal(denied.candidate,null);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,1);
});

test('正文、录音均经过权限校验，停止连接保留正文并阻止后续接口访问',async t=>{
  const f=await context(t),id=await f.connect();f.upstream.items=[f.item()];t.mock.timers.tick(1000);await f.sync(id);const r=one(f.db,'SELECT * FROM minutes_records');
  const read=await f.request(`/minutes/records/${r.id}`,{actor:f.sales});assert.equal(read.body.artifacts.summary.state,'ready');assert.equal(read.body.artifacts.quality.state,'unavailable');
  const response=await fetch(f.base+`/api/minutes/records/${r.id}/audio`,{headers:{Cookie:f.sales.cookie}});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/mpeg');assert.equal((await response.arrayBuffer()).byteLength,3);
  assert.equal((await f.request(`/minutes/records/${r.id}/audio`,{actor:f.other})).status,404);
  assert.equal((await f.request(`/minutes/sources/${id}/disconnect`,{actor:f.sales,method:'POST',body:{}})).status,200);
  assert.equal((await f.sync(id)).status,409);assert.equal((await f.request(`/minutes/records/${r.id}`,{actor:f.sales})).status,200);assert.equal((await f.request(`/minutes/records/${r.id}/audio`,{actor:f.sales})).status,409);
});

test('本地自动采集执行器在上游读取前拒绝，HTTPS开关不代替正式部署身份',async t=>{
  const f=await context(t),id=await f.connect(),before=f.upstream.calls.length;
  await assert.rejects(()=>f.service.minutes.sync(one(f.db,'SELECT * FROM users WHERE id=2'),id,{automatic:true}),/本地禁止/);assert.equal(f.upstream.calls.length,before);
  const stop=f.service.minutes.startScheduler();assert.equal(typeof stop,'function');stop();
});

test('采集等待期间登出后不保存返回记录，失败状态留痕',async t=>{
  const f=await context(t),id=await f.connect();f.upstream.items=[f.item()];t.mock.timers.tick(1000);let release;f.upstream.hold=new Promise(r=>release=r);
  const pending=f.sync(id);for(let i=0;i<30&&f.upstream.calls.length<2;i++)await new Promise(r=>setImmediate(r));
  await f.request('/auth/logout',{actor:f.sales,method:'POST',body:{}});release();const result=await pending;
  assert.equal(result.status,401);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,0);assert.equal(one(f.db,'SELECT status FROM minutes_sync_runs').status,'failed');
});

test('源产物格式与逐字稿完整分页严格核验，录音地址不允许任意主机',async()=>{
  assert.equal(parseMinutesSummary({fullSummary:'不可凭标题猜总结'}).state,'pending');assert.throws(()=>parseTranscriptionPage({paragraphList:[]}),/逐字稿/);
  const client=createMinutesClient({profile:'dingTest:1',corpId:'dingTest',userId:'1'},{run:async(binary,args)=>({stdout:JSON.stringify(args[1]==='+transcript'?{ok:true,outcome:'success',data:{taskUuid:'note',complete:false,direction:'0',pages:1,paragraphList:[],paragraphCount:0},meta:{pagination:{endpoint_exhausted:false}}}:{success:true,result:{fullSummary:'总结',generatingStatus:'COMPLETED',textGenerationInfo:{state:'COMPLETED'}}})})});
  const a=await client.artifacts('note');assert.equal(a.summary.state,'ready');assert.equal(a.transcript.state,'failed');
  assert.equal(safeMinutesAudio('https://127.0.0.1/private'),null);assert.equal(safeMinutesAudio('https://evil.example/audio.mp3'),null);
  await assert.rejects(()=>fetchMinutesAudio('https://evil.example/audio.mp3'),/域名/);
});

test('重复分页游标停止并保留已提交页面，完整水位不前移，重试不重复',async t=>{
  const f=await context(t),id=await f.connect();t.mock.timers.tick(1000);
  f.upstream.listResponder=query=>({items:[f.item()],next:'repeated-cursor'});
  assert.equal((await f.sync(id)).status,502);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,1);assert.equal(one(f.db,'SELECT synced_until FROM minutes_sources').synced_until,null);
  f.upstream.listResponder=null;f.upstream.items=[f.item()];assert.equal((await f.sync(id)).status,200);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,1);
});

test('同一成员可连接多个组织，复用授权不复制凭据；组织分别采集、筛选与停止',async t=>{
  const f=await context(t),primary=await f.connect(),original=one(f.db,"SELECT * FROM minutes_authorizations WHERE status='connected'");
  const foreign={corpId:'dingAnotherOrg',userId:'200002',profile:'dingAnotherOrg:200002',accountName:'同一成员',corpName:'另一组织'};f.upstream.profiles=[{...f.upstream.candidate,current:true},foreign];
  const retry=await f.request(`/minutes/authorizations/${original.id}/retry`,{actor:f.sales,method:'POST',body:{profile:foreign.profile}});assert.equal(retry.status,200,JSON.stringify(retry.body));
  const a=await f.waitAuth();assert.equal(a.status,'pending_confirmation',JSON.stringify(a));assert.equal(a.candidate.corpName,'另一组织');
  const confirmed=await f.request(`/minutes/authorizations/${a.id}/confirm`,{actor:f.sales,method:'POST',body:{accepted:true}});assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));const second=confirmed.body.source_id;assert.notEqual(second,primary);
  const sources=all(f.db,'SELECT * FROM minutes_sources WHERE member_id=2');assert.equal(sources.length,2);assert.ok(sources.every(s=>s.credential_key===original.credential_key));assert.equal(one(f.db,'SELECT status FROM minutes_authorizations WHERE id=?',original.id).status,'connected');
  f.upstream.items=[f.item('same-external-id')];t.mock.timers.tick(1000);await f.sync(primary);await f.sync(second);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,2);
  assert.equal((await f.request('/minutes?source_id='+second,{actor:f.sales})).body.count,1);
  assert.equal((await f.request(`/minutes/sources/${second}/disconnect`,{actor:f.sales,method:'POST',body:{}})).status,200);assert.equal(one(f.db,'SELECT connection_state FROM minutes_sources WHERE id=?',primary).connection_state,'connected');
  const html=renderPage((await f.request('/state',{actor:f.sales})).body,{view:'minutes'});assert.match(html,/data-minutes-connections/);assert.match(html,/data-action="minutes-disconnect"/);assert.match(html,/全部可查看账号/);
});

test('保存的授权包含多个组织时精确选择当前或指定profile，不取第一个账号',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'crm-minute-profiles-'));t.after(()=>{assert.equal(path.dirname(realpathSync(root)),realpathSync(tmpdir()));assert.ok(path.basename(root).startsWith('crm-minute-profiles-'));rmSync(root,{recursive:true,force:true});});
  writeFileSync(path.join(root,'profiles.json'),JSON.stringify({currentProfile:'dingSecond:456',profiles:[{corpId:'dingFirst',userId:'123',status:'active',userName:'首个账号',corpName:'组织一'},{corpId:'dingSecond',userId:'456',status:'active',userName:'当前账号',corpName:'组织二'}]}));
  assert.equal((await readSavedMinutesIdentity(root)).profile,'dingSecond:456');assert.equal((await readSavedMinutesIdentity(root,'dingFirst:123')).profile,'dingFirst:123');assert.equal(readSavedMinutesProfiles(root).length,2);await assert.rejects(()=>readSavedMinutesIdentity(root,'dingUnknown:789'),/重新发起/);
});

test('全部历史默认可查，长日期范围与日期同步不受30天限制，统计和分页遵循本人权限',async t=>{
  const f=await context(t),id=await f.connect();t.mock.timers.tick(1000);
  f.upstream.items=[f.item('older-than-year',Date.UTC(2024,0,1)),f.item('recent')];
  const full=await f.request(`/minutes/sources/${id}/range`,{actor:f.sales,method:'POST',body:{}});assert.equal(full.status,200,JSON.stringify(full.body));await f.service.minutes.shutdown();
  assert.equal(f.upstream.calls.at(-1).from,null);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,2);
  const all=(await f.request('/minutes?page_size=10',{actor:f.sales})).body;assert.equal(all.count,2);assert.equal(all.totals.total,2);assert.equal(all.totals.available,2);assert.equal(all.page_size,10);
  const selected=(await f.request('/minutes?from=2024-01-01&to=2024-01-01',{actor:f.sales})).body;assert.equal(selected.count,1);assert.equal(selected.records[0].external_id,'older-than-year');
  const long=await f.request('/minutes?from=2024-01-01&to=2026-11-01',{actor:f.sales});assert.equal(long.status,200);assert.equal(long.body.count,2);
  const other=(await f.request('/minutes',{actor:f.other})).body;assert.equal(other.count,0);assert.equal(other.totals.total,0);assert.equal(other.runs.length,0);
  for(const query of ['from=2024-02-30&to=2024-03-01','from=2026-11-02&to=2026-11-02','from=2026-01-01'])assert.equal((await f.request('/minutes?'+query,{actor:f.sales})).status,400);
  const range=await f.request(`/minutes/sources/${id}/range`,{actor:f.sales,method:'POST',body:{from:'2024-01-01',to:'2026-11-01'}});assert.equal(range.status,200);await f.service.minutes.shutdown();assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_records').n,2);
  assert.equal((await f.request(`/minutes/sources/${id}/range`,{actor:f.other,method:'POST',body:{}})).status,404);
  assert.equal((await f.request(`/minutes/sources/${id}/range`,{actor:f.sales,method:'POST',body:{member_id:3}})).status,400);
});

test('发生日期按北京时间包含结束日全天，排除前一天末尾与次日零点',async t=>{
  const f=await context(t),id=await f.connect();t.mock.timers.tick(1000);
  f.upstream.items=[f.item('previous-day',Date.parse('2026-10-30T15:59:59.999Z')),f.item('day-start',Date.parse('2026-10-30T16:00:00.000Z')),f.item('day-end',Date.parse('2026-10-31T15:59:59.999Z')),f.item('next-day',Date.parse('2026-10-31T16:00:00.000Z'))];
  assert.equal((await f.request(`/minutes/sources/${id}/range`,{actor:f.sales,method:'POST',body:{}})).status,200);await f.service.minutes.shutdown();
  const result=await f.request('/minutes?from=2026-10-31&to=2026-10-31',{actor:f.sales});assert.equal(result.status,200);assert.equal(result.body.count,2);assert.equal(result.body.totals.total,2);
  assert.deepEqual(result.body.records.map(r=>r.external_id),['day-end','day-start']);
  const cleared=await f.request('/minutes?from=&to=',{actor:f.sales});assert.equal(cleared.body.count,4);
});
