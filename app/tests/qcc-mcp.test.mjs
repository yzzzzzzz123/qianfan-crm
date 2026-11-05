import test from 'node:test';
import assert from 'node:assert/strict';
import {createQccMcpClient,QCC_MCP_ENDPOINT,QCC_MCP_VERSION} from '../server/qcc-mcp-transport.mjs';
import {createCompanyProfileProvider} from '../server/company-profile.mjs';
import {qccCompanyArguments} from '../server/qcc-mcp-profile.mjs';

const name='隔离示例科技有限公司',credit='91310000TEST000001',key='fake-qcc-key-never-real';
const registration='get_company_registration_info',profile='get_company_profile';
const tool=name=>({name,inputSchema:{type:'object',properties:{searchKey:{type:'string',description:'企业名称或统一社会信用代码'}},required:['searchKey']}});
// Field shapes follow the official static examples, with synthetic values:
// https://agent.qcc.com/data/qcc-company/get_company_registration_info?tab=example
// https://agent.qcc.com/data/qcc-company/get_company_profile?tab=example
const registered=()=>({'企业名称':name,'统一社会信用代码':credit,'经营范围':'软件开发；信息技术咨询服务','注册资本':'100万元','人员规模':'100-199人','参保人数':0,'国标行业':{'门类':'信息技术业','大类':'软件服务','中类':'','小类':''}});
const described=()=>({'企业名称':name,'企业规模':'大型','主营产品':['客户管理软件','数据分析服务'],'简介':'源平台返回的企业简介','企查查行业':{'一级':'信息技术','二级':'新兴信息技术','三级':'软件服务','四级':''}});
const json=(id,result,headers={})=>new Response(JSON.stringify({jsonrpc:'2.0',id,result}),{headers:{'Content-Type':'application/json',...headers}});
function fakeServer({tools=[tool(registration),tool(profile)],rows={[registration]:registered(),[profile]:described()},hook}={}){
  const requests=[];
  const fetcher=async(url,options)=>{
    const message=JSON.parse(options.body);requests.push({url,options,message});
    const custom=await hook?.(message,requests);if(custom)return custom;
    if(message.method==='initialize')return json(message.id,{protocolVersion:QCC_MCP_VERSION,capabilities:{tools:{}},serverInfo:{name:'isolated-qcc',version:'1'}},{'Mcp-Session-Id':'isolated-session'});
    if(message.method==='notifications/initialized')return new Response(null,{status:202});
    if(message.method==='tools/list')return json(message.id,{tools});
    if(message.method==='tools/call')return json(message.id,{structuredContent:rows[message.params.name]});
    assert.fail('unexpected method');
  };
  return {fetcher,requests};
}
const provider=server=>createCompanyProfileProvider({env:{CRM_COMPANY_PROFILE_PROVIDER:'qcc-mcp',QCC_MCP_API_KEY:key},fetcher:server.fetcher});
const calls=server=>server.requests.filter(r=>r.message.method==='tools/call');

test('MCP provider没有显式启用及密钥时完全不出网，原OpenAPI适配保持独立',async()=>{
  let calls=0;const fetcher=async()=>{calls++;throw new Error('must not run');};
  for(const env of [{},{QCC_MCP_API_KEY:key},{CRM_COMPANY_PROFILE_PROVIDER:'qcc-mcp'},{CRM_COMPANY_PROFILE_PROVIDER:'qcc-mcp',QCC_APP_KEY:'old',QCC_SECRET_KEY:'old'}]){
    const p=createCompanyProfileProvider({env,fetcher});assert.equal(p.configured,false);await assert.rejects(p.lookup({name}),/未配置/);
  }
  const old=createCompanyProfileProvider({env:{CRM_COMPANY_PROFILE_PROVIDER:'qcc',QCC_APP_KEY:'old',QCC_SECRET_KEY:'old'},fetcher});
  assert.equal(old.provider,'企查查（企业工商详情）');assert.equal(calls,0);
});

test('完整MCP握手、session/version与工具定义先核验；只调用工商和简介',async()=>{
  const server=fakeServer(),result=await provider(server).lookup({name,credit_code:credit});
  assert.equal(result.state,'ready');assert.equal(result.details.company_name,name);assert.equal(result.details.insured_count,'0');
  assert.equal(result.details.employee_scale,'100-199人');assert.equal(result.details.company_scale,'大型');assert.equal(result.details.main_products,'客户管理软件；数据分析服务');
  assert.equal(result.details.industry,'信息技术 / 新兴信息技术 / 软件服务');assert.equal(result.details.national_industry,'信息技术业 / 软件服务');
  assert.equal(result.details.company_description,'源平台返回的企业简介');assert.equal(result.details.main_business,null);
  assert.equal(result.details.annual_employees,null);assert.equal(result.details.annual_report_year,null);
  assert.deepEqual(server.requests.map(r=>r.message.method),['initialize','notifications/initialized','tools/list','tools/call','tools/call']);
  for(const [i,r] of server.requests.entries()){
    assert.equal(r.url,QCC_MCP_ENDPOINT);assert.equal(r.options.redirect,'error');assert.equal(r.options.headers.Authorization,'Bearer '+key);
    assert.equal(r.options.headers.Accept,'application/json, text/event-stream');assert(r.options.signal);
    if(i){assert.equal(r.options.headers['Mcp-Session-Id'],'isolated-session');assert.equal(r.options.headers['MCP-Protocol-Version'],QCC_MCP_VERSION);}
  }
  assert.deepEqual(calls(server).map(r=>r.message.params),[registration,profile].map(name=>({name,arguments:{searchKey:credit}})));
});

