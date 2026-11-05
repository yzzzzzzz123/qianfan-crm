import test from 'node:test';
import assert from 'node:assert/strict';
import { createDingTalk } from '../server/dingtalk.mjs';
import { refreshDailyReport } from '../server/scheduler.mjs';
import { openDatabase,all } from '../server/database.mjs';
import { seedDemo } from '../server/seed.mjs';
const env={DINGTALK_CLIENT_ID:'test-app',DINGTALK_CLIENT_SECRET:'test-secret',DINGTALK_CORP_ID:'test-corp',DINGTALK_REDIRECT_URI:'http://127.0.0.1:3100/'};
const response=value=>({ok:true,json:async()=>value});

test('听记跨组织本人核验：详情不返回手机号时精确查成员，不改变权限或按姓名匹配',async()=>{
  for(const mappedId of ['primary-member','other-member']){
    const paths=[],ding=createDingTalk({env:{...env,DINGTALK_CORP_ID:'dingPrimary'},fetcher:async(url,options)=>{const p=new URL(url).pathname;paths.push(p);if(p==='/v1.0/oauth2/accessToken')return response({accessToken:'isolated-token'});if(p==='/topapi/v2/user/get')return response({result:{userid:'primary-member',unionid:'primary-union'}});assert.equal(p,'/topapi/v2/user/getbymobile');assert.deepEqual(JSON.parse(options.body),{mobile:'13800138000'});return response({result:{userid:mappedId}});}});
    const check=()=>ding.verifyMinutesIdentity({corpId:'dingPrimary',userId:'primary-member',unionId:'primary-union'},{corpId:'dingOtherOrganization',dwsUserId:'987654321',mobile:'13800138000',countryCode:'86'});
    if(mappedId==='primary-member')assert.deepEqual(await check(),{corpId:'dingPrimary',userId:'primary-member',unionId:'primary-union'});else await assert.rejects(check,/本人/);
    assert.equal(paths.filter(p=>p.endsWith('getbymobile')).length,1);assert.ok(paths.every(p=>!p.includes('update')&&!p.includes('create')));
  }
});
test('PRD-钉钉 OAuth要求一次性state及受控凭证，不依赖前端身份',async()=>{
  const calls=[];const ding=createDingTalk({env,fetcher:async(url,options)=>{calls.push({url,body:options.body});return response(url.endsWith('/users/me')?{unionId:'verified-union'}:url.includes('/topapi/user/getbyunionid')?{result:{userid:'test-user'}}:url.includes('/topapi/v2/user/get?')?{result:{userid:'test-user',unionid:'verified-union'}}:{accessToken:'test-access',corpId:'test-corp'});}});
  const started=ding.start(),state=new URL(started.body.url).searchParams.get('state');
  assert.ok(state.length>=32);const req={headers:{cookie:started.cookie.split(';')[0]}};
  assert.deepEqual(await ding.identity(req,{state,code:'auth-code',userId:'forged-user',unionId:'forged-union',corpId:'forged-corp'}),{unionId:'verified-union',userId:'test-user',corpId:'test-corp',seconds:7200});
  await assert.rejects(()=>ding.identity(req,{state,code:'auth-code'}),/校验已过期/);
  assert.equal(calls.length,5);assert.equal(JSON.parse(calls[0].body).grantType,'authorization_code');
  await assert.rejects(()=>ding.identity(req,{state:'forged',code:'auth-code'}),/校验已过期/);
});
test('PRD-钉钉只暴露登录和直连身份核验，不读取PPL配置或请求表格接口',async()=>{
  const calls=[];
  const identityEnv=new Proxy(env,{get(target,key){assert.ok(Object.hasOwn(target,key),'unexpected configuration read');return target[key];}});
  const ding=createDingTalk({env:identityEnv,fetcher:async(url,options)=>{
    const path=new URL(url).pathname;calls.push(path);
    assert.equal(options.redirect,'error');
    switch(path){
      case '/v1.0/oauth2/userAccessToken': return response({accessToken:'test-user-token',corpId:'test-corp',expireIn:1800});
      case '/v1.0/contact/users/me': assert.equal(options.headers['x-acs-dingtalk-access-token'],'test-user-token');return response({unionId:'verified-union'});
      case '/v1.0/oauth2/accessToken': return response({accessToken:'test-app-token',expireIn:7200});
      case '/topapi/user/getbyunionid': assert.deepEqual(JSON.parse(options.body),{unionid:'verified-union'});return response({result:{userid:'test-user'}});
      case '/topapi/v2/user/get': assert.deepEqual(JSON.parse(options.body),{userid:'test-user',language:'zh_CN'});return response({result:{userid:'test-user',unionid:'verified-union'}});
      default: throw new Error('Unexpected DingTalk endpoint');
    }
  }});
  assert.deepEqual(Object.keys(ding).sort(),['configured','identity','loginConfigured','start','verifyMinutesIdentity']);
  for(let i=0;i<2;i++){
    const started=ding.start(),state=new URL(started.body.url).searchParams.get('state');
    assert.deepEqual(await ding.identity({headers:{cookie:started.cookie.split(';')[0]}},{state,code:'test-code'}),{unionId:'verified-union',userId:'test-user',corpId:'test-corp',seconds:1800});
  }
  assert.equal(calls.length,9);
  assert.equal(calls.filter(path=>path==='/v1.0/oauth2/accessToken').length,1,'cache only the enterprise application token');
  assert.equal(calls.filter(path=>path==='/v1.0/contact/users/me').length,2,'recheck each employee login');
});

test('PRD-企业身份必须匹配配置企业，企业userId与unionId须双向一致',async()=>{
  for(const mismatch of ['corp','user','union']){
    const ding=createDingTalk({env,fetcher:async url=>{
      const path=new URL(url).pathname;
      if(path==='/v1.0/oauth2/userAccessToken')return response({accessToken:'test-user-token',corpId:mismatch==='corp'?'other-corp':'test-corp'});
      if(path==='/v1.0/contact/users/me')return response({unionId:'verified-union'});
      if(path==='/v1.0/oauth2/accessToken')return response({accessToken:'test-app-token'});
      if(path==='/topapi/user/getbyunionid')return response({result:{userid:'test-user'}});
      if(path==='/topapi/v2/user/get')return response({result:{userid:mismatch==='user'?'other-user':'test-user',unionid:mismatch==='union'?'other-union':'verified-union'}});
      throw new Error('Unexpected DingTalk endpoint');
    }});
    const started=ding.start(),state=new URL(started.body.url).searchParams.get('state');
    await assert.rejects(()=>ding.identity({headers:{cookie:started.cookie.split(';')[0]}},{state,code:'test-code'}),error=>error.status===403&&/指定企业|身份核验/.test(error.message));
  }
});
test('PRD-每日20点刷新只补最新一次，不重复生成历史快照',()=>{
  const db=openDatabase(':memory:');try {seedDemo(db);assert.equal(refreshDailyReport(db,new Date('2026-10-20T19:00:00+08:00')),true);assert.equal(refreshDailyReport(db,new Date('2026-10-20T19:01:00+08:00')),false);assert.equal(refreshDailyReport(db,new Date('2026-10-23T21:00:00+08:00')),true);assert.deepEqual(all(db,'SELECT day FROM daily_reports ORDER BY day').map(r=>r.day),['2026-10-19','2026-10-23']);}finally{db.close();}
});
