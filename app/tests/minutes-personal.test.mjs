import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {one,all,run} from '../server/database.mjs';
import {createPersonalMinutesClient} from '../server/modules/minutes/personal-client.mjs';
import {DatabaseSync} from 'node:sqlite';
import {migratePersonalMinutes} from '../server/minutes-personal-schema.mjs';
const key='44444444-4444-4444-a444-444444444444';
async function context(t){
 const upstream={items:[],fail:false};
 const f=await fixture(t,{localIdentitySwitch:true,identityProvider:{loginConfigured:true,identity:async()=>({unionId:'isolated-personal-developer'})},minutesOptions:{enabled:true,corpId:'dingCRM',clientFactory:()=>{throw new Error('Personal flow must not use enterprise CLI');},readPersonalTokens:async()=>({provider:'personal_mcp',memberId:2,authorizationKey:key,scope:'qwennote:read',label:'个人账号'}),personalClientFactory:()=>({verify:async()=>{if(upstream.fail)throw new Error('fixture revoked');},list:async()=>({items:upstream.items,next:null}),audio:async()=>({state:'unavailable',reason:'源未提供录音'}),artifacts:async()=>({summary:{state:'empty',content:'',reason:'源未提供'},transcript:{state:'ready',content:'隔离逐字稿',reason:''}})})}});
 for(const id of [1,2,3]){run(f.db,'UPDATE users SET ding_user_id=? WHERE id=?','crm-'+id,id);run(f.db,'INSERT OR REPLACE INTO ding_identities VALUES(?,?)',id,'union-'+id);}
 const owner=await f.login(2),other=await f.login(3),admin=await f.login(1);
 const prepare=(actor=owner,headers={})=>f.request('/minutes/personal/import',{actor,headers,method:'POST',body:{authorization_key:key}});
 const confirm=(id,actor=owner,headers={})=>f.request(`/minutes/authorizations/${id}/confirm`,{actor,headers,method:'POST',body:{accepted:true}});
 const developer=async()=>{run(f.db,"INSERT INTO users(id,name,username,role,developer_admin,business_member,performance_enabled,created_at) VALUES(4,'隔离开发者','personal_dev','admin',1,0,0,?)",new Date().toISOString());run(f.db,'INSERT INTO ding_identities VALUES(?,?)',4,'isolated-personal-developer');const signed=await f.request('/auth/dingtalk/callback',{method:'POST',body:{code:'isolated'}});assert.equal(signed.status,200);return {cookie:signed.cookie.split(';')[0],csrf:signed.body.csrf};};
 return {...f,owner,other,admin,upstream,prepare,confirm,developer};
}
test('个人授权在本人确认前不建立来源，确认后无企业组织编号，保留CRM绑定和本人隔离',async t=>{
 const f=await context(t),before=all(f.db,'SELECT * FROM ding_identities');
 const prepared=await f.prepare();assert.equal(prepared.status,200,JSON.stringify(prepared.body));assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);
 assert.equal((await f.prepare(f.other)).status,403);assert.equal((await f.confirm(prepared.body.id,f.other)).status,409);
 const result=await f.confirm(prepared.body.id);assert.equal(result.status,200,JSON.stringify(result.body));const source=one(f.db,'SELECT * FROM minutes_sources');assert.equal(source.provider,'personal_mcp');assert.equal(source.corp_id,null);assert.equal(source.user_id,null);assert.equal(source.member_id,2);assert.deepEqual(all(f.db,'SELECT * FROM ding_identities'),before);
 f.upstream.items=[{uuid:'isolated-personal-record',title:'隔离个人听记',startTime:Date.now()-86400000,durationMicros:12000000}];
 assert.equal((await f.request(`/minutes/sources/${source.id}/history`,{actor:f.owner,method:'POST',body:{}})).status,200);await f.service.minutes.shutdown();
 const record=one(f.db,'SELECT * FROM minutes_records');assert(record);assert.equal((await f.request(`/minutes/records/${record.id}`,{actor:f.other})).status,404);assert.equal((await f.request(`/minutes/records/${record.id}`,{actor:f.admin})).status,200);
 assert.equal(one(f.db,'PRAGMA foreign_key_check'),undefined);
});
test('已核验的开发者可模拟成员确认个人听记，审计同时保留操作者与归属成员',async t=>{
 const f=await context(t),developer=await f.developer(),headers={'X-CRM-Act-As':'2'},before=all(f.db,'SELECT * FROM ding_identities');
 const prepared=await f.prepare(developer,headers);assert.equal(prepared.status,200);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);
 assert.equal((await f.request('/minutes/connections',{actor:developer,headers})).body.authorization.can_confirm,true);
 assert.equal((await f.confirm(prepared.body.id,developer,{'X-CRM-Act-As':'3'})).status,409);
 assert.equal((await f.confirm(prepared.body.id,f.other,headers)).status,403);
 const confirmed=await f.confirm(prepared.body.id,developer,headers);assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));assert.equal(one(f.db,'SELECT member_id FROM minutes_sources').member_id,2);
 const audit=one(f.db,"SELECT * FROM audit WHERE action='确认个人听记关联'"),detail=JSON.parse(audit.detail);assert.equal(audit.user_id,2);assert.equal(detail.operator_user_id,4);assert.equal(detail.acting_as_user_id,2);assert.equal(detail.confirmed_by_member,false);assert.equal(detail.confirmed_by_developer,true);assert.deepEqual(all(f.db,'SELECT * FROM ding_identities'),before);
 assert.equal((await f.confirm(prepared.body.id,developer,headers)).status,409);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,1);
});
test('开发者确认仍须重新核验个人授权、企业绑定与有效模拟权限',async t=>{
 const f=await context(t),developer=await f.developer(),headers={'X-CRM-Act-As':'2'},prepared=await f.prepare(developer,headers);
 f.upstream.fail=true;assert.equal((await f.confirm(prepared.body.id,developer,headers)).status,500);f.upstream.fail=false;
 run(f.db,"UPDATE ding_identities SET union_id='changed' WHERE user_id=2");assert.equal((await f.confirm(prepared.body.id,developer,headers)).status,409);run(f.db,"UPDATE ding_identities SET union_id='union-2' WHERE user_id=2");
 run(f.db,'UPDATE users SET developer_admin=0 WHERE id=4');assert.equal((await f.confirm(prepared.body.id,developer,headers)).status,403);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);
});
test('开发者确认外部核验期间登出，不能以旧模拟上下文建立来源',async t=>{
 const f=await context(t),developer=await f.developer(),headers={'X-CRM-Act-As':'2'},prepared=await f.prepare(developer,headers);let entered,release;const waiting=new Promise(r=>entered=r),original=f.service.minutes.prepare;
 f.service.minutes.prepare=async(...args)=>{const result=await original(...args);entered();await new Promise(r=>release=r);return result;};
 const confirmation=f.confirm(prepared.body.id,developer,headers);await waiting;await f.request('/auth/logout',{actor:developer,method:'POST',body:{}});release();assert.equal((await confirmation).status,401);assert.equal(one(f.db,'SELECT COUNT(*) n FROM minutes_sources').n,0);
});
test('个人来源约束拒绝填造组织编号，原企业来源不受影响',async t=>{
 const f=await context(t),sql="INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at,provider) VALUES(?,2,?,?,?,'',?,'connected',?,?,?)",date=new Date().toISOString();
 assert.throws(()=>run(f.db,sql,'fake-org','dingInvented',null,'个人',key,date,date,'personal_mcp'),/CHECK constraint/);
 run(f.db,sql,'real-org','dingExisting','real-user','原企业',key,date,date,'dws');assert.equal(one(f.db,'SELECT provider FROM minutes_sources').provider,'dws');
});
function clientFor(responses){const source={credentialDir:'fixture',memberId:2,authorizationKey:key};return createPersonalMinutesClient(source,{load:async()=>({provider:'personal_mcp',memberId:2,authorizationKey:key,scope:'qwennote:read'}),transport:{tools:async()=>[],callReadTool:async(name,args)=>({structuredContent:await responses(name,args)})}});}
test('个人逐字稿完整分页，保持固定记录和方向，缺页不冒充完整正文',async()=>{
 const calls=[];const client=clientFor(async(_name,args)=>{calls.push(args);return {taskUuid:args.taskUuid,filtered:false,total:2,hasMore:!args.nextToken,nextToken:args.nextToken?null:'second-page',paragraphs:[{speakerName:'本人',startTime:0,content:args.nextToken?'末段':'首段'}]};});
 const result=await client.transcript('record');assert.equal(result.state,'ready');assert.match(result.content,/首段/);assert.match(result.content,/末段/);assert(calls.every(call=>call.direction===0));
 const incomplete=clientFor(async()=>({taskUuid:'record',filtered:false,total:2,hasMore:false,paragraphs:[{speakerName:null,startTime:0,content:'仅首段'}]}));assert.equal((await incomplete.transcript('record')).state,'failed');
 const wrong=clientFor(async()=>({taskUuid:'other',filtered:false,total:0,hasMore:false,paragraphs:[]}));assert.equal((await wrong.transcript('record')).state,'failed');
});
test('个人听记映射实际创建时间和毫秒时长，源游标原样传递，异常页拒绝保存',async()=>{
 const calls=[];const client=clientFor(async(name,args)=>{calls.push({name,args});return {items:[{uuid:'source-note',title:'测试',gmtCreate:1793178013000,durationMillis:21349}],hasMore:true,nextToken:'opaque-source-cursor'};});
 const result=await client.list({from:'2026-01-01T00:00:00Z',to:'2026-11-03T00:00:00Z',cursor:'previous'});assert.equal(result.items[0].durationMicros,21349000);assert.equal(result.items[0].startTime,1793178013000);assert.equal(result.next,'opaque-source-cursor');assert.equal(calls[0].args.nextToken,'previous');assert.equal(typeof calls[0].args.createdAfter,'number');
});
test('个人来源迁移失败完整回滚，成功后原企业来源、子表引用与原列保留且可重复打开',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("PRAGMA foreign_keys=ON;CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(26);CREATE TABLE users(id INTEGER PRIMARY KEY);INSERT INTO users VALUES(1);CREATE TABLE minutes_sources(id TEXT PRIMARY KEY,member_id INTEGER NOT NULL REFERENCES users(id),corp_id TEXT NOT NULL,user_id TEXT NOT NULL,account_name TEXT NOT NULL,corp_name TEXT NOT NULL,credential_key TEXT NOT NULL,connection_state TEXT NOT NULL,collect_from TEXT NOT NULL,synced_until TEXT,last_synced_at TEXT,created_at TEXT NOT NULL,UNIQUE(corp_id,user_id),UNIQUE(member_id,corp_id));INSERT INTO minutes_sources VALUES('original',1,'dingOriginal','source-user','原账号','原组织','original-private-key','connected','2026-10-01',NULL,NULL,'2026-10-01');CREATE TABLE child(id INTEGER PRIMARY KEY,source_id TEXT REFERENCES minutes_sources(id));INSERT INTO child VALUES(1,'original');CREATE TRIGGER reject_v27 BEFORE INSERT ON schema_version WHEN NEW.version=27 BEGIN SELECT RAISE(ABORT,'forced-v27');END;");
  const before=all(db,'SELECT * FROM minutes_sources');assert.throws(()=>migratePersonalMinutes(db),/forced-v27/);assert.deepEqual(all(db,'SELECT * FROM minutes_sources'),before);assert(!all(db,'PRAGMA table_info(minutes_sources)').some(c=>c.name==='provider'));assert.equal(one(db,'PRAGMA foreign_keys').foreign_keys,1);
  db.exec('DROP TRIGGER reject_v27');migratePersonalMinutes(db);migratePersonalMinutes(db);
  const after=one(db,'SELECT * FROM minutes_sources');for(const [column,value] of Object.entries(before[0]))assert.equal(after[column],value);assert.equal(after.provider,'dws');assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);assert.equal(one(db,'SELECT source_id FROM child').source_id,'original');
 }finally{db.close();}
});