test('没有信用代码时使用完整名称，NFKC名称校验不做模糊主体选择',async()=>{
  const server=fakeServer();assert.equal((await provider(server).lookup({name:'  '+name+'  '})).state,'ready');
  assert.equal(calls(server)[0].message.params.arguments.searchKey,name);
  const wrong=fakeServer({rows:{[registration]:{...registered(),'企业名称':'隔离示例科技发展有限公司'}}});
  assert.equal((await provider(wrong).lookup({name})).state,'mismatch');assert.equal(calls(wrong).length,1);
});

test('已有信用代码时必须核对工商返回，简介异主体不能混入',async()=>{
  for(const code of ['wrong',null]){
    const server=fakeServer({rows:{[registration]:{...registered(),'统一社会信用代码':code}}});
    const result=await provider(server).lookup({name,credit_code:credit});assert.equal(result.state,'mismatch');assert.deepEqual(result.details,{});assert.equal(calls(server).length,1);
  }
  const server=fakeServer({rows:{[registration]:registered(),[profile]:{...described(),'统一社会信用代码':'other'}}});
  assert.equal((await provider(server).lookup({name,credit_code:credit})).state,'mismatch');
});

test('文本JSON/单记录包装可读，空查询明确not_found，多主体绝不取第一条',async()=>{
  const server=fakeServer({hook:m=>m.method==='tools/call'?json(m.id,{content:[{type:'text',text:JSON.stringify({Result:[m.params.name===registration?registered():described()]})}]}):null});
  assert.equal((await provider(server).lookup({name})).state,'ready');
  const empty=fakeServer({hook:m=>m.method==='tools/call'?json(m.id,{content:[{type:'text',text:'{"Result":null}'}]}):null});
  assert.equal((await provider(empty).lookup({name})).state,'not_found');assert.equal(calls(empty).length,1);
  const many=fakeServer({rows:{[registration]:{data:[registered(),registered()]}}});
  await assert.rejects(provider(many).lookup({name}),error=>error.code==='QCC_IDENTITY_REQUIRED');assert.equal(calls(many).length,1);
});

test('SSE跨UTF8字节分块和通知可读，收到对应结果即关闭流',async()=>{
  let cancelled=false;
  const server=fakeServer({hook:m=>{
    if(m.method!=='tools/call')return;
    const payload=': heartbeat\r\n\r\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progress:1}})+'\r\n\r\nevent: message\r\ndata: '+JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify(m.params.name===registration?registered():described())}]}})+'\r\n\r\n';
    const bytes=new TextEncoder().encode(payload);let offset=0;
    return new Response(new ReadableStream({pull(c){if(offset<bytes.length){c.enqueue(bytes.slice(offset,offset+=7));}},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
  }});
  assert.equal((await provider(server).lookup({name})).state,'ready');assert.equal(cancelled,true);
});

test('工具分页追踪游标后发现两工具，没有额外付费查询',async()=>{
  const server=fakeServer({hook:m=>m.method==='tools/list'?json(m.id,m.params.cursor?{tools:[tool(profile)]}:{tools:[tool(registration)],nextCursor:'next'}):null});
  assert.equal((await provider(server).lookup({name})).state,'ready');assert.equal(server.requests.filter(r=>r.message.method==='tools/list').length,2);
});

test('循环游标、分页上限和重复工具均拒绝且没有tools/call',async()=>{
  for(const mode of ['cycle','limit','duplicate']){
    let page=0;const server=fakeServer({hook:m=>m.method==='tools/list'?json(m.id,{tools:[tool(mode==='duplicate'?'same':'page'+(++page))],nextCursor:mode==='cycle'?'loop':'page'+page}):null});
    await assert.rejects(provider(server).lookup({name}),/游标|分页|重复/);assert.equal(calls(server).length,0);
  }
});

test('实时参数schema未识别/新增必填时在扣分前拒绝，不猜参数名',async()=>{
  const unknown=tool(profile);unknown.inputSchema.required.push('companyId');unknown.inputSchema.properties.companyId={type:'string'};
  const server=fakeServer({tools:[tool(registration),unknown]});await assert.rejects(provider(server).lookup({name}),/参数尚未核实/);assert.equal(calls(server).length,0);
  assert.throws(()=>qccCompanyArguments({inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}},{name}),/参数尚未核实/);
  assert.throws(()=>qccCompanyArguments({...tool(profile),inputSchema:{...tool(profile).inputSchema,oneOf:[]}},{name}),/暂不支持/);
});

test('MCP调用错误/JSON-RPC错误必须脱敏，不把失败文本当公司资料',async()=>{
  for(const error of ['tool','rpc','http']){
    const server=fakeServer({hook:m=>{
      if(m.method!=='tools/call')return;
      if(error==='http')return new Response('secret-from-provider',{status:401});
      if(error==='rpc')return new Response(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'secret-from-provider'}}),{headers:{'Content-Type':'application/json'}});
      return json(m.id,{isError:true,content:[{type:'text',text:'secret-from-provider'}],structuredContent:registered()});
    }});
    await assert.rejects(provider(server).lookup({name}),e=>{assert.doesNotMatch(e.message,/secret-from-provider|fake-qcc-key|Bearer/);return e.status===502;});assert.equal(calls(server).length,1);
  }
});

