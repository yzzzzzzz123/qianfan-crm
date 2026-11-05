import {AppError,assert as domainAssert} from './domain.mjs';

// Official public endpoint: https://agent.qcc.com/guide . No configurable URL,
// redirect, retry, remote resources, sampling or server-provided instructions.
export const QCC_MCP_ENDPOINT='https://agent.qcc.com/mcp/company/stream';
export const QCC_MCP_VERSION='2025-06-18';
const versions=new Set([QCC_MCP_VERSION,'2025-03-26']);
const allowedTools=new Set(['get_company_registration_info','get_company_profile']);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const errorMessages={
  QCC_QUOTA_EXHAUSTED:'企查查积分不足，查询已暂停，保留已完成部分，等待额度恢复后继续',
  QCC_AUTH_INVALID:'企查查授权无效或无访问权限，请检查接入配置后继续',
  QCC_RATE_LIMITED:'企查查调用频率受限，保留进度，稍后继续',
  QCC_TRANSIENT:'企查查连接超时或暂时未完成，保留进度，稍后继续',
  QCC_IDENTITY_REQUIRED:'源企业主体不唯一或缺少可靠名称，请人工核对后继续',
  QCC_RESPONSE_INVALID:'企查查返回格式或工具定义无法核验，保留进度，请检查接口兼容性',
};
export class QccMcpError extends AppError {
  constructor(code,{retryAfterMs}={}){
    super(errorMessages[code]||errorMessages.QCC_RESPONSE_INVALID,502);
    this.code=Object.hasOwn(errorMessages,code)?code:'QCC_RESPONSE_INVALID';
    this.retryable=['QCC_RATE_LIMITED','QCC_TRANSIENT'].includes(this.code);
    if(Number.isFinite(retryAfterMs)&&retryAfterMs>=0)this.retryAfterMs=Math.min(retryAfterMs,86400000);
  }
}
export function qccFailure(value,fallback='QCC_RESPONSE_INVALID',options={}){
  // Inspect explicit protocol positions only, never free text or arbitrary
  // nested company fields. Upstream messages/URLs/credentials are not exposed.
  const code=object(value)?value.error?.code??value.code:undefined;
  return new QccMcpError(String(code)==='300008'?'QCC_QUOTA_EXHAUSTED':String(code)==='200001'?'QCC_AUTH_INVALID':fallback,options);
}
const failure=()=>new QccMcpError('QCC_RESPONSE_INVALID');
const assert=(ok,message,status=400)=>{
  if(!ok&&status===502){const error=failure();error.message=message;throw error;}
  domainAssert(ok,message,status);
};
const safeHttpError=(status,value,headers)=>{
  const raw=headers?.get('retry-after'),seconds=raw&&/^\d+$/.test(raw)?Number(raw)*1000:raw?Date.parse(raw)-Date.now():undefined;
  return qccFailure(value,status===401||status===403?'QCC_AUTH_INVALID':status===429?'QCC_RATE_LIMITED':status>=500?'QCC_TRANSIENT':'QCC_RESPONSE_INVALID',{retryAfterMs:seconds});
};

async function errorEnvelope(response){
  if(!(response.headers.get('content-type')||'').includes('application/json')||!response.body?.getReader)return null;
  const reader=response.body.getReader();let bytes=0,text='';const decoder=new TextDecoder();
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>65536)return null;text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
  catch{return null;}
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}

function rpcResult(message,id) {
  assert(object(message)&&message.jsonrpc==='2.0','企查查 MCP 协议返回无效',502);
  if(Object.hasOwn(message,'method')){
    // No server-initiated requests are needed or advertised by this client.
    assert(!Object.hasOwn(message,'id'),'企查查 MCP 返回了不支持的请求',502);
    return {notification:true};
  }
  assert(message.id===id,'企查查 MCP 响应编号不匹配',502);
  assert(Object.hasOwn(message,'result')!==Object.hasOwn(message,'error'),'企查查 MCP 协议返回无效',502);
  if(Object.hasOwn(message,'error'))throw qccFailure(message);
  return {result:message.result};
}

