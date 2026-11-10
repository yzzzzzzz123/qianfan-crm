import {createHash} from 'node:crypto';
import {all,one,run,transaction} from './database.mjs';
import {AppError,assert,normalize,now} from './domain.mjs';
import {createQccMcpProfileProvider} from './qcc-mcp-profile.mjs';
import {withQwenCompanyFallback} from './company-profile-fallback.mjs';

export const COMPANY_PROFILE_DOC='https://openapi.qcc.com/dataApi/735';
export const COMPANY_PROFILE_ENDPOINT='https://api.qichacha.com/ECIInfoVerify/GetInfo';
const tidy=value=>String(value??'').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g,'');
export const normalizeCompanyName=value=>normalize(tidy(value));
export const normalizeCreditCode=value=>tidy(value).replace(/\s/g,'').toUpperCase();
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const companyIdentity=customer=>hash([normalizeCompanyName(customer.name),normalizeCreditCode(customer.credit_code)]);
export function assertCustomerIdentityUnique(db,{name,credit_code},exceptId=null) {
  const candidates=all(db,'SELECT id,name,credit_code FROM customers WHERE id!=?',exceptId??-1);
  if(name!==undefined)assert(!candidates.some(c=>normalizeCompanyName(c.name)===normalizeCompanyName(name)),'已有同名客户，请先查看客户档案',409);
  if(credit_code!==undefined&&normalizeCreditCode(credit_code))assert(!candidates.some(c=>normalizeCreditCode(c.credit_code)===normalizeCreditCode(credit_code)),'统一社会信用代码已存在',409);
}
const clean=(value,max=1000)=>typeof value==='string'||typeof value==='number'?String(value).trim().slice(0,max):null;
const missing='尚未配置企业信息接口，未查询企业规模或主营业务';
export function createCompanyProfileProvider({env=process.env,fetcher=fetch,clock=Date.now}={}) {
  if(env.CRM_COMPANY_PROFILE_PROVIDER==='qcc-mcp')return withQwenCompanyFallback(createQccMcpProfileProvider({env,fetcher}),{env,fetcher});
  // Enabling this adapter requires the owner's own authorized QCC application.
  // Merely having unrelated API credentials never causes a request.
  const configured=env.CRM_COMPANY_PROFILE_PROVIDER==='qcc'&&!!env.QCC_APP_KEY&&!!env.QCC_SECRET_KEY;
  async function lookup(customer) {
    assert(configured,missing,503);
    const timespan=String(Math.floor(clock()/1000));
    const token=createHash('md5').update(env.QCC_APP_KEY+timespan+env.QCC_SECRET_KEY).digest('hex').toUpperCase();
    const url=new URL(COMPANY_PROFILE_ENDPOINT);
    url.searchParams.set('key',env.QCC_APP_KEY);
    url.searchParams.set('searchKey',normalizeCreditCode(customer.credit_code)||String(customer.name).trim());
    let response,data;
    try {
      response=await fetcher(url,{headers:{Token:token,Timespan:timespan,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error();
      const raw=await response.text();if(raw.length>2*1024*1024)throw new Error();data=JSON.parse(raw);
    }catch{throw new AppError('企业信息接口暂时不可用，客户档案已保留，可稍后重试',502);}
    if(String(data?.Status)!=='200')throw new AppError('企业信息接口未返回成功结果，请核对接口授权或稍后重试',502);
    const row=data.Result;
    if(row===null||row===undefined)return {state:'not_found',details:{},reason:'源接口未查询到该企业，未补写企业信息'};
    assert(row&&typeof row==='object'&&!Array.isArray(row),'企业信息接口返回格式无效',502);
    if(!clean(row.Name)||normalizeCompanyName(row.Name)!==normalizeCompanyName(customer.name)||(normalizeCreditCode(customer.credit_code)&&normalizeCreditCode(row.CreditCode)!==normalizeCreditCode(customer.credit_code)))
      return {state:'mismatch',details:{},reason:'源企业名称或信用代码与客户档案不一致，请先核对企业主体'};
    return {state:'ready',complete:true,reason:'经营范围为工商登记内容；未提供的主营业务、实际人数等不作推断',details:{
      company_name:clean(row.Name),credit_code:clean(row.CreditCode,50),employee_scale:clean(row.PersonScope,100),
      insured_count:clean(row.InsuredCount,100),business_scope:clean(row.Scope,5000),main_business:null,
      industry:clean(row.Industry?.SubIndustry||row.Industry?.Industry,200),registered_capital:clean(row.RegistCapi,100),
      registration_status:clean(row.Status,100),established_at:clean(row.StartDate,50),registered_address:clean(row.Address),
      source_updated_at:clean(row.UpdatedDate,50),
    }};
  }
  return {configured,provider:configured?'企查查（企业工商详情）':'',sourceUrl:configured?COMPANY_PROFILE_DOC:'',lookup};
}
export function createCompanyProfiles({db,scoped,audit,provider=createCompanyProfileProvider()}) {
  const defaults=()=>({state:provider.configured?'not_read':'not_configured',provider:provider.provider||'',source_url:provider.sourceUrl||'',details:{},checked_at:null,can_refresh:!!provider.configured,reason:provider.configured?'尚未读取企业信息':missing});
  function read(customer) {
    const row=one(db,'SELECT * FROM customer_profiles WHERE customer_id=?',customer.id);
    if(!row)return defaults();
    const value={state:row.state,provider:row.provider,source_url:row.source_url,details:JSON.parse(row.details),checked_at:row.checked_at,can_refresh:!!provider.configured,reason:row.reason};
    if(row.identity_fingerprint!==companyIdentity(customer))return {...value,state:'stale',reason:'客户名称或信用代码已变化，之前读取的信息待重新核验'};
    if(row.state==='not_configured'&&provider.configured)return {...value,state:'not_read',reason:'企业信息接口已配置，尚未读取此客户的详细信息'};
    return value;
  }
  function initialize(id) {
    const customer=one(db,'SELECT * FROM customers WHERE id=?',id),value=defaults();
    run(db,'INSERT INTO customer_profiles(customer_id,state,provider,source_url,details,reason,checked_at,identity_fingerprint) VALUES(?,?,?,?,?,?,?,?)',id,value.state,value.provider,value.source_url,'{}',value.reason,null,companyIdentity(customer));
  }
  function saveResult(customer,result,{actor=null}={}) {
    const current=one(db,'SELECT * FROM customers WHERE id=?',customer.id);
    assert(current&&companyIdentity(current)===companyIdentity(customer),'客户主体在读取期间发生变化，请重新读取企业信息',409);
    assert(result&&['ready','partial','not_found','mismatch','failed','not_configured'].includes(result.state),'企业信息读取状态无效',502);
    const previous=read(current);
    let value={...defaults(),...result,checked_at:now()};
    if(['qwen','deepseek'].includes(value.details?._lookup?.kind)&&previous.state!=='stale'){
      // A fallback may supplement, but never replace, previously verified QCC facts.
      const details={...value.details},meta={...details._lookup,field_sources:{...details._lookup.field_sources}};
      for(const [key,item] of Object.entries(previous.details))if(key!=='_lookup'&&item!==null&&item!==''&&meta.field_sources[key]!=='qcc'&&(!previous.details._lookup||previous.details._lookup.field_sources?.[key]==='qcc')){
        details[key]=item;meta.field_sources[key]='qcc';
      }
      if(Object.values(meta.field_sources).includes('qcc')){
        value.provider='企查查 MCP + AI 联网整理（补充资料待核验）';
        meta.qcc_checked_at=meta.qcc_checked_at||previous.details._lookup?.qcc_checked_at||previous.checked_at;
      }
      value={...value,details:{...details,_lookup:meta}};
    }
    if(['failed','not_configured'].includes(value.state)&&previous.state!=='stale'&&Object.keys(previous.details).length)
      value={...value,details:previous.details,provider:previous.provider,source_url:previous.source_url,checked_at:previous.checked_at,reason:value.reason+'；保留上次读取的资料供核对，本次未核验，不作为当前已核实资料用于AI建议'};
    run(db,`INSERT INTO customer_profiles(customer_id,state,provider,source_url,details,reason,checked_at,identity_fingerprint) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET state=excluded.state,provider=excluded.provider,source_url=excluded.source_url,details=excluded.details,reason=excluded.reason,checked_at=excluded.checked_at,identity_fingerprint=excluded.identity_fingerprint`,current.id,value.state,value.provider,value.source_url,JSON.stringify(value.details||{}),value.reason||'',value.checked_at,companyIdentity(current));
    audit(actor||{id:null},actor?'读取企业详细信息':'自动读取企业详细信息','customer',current.id,{state:value.state,provider:value.provider});
    return read(current);
  }
  async function refresh(actor,id,authorize) {
    const before=scoped('customers',id,actor),fingerprint=hash(before),previous=read(before);
    authorize();
    let value=defaults();
    if(provider.configured){
      try {
        const result=await provider.lookup({name:before.name,credit_code:before.credit_code});
        assert(result&&['ready','partial','not_found','mismatch'].includes(result.state)&&result.details&&typeof result.details==='object','企业信息接口返回格式无效',502);
        value={...value,...result,checked_at:now()};
      }catch(error){value={...value,...(error.partialResult||{state:'failed',details:{}}),checked_at:now(),reason:error.partialResult?.reason||'企业信息接口读取失败，客户档案已保留，可稍后重试'};}
    }
    if(['failed','not_configured'].includes(value.state)&&previous.state!=='stale'&&Object.keys(previous.details).length){
      value={...value,details:previous.details,provider:previous.provider,source_url:previous.source_url,checked_at:previous.checked_at,reason:value.reason+'；保留上次读取的资料供核对，本次未核验，不作为当前已核实资料用于AI建议'};
    }
    authorize();const after=scoped('customers',id,actor);
    assert(hash(after)===fingerprint,'客户档案在读取期间发生变化，请重新读取企业信息',409);
    transaction(db,()=>saveResult(after,value,{actor}));
    return {customer_id:Number(id),company_profile:read(after)};
  }
  return {read,initialize,refresh,saveResult,configured:!!provider.configured,provider:provider.provider||''};
}