test('简介读取失败保留已核实工商检查点，明确partial且不假装完整或重试年报',async()=>{
  const server=fakeServer({hook:m=>m.method==='tools/call'&&m.params.name===profile?new Response(null,{status:429}):null});
  await assert.rejects(provider(server).lookup({name}),error=>{
    assert.equal(error.code,'QCC_RATE_LIMITED');const result=error.partialResult;assert.equal(result.state,'partial');assert.equal(result.complete,false);
    assert.equal(result.details.business_scope,registered()['经营范围']);assert.equal(result.details.company_description,null);assert.equal(result.details.main_products,null);
    assert.equal(error.checkpoint.registration.state,'ready');assert.equal(error.checkpoint.profile,undefined);return true;
  });assert.equal(calls(server).length,2);
});

test('JSON响应编号、协议版本、batch和错误内容类型不能被当成功',async()=>{
  for(const mode of ['id','version','batch','type']){
    const server=fakeServer({hook:m=>{
      if(m.method!=='initialize')return;
      const result={protocolVersion:mode==='version'?'unknown':QCC_MCP_VERSION,capabilities:{tools:{}}};
      if(mode==='id')return json('wrong-id',result);
      if(mode==='batch')return new Response(JSON.stringify([{jsonrpc:'2.0',id:m.id,result}]),{headers:{'Content-Type':'application/json'}});
      if(mode==='type')return new Response('secret',{headers:{'Content-Type':'text/html'}});
      return json(m.id,result);
    }});
    await assert.rejects(provider(server).lookup({name}),e=>e.status===502);assert.equal(server.requests.length,1);
  }
});

test('响应字节上限包含分块正文，不能靠缺失Content-Length绕过',async()=>{
  const server=fakeServer({hook:m=>m.method==='tools/list'?json(m.id,{tools:[],padding:'x'.repeat(2000)}):null});
  const client=createQccMcpClient({apiKey:key,fetcher:server.fetcher,maxBytes:1000});await assert.rejects(client.discover(),/响应过大/);
});

test('总请求时限覆盖不响应fetch并中止，不自动重试',async()=>{
  let count=0,signal;const client=createQccMcpClient({apiKey:key,timeoutMs:20,fetcher:async(_u,o)=>{count++;signal=o.signal;return await new Promise(()=>{});}});
  await assert.rejects(client.discover(),/超时/);assert.equal(count,1);assert.equal(signal.aborted,true);
});

test('伪造redirect返回和非白名单工具拒绝，不传密钥到其他地址',async()=>{
  const server=fakeServer({hook:m=>{if(m.method!=='initialize')return;const response=json(m.id,{});Object.defineProperty(response,'redirected',{value:true});return response;}});
  await assert.rejects(provider(server).lookup({name}),/重定向/);assert.equal(server.requests.length,1);
  const valid=fakeServer(),client=createQccMcpClient({apiKey:key,fetcher:valid.fetcher});await client.discover();
  await assert.rejects(client.call('get_annual_reports',{searchKey:name}),/授权范围/);assert.equal(calls(valid).length,0);
});

test('只有原始结构化字段可落档，不解析自然语言猜主营或员工总人数',async()=>{
  const server=fakeServer({rows:{[registration]:{'企业名称':name,'经营范围':'模型培训、软件咨询','主要人员':[{},{}]},[profile]:{'企业名称':name,'简介':'约有100人，主要卖软件'}}});
  const result=await provider(server).lookup({name});assert.equal(result.state,'ready');assert.equal(result.details.main_business,null);assert.equal(result.details.main_products,null);assert.equal(result.details.employee_scale,null);assert.equal(result.details.annual_employees,null);
  const prose=fakeServer({hook:m=>m.method==='tools/call'?json(m.id,{content:[{type:'text',text:'该公司注册资本100万元，员工100人。'}]}):null});
  await assert.rejects(provider(prose).lookup({name}),/未猜测/);
});
