import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gatewayEnvironment, minutesConnectorError } from './device-flow.mjs';
import { AppError } from './errors.mjs';
import { corporateMobile } from './corporate-mobile.mjs';
import {missingArtifact,parseMinutesSummary,parseTranscriptionPage} from './content.mjs';
import {parseSpeakerSummary,isEmptySpeakerQuery,qualityUnavailable,speakerPending,speakerFailed} from './speaker.mjs';
import {createTranscriptReader} from './transcript.mjs';
const execute=promisify(execFile);
export const defaultMinutesBinary=()=>join(homedir(),'.local/bin',process.platform==='win32'?'dws.exe':'dws');
export function readSavedMinutesProfiles(credentialDir){
 try{const saved=JSON.parse(readFileSync(join(credentialDir,'profiles.json'),'utf8'));return Array.isArray(saved.profiles)?saved.profiles.filter(p=>p.status==='active'&&/^ding[a-zA-Z0-9]+$/.test(p.corpId)&&typeof p.userId==='string'&&/^[-a-zA-Z0-9_]{1,160}$/.test(p.userId)).map(p=>({corpId:p.corpId,userId:p.userId,profile:`${p.corpId}:${p.userId}`,accountName:String(p.userName||'已授权账号').slice(0,120),corpName:String(p.corpName||'已授权组织').slice(0,200),current:`${p.corpId}:${p.userId}`===saved.currentProfile})):[];}catch{return [];}
}
export async function readSavedMinutesIdentity(credentialDir,profile){
 try{
  const saved=JSON.parse(await readFile(join(credentialDir,'profiles.json'),'utf8'));
  if(!Array.isArray(saved.profiles)||!saved.profiles.length)throw new Error();
  const matches=saved.profiles.filter(p=>`${p.corpId}:${p.userId}`===(profile||saved.currentProfile));
  const p=matches.length===1?matches[0]:!profile&&saved.profiles.length===1?saved.profiles[0]:null;
  if(!p)throw new Error();
  if(p.status!=='active'||!/^ding[a-zA-Z0-9]+$/.test(p.corpId)||typeof p.userId!=='string'||!/^[-a-zA-Z0-9_]{1,160}$/.test(p.userId))throw new Error();
  return {corpId:p.corpId,userId:p.userId,profile:`${p.corpId}:${p.userId}`,accountName:typeof p.userName==='string'?p.userName.slice(0,120):'已授权账号',corpName:typeof p.corpName==='string'?p.corpName.slice(0,200):'已授权组织'};
 }catch{throw new AppError(409,'AUTH_REAUTHORIZE','未找到完整的本人授权，请重新发起钉钉授权');}
}
// DWS profile userId and the enterprise directory's orgUserId are different
// identifiers. Only the online current-user result can establish their link.
function minutesAccountModel(payload,source){
 const rows=payload?.result;
 if(!Array.isArray(rows))throw new AppError(502,'MINUTES_MEMBER_IDENTITY','无法核验闪记账号的企业成员身份');
 const matches=rows.map(x=>x?.orgEmployeeModel).filter(x=>x?.corpId===source.corpId);
 if(matches.length!==1)throw new AppError(502,'MINUTES_MEMBER_IDENTITY','闪记账号的企业成员身份缺失或不唯一');
 const row=matches[0],ids=[row.userId,row.userid].filter(x=>x!==undefined);
 if(!ids.length||ids.some(x=>String(x)!==source.userId))throw new AppError(502,'MINUTES_MEMBER_IDENTITY','闪记返回的成员身份与实际授权账号不一致');
 return row;
}
export function parseMinutesEmployeeIdentity(payload,source){
 const row=minutesAccountModel(payload,source);
 if(row.orgUserId!==undefined&&row.orgUserId!==null){
  if(typeof row.orgUserId!=='string'||!row.orgUserId.trim())throw new AppError(502,'MINUTES_MEMBER_IDENTITY','闪记返回的企业成员编号无效');
  return {corpId:row.corpId,userId:row.orgUserId,dwsUserId:source.userId,...(corporateMobile(row.orgUserMobile,row.stateCode)?{mobile:row.orgUserMobile,countryCode:row.stateCode}:{})};
 }
 if(!corporateMobile(row.orgUserMobile,row.stateCode))throw new AppError(502,'MINUTES_MEMBER_IDENTITY','闪记未提供完整的企业成员编号或手机号，无法核验本人身份，请联系项目负责人');
 // Transient evidence only: caller must resolve this against the trusted
 // enterprise directory. It must never be returned to the UI or persisted.
 return {corpId:row.corpId,dwsUserId:source.userId,mobile:row.orgUserMobile,countryCode:row.stateCode};
}
export function createMinutesClient(source,{run=execute,binary=defaultMinutesBinary(),proxyMode='inherit',resolveEmployeeIdentity}={}){
 async function call(args){
  let output='';try{const {stdout}=await run(binary,[...args,'--profile',source.profile,'--format','json'],{timeout:45000,maxBuffer:8*1024*1024,encoding:'utf8',windowsHide:true,...(source.credentialDir?{env:gatewayEnvironment(source.credentialDir,{proxyMode})}:{})});output=stdout;const x=JSON.parse(stdout);const shortcut=args[1]?.startsWith('+');if(args[0]!=='auth'&&(shortcut?x.ok!==true||x.outcome!=='success':x.success!==true&&x.success!=='true'))throw new Error();return x;}catch(e){if(isEmptySpeakerQuery(args,output,e.stdout,e.stderr))return {success:true,result:null};throw minutesConnectorError(output+'\n'+(e.stdout||'')+'\n'+(e.stderr||''));}
 }
 const transcript=createTranscriptReader(call);
 async function speakerInsights(id,{generate=false}={}) {
  if(generate){await call(['minutes','speaker','summary','create','--ids',id,'--yes']);return speakerPending();}
  try{return parseSpeakerSummary((await call(['minutes','speaker','summary','get','--ids',id])).result);}catch{return speakerFailed();}
 }
 return {
  speakerInsights,transcript,
  async accountIdentity(){minutesAccountModel(await call(['contact','user','get-self']),source);return {corpId:source.corpId,userId:source.userId};},
  async employeeIdentity(expected){
   const evidence=parseMinutesEmployeeIdentity(await call(['contact','user','get-self']),source);
   if(evidence.userId&&evidence.corpId===expected.corpId){if(evidence.userId!==expected.userId)throw new AppError(403,'MINUTES_ACCOUNT_MISMATCH','实际授权账号与当前成员不一致');return {corpId:expected.corpId,userId:expected.userId};}
   if(evidence.corpId===expected.corpId&&evidence.dwsUserId===expected.userId){
    // Equal identifier text alone is not identity proof: DWS and enterprise
    // IDs can use different namespaces. Resolve the online self ID through
    // the selected profile's directory before accepting its explicit orgUserId.
    const payload=await call(['contact','user','get','--ids',source.userId]),rows=payload.result;
    if(!Array.isArray(rows)||rows.length!==1)throw new AppError(502,'MINUTES_MEMBER_IDENTITY','当前听记账号的企业成员详情缺失或不唯一');
    const row=rows[0]?.orgEmployeeModel;
    // The detail endpoint can omit orgId; its tenant is the fixed profile
    // already checked against get-self.corpId, not a name from the response.
    if(!row||typeof row.orgUserId!=='string'||!row.orgUserId)throw new AppError(502,'MINUTES_MEMBER_IDENTITY','当前听记账号未返回完整的企业成员详情');
    if(row.orgUserId!==expected.userId||row.corpId!==undefined&&row.corpId!==source.corpId||row.userId!==undefined&&String(row.userId)!==source.userId)throw new AppError(403,'MINUTES_ACCOUNT_MISMATCH','当前听记账号的企业成员编号与当前成员不一致');
    return {corpId:expected.corpId,userId:expected.userId};
   }
   if(typeof resolveEmployeeIdentity!=='function')throw new AppError(503,'MINUTES_IDENTITY_UNAVAILABLE','企业身份核验服务尚未配置');const actual=await resolveEmployeeIdentity(expected,evidence);if(actual?.corpId!==expected.corpId||actual.userId!==expected.userId||actual.unionId!==expected.unionId)throw new AppError(403,'MINUTES_ACCOUNT_MISMATCH','实际授权账号与当前成员的钉钉身份不一致，未建立绑定');return {corpId:actual.corpId,userId:actual.userId};
  },
  async verify(){const x=await call(['auth','status']);if(x.authenticated!==true||x.token_valid!==true||x.corp_id!==source.corpId||String(x.user_id)!==source.userId)throw new AppError(503,'MINUTES_IDENTITY','闪记授权身份与固定连接账号不一致，请重新授权对应账号');},
  async tags(){const x=await call(['minutes','tag','list']);if(!Array.isArray(x.result?.tagList))throw new AppError(502,'MINUTES_TAGS','闪记标签返回不完整');return x.result.tagList.length?'unverified':'empty';},
  async tagEvidence(ids){
   const x=await call(['minutes','tag','list']),tags=x.result?.tagList;
   if(!Array.isArray(tags)||tags.length>100||tags.some(t=>typeof t.tagId!=='string'||!t.tagId||t.tagId.length>160))throw new AppError(502,'MINUTES_TAGS','闪记标签返回不完整');
   const mapped=new Map(ids.map(id=>[id,[]]));
   for(const tag of tags){let cursor=null;const seen=new Set();for(let page=0;;page++){
    if(page>=100||seen.has(cursor))throw new AppError(502,'MINUTES_TAGS','源标签分页未完成');seen.add(cursor);
    const r=(await call(['minutes','tag','query','--tag-id',tag.tagId,'--limit','20',...(cursor?['--cursor',cursor]:[])])).result;
    if(!r||!Array.isArray(r.itemList)||typeof r.hasMore!=='boolean'||r.itemList.some(t=>typeof t.uuid!=='string')||r.hasMore&&(typeof r.nextToken!=='string'||!r.nextToken))throw new AppError(502,'MINUTES_TAGS','源标签记录返回不完整');
    for(const item of r.itemList)if(mapped.has(item.uuid))mapped.get(item.uuid).push(tag.tagId);
    if(!r.hasMore)break;cursor=r.nextToken;
   }}
   return Object.fromEntries(mapped);
  },
  async artifacts(id){
   const artifacts={quality:qualityUnavailable()};
   artifacts.speaker_insights=await speakerInsights(id);
   try{artifacts.summary=parseMinutesSummary((await call(['minutes','get','summary','--id',id])).result);}catch{artifacts.summary={state:'failed',content:'',reason:'源摘要读取未完成，请核对授权或稍后重试'};}
   artifacts.transcript=await transcript(id);
   return artifacts;
  },
  // The selected profile is fixed to the verified CRM member. "all" includes
  // meetings explicitly shared with that account, not another member's login.
  // Omitting --start is necessary to retrieve older meetings via the API.
  async list({from,to,cursor}){const x=await call(['minutes','list','all','--limit','20',...(from?['--start',from]:[]),...(to?['--end',to]:[]),...(cursor?['--cursor',cursor]:[])]);const r=x.result;if(!r||!Array.isArray(r.itemList)||typeof r.hasMore!=='boolean'||r.hasMore&&(typeof r.nextToken!=='string'||!r.nextToken))throw new AppError(502,'MINUTES_PAGE','闪记分页返回不完整，本页未提交');return {items:r.itemList,next:r.hasMore?r.nextToken:null};},
  async audio(id){const x=await call(['minutes','get','audio','--id',id]);const r=x.result;if(!r||typeof r.filtered!=='boolean')throw new AppError(502,'MINUTES_AUDIO','闪记录音接口返回不完整');if(r.filtered)return {state:'unsupported',reason:r.filterReason==='VOIP_NOT_SUPPORTED'?'语音通话类闪记暂不支持录音读取':'该录音受源接口限制'};if(typeof r.audioUrl!=='string'||!r.audioUrl)return {state:'unavailable',reason:'源接口未提供可播放录音'};return {state:'available',reason:'',url:r.audioUrl};},
 };
}
