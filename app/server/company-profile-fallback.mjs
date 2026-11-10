import {AppError} from './domain.mjs';
import {createQwenCompanyProfile,PROFILE_FIELDS} from './qwen-company-profile.mjs';

const fallbackCodes=new Set(['QCC_QUOTA_EXHAUSTED','QCC_AUTH_INVALID','QCC_RATE_LIMITED','QCC_TRANSIENT','QCC_RESPONSE_INVALID','QCC_NOT_CONFIGURED','QCC_NOT_FOUND']);
const causes={QCC_QUOTA_EXHAUSTED:'企查查额度不足',QCC_AUTH_INVALID:'企查查授权暂不可用',QCC_RATE_LIMITED:'企查查调用受限',QCC_TRANSIENT:'企查查连接暂不可用',QCC_RESPONSE_INVALID:'企查查响应未能读取',QCC_NOT_CONFIGURED:'企查查尚未配置',QCC_NOT_FOUND:'企查查未找到企业资料'};
const norm=v=>String(v??'').normalize('NFKC').replace(/[\s()\u200b-\u200d\u2060\ufeff]/g,'').toLowerCase();
function savedRegistration(customer,checkpoint){
  const r=checkpoint?.registration,d=r?.details;
  if(checkpoint?.provider!=='qcc-mcp'||r?.state!=='ready'||!d||norm(d.company_name)!==norm(customer.name)||customer.credit_code&&norm(d.credit_code)!==norm(customer.credit_code))return {};
  return Object.fromEntries(Object.entries(d).filter(([k,v])=>PROFILE_FIELDS.includes(k)&&typeof v==='string'&&v.length<=5000));
}
export function withQwenCompanyFallback(primary,{env=process.env,fetcher=fetch,fallback=createQwenCompanyProfile({env,fetcher})}={}){
  async function lookup(customer,options={}){
    let checkpoint=options.checkpoint,partial={},code;
    const onCheckpoint=async value=>{if(options.onCheckpoint)await options.onCheckpoint(value);checkpoint=value;};
    if(options.primaryPause&&fallback.configured)code=options.primaryPause;
    else if(!primary.configured)code='QCC_NOT_CONFIGURED';
    else{
      try{
        const result=await primary.lookup(customer,{...options,onCheckpoint});
        if(result.state!=='not_found'||!fallback.configured)return result;
        code='QCC_NOT_FOUND';checkpoint=result.checkpoint||checkpoint;
      }catch(error){
        if(!fallback.configured||!fallbackCodes.has(error?.code))throw error;
        code=error.code;checkpoint=error.checkpoint||checkpoint;partial=error.partialResult?.details||{};
        // Persist account-wide quota/auth backoff before starting the AI call.
        if(options.onPrimaryFailure)await options.onPrimaryFailure(error);
      }
    }
    if(!fallback.configured)throw Object.assign(new AppError('企查查与 DeepSeek 企业资料查询尚未配置',503),{code:'COMPANY_AI_UNAVAILABLE'});
    const registration={...savedRegistration(customer,checkpoint),...Object.fromEntries(Object.entries(partial).filter(([k,v])=>PROFILE_FIELDS.includes(k)&&typeof v==='string'&&v.trim()&&v.length<=5000))};
    let ai;
    try{ai=await fallback.lookup(customer,{verifiedIdentity:!!registration.company_name});}
    catch{
      const error=Object.assign(new AppError('企查查暂不可用，DeepSeek 联网查询也未完成，请稍后手动重试',502),{code:'COMPANY_AI_UNAVAILABLE'});
      error.checkpoint=checkpoint;
      error.partialResult={state:Object.keys(registration).length?'partial':'failed',complete:false,details:registration,reason:error.message};
      throw error;
    }
    const details={...ai.details,...registration},field_sources={...ai.field_sources,...Object.fromEntries(Object.keys(registration).map(k=>[k,'qcc']))};
    const meta={kind:'deepseek',model:fallback.model,fallback_code:code,fallback_reason:causes[code],sources:ai.sources||[],evidence:ai.evidence||{},field_sources,qcc_checked_at:checkpoint?.registration?.checked_at||null};
    // AI-derived fields stay partial, so downstream sales analysis never treats
    // them as a fully verified QCC profile. No automatic retry is scheduled.
    const found=Object.keys(details).length>0;
    return {state:'partial',complete:false,provider:Object.keys(registration).length?'企查查 MCP + DeepSeek 联网整理（补充资料待核验）':'DeepSeek 联网整理（待核验）',source_url:ai.sources?.[0]?.url||'',details:{...details,_lookup:meta},checkpoint,reason:`${causes[code]}，已转 DeepSeek；${found?ai.reason:'未查到有依据的企业资料，请核对完整企业名称后重试'}`};
  }
  return {...primary,configured:primary.configured||fallback.configured,fallbackConfigured:fallback.configured===true,lookup};
}
