import {loadPersonalTokens,savePersonalTokens,refreshPersonalTokens,boundedText,personalResource} from './personal-oauth.mjs';
import {AppError} from './errors.mjs';

const fail=(code,message,status=502)=>new AppError(status,code,message);
const refreshing=new Map();
export function parseMcpResponse(text,id){
 let messages;
 try{
  if(text.trimStart().startsWith('{'))messages=[JSON.parse(text)];
  else messages=text.split(/\r?\n\r?\n/).flatMap(block=>{const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');return data?[JSON.parse(data)]:[];});
 }catch{throw fail('PERSONAL_MCP_FORMAT','个人听记接口响应格式无效');}
 const message=messages.find(message=>message.jsonrpc==='2.0'&&message.id===id);
 if(!message||message.error||!Object.hasOwn(message,'result'))throw fail('PERSONAL_MCP_ERROR','个人听记接口暂未完成读取，请稍后重试');
 return message.result;
}
export function createPersonalTransport({credentialDir,fetchImpl=fetch,load=loadPersonalTokens,save=savePersonalTokens,refresh=refreshPersonalTokens,allowedReadTools=[]}={}){
 let sequence=0,session='',protocol='2025-03-26',initializing=null,initialized=false;
 const allowed=new Set(allowedReadTools);
 async function tokens(force=false,oldAccessToken){
  let stored=await load(credentialDir);
  if(force&&oldAccessToken&&stored.accessToken!==oldAccessToken&&stored.expiresAt>Date.now()+60000)return stored;
  if(force||stored.expiresAt<Date.now()+60000){
   if(!refreshing.has(credentialDir)){const task=(async()=>{stored=await refresh(await load(credentialDir),{fetchImpl});await save(credentialDir,stored);return stored;})().finally(()=>refreshing.delete(credentialDir));refreshing.set(credentialDir,task);}
   stored=await refreshing.get(credentialDir);
  }
  return stored;
 }
 async function request(method,params,{notification=false,retry=true}={}){
  const stored=await tokens(),id=notification?undefined:++sequence;
  let response;
  try{response=await fetchImpl(personalResource,{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),headers:{authorization:'Bearer '+stored.accessToken,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':protocol,...(session?{'mcp-session-id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,...(params===undefined?{}:{params})})});}
  catch{throw fail('PERSONAL_MCP_NETWORK','个人听记服务连接失败或超时');}
  if(response.status===401&&retry){await response.body?.cancel();await tokens(true,stored.accessToken);return request(method,params,{notification,retry:false});}
  if(!response.ok){await response.body?.cancel();throw fail(response.status===401?'PERSONAL_REAUTHORIZE':'PERSONAL_MCP_HTTP',response.status===401?'个人听记授权已失效，请本人重新授权':`个人听记服务返回 HTTP ${response.status}`,response.status===401?401:502);}
  const nextSession=response.headers.get('mcp-session-id');if(nextSession){if(nextSession.length>512)throw fail('PERSONAL_MCP_SESSION','个人听记会话无效');session=nextSession;}
  if(notification){await response.body?.cancel();return;}
  return parseMcpResponse(await boundedText(response,8*1024*1024),id);
 }
 async function initialize(){
  if(initialized)return;
  if(!initializing)initializing=(async()=>{const result=await request('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'qianfan-crm-personal-minutes',version:'1.0'}});if(!['2024-11-05','2025-03-26','2025-06-18'].includes(result.protocolVersion))throw fail('PERSONAL_MCP_VERSION','个人听记接口版本尚未适配');protocol=result.protocolVersion;await request('notifications/initialized',undefined,{notification:true});initialized=true;})().finally(()=>initializing=null);
  return initializing;
 }
 return {
  async tools(){await initialize();const tools=[],seen=new Set();let cursor;
   for(let page=0;page<20;page++){const result=await request('tools/list',cursor?{cursor}:{});if(!Array.isArray(result.tools)||result.tools.length+tools.length>500)throw fail('PERSONAL_MCP_TOOLS','个人听记能力列表无效');tools.push(...result.tools);if(!result.nextCursor)return tools;if(typeof result.nextCursor!=='string'||seen.has(result.nextCursor))break;cursor=result.nextCursor;seen.add(cursor);}
   throw fail('PERSONAL_MCP_TOOLS','个人听记能力分页未完整返回');
  },
  async callReadTool(name,args={}){if(!allowed.has(name))throw fail('PERSONAL_TOOL_FORBIDDEN','此个人听记操作不在已核验的只读范围内',403);await initialize();const result=await request('tools/call',{name,arguments:args});if(result.isError)throw fail('PERSONAL_TOOL_FAILED','个人听记读取未完成，请核对授权和资料范围');return result;},
 };
}
