import {randomUUID} from 'node:crypto';
import {AppError} from './errors.mjs';


export const artifactKinds=['summary','transcript','speaker_insights','quality'];
const states=['ready','empty','pending','unavailable','unsupported_shape','failed'];
const maxContent=500000;
export const missingArtifact=(reason='源接口尚未返回此项内容')=>({state:'unavailable',content:'',reason});

// These result fields were checked against the official DWS 1.0.66 CLI and
// the authorized account's real response. Unknown responses stay unknown.
export function parseMinutesSummary(result){
 if(!result||typeof result.fullSummary!=='string')return {state:'unsupported_shape',content:'',reason:'摘要返回格式尚未核验'};
 if(result.generatingStatus!=='COMPLETED'||result.textGenerationInfo?.state!=='COMPLETED')return {state:'pending',content:'',reason:'源平台尚未确认摘要生成完成'};
 const content=result.fullSummary.trim();
 return content?{state:'ready',content,reason:''}:{state:'empty',content:'',reason:'源平台返回空摘要'};
}
export function parseTranscriptionPage(result){
 if(!result||!Array.isArray(result.paragraphList)||typeof result.hasNext!=='boolean'||(result.hasNext&&(typeof result.nextToken!=='string'||!result.nextToken)))throw new AppError(502,'MINUTES_TRANSCRIPT_SHAPE','逐字稿返回格式尚未核验');
 const paragraphs=result.paragraphList.map(p=>{
  if(!p||typeof p.paragraph!=='string'||!Number.isSafeInteger(p.paragraphId)||typeof p.nickName!=='string'||!Number.isFinite(p.startTime))throw new AppError(502,'MINUTES_TRANSCRIPT_SHAPE','逐字稿段落字段尚未核验');
  return {id:String(p.paragraphId),speaker:p.nickName,text:p.paragraph};
 });
 return {paragraphs,next:result.hasNext?result.nextToken:null};
}
export function normalizeArtifacts(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!artifactKinds.includes(k)))throw new AppError(400,'MINUTES_CONTENT','听记内容类型不正确');
 const result={};
 for(const [kind,v] of Object.entries(input)){
  if(!v||!states.includes(v.state)||typeof v.content!=='string'||v.content.length>maxContent||typeof (v.reason??'')!=='string'||(v.reason||'').length>500||(v.state==='ready'&&!v.content.trim())||(v.state!=='ready'&&v.content))throw new AppError(400,'MINUTES_CONTENT','听记正文、状态或长度不正确');
  result[kind]={state:v.state,content:v.content.trim(),reason:v.reason||''};
 }
 return result;
}
