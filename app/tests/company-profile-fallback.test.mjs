import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,one,run} from '../server/database.mjs';
import {createCompanyProfiles,companyIdentity,createCompanyProfileProvider} from '../server/company-profile.mjs';
import {withQwenCompanyFallback} from '../server/company-profile-fallback.mjs';
import {createQwenCompanyProfile,COMPANY_SEARCH_ENDPOINT,companySourceUrl} from '../server/qwen-company-profile.mjs';
import {createCompanyProfileQueue} from '../server/company-profile-queue.mjs';
import {AI_ENDPOINT,AI_MODEL} from '../server/ai-intake.mjs';
import {companyProfileDetails,companyProfileFeedback} from '../public/modules/customers.js';

const customer={id:1,name:'隔离测试科技有限公司',credit_code:'913ABC'};
const checkpoint={version:1,provider:'qcc-mcp',registration:{state:'ready',details:{company_name:customer.name,credit_code:'913ABC',registered_capital:'100万元'},checked_at:'2026-11-02T00:00:00Z'}};
const quota=()=>Object.assign(new Error('upstream-secret-never-expose'),{code:'QCC_QUOTA_EXHAUSTED'});
const ai=()=>({configured:true,model:AI_MODEL,lookup:async()=>({details:{company_description:'隔离产品制造商',registered_capital:'200万元'},field_sources:{company_description:'qwen',registered_capital:'qwen'},sources:[{id:1,title:'隔离企业官网',url:'https://example.com/company'}],reason:'来自公开搜索摘录'})});
const primary=lookup=>({configured:true,provider:'企查查 MCP',sourceUrl:'https://agent.qcc.com/guide',lookup});
function fixture(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());
  run(db,"INSERT INTO users(id,name,username,role,created_at) VALUES(1,'隔离成员','fallback-fixture','sales','2026-11-02')");
  run(db,"INSERT INTO customers(id,name,normalized,credit_code,owner_id,created_at,updated_at) VALUES(1,?,?,?,1,'2026-11-02','2026-11-02')",customer.name,customer.name,customer.credit_code);
  const profiles=createCompanyProfiles({db,provider:primary(()=>{}),scoped:()=>one(db,'SELECT * FROM customers WHERE id=1'),audit:()=>{}});
  return {db,profiles};
}

test('优先企查查，成功或主体冲突均不调用Qwen；无匹配可查公开资料',async()=>{
  let calls=0;const fallback={...ai(),lookup:async()=>{calls++;return ai().lookup();}};
  for(const state of ['ready','mismatch']){
    const result=await withQwenCompanyFallback(primary(async()=>({state,details:{company_name:customer.name},complete:state==='ready'})),{fallback}).lookup(customer);
    assert.equal(result.state,state);assert.equal(calls,0);
  }
  const result=await withQwenCompanyFallback(primary(async()=>({state:'not_found',details:{}})),{fallback}).lookup(customer);
  assert.equal(calls,1);assert.equal(result.state,'partial');assert.equal(result.details._lookup.fallback_code,'QCC_NOT_FOUND');
});

test('额度/授权/429/超时/接口错误均回退，参数及主体不明确/租约失败不能被AI绕过',async()=>{
  for(const code of ['QCC_QUOTA_EXHAUSTED','QCC_AUTH_INVALID','QCC_RATE_LIMITED','QCC_TRANSIENT','QCC_RESPONSE_INVALID']){
    let paused=false;
    const fallback={...ai(),lookup:async()=>{assert.equal(paused,true);return ai().lookup();}};
    const value=await withQwenCompanyFallback(primary(async()=>{throw Object.assign(new Error('private'),{code});}),{fallback}).lookup(customer,{onPrimaryFailure:async()=>{paused=true;}});
    assert.equal(value.state,'partial');assert.equal(value.complete,false);assert.equal(value.details._lookup.fallback_code,code);assert.doesNotMatch(JSON.stringify(value),/private/);
  }
  for(const code of ['QCC_IDENTITY_REQUIRED','BAD_CUSTOMER',undefined]){
    let calls=0;await assert.rejects(withQwenCompanyFallback(primary(async()=>{throw Object.assign(new Error('rejected'),{code});}),{fallback:{...ai(),lookup(){calls++;}}}).lookup(customer),/rejected/);assert.equal(calls,0);
  }
});

test('回退保留付费工商检查点且不重查，不以Qwen覆盖登记事实',async()=>{
  const provider=withQwenCompanyFallback(primary(async(c,{onCheckpoint})=>{await onCheckpoint(checkpoint);throw Object.assign(quota(),{checkpoint,partialResult:{details:{...checkpoint.registration.details,company_description:null,main_products:null}}});}),{fallback:ai()});
  let saved;const value=await provider.lookup(customer,{onCheckpoint:async c=>{saved=c;}});
  assert.deepEqual(saved,checkpoint);assert.deepEqual(value.checkpoint,checkpoint);
  assert.equal(value.details.registered_capital,'100万元');assert.equal(value.details.company_description,'隔离产品制造商');
  assert.equal(value.details._lookup.field_sources.registered_capital,'qcc');assert.equal(value.details._lookup.field_sources.company_description,'qwen');
  assert.match(value.provider,/企查查 MCP \+ Qwen/);
  let rejected=false;const safe=withQwenCompanyFallback(primary(async()=>{throw quota();}),{fallback:{...ai(),lookup(){rejected=true;}}});
  await assert.rejects(safe.lookup(customer,{onPrimaryFailure:async()=>{throw new Error('lease lost');}}),/lease lost/);assert.equal(rejected,false);
});

