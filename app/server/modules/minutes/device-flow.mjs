import {spawn} from 'node:child_process';
import {mkdir,chmod,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {AppError} from './errors.mjs';
export const gatewayEnvironment=(dir,{proxyMode='inherit'}={})=>{const env={...process.env,DWS_CONFIG_DIR:dir,DWS_KEYCHAIN_DIR:join(dir,'keychain'),NO_COLOR:'1',LANG:'zh_CN.UTF-8'};for(const k of ['DWS_CLIENT_ID','DWS_CLIENT_SECRET','DWS_ACCESS_TOKEN','DWS_TOKEN','DWS_MCP_URL','DWS_PRE_URL','DWS_KEYCHAIN_TEST_NAMESPACE'])delete env[k];if(proxyMode==='direct')for(const k of Object.keys(env))if(/^(?:https?_proxy|all_proxy)$/i.test(k))delete env[k];return env;};
export async function initializeMinutesAuthorization(credentialDir){
 await mkdir(credentialDir,{recursive:true,mode:0o700});await chmod(credentialDir,0o700);
 // An absent/legacy registry makes DWS seed this directory from the OS's
 // previous global login. An explicit empty v2 registry disables that import.
 try{await writeFile(join(credentialDir,'profiles.json'),JSON.stringify({version:2,currentProfile:'',orgCurrentProfiles:{},profiles:[]}),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
}
export function safeAuthorizationUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='login.dingtalk.com'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&u.pathname.startsWith('/oauth2/')?u.href:null;}catch{return null;}}
export function parseDevicePrompt(raw){
 let plain=raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'');const begin=plain.lastIndexOf('请在浏览器中打开以下链接');if(begin>=0)plain=plain.slice(begin);
 const code=plain.match(/(?:授权码|User code|Code)\s*[:：]\s*([A-Z0-9-]{4,32})/i)?.[1];
 const expiry=plain.match(/授权码将在\s*(\d+)\s*秒后过期/)?.[1]||plain.match(/expires?\s+in\s+(\d+)\s+seconds/i)?.[1];
 const urls=(plain.match(/https:\/\/[^\s│┃┌┐└┘]+/g)||[]).map(safeAuthorizationUrl).filter(Boolean);
 if(!code||!urls.length||!expiry)return null;
 const expires=Number(expiry);if(!Number.isInteger(expires)||expires<1||expires>3600)return null;
 return {url:urls.find(x=>new URL(x).searchParams.has('user_code'))||urls.at(-1),code,expiresIn:Math.min(expires,600)};
}
export function parseLoginIdentity(raw){
 let x;try{x=JSON.parse(raw);}catch{throw new AppError(502,'AUTH_RESULT','授权返回不完整，请重新授权');}
 if(x.success!==true||x.token_valid!==true||!/^ding[a-zA-Z0-9]+$/.test(x.corp_id)||typeof x.user_id!=='string'||!/^[-a-zA-Z0-9_]{1,160}$/.test(x.user_id))throw new AppError(502,'AUTH_IDENTITY','授权未返回可核验的组织与用户身份');
 return {corpId:x.corp_id,userId:x.user_id,accountName:typeof x.user_name==='string'?x.user_name.slice(0,120):'已授权账号',corpName:typeof x.corp_name==='string'?x.corp_name.slice(0,200):'已授权组织',profile:`${x.corp_id}:${x.user_id}`};
}
// Match known failure classes, then return fixed text. CLI output may contain
// tokens, device codes and other accounts' names, so never forward raw output.
const cliAccessDenied='钉钉未允许本次所选账号和组织使用 CLI 访问数据。请在授权页核对实际听记账号及其所属组织，再由该组织管理员核对访问权限';
export function publicAuthorizationError(message){
 if(message==='钉钉授权未完成，可能被取消、过期或组织尚未开通访问权限，请重新授权或核对组织权限')return '本次授权未完成，旧版本未保留具体错误原因，请重新发起授权（DEVICE_AUTH_FAILED）';
 if(message==='所选钉钉组织尚未给当前成员开通 CLI 数据访问权限，请该组织管理员授权后重试（MINUTES_MEMBER_NOT_AUTHORIZED）')return `${cliAccessDenied}（MINUTES_CLI_ACCESS_DENIED）`;
 return message;
}
export function minutesConnectorError(output,{authorization=false}={}){
 const raw=String(output||'').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'');
 const failures=[
  [/CLI_ORG_NOT_AUTHORIZED|该组织尚未开启\s*CLI\s*数据访问权限|organization has not enabled CLI/i,'MINUTES_ORG_NOT_AUTHORIZED','所选钉钉组织尚未开通听记接口所需的 CLI 数据访问权限，请该组织主管理员开通后重新授权'],
  [/当前渠道[^\n]*未获得该组织授权|CLI_CHANNEL_NOT_AUTHORIZED|当前组织已开启渠道管控/i,'MINUTES_CHANNEL_NOT_AUTHORIZED','所选钉钉组织限制了当前连接渠道，请该组织管理员核对 CLI 渠道授权'],
  [/CLI_USER_NOT_AUTHORIZED/i,'MINUTES_MEMBER_NOT_AUTHORIZED','钉钉未给本次实际授权账号开通所选组织的 CLI 数据访问权限，请核对账号和组织后由该组织管理员授权'],
  [/您暂无\s*CLI\s*数据访问权限|未授权您通过\s*CLI/i,'MINUTES_CLI_ACCESS_DENIED',cliAccessDenied],
  [/expired_token|DEVICE_CODE_EXPIRED|授权码已过期|设备授权已过期|授权已超时/i,'MINUTES_AUTH_EXPIRED','本次钉钉授权码已过期，请重新打开授权页并使用新授权码'],
  [/access_denied|authorization_declined|用户拒绝|已拒绝授权|授权被拒绝/i,'MINUTES_AUTH_DENIED','本次钉钉授权被拒绝，请由当前成员重新授权'],
  [/用户取消|授权已取消|authorization.{0,20}cancelled/i,'MINUTES_AUTH_CANCELLED','本次钉钉授权已取消，可重新发起'],
  [/保存\s*token\s*失败|本地登录态无法安全更新|failed to save token/i,'MINUTES_CREDENTIAL_SAVE','钉钉已返回授权，但连接工具未能保存登录状态，请联系项目负责人检查凭据存储'],
  [/无法检查\s*CLI\s*数据访问权限状态|检查\s*CLI\s*授权状态失败|timeout|timed out|deadline exceeded|PROTOCOL_ERROR|ECONN|ENOTFOUND|TLS handshake|network is unreachable|connection (?:refused|reset)/i,'MINUTES_AUTH_NETWORK','钉钉授权服务连接未完成，请稍后重新核验已有授权；不能据此判断组织未开通权限'],
 ];
 const found=failures.find(([pattern])=>pattern.test(raw));
 if(found)return new AppError(502,found[1],`${found[2]}（${found[1]}）`);
 return authorization?new AppError(502,'DEVICE_AUTH_FAILED','钉钉授权流程未完成，请重新打开授权页（DEVICE_AUTH_FAILED）'):new AppError(502,'MINUTES_UPSTREAM','闪记接口读取失败，请检查当前账号授权后重试（MINUTES_UPSTREAM）');
}
export function createDeviceFlow({spawnImpl=spawn,binary=join(homedir(),'.local/bin',process.platform==='win32'?'dws.exe':'dws'),proxyMode='inherit'}={}){
 return async function begin({credentialDir,onPrompt,onVerifying}){
  await initializeMinutesAuthorization(credentialDir);
  const child=spawnImpl(binary,['auth','login','--device','--no-browser','--format','json'],{env:gatewayEnvironment(credentialDir,{proxyMode}),stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  let out='',err='',stopped=false,announced='',total=0;
  const completion=new Promise((resolve,reject)=>{
   const fail=error=>reject(error?.code==='ENOENT'?new AppError(503,'MINUTES_CONNECTOR_MISSING','服务尚未安装闪记连接工具，请联系项目负责人完成配置'):minutesConnectorError(out+'\n'+err,{authorization:true}));
   child.on('error',fail);
   child.stdout.on('data',chunk=>{total+=chunk.length;if(total>1024*1024){child.kill('SIGTERM');return;}out+=chunk.toString('utf8');});
   child.stderr.on('data',chunk=>{total+=chunk.length;if(total>1024*1024){child.kill('SIGTERM');return;}err=(err+chunk.toString('utf8')).slice(-65536);const prompt=parseDevicePrompt(err);if(prompt&&announced!==prompt.code){announced=prompt.code;onPrompt(prompt);}if(announced&&/(使用授权码换取|exchanging.*token)/i.test(err))onVerifying();});
   child.on('close',code=>{try{if(stopped)return reject(new AppError(409,'AUTH_CANCELLED','授权已取消'));if(code!==0)return fail();resolve(parseLoginIdentity(out));}catch(e){reject(e);}finally{out='';err='';}});
  });
  return {completion,cancel(){stopped=true;child.kill('SIGTERM');}};
 };
}
