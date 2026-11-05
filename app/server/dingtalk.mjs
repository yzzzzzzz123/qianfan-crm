import { randomBytes } from 'node:crypto';
import { assert, AppError } from './domain.mjs';

// OAuth login followed by bidirectional enterprise identity verification.
export function createDingTalk({env=process.env,fetcher=fetch,secure=false,basePath='/'}={}) {
  const key=env.DINGTALK_CLIENT_ID,secret=env.DINGTALK_CLIENT_SECRET;
  const configured=!!(key&&secret),loginConfigured=configured&&!!env.DINGTALK_REDIRECT_URI&&!!env.DINGTALK_CORP_ID;
  const challenges=new Map();let appToken=null;
  async function request(url,body,token) {
    try {
      const response=await fetcher(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{'x-acs-dingtalk-access-token':token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error'});
      if(!response.ok)throw new AppError('钉钉接口调用失败，请核对应用权限和配置',502);
      const result=await response.json();
      assert(!result.code||result.code==='OK','钉钉接口未返回有效数据',502);
      return result;
    }catch(error){if(error instanceof AppError)throw error;throw new AppError('钉钉连接超时或响应无效，请稍后重试',502);}
  }
  async function token() {
    assert(configured,'请先配置钉钉企业应用',503);
    if(appToken&&appToken.until>Date.now())return appToken.value;
    const result=await request('https://api.dingtalk.com/v1.0/oauth2/accessToken',{appKey:key,appSecret:secret});assert(typeof result.accessToken==='string','钉钉未返回应用凭证',502);
    appToken={value:result.accessToken,until:Date.now()+Math.max(30,Number(result.expireIn||7200)-120)*1000};return appToken.value;
  }
  function start() {
    assert(loginConfigured,'钉钉登录尚未配置',503);
    const redirect=new URL(env.DINGTALK_REDIRECT_URI);assert(redirect.protocol==='https:'||['localhost','127.0.0.1'].includes(redirect.hostname),'钉钉回调地址须使用HTTPS');
    for(const [key,value]of challenges)if(value<Date.now())challenges.delete(key);
    assert(challenges.size<1000,'登录请求过多，请稍后重试',429);
    const state=randomBytes(32).toString('hex');challenges.set(state,Date.now()+600000);
    const url=new URL('https://login.dingtalk.com/oauth2/auth');
    url.search=new URLSearchParams({redirect_uri:redirect.href,response_type:'code',client_id:key,scope:'openid corpid',corpId:env.DINGTALK_CORP_ID,state,prompt:'consent'});
    return {body:{url:url.href},cookie:`qf_ding_state=${state}; Path=${basePath}api/auth/dingtalk; HttpOnly; SameSite=Lax; Max-Age=600${secure?'; Secure':''}`};
  }
  async function identity(req,b) {
    assert(loginConfigured,'钉钉登录尚未配置',503);
    const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('qf_ding_state='))?.slice(14);
    assert(typeof b.state==='string'&&b.state===cookie&&challenges.get(b.state)>Date.now(),'钉钉登录校验已过期，请重新发起登录',403);challenges.delete(b.state);
    assert(typeof b.code==='string'&&b.code.length>0&&b.code.length<2048,'钉钉授权码无效');
    const result=await request('https://api.dingtalk.com/v1.0/oauth2/userAccessToken',{clientId:key,clientSecret:secret,code:b.code,grantType:'authorization_code'});
    assert(result.corpId===env.DINGTALK_CORP_ID,'请使用指定企业的钉钉身份登录',403);
    assert(typeof result.accessToken==='string','钉钉授权未完成',502);
    const profile=await request('https://api.dingtalk.com/v1.0/contact/users/me',null,result.accessToken);
    assert(typeof profile.unionId==='string'&&profile.unionId.length>0,'钉钉未返回可核验身份',502);
    const mapped=await legacy('/topapi/user/getbyunionid',{unionid:profile.unionId});
    assert(typeof mapped.result?.userid==='string','当前身份不在企业应用可用范围内',403);
    const record=await legacy('/topapi/v2/user/get',{userid:mapped.result.userid,language:'zh_CN'});
    assert(record.result?.userid===mapped.result.userid&&record.result?.unionid===profile.unionId,'钉钉企业身份核验未通过',403);
    const seconds=Math.min(28800,Number(result.expireIn)||7200);assert(seconds>=60,'钉钉授权已过期，请重新登录',403);
    return {unionId:profile.unionId,userId:mapped.result.userid,corpId:result.corpId,seconds};
  }
  async function legacy(api,body) {const value=await request('https://oapi.dingtalk.com'+api+'?access_token='+encodeURIComponent(await token()),body);assert(!value.errcode,'钉钉企业通讯录核验失败，请检查权限和应用范围',502);return value;}
  async function verifyMinutesIdentity(expected,evidence) {
    assert(expected?.corpId===env.DINGTALK_CORP_ID&&typeof evidence?.corpId==='string'&&/^ding[a-zA-Z0-9]+$/.test(evidence.corpId)&&expected.userId&&expected.unionId,'听记企业身份不匹配',403);
    const normalized=(mobile,country)=>typeof mobile==='string'&&typeof country==='string'&&/^[1-9]\d{0,2}$/.test(country.trim().replace(/^\+/,''))&&/^\d{6,14}$/.test(mobile.trim().replace(/[ -]/g,''))?country.trim().replace(/^\+/,'')+':'+mobile.trim().replace(/[ -]/g,''):null;
    const claimed=normalized(evidence.mobile,evidence.countryCode);
    assert(claimed&&evidence.dwsUserId,'听记未提供完整的企业身份，无法确认本人授权',502);
    const row=(await legacy('/topapi/v2/user/get',{userid:expected.userId,language:'zh_CN'})).result;
    assert(row?.userid===expected.userId&&row?.unionid===expected.unionId,'企业成员身份已变化，请重新登录',403);
    const actual=normalized(row.mobile,row.state_code);
    if(actual)assert(actual===claimed,'请使用当前成员本人的钉钉账号授权听记',403);
    else {
      // The directory may omit sensitive mobile fields while still allowing an
      // exact, read-only mobile-to-member lookup. Never guess a country code.
      const [country,mobile]=claimed.split(':');
      assert(country==='86'&&/^1\d{10}$/.test(mobile),'此账号的区号暂不能通过现有企业接口核验，请联系项目负责人',503);
      const mapped=await legacy('/topapi/v2/user/getbymobile',{mobile});
      assert(mapped.result?.userid===expected.userId,'请使用当前成员本人的钉钉账号授权听记',403);
    }
    return {corpId:expected.corpId,userId:expected.userId,unionId:expected.unionId};
  }
  return {configured,loginConfigured,start,identity,verifyMinutesIdentity};
}
