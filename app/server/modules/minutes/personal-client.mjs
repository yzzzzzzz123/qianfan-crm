import {createPersonalTransport} from './personal-transport.mjs';
import {loadPersonalTokens,personalScope} from './personal-oauth.mjs';
import {AppError} from './errors.mjs';
import {missingArtifact} from './content.mjs';
import {qualityUnavailable} from './speaker.mjs';
import {safeMinutesAudio} from './recordings.mjs';

const readTools=['list_my_minutes','get_minutes_basic_info','get_minutes_ai_summary','get_minutes_transcription','get_minutes_media_url'];
const invalid=message=>new AppError(502,'PERSONAL_MINUTES_SHAPE',message);
export function unpackPersonalResult(result){
 if(result.structuredContent&&typeof result.structuredContent==='object')return result.structuredContent;
 try{const text=result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n');const value=JSON.parse(text);if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch{}
 throw invalid('个人听记返回格式尚未核验');
}
export function createPersonalMinutesClient(source,{transport,load=loadPersonalTokens}={}){
 transport??=createPersonalTransport({credentialDir:source.credentialDir,allowedReadTools:readTools});
 const call=async(name,args)=>unpackPersonalResult(await transport.callReadTool(name,args));
 const checkId=(result,id)=>{if(result?.taskUuid!==id)throw invalid('个人听记返回了其他记录，本次未保存');return result;};
 async function transcript(id){
  try{let cursor,total=null,content='';const seen=new Set();let count=0;
   for(let page=0;page<100;page++){
    const result=checkId(await call('get_minutes_transcription',{taskUuid:id,maxResults:200,direction:0,...(cursor?{nextToken:cursor}:{})}),id);
    if(result.filtered===true)return missingArtifact('个人听记接口限制了这条逐字稿的读取');
    if(result.filtered!==false||!Array.isArray(result.paragraphs)||!Number.isSafeInteger(result.total)||result.total<0||typeof result.hasMore!=='boolean'||total!==null&&total!==result.total)throw invalid('个人逐字稿分页数量不一致');
    total=result.total;
    for(const paragraph of result.paragraphs){if(typeof paragraph?.content!=='string'||paragraph.speakerName!==null&&typeof paragraph.speakerName!=='string'||!Number.isFinite(paragraph.startTime))throw invalid('个人逐字稿段落不完整');count++;if(paragraph.content.trim())content+=(content?'\n\n':'')+`${paragraph.speakerName||'未识别发言人'}：${paragraph.content.trim()}`;if(content.length>500000)throw invalid('个人逐字稿超过正文限额');}
    if(!result.hasMore){if(count!==total)throw invalid('个人逐字稿尚未完整读取');return content?{state:'ready',content,reason:''}:{state:'empty',content:'',reason:'个人听记本次未提供逐字稿正文'};}
    if(typeof result.nextToken!=='string'||!result.nextToken||seen.has(result.nextToken))throw invalid('个人逐字稿分页未完成');cursor=result.nextToken;seen.add(cursor);
   }
   throw invalid('个人逐字稿超过单轮分页预算');
  }catch{return {state:'failed',content:'',reason:'个人逐字稿暂未完整读取，已保留现有正文与摘要'};}
 }
 return {
  async verify(){const stored=await load(source.credentialDir);if(stored.provider!=='personal_mcp'||stored.memberId!==source.memberId||stored.authorizationKey!==source.authorizationKey||stored.scope!==personalScope)throw new AppError(403,'PERSONAL_GRANT_MISMATCH','个人听记授权与当前成员或固定来源不一致');await transport.tools();},
  async list({from,to,cursor}={}){
   const args={pageSize:20,...(from?{createdAfter:Date.parse(from)}:{}),...(to?{createdBefore:Date.parse(to)}:{}),...(cursor?{nextToken:cursor}:{})};
   const result=await call('list_my_minutes',args);
   if(!Array.isArray(result.items)||typeof result.hasMore!=='boolean'||result.hasMore&&(typeof result.nextToken!=='string'||!result.nextToken))throw invalid('个人听记分页返回不完整');
   return {items:result.items.map(item=>{if(typeof item.uuid!=='string'||!/^[-A-Za-z0-9_]{1,240}$/.test(item.uuid)||typeof item.title!=='string'||!Number.isSafeInteger(item.gmtCreate)||item.gmtCreate<=0||!Number.isSafeInteger(item.durationMillis)||item.durationMillis<0||item.durationMillis>Number.MAX_SAFE_INTEGER/1000)throw invalid('个人听记记录字段不完整');return {uuid:item.uuid,title:item.title,startTime:item.gmtCreate,durationMicros:item.durationMillis*1000};}),next:result.hasMore?result.nextToken:null};
  },
  transcript,
  async speakerInsights(){return missingArtifact('个人只读通道暂未提供发言人观点，未创建上游分析任务');},
  async artifacts(id){
   let summary;try{const result=checkId(await call('get_minutes_ai_summary',{taskUuid:id}),id);if(typeof result.hasSummary!=='boolean'||result.hasSummary&&typeof result.fullSummary!=='string')throw invalid('个人摘要返回不完整');summary=result.hasSummary&&result.fullSummary.trim()?{state:'ready',content:result.fullSummary.trim(),reason:''}:{state:'empty',content:'',reason:'个人听记尚未提供 AI 总结'};if(summary.content.length>500000)throw invalid('个人摘要超过正文限额');}catch{summary={state:'failed',content:'',reason:'个人听记摘要尚未读取完成'};}
   return {summary,transcript:await transcript(id),speaker_insights:missingArtifact('个人只读通道暂未提供发言人观点'),quality:qualityUnavailable()};
  },
  async audio(id){const result=checkId(await call('get_minutes_media_url',{taskUuid:id}),id);if(typeof result.available!=='boolean')throw invalid('个人听记录音返回不完整');if(!result.available)return {state:'unavailable',reason:'个人听记接口本次未提供可播放录音'};const url=result.audioUrl||result.mediaUrl||result.url;if(!safeMinutesAudio(url))throw invalid('个人听记录音地址未经核验');return {state:'available',reason:'',url};},
 };
}
