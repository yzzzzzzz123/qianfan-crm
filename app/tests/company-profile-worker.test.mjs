import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCompanyProfileWorker} from '../server/company-profile-worker.mjs';
import {prepareLocalCompanyProfileAutomation,validateLocalCompanyProfileAutomation} from '../../local/company-profile-automation.mjs';

test('企业资料本地授权限定项目、数据库和回环预览运行环境',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qf-profile-authority-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.equal(prepareLocalCompanyProfileAutomation(root),null);
  fs.mkdirSync(path.join(root,'.private'));
  const record={version:1,scope:'qianfan-company-profile',target:'local',automatic:true,project_root:root,database:'app/data/crm.sqlite',origin:'http://127.0.0.1:3100'};
  const file=path.join(root,'.private/company-profile-automation.json');fs.writeFileSync(file,JSON.stringify(record));
  const authority=prepareLocalCompanyProfileAutomation(root,{platform:'win32'});
  const context={platform:'win32',localHttp:true,projectRoot:root,filename:path.join(root,record.database),origin:record.origin};
  assert.equal(validateLocalCompanyProfileAutomation(authority,context).runtimeChecked,true);
  for(const patch of [{platform:'linux'},{localHttp:false},{filename:path.join(root,'other.sqlite')},{origin:'http://0.0.0.0:3100'},{projectRoot:path.join(root,'other')}])assert.equal(validateLocalCompanyProfileAutomation(authority,{...context,...patch}),null);
  fs.writeFileSync(file,JSON.stringify({...record,scope:'minutes'}));
  assert.throws(()=>prepareLocalCompanyProfileAutomation(root,{platform:'win32'}),/授权无效/);
});

test('本地默认及未完成运行时校验的开关都不能启动自动查询',async()=>{
  for(const localAutomation of [undefined,{authorized:true,scope:'qianfan-company-profile'},{authorized:true,runtimeChecked:true,scope:'minutes'}]){
    let calls=0;const worker=createCompanyProfileWorker({queue:{runNext(){calls++;},enqueueAll(){calls++;}},configured:true,localAutomation,gapMs:0});
    assert.equal(worker.automatic,false);worker.startScheduler()();assert.equal((await worker.kick()).state,'disabled');assert.equal(calls,0);
  }
});

test('手动全量运行保留队列状态并在明确额度不足时停止，单进程不重复领取',async()=>{
  let calls=0,release;const first=new Promise(resolve=>{release=resolve;});
  const worker=createCompanyProfileWorker({queue:{async runNext(){calls++;if(calls===1){await first;return {state:'processed'};}return {state:'waiting_quota'};}},configured:true,gapMs:0});
  const one=worker.kick({manual:true}),two=worker.kick({manual:true});assert.equal(one,two);release();
  const result=await one;assert.equal(result.state,'waiting_quota');assert.equal(result.processed,1);assert.equal(calls,2);await worker.shutdown();
});

test('本地明确授权只启用企业资料worker，启动补入全部已有客户且停止后不再执行',async()=>{
  let enqueued=0,calls=0;let reached;const ran=new Promise(resolve=>{reached=resolve;});
  const worker=createCompanyProfileWorker({queue:{enqueueAll(){enqueued++;},async runNext(){calls++;reached();return {state:'idle'};}},configured:true,localAutomation:{authorized:true,runtimeChecked:true,scope:'qianfan-company-profile'},gapMs:0});
  assert.equal(worker.automatic,true);worker.startScheduler();await ran;await worker.shutdown();
  assert.equal(enqueued,1);assert.equal(calls,1);assert.equal((await worker.kick()).state,'disabled');
});

test('自动任务在执行时收到单客户手动请求，保留该意图且不顺带领取其他余项',async()=>{
  const calls=[];let release;const gate=new Promise(resolve=>{release=resolve;});
  const worker=createCompanyProfileWorker({queue:{async runNext(options){calls.push(options);if(calls.length===1){await gate;return {state:'processed'};}return {state:'processed'};}},configured:true,deployment:'production',gapMs:0});
  const automatic=worker.kick();
  const manual=worker.kick({manual:true,customerId:42,maxJobs:1});
  release();await automatic;await manual;
  assert.deepEqual(calls,[{manual:false},{manual:true,customerId:42}]);await worker.shutdown();
});
