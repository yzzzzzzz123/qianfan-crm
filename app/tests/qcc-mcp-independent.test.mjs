import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanyProfileProvider} from '../server/company-profile.mjs';
import {QCC_MCP_VERSION} from '../server/qcc-mcp-transport.mjs';

// Independent, synthetic responses only. No network, credentials or database.
const name='独立隔离核验科技有限公司',credit='91310000MA1K00000X';
const registration='get_company_registration_info',profile='get_company_profile';
const row=()=>({'企业名称':name,'统一社会信用代码':credit,'人员规模':'400-499人'});
const tool=name=>({name,inputSchema:{type:'object',properties:{searchKey:{type:'string',description:'企业名称或统一社会信用代码'}},required:['searchKey']}});
function server({registrationResult={structuredContent:row()},sseCR=false,splitCRLF=false}={}){
  const calls=[];
  const fetcher=async(_url,options)=>{
    const message=JSON.parse(options.body);calls.push(message);
    if(message.method==='notifications/initialized')return new Response(null,{status:202});
    const result=message.method==='initialize'?{protocolVersion:QCC_MCP_VERSION,capabilities:{tools:{}}}:
      message.method==='tools/list'?{tools:[tool(registration),tool(profile)]}:
      message.params.name===registration?registrationResult:{structuredContent:{'企业名称':name,'企业规模':'大型'}};
    const body=JSON.stringify({jsonrpc:'2.0',id:message.id,result});
    if(splitCRLF){
      // Deliberately separate every CR from its LF, and every multibyte Chinese
      // character. Multiple data lines make a falsely dispatched blank visible.
      const event=': keepalive\r\nevent: message\r\ndata: {\r\ndata: "jsonrpc":"2.0",\r\ndata: "id":'+message.id+',\r\ndata: "result":'+JSON.stringify(result)+'}\r\n\r\n';
      const bytes=new TextEncoder().encode(event);let offset=0;
      return new Response(new ReadableStream({pull(controller){if(offset<bytes.length)controller.enqueue(bytes.slice(offset,++offset));else controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
    }
    return new Response(sseCR?'event: message\rdata: '+body+'\r\r':body,{headers:{'Content-Type':sseCR?'text/event-stream':'application/json'}});
  };
  return {calls,provider:createCompanyProfileProvider({env:{CRM_COMPANY_PROFILE_PROVIDER:'qcc-mcp',QCC_MCP_API_KEY:'synthetic-key-not-real'},fetcher})};
}

test('独立审计：已知积分错误包装即使夹带企业数据也不能标已核验',async()=>{
  const s=server({registrationResult:{structuredContent:{code:300008,message:'synthetic-sensitive-detail',data:row()}}});
  await assert.rejects(s.provider.lookup({name,credit_code:credit}),error=>{
    assert.doesNotMatch(error.message,/synthetic-sensitive-detail|synthetic-key/);return error.status===502;
  });
  assert.equal(s.calls.filter(m=>m.method==='tools/call').length,1);
});

test('独立审计：明确失败标志不能因data带企业名称而被当成功',async()=>{
  for(const envelope of [{success:false,data:row()},{error:{code:200001,message:'synthetic-auth-failure'},data:row()}]){
    const s=server({registrationResult:{content:[{type:'text',text:JSON.stringify(envelope)}]}});
    await assert.rejects(s.provider.lookup({name,credit_code:credit}),error=>error.status===502);
    assert.equal(s.calls.filter(m=>m.method==='tools/call').length,1);
  }
});

test('独立审计：同份结果中相互冲突的主体别名不可只取第一个',async()=>{
  for(const conflict of [{CompanyName:'另一隔离主体有限公司'},{CreditCode:'91310000MA1K00001X'}]){
    const s=server({registrationResult:{structuredContent:{...row(),...conflict}}});
    let result;
    try{result=await s.provider.lookup({name,credit_code:credit});}
    catch(error){assert.equal(error.status,502);}
    if(result)assert.equal(result.state,'mismatch');
    assert.equal(s.calls.filter(m=>m.method==='tools/call').length,1);
  }
});

test('独立审计：官方CLI已支持的CR单字符SSE行结束符可被解析',async()=>{
  const s=server({sseCR:true});
  assert.equal((await s.provider.lookup({name,credit_code:credit})).state,'ready');
});

test('独立审计：CRLF在每个字节处分块且多行data仍组成唯一响应',async()=>{
  const s=server({splitCRLF:true});
  const result=await s.provider.lookup({name,credit_code:credit});
  assert.equal(result.state,'ready');assert.equal(result.details.company_name,name);
  assert.equal(result.details.employee_scale,'400-499人');assert.equal(result.details.company_scale,'大型');
});
