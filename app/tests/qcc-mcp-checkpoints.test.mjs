import test from 'node:test';
import assert from 'node:assert/strict';
import {AppError} from '../server/domain.mjs';
import {createQccMcpProfileProvider} from '../server/qcc-mcp-profile.mjs';
import {QCC_MCP_VERSION} from '../server/qcc-mcp-transport.mjs';

const company={name:'续读隔离测试科技有限公司',credit_code:'91310000MA1K00000X'};
const registration='get_company_registration_info',profile='get_company_profile';
const key='synthetic-qcc-key-only';
const tool=name=>({name,inputSchema:{type:'object',properties:{searchKey:{type:'string'}},required:['searchKey']}});
const json=(id,result)=>new Response(JSON.stringify({jsonrpc:'2.0',id,result}),{headers:{'Content-Type':'application/json'}});
function fixture({hook,subject=company}={}){
  const messages=[];
  const fetcher=async(_url,options)=>{
    const m=JSON.parse(options.body);messages.push(m);const custom=await hook?.(m);if(custom)return custom;
    if(m.method==='initialize')return json(m.id,{protocolVersion:QCC_MCP_VERSION,capabilities:{tools:{}}});
    if(m.method==='notifications/initialized')return new Response(null,{status:202});
    if(m.method==='tools/list')return json(m.id,{tools:[tool(registration),tool(profile)]});
    const data=m.params.name===registration?{'企业名称':subject.name,'统一社会信用代码':subject.credit_code,'人员规模':'20-49人','经营范围':'软件开发','参保人数':0}:{'企业名称':subject.name,'企业规模':'小型','简介':'源提供的简介','主营产品':['软件']};
    return json(m.id,{structuredContent:data});
  };
  return {messages,provider:createQccMcpProfileProvider({env:{CRM_COMPANY_PROFILE_PROVIDER:'qcc-mcp',QCC_MCP_API_KEY:key},fetcher}),calls:()=>messages.filter(m=>m.method==='tools/call').map(m=>m.params.name)};
}

test('工商检查点须先持久化完成才查询简介；积分不足保留partial并仅续读缺失工具',async()=>{
  let saved,entered;const began=new Promise(r=>entered=r);let release;const commit=new Promise(r=>release=r);
  const first=fixture({hook:m=>m.method==='tools/call'&&m.params.name===profile?json(m.id,{isError:true,content:[{type:'text',text:JSON.stringify({code:300008,message:'upstream-sensitive-token'})}]}):null});
  const pending=first.provider.lookup(company,{onCheckpoint:async cp=>{entered();await commit;saved=cp;}});
  const rejected=assert.rejects(pending,error=>{
    assert.equal(error.code,'QCC_QUOTA_EXHAUSTED');assert.equal(error.retryable,false);assert.doesNotMatch(error.message,/upstream-sensitive-token|synthetic-qcc/);
    assert.equal(error.partialResult.state,'partial');assert.equal(error.partialResult.complete,false);assert.equal(error.partialResult.details.insured_count,'0');assert.deepEqual(error.checkpoint,saved);return true;
  });
  await began;assert.deepEqual(first.calls(),[registration]);release();await rejected;
  const second=fixture(),result=await second.provider.lookup(company,{checkpoint:saved,onCheckpoint:async cp=>{saved=cp;}});
  assert.deepEqual(second.calls(),[profile]);assert.equal(result.state,'ready');assert.equal(result.complete,true);assert.equal(result.details.company_description,'源提供的简介');
  assert.equal(saved.registration.state,'ready');assert.equal(saved.profile.state,'ready');
  const cached=fixture(),again=await cached.provider.lookup(company,{checkpoint:saved});assert.equal(again.complete,true);assert.equal(cached.messages.length,0);
});

test('客户名称或信用代码变更不能复用旧主体检查点',async()=>{
  const original=await fixture().provider.lookup(company);
  for(const changed of [{...company,name:'另外隔离主体有限公司'},{...company,credit_code:'91310000MA1K00001X'}]){
    const next=fixture({subject:changed}),result=await next.provider.lookup(changed,{checkpoint:original.checkpoint});
    assert.equal(result.complete,true);assert.deepEqual(next.calls(),[registration,profile]);assert.equal(result.details.company_name,changed.name);
  }
});

test('不接纳含未知身份覆盖或凭据字段的缓存，不将其带入资料',async()=>{
  const original=await fixture().provider.lookup(company);
  original.checkpoint.profile.details.company_name='别的主体';original.checkpoint.registration.details.apiKey='not-a-company-field';
  const next=fixture(),result=await next.provider.lookup(company,{checkpoint:original.checkpoint});assert.deepEqual(next.calls(),[registration,profile]);
  assert.equal(result.details.company_name,company.name);assert.equal(result.details.apiKey,undefined);
});

