import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {createMinutesClient} from '../server/modules/minutes/client.mjs';
import {minutesConnectorError} from '../server/modules/minutes/device-flow.mjs';
import {renderPage} from '../public/views.js';

async function context(t){
 const upstream={candidate:{corpId:'dingExternal',userId:'external-123',profile:'dingExternal:external-123',accountName:'独立听记账号',corpName:'听记所在组织'},profiles:[],calls:[],items:[],identity:null,hold:null,error:null,employeeMatches:false};
 const clientFactory=source=>({
  async verify(){upstream.calls.push({kind:'status',profile:source.profile});if(upstream.error)throw upstream.error;},
  async accountIdentity(){upstream.calls.push({kind:'account',profile:source.profile});return upstream.identity||{corpId:source.corpId,userId:source.userId};},
  async employeeIdentity(expected){upstream.calls.push({kind:'employee',profile:source.profile});return {...expected,userId:upstream.employeeMatches?expected.userId:'different-enterprise-user'};},
  async list(query){upstream.calls.push({kind:'list',profile:source.profile,query});if(upstream.hold)await upstream.hold;return {items:upstream.items,next:null};},
  async artifacts(){return {summary:{state:'empty',content:'',reason:'隔离测试'},transcript:{state:'empty',content:'',reason:'隔离测试'}};},
  async audio(){return {state:'unavailable',reason:'隔离测试'};},
 });
 const f=await fixture(t,{localIdentitySwitch:true,identityProvider:{loginConfigured:true,identity:async()=>({unionId:'isolated-developer',seconds:7200})},minutesOptions:{enabled:true,corpId:'dingCrmCorp',clientFactory,readSavedProfiles:()=>upstream.profiles,readSavedIdentity:async(_dir,profile)=>upstream.profiles.find(p=>p.profile===profile),beginDeviceFlow:async()=>({completion:Promise.resolve(upstream.candidate),cancel(){}})}});
 for(const id of [1,2,3]){run(f.db,'UPDATE users SET ding_user_id=? WHERE id=?','crm-user-'+id,id);run(f.db,'INSERT OR REPLACE INTO ding_identities VALUES(?,?)',id,'crm-union-'+id);}
 const owner=await f.login(2),other=await f.login(3),admin=await f.login(1);
 const wait=async(actor=owner,headers={})=>{for(let i=0;i<50;i++){const r=await f.request('/minutes/connections',{actor,headers});assert.equal(r.status,200);if(!['starting','awaiting','verifying'].includes(r.body.authorization?.status))return r.body.authorization;await new Promise(r=>setImmediate(r));}assert.fail('authorization did not finish');};
 const start=(actor=owner,body={account_mode:'separate_account'},headers={})=>f.request('/minutes/start',{actor,body,headers,method:'POST'});
 const confirm=(id,actor=owner,body={accepted:true},headers={})=>f.request(`/minutes/authorizations/${id}/confirm`,{actor,headers,body,method:'POST'});
 const developer=async()=>{
  run(f.db,"INSERT INTO users(id,name,username,role,developer_admin,business_member,performance_enabled,created_at) VALUES(4,'隔离开发者','isolated_dev','admin',1,0,0,?)",new Date().toISOString());run(f.db,'INSERT INTO ding_identities VALUES(?,?)',4,'isolated-developer');
  const r=await f.request('/auth/dingtalk/callback',{method:'POST',body:{code:'isolated-code'}});assert.equal(r.status,200);return {cookie:r.cookie.split(';')[0],csrf:r.body.csrf};
 };
 return {...f,upstream,owner,other,admin,wait,start,confirm,developer};
}

