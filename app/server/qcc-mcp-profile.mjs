import {AppError,assert} from './domain.mjs';
import {createQccMcpClient,QccMcpError,qccFailure} from './qcc-mcp-transport.mjs';

export const QCC_MCP_DOC='https://agent.qcc.com/guide';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const scalar=(value,max=1000)=>{
  if(typeof value!=='string'&&(typeof value!=='number'||!Number.isFinite(value)))return null;
  const text=String(value).trim();
  return !text||/^(?:-|--|暂无|暂无数据|未公开|未披露|未知|null|undefined|N\/A)$/i.test(text)?null:text.slice(0,max);
};
const first=(row,keys,max)=>{for(const key of keys){const value=scalar(row?.[key],max);if(value!==null)return value;}return null;};
const stringList=value=>Array.isArray(value)&&value.every(item=>typeof item==='string')?scalar(value.join('；'),3000):scalar(value,3000);
const hierarchy=(value,levels)=>object(value)?levels.map(level=>scalar(value[level],200)).filter(Boolean).join(' / ')||null:scalar(value,800);
const cleanName=value=>String(value??'').normalize('NFKC').replace(/[\s（）()\u200b-\u200d\u2060\ufeff]/g,'').toLowerCase();
const cleanCode=value=>String(value??'').normalize('NFKC').replace(/[\s\u200b-\u200d\u2060\ufeff]/g,'').toUpperCase();
const names=['企业名称','公司名称','Name','CompanyName','company_name'];
const codes=['统一社会信用代码','CreditCode','credit_code'];
const mismatch=()=>({state:'mismatch',complete:false,details:{},reason:'源企业名称或信用代码与客户档案不一致，请先核对企业主体'});

// Parameters are taken from tools/list, never invented or supplied by an LLM.
// searchKey is QCC's documented company-domain parameter. Other names are only
// accepted when the live schema explicitly describes that precise identifier.
export function qccCompanyArguments(tool,customer){
  const schema=tool?.inputSchema;
  assert(object(schema)&&schema.type==='object'&&object(schema.properties),'企查查 MCP 工具参数定义缺失',502);
  assert(!schema.oneOf&&!schema.anyOf&&!schema.allOf&&!schema.$ref,'企查查 MCP 工具参数定义暂不支持',502);
  const required=schema.required??[];
  assert(Array.isArray(required)&&required.every(key=>typeof key==='string'),'企查查 MCP 工具必填定义无效',502);
  const args={};
  for(const [key,definition] of Object.entries(schema.properties)){
    if(!object(definition)||definition.type!=='string')continue;
    const description=String(definition.description??definition.title??'');
    const nameParameter=/^(company_?name|name)$/i.test(key)&&/企业.*(?:名称|全称)|公司.*(?:名称|全称)|company name/i.test(description);
    const codeParameter=/^(credit_?code|unified_?social_?credit_?code)$/i.test(key)&&/信用代码|credit code/i.test(description);
    if(key==='searchKey')args[key]=cleanCode(customer.credit_code)||String(customer.name).trim();
    else if(nameParameter)args[key]=String(customer.name).trim();
    else if(codeParameter&&cleanCode(customer.credit_code))args[key]=cleanCode(customer.credit_code);
    if(Object.hasOwn(args,key)){
      const value=args[key];
      assert(value&&value.length<=500&&(!definition.minLength||value.length>=definition.minLength)&&(!definition.maxLength||value.length<=definition.maxLength),'客户名称或信用代码不符合企查查参数要求',400);
      assert(!definition.enum||definition.enum.includes(value),'企查查 MCP 工具参数定义暂不支持',502);
      // Arbitrary remote regular expressions are not executed locally.
      assert(!definition.pattern&&!definition.$ref&&!definition.oneOf&&!definition.anyOf,'企查查 MCP 工具参数定义暂不支持',502);
    }
  }
  assert(Object.keys(args).length>0&&required.every(key=>Object.hasOwn(args,key)),'企查查 MCP 工具参数尚未核实，未执行企业查询',502);
  return args;
}

