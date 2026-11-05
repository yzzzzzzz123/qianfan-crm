import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixture.mjs';
import { run } from '../server/database.mjs';
import { createDingTalk } from '../server/dingtalk.mjs';
import { serverEnvironment,serverAIEnvironment } from '../server/server-config.mjs';

test('HTTPS部署可明确启用开发者切换，登录和退出Cookie仅作用于CRM路径',async t=>{
  const f=await fixture(t,{secure:true,production:false,localIdentitySwitch:false,developerIdentitySwitch:true,basePath:'/qf-crm/',identityProvider:{loginConfigured:true,identity:async()=>({unionId:'server-developer',seconds:7200})}});
  run(f.db,"INSERT INTO users(id,name,username,role,developer_admin,business_member,performance_enabled,created_at) VALUES(4,'余志政','developer_yu','admin',1,0,0,?)",new Date().toISOString());
  run(f.db,'INSERT INTO ding_identities VALUES(?,?)',4,'server-developer');
  const signed=await f.request('/auth/dingtalk/callback',{method:'POST',body:{code:'isolated-server-code'}});assert.equal(signed.status,200);
  assert.match(signed.cookie,/Path=\/qf-crm\/; HttpOnly; SameSite=Lax/);assert.match(signed.cookie,/Secure/);assert.match(signed.cookie,/qf_ding_state=; Path=\/qf-crm\/api\/auth\/dingtalk/);
  const actor={cookie:signed.cookie.split(';')[0],csrf:signed.body.csrf};
  const state=(await f.request('/state',{actor})).body;assert.equal(state.actor.name,'王宏');assert.deepEqual(state.developer.users.map(u=>u.id).sort(),[1,2,3]);
  assert.equal((await f.request('/developer/identity',{actor,method:'POST',body:{memberId:2}})).status,200);
  const sales=(await f.request('/state',{actor,headers:{'X-CRM-Act-As':'2'}})).body;assert.ok(sales.opportunities.every(o=>o.owner_id===2));
  const callback=await fetch(f.base+'/api/auth/dingtalk/callback?code=isolated',{redirect:'manual'});assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/qf-crm/');
  const logout=await f.request('/auth/logout',{actor,method:'POST'});assert.match(logout.cookie,/Path=\/qf-crm\/; HttpOnly/);assert.equal((await f.request('/state',{actor})).status,401);
});

test('服务器授权入口使用HTTPS公网回调及局部状态Cookie，不发送外部请求',()=>{
  const ding=createDingTalk({secure:true,basePath:'/qf-crm/',env:{DINGTALK_CLIENT_ID:'isolated-app',DINGTALK_CLIENT_SECRET:'isolated-secret',DINGTALK_CORP_ID:'isolated-corp',DINGTALK_REDIRECT_URI:'https://qfspark.thousand-sails.com/qf-crm/api/auth/dingtalk/callback'},fetcher:()=>{throw new Error('must not contact DingTalk');}});
  const start=ding.start();assert.equal(new URL(start.body.url).searchParams.get('redirect_uri'),'https://qfspark.thousand-sails.com/qf-crm/api/auth/dingtalk/callback');assert.match(start.cookie,/Path=\/qf-crm\/api\/auth\/dingtalk;/);assert.match(start.cookie,/Secure/);
});

test('服务器配置固定回环监听、HTTPS回调及真实身份，拒绝不完整或不安全配置',()=>{
  const config={origin:'https://qfspark.thousand-sails.com',basePath:'/qf-crm/',port:5310,dbPath:'/srv/qianfan-crm/data/crm.sqlite',developerSwitch:true,dingtalk:{clientId:'test-app',clientSecret:'test-secret',corpId:'test-corp'}};
  const env=serverEnvironment(config);assert.equal(env.HOST,'127.0.0.1');assert.equal(env.DEMO_MODE,'false');assert.equal(env.DINGTALK_ONLY,'true');assert.equal(env.CRM_DEVELOPER_SWITCH,'true');assert.equal(env.DINGTALK_REDIRECT_URI,config.origin+'/qf-crm/api/auth/dingtalk/callback');
  assert.equal(env.CRM_MINUTES_BINARY,'/srv/qianfan-crm/runtime/minutes-tools/dws');assert.equal(env.CRM_MINUTES_CREDENTIAL_ROOT,'/srv/qianfan-crm/private/minutes-accounts');assert.equal(env.CRM_RUNTIME_ENVIRONMENT,'server');
  for(const patch of [{origin:'http://example.com'},{origin:'https://example.com/qf-crm/'},{basePath:'/qf-crm/../'},{dbPath:'relative.sqlite'},{port:80},{developerSwitch:undefined},{dingtalk:{}}])assert.throws(()=>serverEnvironment({...config,...patch}));
});

test('服务器AI独立配置限制模型、凭据和Python运行位置，不把私有值写入错误消息',()=>{
  const config={provider:'ppio',model:'qwen/qwen3.8-max',base_url:'https://api.ppio.com/openai/v1',apiKey:'isolated-private-key-for-test',python_executable:'/srv/qianfan-crm/runtime/intake-venv/bin/python3'};
  const env=serverAIEnvironment(config);assert.equal(env.PPIO_API_KEY,config.apiKey);assert.equal(env.CRM_PYTHON,config.python_executable);
  for(const patch of [{model:'other-model'},{base_url:'https://other.invalid'},{apiKey:'short'},{python_executable:'/usr/bin/python3'},{python_executable:'/srv/qianfan-crm/runtime/../../other/bin/python3'}])assert.throws(()=>serverAIEnvironment({...config,...patch}),error=>!error.message.includes(config.apiKey));
});