test('HTTP限流与积分不足、鉴权失败、服务故障分别分类，Retry-After只作限流退避',async()=>{
  const cases=[
    [401,null,'QCC_AUTH_INVALID'],[403,null,'QCC_AUTH_INVALID'],[429,null,'QCC_RATE_LIMITED'],[503,null,'QCC_TRANSIENT'],
    [402,{code:300008,message:'secret-detail'},'QCC_QUOTA_EXHAUSTED'],[400,{error:{code:200001,message:'secret-detail'}},'QCC_AUTH_INVALID'],
  ];
  for(const [status,body,code] of cases){
    const f=fixture({hook:()=>new Response(body?JSON.stringify(body):null,{status,headers:{'Content-Type':'application/json','Retry-After':'2'}})});
    await assert.rejects(f.provider.lookup(company),error=>{assert.equal(error.code,code);assert.doesNotMatch(error.message,/secret-detail/);if(code==='QCC_RATE_LIMITED'){assert.equal(error.retryAfterMs,2000);assert.equal(error.retryable,true);}return true;});
    assert.equal(f.messages.length,1);
  }
});

test('JSON-RPC和MCP工具内部的已知错误码透传为固定脱敏分类',async()=>{
  for(const envelope of ['rpc','structured','text','normal-data']){
    const f=fixture({hook:m=>{
      if(m.method!=='tools/call')return;
      const err={code:300008,message:'secret-token-must-not-escape'};
      if(envelope==='rpc')return new Response(JSON.stringify({jsonrpc:'2.0',id:m.id,error:err}),{headers:{'Content-Type':'application/json'}});
      if(envelope==='structured')return json(m.id,{isError:true,structuredContent:err});
      if(envelope==='text')return json(m.id,{isError:true,content:[{type:'text',text:JSON.stringify(err)}]});
      return json(m.id,{structuredContent:{...err,data:{'企业名称':company.name}}});
    }});
    await assert.rejects(f.provider.lookup(company),error=>{assert.equal(error.code,'QCC_QUOTA_EXHAUSTED');assert.doesNotMatch(error.message,/secret-token/);return true;});assert.deepEqual(f.calls(),[registration]);
  }
});

test('临时网络异常属于可重试错误且保留工商进度，未知协议错误不作额度猜测',async()=>{
  const network=fixture({hook:m=>{if(m.method==='tools/call'&&m.params.name===profile)throw new Error('network secret-token');}});
  await assert.rejects(network.provider.lookup(company),error=>{assert.equal(error.code,'QCC_TRANSIENT');assert.equal(error.retryable,true);assert.equal(error.checkpoint.registration.state,'ready');assert.equal(error.partialResult.complete,false);assert.doesNotMatch(error.message,/secret-token/);return true;});
  const malformed=fixture({hook:m=>m.method==='tools/call'?new Response('not json SECRET',{headers:{'Content-Type':'application/json'}}):null});
  await assert.rejects(malformed.provider.lookup(company),error=>error.code==='QCC_RESPONSE_INVALID'&&error.retryable===false);
});

test('检查点保存时权限或版本复核失败直接中止，不执行后续收费查询',async()=>{
  const f=fixture(),denied=new AppError('隔离权限已变化',403);
  await assert.rejects(f.provider.lookup(company,{onCheckpoint:async()=>{throw denied;}}),error=>{assert.equal(error,denied);assert.equal(error.checkpoint,undefined);return true;});
  assert.deepEqual(f.calls(),[registration]);
  let callbacks=0,saved;const second=fixture();
  await assert.rejects(second.provider.lookup(company,{onCheckpoint:async cp=>{if(++callbacks===2)throw denied;saved=cp;}}),error=>error===denied);
  assert.equal(saved.registration.state,'ready');assert.equal(saved.profile,undefined);
});

test('简介查询成功但来源未提供结果可完成，未知字段不补造',async()=>{
  const f=fixture({hook:m=>m.method==='tools/call'&&m.params.name===profile?json(m.id,{content:[{type:'text',text:'{"Result":null}'}]}):null});
  const result=await f.provider.lookup(company);assert.equal(result.complete,true);assert.equal(result.state,'ready');assert.equal(result.checkpoint.profile.state,'not_found');assert.match(result.reason,/来源未提供/);assert.equal(result.details.main_products,null);assert.equal(result.details.company_scale,null);assert.equal(result.details.annual_employees,null);
});

test('查无工商主体和主体不匹配都不计为完整成功，也不查询后续简介',async()=>{
  for(const data of [{Result:null},{'企业名称':'另一个主体有限公司'}]){
    const f=fixture({hook:m=>m.method==='tools/call'?json(m.id,{structuredContent:data}):null});let checkpoints=0;
    const result=await f.provider.lookup(company,{onCheckpoint:()=>{checkpoints++;}});assert.equal(result.complete,false);assert(['not_found','mismatch'].includes(result.state));assert.equal(checkpoints,0);assert.deepEqual(f.calls(),[registration]);
  }
});