test('另一个听记账号不属于CRM企业也可连接，本人确认前不建来源，原登录身份保持',async t=>{
 const f=await context(t),before=all(f.db,'SELECT u.id,u.ding_user_id,d.union_id FROM users u LEFT JOIN ding_identities d ON d.user_id=u.id ORDER BY u.id');
 assert.equal((await f.start()).status,200);const a=await f.wait();assert.equal(a.status,'pending_confirmation');assert.equal(a.account_mode,'separate_account');assert.equal(a.can_confirm,true);assert.equal(a.candidate.accountName,'独立听记账号');assert.deepEqual(a.profiles,[]);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);
 const state=(await f.request('/state',{actor:f.owner})).body;assert.doesNotMatch(JSON.stringify(state.minutes),/crmIdentity|crm-union|credential_key/);assert.doesNotMatch(renderPage(state,{view:'minutes'}),/钉钉账号连接|data-form="minutes-start"|data-form="minutes-confirm"/);
 assert.equal((await f.confirm(a.id,f.other)).status,409);assert.equal((await f.confirm(a.id,f.admin)).status,409);assert.equal((await f.confirm(a.id,f.owner,{accepted:false})).status,409);
 const r=await f.confirm(a.id);assert.equal(r.status,200,JSON.stringify(r.body));const source=one(f.db,'SELECT * FROM minutes_sources');assert.equal(source.member_id,2);assert.equal(source.corp_id,'dingExternal');assert.equal(source.user_id,'external-123');assert.ok(f.upstream.calls.every(c=>c.profile==='dingExternal:external-123'));assert.ok(!f.upstream.calls.some(c=>c.kind==='employee'));
 assert.deepEqual(all(f.db,'SELECT u.id,u.ding_user_id,d.union_id FROM users u LEFT JOIN ding_identities d ON d.user_id=u.id ORDER BY u.id'),before);
 const audit=one(f.db,"SELECT * FROM audit WHERE action='确认听记账号连接'");assert.equal(audit.user_id,2);assert.equal(JSON.parse(audit.detail).account_mode,'separate_account');assert.equal(JSON.parse(audit.detail).confirmed_by_member,true);
 f.upstream.items=[{uuid:'isolated-external-note',title:'独立账号真实来源测试',startTime:Date.now()-86400000,durationMicros:60000000}];
 // History reads the selected account; it does not require the other account
 // to be added to the CRM enterprise directory.
 const history=await f.request(`/minutes/sources/${source.id}/history`,{actor:f.owner,method:'POST',body:{}});assert.equal(history.status,200);await f.service.minutes.shutdown();
 const note=one(f.db,'SELECT * FROM minutes_records');assert.ok(note);assert.equal((await f.request('/minutes',{actor:f.other})).body.count,0);assert.equal((await f.request(`/minutes/records/${note.id}`,{actor:f.other})).status,404);assert.equal((await f.request(`/minutes/records/${note.id}`,{actor:f.admin})).status,200);
});

test('默认同账号流程仍核对企业身份，切换账号模式不能夹带成员或确认时绕过',async t=>{
 const f=await context(t);assert.equal((await f.start(f.owner,{account_mode:'arbitrary'})).status,400);assert.equal((await f.start(f.owner,{account_mode:'separate_account',member_id:3})).status,400);
 assert.equal((await f.start(f.owner,{})).status,200);const denied=await f.wait();assert.equal(denied.status,'failed');assert.match(denied.error,/当前成员不一致/);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);assert.ok(f.upstream.calls.some(c=>c.kind==='employee'));
 assert.equal((await f.confirm(denied.id,f.owner,{accepted:true,account_mode:'separate_account'})).status,409);
});

test('开发者可模拟成员确认独立账号；取消和过期保留模式且禁止改选其他保存账号',async t=>{
 const f=await context(t),operator=await f.developer(),headers={'X-CRM-Act-As':'2'};
 assert.equal((await f.start(operator,{account_mode:'separate_account'},headers)).status,200);const a=await f.wait(operator,headers);assert.equal(a.status,'pending_confirmation');assert.equal(a.can_confirm,true);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);
 const state=(await f.request('/state',{actor:operator,headers})).body,html=renderPage(state,{view:'minutes'});assert.doesNotMatch(html,/钉钉账号连接/);assert.doesNotMatch(html,/data-form="minutes-confirm"/);
 f.upstream.profiles=[{...f.upstream.candidate,current:true},{corpId:'dingUnrelated',userId:'other',profile:'dingUnrelated:other',accountName:'其他人的旧登录',corpName:'其他组织'}];
 assert.equal((await f.request(`/minutes/authorizations/${a.id}/retry`,{actor:operator,headers,method:'POST',body:{profile:'dingUnrelated:other'}})).status,409);
 const done=await f.confirm(a.id,operator,{accepted:true},headers);assert.equal(done.status,200,JSON.stringify(done.body));const initiated=one(f.db,"SELECT * FROM audit WHERE action='发起听记授权'");assert.equal(JSON.parse(initiated.detail).operator_user_id,4);const confirmed=one(f.db,"SELECT * FROM audit WHERE action='确认听记账号连接'");assert.equal(confirmed.user_id,2);assert.equal(JSON.parse(confirmed.detail).operator_user_id,4);assert.equal(JSON.parse(confirmed.detail).confirmed_by_member,false);
 // An expired reconnect must not fall back to the same-account identity rule.
 assert.equal((await f.start()).status,200);const next=await f.wait();run(f.db,'UPDATE minutes_authorizations SET expires_at=? WHERE id=?','2000-01-01T00:00:00.000Z',next.id);const expired=await f.wait();assert.equal(expired.status,'expired');assert.equal(expired.account_mode,'separate_account');assert.equal((await f.confirm(next.id)).status,409);
 assert.equal((await f.request(`/minutes/authorizations/${next.id}/retry`,{actor:f.owner,method:'POST',body:{profile:f.upstream.candidate.profile}})).status,200);const retry=await f.wait();assert.equal(retry.account_mode,'separate_account');assert.equal(retry.status,'pending_confirmation');
 assert.equal((await f.request(`/minutes/authorizations/${retry.id}/cancel`,{actor:f.owner,method:'POST',body:{}})).status,200);assert.equal((await f.wait()).account_mode,'separate_account');assert.equal((await f.confirm(retry.id)).status,409);
});