function documentFromResult(result){
  if(object(result.structuredContent))return result.structuredContent;
  assert(Array.isArray(result.content),'企查查 MCP 未返回可核验的结构化企业资料',502);
  const texts=(result.content??[]).filter(item=>item?.type==='text'&&typeof item.text==='string').map(item=>item.text.trim()).filter(Boolean);
  assert(texts.length===1,'企查查 MCP 未返回可核验的结构化企业资料',502);
  const raw=texts[0].replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1');
  try{return JSON.parse(raw);}catch{throw new AppError('企查查 MCP 企业资料格式尚未支持，未猜测文本内容',502);}
}
function companyRow(result){
  let row=documentFromResult(result);
  for(let depth=0;depth<5;depth++){
    if(row===null)return null;
    if(Array.isArray(row)){if(row.length>1)throw new QccMcpError('QCC_IDENTITY_REQUIRED');row=row[0]??null;continue;}
    assert(object(row),'企查查 MCP 企业资料格式无效',502);
    // The official API also returns a sole-key no-match object. Recognize only
    // that exact shape; a marker beside identity or error fields is not empty.
    if(Object.keys(row).length===1&&Object.hasOwn(row,'无匹配项'))return null;
    // Only inspect protocol/envelope positions; do not search ordinary company
    // descriptions for error words or treat business registration status as HTTP.
    if(row.success===false||row.isError===true||(Object.hasOwn(row,'error')&&row.error!==null&&row.error!==false)||['300008','200001'].includes(String(row.code)))throw qccFailure(row);
    const wrappers=['Result','result','data','数据'].filter(key=>Object.hasOwn(row,key));
    if(wrappers.length&&Object.hasOwn(row,'code'))assert(['0','200'].includes(String(row.code)),'企查查 MCP 企业查询未成功',502);
    if(Object.hasOwn(row,'Status')&&Object.hasOwn(row,'Result'))assert(String(row.Status)==='200','企查查 MCP 企业查询未成功',502);
    if(first(row,names))return row;
    assert(wrappers.length===1,'企查查 MCP 未提供唯一企业主体',502);row=row[wrappers[0]];
  }
  throw new AppError('企查查 MCP 企业资料层级无效',502);
}
function matches(row,customer,{requireCode=true}={}){
  const actualNames=names.map(key=>scalar(row[key])).filter(Boolean).map(cleanName),actualCodes=codes.map(key=>scalar(row[key])).filter(Boolean).map(cleanCode);
  const expectedName=cleanName(customer.name),expectedCode=cleanCode(customer.credit_code);
  return actualNames.length>0&&actualNames.every(name=>name===expectedName)&&new Set(actualCodes).size<=1&&(!expectedCode||(actualCodes.length?actualCodes.every(code=>code===expectedCode):!requireCode));
}
function registrationDetails(row){
  return {
    company_name:first(row,names),credit_code:first(row,codes,50),
    employee_scale:first(row,['人员规模','PersonScope'],100),company_scale:null,
    insured_count:first(row,['参保人数','InsuredCount'],100),
    business_scope:first(row,['经营范围','Scope'],5000),main_business:null,main_products:null,
    company_description:null,annual_employees:null,annual_report_year:null,
    industry:first(row,['行业','IndustryName'],200),national_industry:hierarchy(row['国标行业'],['门类','大类','中类','小类']),registered_capital:first(row,['注册资本','RegistCapi'],100),
    registration_status:first(row,['登记状态','经营状态','Status'],100),
    established_at:first(row,['成立日期','成立时间','StartDate'],50),
    registered_address:first(row,['注册地址','住所','Address']),
    source_updated_at:first(row,['更新时间','UpdatedDate'],50),
  };
}
function profileDetails(row){
  return {
    company_scale:first(row,['企业规模'],100),
    employee_scale:first(row,['人员规模','PersonScope'],100),
    insured_count:first(row,['参保人数','InsuredCount'],100),
    main_business:first(row,['主营业务'],3000),main_products:stringList(row['主营产品']),
    company_description:first(row,['企业简介','简介'],5000),
    industry:hierarchy(row['企查查行业'],['一级','二级','三级','四级'])||first(row,['行业'],200),
    source_updated_at:first(row,['更新时间','UpdatedDate'],50),
  };
}