test('续读时授权失效保留已完成工商，不将其重复查询或误标完整',async()=>{
  const original=await fixture().provider.lookup(company);delete original.checkpoint.profile;
  const f=fixture({hook:()=>new Response(null,{status:401})});
  await assert.rejects(f.provider.lookup(company,{checkpoint:original.checkpoint}),error=>{assert.equal(error.code,'QCC_AUTH_INVALID');assert.equal(error.partialResult.state,'partial');assert.equal(error.partialResult.complete,false);assert.equal(error.checkpoint.registration.checked_at,original.checkpoint.registration.checked_at);return true;});assert.deepEqual(f.calls(),[]);
});

test('畸形工具content返回明确协议错误，不泄漏远端文本或原生TypeError',async()=>{
  for(const content of [{secret:'sensitive-upstream-token'},42,'sensitive-upstream-token']){
    const f=fixture({hook:m=>m.method==='tools/call'&&m.params.name===profile?json(m.id,{content}):null});
    await assert.rejects(f.provider.lookup(company),error=>{assert.equal(error.code,'QCC_RESPONSE_INVALID');assert.equal(error.retryable,false);assert.equal(error.partialResult.state,'partial');assert.doesNotMatch(error.message,/sensitive-upstream-token|filter|iterable/);return true;});
  }
  const known=fixture({hook:m=>m.method==='tools/call'?json(m.id,{isError:true,structuredContent:{code:300008},content:{invalid:true}}):null});
  await assert.rejects(known.provider.lookup(company),error=>error.code==='QCC_QUOTA_EXHAUSTED');
});

test('缓存只重放已定义步骤字段，不传播检查点中多余元数据',async()=>{
  const original=await fixture().provider.lookup(company);
  original.checkpoint.registration.apiKey='do-not-copy';original.checkpoint.profile.extra='do-not-copy';original.checkpoint.secret='do-not-copy';
  const cached=fixture(),result=await cached.provider.lookup(company,{checkpoint:original.checkpoint});
  assert.equal(result.complete,true);assert.equal(cached.messages.length,0);assert.doesNotMatch(JSON.stringify(result),/do-not-copy/);
});

test('官方唯一无匹配项对象明确not_found，简介同形态无资料仍是成功查询',async()=>{
  for(const data of [{'无匹配项':'没有查询到企业'},{Result:{'无匹配项':[]}}]){
    const f=fixture({hook:m=>m.method==='tools/call'?json(m.id,{content:[{type:'text',text:JSON.stringify(data)}]}):null});
    const result=await f.provider.lookup(company);assert.equal(result.state,'not_found');assert.equal(result.complete,false);assert.deepEqual(result.details,{});assert.deepEqual(f.calls(),[registration]);
  }
  const f=fixture({hook:m=>m.method==='tools/call'&&m.params.name===profile?json(m.id,{content:[{type:'text',text:'{"无匹配项":"没有企业简介"}'}]}):null});
  const result=await f.provider.lookup(company);assert.equal(result.state,'ready');assert.equal(result.complete,true);assert.equal(result.checkpoint.profile.state,'not_found');assert.equal(result.details.company_description,null);
});

test('无匹配项标记不能吞掉同对象企业主体，也不扫描普通描述文字',async()=>{
  for(const extra of [{'无匹配项':'普通标记'},{'简介':'普通描述里写了无匹配项'}]){
    const f=fixture({hook:m=>m.method==='tools/call'&&m.params.name===registration?json(m.id,{structuredContent:{'企业名称':company.name,'统一社会信用代码':company.credit_code,...extra}}):null});
    const result=await f.provider.lookup(company);assert.equal(result.state,'ready');assert.equal(result.complete,true);assert.deepEqual(f.calls(),[registration,profile]);
  }
  for(const data of [{'描述':'无匹配项'},{'无匹配项':'没有数据','其他字段':'不能当单键标记'}]){
    const f=fixture({hook:m=>m.method==='tools/call'?json(m.id,{structuredContent:data}):null});
    await assert.rejects(f.provider.lookup(company),error=>error.code==='QCC_RESPONSE_INVALID');
  }
});

test('无匹配项标记旁的额度或鉴权错误优先保留明确错误，不作为查无数据',async()=>{
  for(const [data,code] of [
    [{'无匹配项':'没有数据',code:300008},'QCC_QUOTA_EXHAUSTED'],
    [{'无匹配项':'没有数据',error:{code:200001}},'QCC_AUTH_INVALID'],
    [{'无匹配项':'没有数据',success:false},'QCC_RESPONSE_INVALID'],
  ]){
    const f=fixture({hook:m=>m.method==='tools/call'?json(m.id,{structuredContent:data}):null});
    await assert.rejects(f.provider.lookup(company),error=>error.code===code);assert.deepEqual(f.calls(),[registration]);
  }
});
