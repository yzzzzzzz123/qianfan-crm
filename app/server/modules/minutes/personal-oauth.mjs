import {randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {AppError} from './errors.mjs';

export const personalOrigin='https://minutes.qwennote.cn';
export const personalResource=personalOrigin+'/mcp';
export const personalScope='qwennote:read';
const failure=(code,message,status=502)=>new AppError(status,code,message);
export async function boundedText(response,max=1024*1024){
 if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw failure('PERSONAL_RESPONSE_LIMIT','个人听记响应超过安全限额');}
 if(!response.body)return '';
 const reader=response.body.getReader(),chunks=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();throw failure('PERSONAL_RESPONSE_LIMIT','个人听记响应超过安全限额');}chunks.push(value);}const bytes=Buffer.concat(chunks,total);return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
 finally{reader.releaseLock();}
}
async function jsonRequest(url,options={},fetchImpl=fetch){
 const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(20000),...options});
 if(!response.ok){await response.body?.cancel();throw failure('PERSONAL_OAUTH_HTTP',`个人听记授权服务返回 HTTP ${response.status}`);}
 try{return JSON.parse(await boundedText(response,65536));}catch(e){if(e instanceof AppError)throw e;throw failure('PERSONAL_OAUTH_FORMAT','个人听记授权服务返回格式无效');}
}
export async function registerPersonalClient(redirectUri,{fetchImpl=fetch}={}){
 const redirect=new URL(redirectUri);
 if(!((redirect.protocol==='http:'&&redirect.hostname==='127.0.0.1')||redirect.protocol==='https:')||redirect.username||redirect.password||redirect.hash)throw failure('PERSONAL_REDIRECT','个人听记授权回调地址无效');
 const result=await jsonRequest(personalOrigin+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'千帆 CRM · 个人听记',redirect_uris:[redirect.href],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:personalScope})},fetchImpl);
 if(typeof result.client_id!=='string'||!result.client_id||result.client_id.length>512)throw failure('PERSONAL_CLIENT','个人听记未返回有效的授权客户端');
 return {clientId:result.client_id,redirectUri:redirect.href};
}
export function personalAuthorization(client){
 const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url');
 const url=new URL(personalOrigin+'/authorize');
 for(const [key,value] of Object.entries({response_type:'code',client_id:client.clientId,redirect_uri:client.redirectUri,scope:personalScope,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:personalResource}))url.searchParams.set(key,value);
 return {url:url.href,state,verifier,createdAt:Date.now(),...client};
}
function checkedTokens(result,previous={}){
 if(typeof result.access_token!=='string'||!result.access_token||result.access_token.length>32768||result.token_type?.toLowerCase()!=='bearer')throw failure('PERSONAL_TOKEN','个人听记未返回有效授权');
 const scope=typeof result.scope==='string'?result.scope:personalScope;
 if(scope.split(/\s+/).some(s=>s!==personalScope))throw failure('PERSONAL_SCOPE','个人听记返回了本次未请求的权限范围');
 const expiresIn=Number(result.expires_in);
 if(!Number.isFinite(expiresIn)||expiresIn<=0||expiresIn>366*86400)throw failure('PERSONAL_TOKEN','个人听记授权期限无效');
 return {...previous,accessToken:result.access_token,refreshToken:typeof result.refresh_token==='string'?result.refresh_token:previous.refreshToken||'',expiresAt:Date.now()+expiresIn*1000,scope,tokenResponse:result};
}
export async function exchangePersonalCode(flow,code,{fetchImpl=fetch}={}){
 if(typeof code!=='string'||!code||code.length>4096)throw failure('PERSONAL_CODE','个人听记授权码无效',400);
 const body=new URLSearchParams({grant_type:'authorization_code',client_id:flow.clientId,redirect_uri:flow.redirectUri,code_verifier:flow.verifier,code,resource:personalResource});
 return checkedTokens(await jsonRequest(personalOrigin+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body},fetchImpl),{clientId:flow.clientId,redirectUri:flow.redirectUri});
}
export async function refreshPersonalTokens(stored,{fetchImpl=fetch}={}){
 if(!stored.refreshToken)throw failure('PERSONAL_REAUTHORIZE','个人听记授权已到期，请本人重新授权',401);
 const body=new URLSearchParams({grant_type:'refresh_token',client_id:stored.clientId,refresh_token:stored.refreshToken,scope:personalScope,resource:personalResource});
 return checkedTokens(await jsonRequest(personalOrigin+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body},fetchImpl),stored);
}
function dpapi(value,unprotect=false){
 const method=unprotect?'Unprotect':'Protect';
 const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$raw=[Convert]::FromBase64String([Console]::In.ReadToEnd());$result=[Security.Cryptography.ProtectedData]::${method}($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($result));`;
 return new Promise((resolve,reject)=>{
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{stdio:['pipe','pipe','ignore'],windowsHide:true});let output='',size=0,settled=false;
  const timer=setTimeout(()=>{child.kill();finish(failure('PERSONAL_STORAGE','个人听记凭据保护未完成',503));},10000);
  function finish(error,result){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);}
  child.on('error',()=>finish(failure('PERSONAL_STORAGE','个人听记凭据保护不可用',503)));
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>262144){child.kill();finish(failure('PERSONAL_STORAGE','个人听记凭据过大',503));}else output+=chunk.toString('ascii');});
  child.on('close',code=>{if(code!==0||!/^[a-zA-Z0-9+/]+=*$/.test(output))return finish(failure('PERSONAL_STORAGE','个人听记凭据无法由当前服务身份解密',503));finish(null,Buffer.from(output,'base64'));});
  child.stdin.on('error',()=>{});child.stdin.end(Buffer.from(value).toString('base64'));
 });
}
async function localKey(directory){
 const filename=join(directory,'.personal-oauth.key');
 try{const key=await readFile(filename);if(key.length!==32)throw new Error();return key;}
 catch(e){if(e.code!=='ENOENT')throw failure('PERSONAL_STORAGE','个人听记凭据密钥无效',503);const key=randomBytes(32);try{await writeFile(filename,key,{flag:'wx',mode:0o600});return key;}catch(e){if(e.code==='EEXIST')return localKey(directory);throw e;}}
}
export async function savePersonalTokens(directory,value){
 await mkdir(directory,{recursive:true,mode:0o700});const plain=Buffer.from(JSON.stringify(value));let envelope;
 try{if(process.platform==='win32')envelope={version:1,storage:'windows-dpapi',data:(await dpapi(plain)).toString('base64')};
 else{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await localKey(directory),iv);envelope={version:1,storage:'aes-256-gcm',iv:iv.toString('base64'),data:Buffer.concat([cipher.update(plain),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')};}}
 finally{plain.fill(0);}
 const temp=join(directory,`.personal-${randomBytes(8).toString('hex')}.tmp`),target=join(directory,'personal-oauth.json');
 try{await writeFile(temp,JSON.stringify(envelope),{mode:0o600,flag:'wx'});await rename(temp,target);}finally{await unlink(temp).catch(()=>{});}
}
export async function loadPersonalTokens(directory){
 try{const raw=await readFile(join(directory,'personal-oauth.json'),'utf8');if(raw.length>262144)throw new Error();const envelope=JSON.parse(raw);let plain;
  if(envelope.version!==1)throw new Error();
  if(envelope.storage==='windows-dpapi'&&process.platform==='win32')plain=await dpapi(Buffer.from(envelope.data,'base64'),true);
  else if(envelope.storage==='aes-256-gcm'&&process.platform!=='win32'){const decipher=createDecipheriv('aes-256-gcm',await localKey(directory),Buffer.from(envelope.iv,'base64'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));plain=Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]);}
  else throw new Error();
  try{return JSON.parse(plain.toString('utf8'));}finally{plain.fill(0);}
 }catch(e){if(e instanceof AppError)throw e;throw failure('PERSONAL_STORAGE','个人听记授权无法读取，请本人重新授权',503);}
}