export function createQccMcpProfileProvider({env=process.env,fetcher=fetch}={}){
  const apiKey=typeof env.QCC_MCP_API_KEY==='string'?env.QCC_MCP_API_KEY.trim():'';
  const configured=env.CRM_COMPANY_PROFILE_PROVIDER==='qcc-mcp'&&!!apiKey;
  async function lookup(customer,{checkpoint:previous,onCheckpoint}={}){
    assert(configured,'尚未配置企查查 MCP 密钥，未查询企业信息',503);
    assert(typeof customer?.name==='string'&&customer.name.trim()&&customer.name.length<=500,'请提供完整企业名称',400);
    assert(onCheckpoint===undefined||typeof onCheckpoint==='function','企业查询进度保存器无效',500);
    const identity={name:cleanName(customer.name),credit_code:cleanCode(customer.credit_code)};
    const fresh=()=>({version:1,provider:'qcc-mcp',identity});
    const safeSavedDetails=(details,allowed)=>object(details)&&Object.entries(details).every(([key,value])=>allowed.includes(key)&&(value===null||typeof value==='string'&&value.length<=5000));
    let checkpoint=fresh();
    if(object(previous)&&previous.version===1&&previous.provider==='qcc-mcp'&&previous.identity?.name===identity.name&&previous.identity?.credit_code===identity.credit_code){
      // Checkpoint data comes only from our durable, permission-scoped queue.
      // Still revalidate the subject before reusing it; changed subjects cannot
      // inherit paid results from their prior identity.
      const registration=previous.registration;
      if(registration?.state==='ready'&&safeSavedDetails(registration.details,Object.keys(registrationDetails({})))&&matches(registration.details,customer)&&typeof registration.checked_at==='string'){
        checkpoint={...fresh(),registration:{state:'ready',details:structuredClone(registration.details),checked_at:registration.checked_at}};
        if(['ready','not_found'].includes(previous.profile?.state)&&safeSavedDetails(previous.profile.details,Object.keys(profileDetails({})))&&typeof previous.profile.checked_at==='string')checkpoint.profile={state:previous.profile.state,details:structuredClone(previous.profile.details),checked_at:previous.profile.checked_at};
      }
    }
    const merged=()=>{
      const details={...(checkpoint.registration?.details||{})};
      for(const [key,value] of Object.entries(checkpoint.profile?.details||{}))if(value!==null)details[key]=value;
      return details;
    };
    const completed=()=>({state:'ready',complete:true,details:merged(),checkpoint:structuredClone(checkpoint),reason:checkpoint.profile?.state==='not_found'?'工商信息已核验；企业简介查询已完成，但来源未提供简介资料；未提供字段不作推断':'工商登记与企业简介来自企查查 MCP；经营范围、主营产品及参保人数分别展示，未提供字段不作推断；本次未额外查询年报'});
    const persist=async next=>{
      // A permission/version/lease failure in the caller must stop processing.
      // Do not return the uncommitted step as a successful checkpoint.
      if(onCheckpoint)await onCheckpoint(structuredClone(next));
      checkpoint=next;
    };
    if(checkpoint.registration&&checkpoint.profile)return completed();
    let saving=false;
    try{
      const client=createQccMcpClient({apiKey,fetcher}),tools=await client.discover();
      const profileArgs=qccCompanyArguments(tools.get('get_company_profile'),customer);
      const registrationArgs=checkpoint.registration?null:qccCompanyArguments(tools.get('get_company_registration_info'),customer);
      if(!checkpoint.registration){
        const row=companyRow(await client.call('get_company_registration_info',registrationArgs));
        if(!row)return {state:'not_found',complete:false,details:{},checkpoint:structuredClone(checkpoint),reason:'源接口未查询到该企业，未补写企业信息'};
        if(!matches(row,customer))return {...mismatch(),checkpoint:structuredClone(checkpoint)};
        saving=true;await persist({...checkpoint,registration:{state:'ready',details:registrationDetails(row),checked_at:new Date().toISOString()}});saving=false;
      }
      const profile=companyRow(await client.call('get_company_profile',profileArgs));
      if(profile&&!matches(profile,{name:customer.name,credit_code:customer.credit_code||checkpoint.registration.details.credit_code},{requireCode:false}))return {...mismatch(),checkpoint:structuredClone(checkpoint)};
      saving=true;await persist({...checkpoint,profile:{state:profile?'ready':'not_found',details:profile?profileDetails(profile):{},checked_at:new Date().toISOString()}});saving=false;
      return completed();
    }catch(original){
      if(saving)throw original;
      const error=original instanceof QccMcpError?original:original instanceof AppError&&original.status===502?Object.assign(original,{code:'QCC_RESPONSE_INVALID',retryable:false}):original;
      if(error instanceof AppError){
        error.checkpoint=structuredClone(checkpoint);
        if(checkpoint.registration)error.partialResult={state:'partial',complete:false,details:merged(),reason:error.message,checkpoint:structuredClone(checkpoint)};
      }
      throw error;
    }
  }
  return {configured,provider:configured?'企查查 MCP（工商与企业简介）':'',sourceUrl:configured?QCC_MCP_DOC:'',lookup};
}