test('另一个账号确认时重新核验实际身份，CRM绑定变化或已有他人来源时拒绝',async t=>{
 const f=await context(t);assert.equal((await f.start()).status,200);const a=await f.wait();
 f.upstream.identity={corpId:'dingExternal',userId:'swapped-user'};assert.equal((await f.confirm(a.id)).status,403);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);f.upstream.identity=null;
 run(f.db,"UPDATE ding_identities SET union_id='changed-identity' WHERE user_id=2");assert.equal((await f.confirm(a.id)).status,409);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);run(f.db,"UPDATE ding_identities SET union_id='crm-union-2' WHERE user_id=2");
 assert.equal((await f.confirm(a.id)).status,200);
 assert.equal((await f.start(f.other)).status,200);const other=await f.wait(f.other);assert.equal((await f.confirm(other.id,f.other)).status,409);assert.equal(one(f.db,'SELECT member_id FROM minutes_sources').member_id,2);
});

test('另一个账号确认等待时登出，不能建立绑定',async t=>{
 const f=await context(t);assert.equal((await f.start()).status,200);const a=await f.wait();
 let release,entered;const pending=new Promise(r=>entered=r);const original=f.service.minutes.prepare;
 // Hold the authorization recheck, then exercise the real HTTP logout race.
 f.service.minutes.prepare=async(...args)=>{const result=await original(...args);entered();await new Promise(r=>release=r);return result;};
 const confirmation=f.confirm(a.id);await pending;await f.request('/auth/logout',{actor:f.owner,method:'POST',body:{}});release();assert.equal((await confirmation).status,401);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);
});

test('钉钉明确拒绝CLI时另一个账号同样失败，不能把权限拒绝转换为成功',async t=>{
 const f=await context(t);f.upstream.error=minutesConnectorError('您暂无 CLI 数据访问权限',{authorization:true});assert.equal((await f.start()).status,200);const a=await f.wait();assert.equal(a.status,'failed');assert.match(a.error,/MINUTES_CLI_ACCESS_DENIED/);assert.doesNotMatch(a.error,/当前成员|千帆/);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);
 const stored='所选钉钉组织尚未给当前成员开通 CLI 数据访问权限，请该组织管理员授权后重试（MINUTES_MEMBER_NOT_AUTHORIZED）';run(f.db,'UPDATE minutes_authorizations SET error_message=? WHERE id=?',stored,a.id);assert.match((await f.wait()).error,/MINUTES_CLI_ACCESS_DENIED/);assert.equal(one(f.db,'SELECT error_message FROM minutes_authorizations WHERE id=?',a.id).error_message,stored);
});

test('独立账号只核验源组织和固定用户，不要求企业通讯录编号或手机号，其他身份返回拒绝',async()=>{
 const source={corpId:'dingExternal',userId:'external-123',profile:'dingExternal:external-123'},calls=[];let row={corpId:source.corpId,userId:source.userId};
 const client=createMinutesClient(source,{run:async(_binary,args)=>{calls.push(args);return {stdout:JSON.stringify({success:true,result:[{orgEmployeeModel:row}]})};}});
 assert.deepEqual(await client.accountIdentity(),{corpId:source.corpId,userId:source.userId});assert.equal(calls[0][calls[0].indexOf('--profile')+1],source.profile);assert.deepEqual(calls[0].slice(0,3),['contact','user','get-self']);await assert.rejects(()=>client.employeeIdentity({corpId:'dingCrmCorp',userId:'crm-user-2'}),/完整的企业成员编号或手机号/);
 row={...row,userId:'different-user'};await assert.rejects(()=>client.accountIdentity(),/实际授权账号不一致/);row={...row,corpId:'dingUnrelated'};await assert.rejects(()=>client.accountIdentity(),/身份缺失或不唯一/);
});