test('全局企查查额度暂停仍能手动查指定客户，持续暂停时直接Qwen且不查询其他历史余项',async t=>{
  const {db,profiles}=fixture(t);let qccCalls=0,aiCalls=0;
  const provider=withQwenCompanyFallback(primary(async()=>{qccCalls++;throw quota();}),{fallback:{...ai(),lookup:async()=>{aiCalls++;return ai().lookup();}}});
  const queue=createCompanyProfileQueue({db,provider,deployment:'local',commitResult:(c,r)=>profiles.saveResult(c,r)});
  queue.markRemainingManual();queue.enqueueCustomer(1,{manual:true});
  assert.equal((await queue.runNext({manual:true,customerId:1})).job.status,'partial');assert.equal(qccCalls,1);assert.equal(aiCalls,1);
  assert.equal(one(db,'SELECT pause_reason FROM company_profile_queue_control').pause_reason,'QCC_QUOTA_EXHAUSTED');
  assert.equal(queue.read(1).next_retry_at,null);assert.equal(queue.summary().pause_reason,'');
  run(db,"INSERT INTO customers(id,name,normalized,owner_id,created_at,updated_at) VALUES(2,'另一历史余项','另一历史余项',1,'2026-11-02','2026-11-02')");
  queue.markRemainingManual();assert.equal((await queue.runNext()).state,'disabled');
  queue.enqueueCustomer(1,{manual:true,retry:true});await queue.runNext({manual:true,customerId:1});
  assert.equal(qccCalls,1);assert.equal(aiCalls,2);assert.equal(queue.read(2).status,'failed');assert.equal(queue.read(2).manual_only,true);
  assert.equal(profiles.read(customer).state,'partial');assert.match(profiles.read(customer).provider,/Qwen/);
});

test('额度已恢复后下次仍优先企查查；AI完成不被当成完整已核验资料',async t=>{
  const {db}=fixture(t);let clock=Date.parse('2026-11-02T01:00:00Z'),qccCalls=0;
  const provider=withQwenCompanyFallback(primary(async()=>{qccCalls++;return {state:'ready',complete:true,details:{company_name:customer.name}};}),{fallback:ai()});
  const queue=createCompanyProfileQueue({db,provider,clock:()=>clock});
  run(db,"UPDATE company_profile_queue_control SET paused_until='2026-11-02T18:05:00Z',pause_reason='QCC_QUOTA_EXHAUSTED'");
  assert.equal((await queue.runNext({manual:true})).job.status,'partial');assert.equal(qccCalls,0);
  assert.equal((await queue.runNext({manual:true})).state,'idle');
  clock=Date.parse('2026-11-02T18:06:00Z');queue.enqueueCustomer(1,{manual:true});
  assert.equal((await queue.runNext({manual:true})).job.status,'complete');assert.equal(qccCalls,1);
});