async function readResult(response,id,maxBytes) {
  const contentType=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  assert(['application/json','text/event-stream'].includes(contentType),'企查查 MCP 响应类型无效',502);
  const size=Number(response.headers.get('content-length'));
  assert(!Number.isFinite(size)||size<=maxBytes,'企查查 MCP 响应过大',502);
  assert(response.body?.getReader,'企查查 MCP 响应内容无效',502);
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  let bytes=0,buffer='',events=0,eventData=[];
  try {
    while(true){
      const {done,value}=await reader.read();
      if(value){bytes+=value.byteLength;assert(bytes<=maxBytes,'企查查 MCP 响应过大',502);}
      buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
      if(contentType==='text/event-stream'){
        let ending;
        while((ending=/[\r\n]/.exec(buffer))){
          // Retain a trailing CR until the next chunk: CRLF is one delimiter,
          // including when its two bytes arrive in different chunks.
          if(buffer[ending.index]==='\r'&&ending.index===buffer.length-1&&!done)break;
          const line=buffer.slice(0,ending.index),width=buffer[ending.index]==='\r'&&buffer[ending.index+1]==='\n'?2:1;
          buffer=buffer.slice(ending.index+width);
          if(line===''){
            if(!eventData.length)continue;
            assert(++events<=100,'企查查 MCP 事件数量过多',502);
            const parsed=rpcResult(JSON.parse(eventData.join('\n')),id);eventData=[];
            if(!parsed.notification)return parsed.result;
          }else if(line==='data')eventData.push('');
          else if(line.startsWith('data:'))eventData.push(line.slice(5).replace(/^ /,''));
        }
      }
      if(done)break;
    }
    if(contentType==='application/json'){
      const parsed=rpcResult(JSON.parse(buffer),id);assert(!parsed.notification,'企查查 MCP 缺少请求结果',502);return parsed.result;
    }
    throw failure();
  }finally{
    // A server may keep an SSE connection open after returning the result.
    // Cancel this response stream without waiting for its eventual close.
    void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

export function createQccMcpClient({apiKey,fetcher=fetch,timeoutMs=25000,maxBytes=2*1024*1024,maxPages=5}={}) {
  assert(typeof apiKey==='string'&&/^[\x21-\x7e]{1,4096}$/.test(apiKey),'企查查 MCP 密钥未配置或格式无效',503);
  assert(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000,'企查查 MCP 超时设置无效',500);
  assert(Number.isInteger(maxBytes)&&maxBytes>0&&maxBytes<=2*1024*1024,'企查查 MCP 响应限制无效',500);
  assert(Number.isInteger(maxPages)&&maxPages>0&&maxPages<=5,'企查查 MCP 分页限制无效',500);
  let sequence=0,session='',version='',started=false;
  const deadline=Date.now()+timeoutMs;
  async function send(method,params,notification=false){
    const remaining=deadline-Date.now();if(remaining<=0)throw new QccMcpError('QCC_TRANSIENT');
    const controller=new AbortController(),id=++sequence;
    const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+apiKey};
    if(session)headers['Mcp-Session-Id']=session;
    if(version)headers['MCP-Protocol-Version']=version;
    const body={jsonrpc:'2.0',...(!notification?{id}:{}),method,...(params===undefined?{}:{params})};
    let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new QccMcpError('QCC_TRANSIENT'));},remaining);});
    try {
      return await Promise.race([timeout,(async()=>{
        let response;
        try{response=await fetcher(QCC_MCP_ENDPOINT,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:controller.signal});}
        catch{throw new QccMcpError('QCC_TRANSIENT');}
        if(!response.ok)throw safeHttpError(response.status,await errorEnvelope(response),response.headers);
        assert(!response.redirected,'企查查 MCP 不允许重定向',502);
        if(notification){assert(response.status===202||response.status===204,'企查查 MCP 初始化通知未被接受',502);void response.body?.cancel().catch(()=>{});return;}
        const result=await readResult(response,id,maxBytes);
        if(method==='initialize'){
          const received=response.headers.get('mcp-session-id');
          assert(!received||/^[\x21-\x7e]{1,1024}$/.test(received),'企查查 MCP 会话标识无效',502);
          session=received||'';
        }
        return result;
      })()]);
    }catch(error){controller.abort();if(error instanceof AppError)throw error;throw failure();}
    finally{clearTimeout(timer);}
  }
  async function discover(){
    assert(!started,'企查查 MCP 会话不能重复初始化',500);started=true;
    const init=await send('initialize',{protocolVersion:QCC_MCP_VERSION,capabilities:{},clientInfo:{name:'qianfan-crm-company-profile',version:'1.0.0'}});
    assert(object(init)&&versions.has(init.protocolVersion)&&object(init.capabilities?.tools),'企查查 MCP 版本或工具能力不兼容',502);
    version=init.protocolVersion;
    await send('notifications/initialized',undefined,true);
    const tools=new Map(),cursors=new Set();let cursor;
    for(let page=0;page<maxPages;page++){
      const result=await send('tools/list',cursor?{cursor}:{});
      assert(object(result)&&Array.isArray(result.tools)&&result.tools.length<=256,'企查查 MCP 工具清单无效',502);
      for(const tool of result.tools){
        assert(object(tool)&&typeof tool.name==='string'&&tool.name.length<=200&&!tools.has(tool.name),'企查查 MCP 工具清单重复或无效',502);
        tools.set(tool.name,tool);assert(tools.size<=256,'企查查 MCP 工具清单过大',502);
      }
      if(result.nextCursor===undefined||result.nextCursor===null||result.nextCursor==='')return tools;
      assert(typeof result.nextCursor==='string'&&result.nextCursor.length<=1024&&!cursors.has(result.nextCursor),'企查查 MCP 分页游标无效',502);
      cursor=result.nextCursor;cursors.add(cursor);
    }
    const error=failure();error.message='企查查 MCP 工具清单超过分页上限';throw error;
  }
  async function call(name,args){
    assert(version&&allowedTools.has(name),'企查查 MCP 工具不在企业详情授权范围',502);
    const result=await send('tools/call',{name,arguments:args});
    assert(object(result),'企查查 MCP 企业查询未成功，请核对授权或额度',502);
    if(result.isError===true){
      const candidates=[result,result.structuredContent];
      for(const item of Array.isArray(result.content)?result.content:[])if(item?.type==='text'&&typeof item.text==='string'){try{candidates.push(JSON.parse(item.text));}catch{}}
      for(const candidate of candidates){const error=qccFailure(candidate);if(error.code!=='QCC_RESPONSE_INVALID')throw error;}
      throw failure();
    }
    return result;
  }
  return {discover,call};
}