test('两通道都失败脱敏报错并保留上次真实资料，已核验事实不被后续Qwen值替换',async t=>{
  const {profiles}=fixture(t);
  profiles.saveResult(customer,{state:'ready',complete:true,details:{company_name:customer.name,employee_scale:'100-199人'}});
  const prior=profiles.read(customer);
  const fallbackValue=await withQwenCompanyFallback(primary(async()=>{throw quota();}),{fallback:{...ai(),lookup:async()=>({...await ai().lookup(),details:{employee_scale:'200-299人',company_description:'新公开简介'}})}}).lookup(customer);
  profiles.saveResult(customer,fallbackValue);
  const kept=profiles.read(customer);assert.equal(kept.details.employee_scale,'100-199人');assert.equal(kept.details.company_description,'新公开简介');assert.equal(kept.details._lookup.field_sources.employee_scale,'qcc');assert.equal(kept.details._lookup.qcc_checked_at,prior.checked_at);
  const provider=withQwenCompanyFallback(primary(async()=>{throw quota();}),{fallback:{...ai(),lookup:async()=>{throw new Error('private-token');}}});
  let failure;try{await provider.lookup(customer);}catch(e){failure=e;}
  assert.equal(failure.code,'COMPANY_AI_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(failure),/private-token|upstream-secret/);
  profiles.saveResult(customer,failure.partialResult);assert.equal(profiles.read(customer).details.employee_scale,'100-199人');
  assert.equal(profiles.read(customer).state,'failed');
});

test('Qwen使用真实工作台协议先搜索后提取，只接受存在的来源和逐字依据',async()=>{
  const calls=[];const text=customer.name+' 统一社会信用代码913ABC。隔离产品制造商。员工人数50人。';
  const provider=createQwenCompanyProfile({env:{PPIO_API_KEY:'isolated-workbench-key'},fetcher:async(url,options)=>{
    calls.push(url);const body=JSON.parse(options.body);assert.equal(options.headers.Authorization,'Bearer isolated-workbench-key');assert.equal(options.redirect,'error');
    if(url===COMPANY_SEARCH_ENDPOINT){assert.equal(body.count,8);assert.equal(body.summary,true);assert.match(body.query,/913ABC/);assert.doesNotMatch(JSON.stringify(body),/内部跟进/);return Response.json({data:{webPages:{value:[{name:customer.name,url:'https://example.com/company',summary:text},{name:customer.name,url:'javascript:alert(1)',summary:text}]}}});}
    assert.equal(url,AI_ENDPOINT);assert.equal(body.model,AI_MODEL);assert.equal(body.response_format.type,'json_object');
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({company_name:customer.name,credit_code:'913ABC',fields:{company_description:{value:'隔离产品制造商',source_id:1,evidence:'隔离产品制造商。'},employee_scale:{value:'50人',source_id:1,evidence:'员工人数50人。'},registered_capital:{value:'100万元',source_id:1,evidence:'注册资本100万元'},business_scope:{value:'虚构范围',source_id:999,evidence:'虚构范围'},main_business:{value:'篡改后的主营',source_id:1,evidence:'隔离产品制造商。'}}})}}]});
  }});
  const result=await provider.lookup({...customer,note:'内部跟进'});
  assert.deepEqual(calls,[COMPANY_SEARCH_ENDPOINT,AI_ENDPOINT]);assert.deepEqual(result.details,{company_description:'隔离产品制造商',employee_scale:'50人'});assert.equal(result.sources.length,1);assert.equal(result.evidence.employee_scale.quote,'员工人数50人。');
});

test('无同主体搜索证据不调用模型、不造资料；有信用代码须匹配；AI截断或主体错拒绝',async()=>{
  for(const row of [{name:'另一个企业',url:'https://example.com',summary:'其他主体'},{name:customer.name,url:'https://example.com',summary:'信用代码912OTHER'}]){
    let calls=0;const p=createQwenCompanyProfile({env:{PPIO_API_KEY:'isolated'},fetcher:async()=>{calls++;return Response.json({webPages:{value:[row]}});}});
    assert.deepEqual((await p.lookup(customer)).details,{});assert.equal(calls,1);
  }
  for(const choice of [{finish_reason:'length',message:{content:'{}'}},{finish_reason:'stop',message:{content:JSON.stringify({company_name:'别的企业',fields:{}})}}]){
    let calls=0;const p=createQwenCompanyProfile({env:{PPIO_API_KEY:'isolated'},fetcher:async()=>{calls++;return Response.json(calls===1?{webPages:{value:[{name:customer.name,url:'https://example.com',summary:'913ABC'}]}}:{choices:[choice]});}});
    await assert.rejects(p.lookup(customer),e=>e.code==='COMPANY_AI_UNAVAILABLE');
  }
  for(const url of ['javascript:alert(1)','file:///private','https://127.0.0.1/x','http://localhost/x','https://user:password@example.com','http://test.local/a'])assert.equal(companySourceUrl(url),null);
});

test('显式MCP默认接上Qwen，无关key或关闭provider不隐式启动查询',()=>{
  assert.equal(createCompanyProfileProvider({env:{CRM_COMPANY_PROFILE_PROVIDER:'qcc-mcp',PPIO_API_KEY:'fixture'}}).fallbackConfigured,true);
  assert.equal(createCompanyProfileProvider({env:{PPIO_API_KEY:'fixture'}}).configured,false);
  assert.equal(createCompanyProfileProvider({env:{CRM_COMPANY_PROFILE_PROVIDER:'off',PPIO_API_KEY:'fixture'}}).configured,false);
});

test('页面标记Qwen字段、可追溯来源且转义，不恢复队列标签；点击有明确反馈',()=>{
  const p={state:'partial',provider:'Qwen 联网整理（待核验）',reason:'已转 Qwen',details:{company_description:'<img src=x>',_lookup:{kind:'qwen',field_sources:{company_description:'qwen'},sources:[{title:'公开资料<script>',url:'https://example.com/?a=1&b=2'},{title:'恶意',url:'javascript:alert(1)'}]}}};
  const html=companyProfileDetails({id:1,company_profile:p},true);
  assert.match(html,/Qwen 整理，待核验/);assert.match(html,/https:\/\/example.com\/\?a=1&amp;b=2/);assert.doesNotMatch(html,/javascript:|<img|<script>|已排队|等待额度/);
  assert.match(html,/target="_blank" rel="noopener noreferrer"/);
  assert.equal(companyProfileFeedback(p).message,'已转 Qwen');assert.equal(companyProfileFeedback({...p,job:{status:'running'}}).pending,true);
  assert.equal(companyProfileFeedback({state:'failed',reason:'两通道均失败'}).error,true);
  assert.equal(companyProfileFeedback({state:'ready'}).message,'企业资料已更新');
});
