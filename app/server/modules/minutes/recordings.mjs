import { AppError } from './errors.mjs';
export const safeMinutesAudio=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&['mozi-conf-tingwu.oss-cn-beijing.aliyuncs.com','prod-tingwu-paas-common-beijing.oss-cn-beijing.aliyuncs.com'].includes(u.hostname)?u.href:null;}catch{return null;}};
export async function fetchMinutesAudio(value,{range,fetchImpl=fetch}={}){
 let url=safeMinutesAudio(value);if(!url)throw new AppError(502,'MINUTES_AUDIO_HOST','录音文件域名尚未验证');
 if(range&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))throw new AppError(416,'INVALID_RANGE','录音分段参数不正确');
 for(let i=0;i<4;i++){
  let r;try{r=await fetchImpl(url,{headers:range?{Range:range}:{},redirect:'manual',signal:AbortSignal.timeout(30000)});}catch{throw new AppError(502,'MINUTES_AUDIO_NETWORK','录音获取失败，请重试');}
  if([301,302,303,307,308].includes(r.status)){const location=r.headers.get('location');await r.body?.cancel();try{url=location&&safeMinutesAudio(new URL(location,url).href);}catch{url=null;}if(!url)throw new AppError(502,'MINUTES_AUDIO_HOST','录音跳转域名未验证');continue;}
  if(![200,206].includes(r.status)){await r.body?.cancel();throw new AppError(r.status===416?416:502,'MINUTES_AUDIO_UNAVAILABLE','录音暂不可用，请检查源文件权限后重试');}
  const mime=(r.headers.get('content-type')||'application/octet-stream').split(';')[0].trim();if(!mime.startsWith('audio/')&&mime!=='application/octet-stream'){await r.body?.cancel();throw new AppError(502,'MINUTES_AUDIO_FORMAT','源接口未返回音频文件');}
  if(Number(r.headers.get('content-length')||0)>128*1024*1024){await r.body?.cancel();throw new AppError(413,'MINUTES_AUDIO_SIZE','录音超过当前 128MB 回放限制');}return r;
 }
 throw new AppError(502,'MINUTES_AUDIO_REDIRECT','录音跳转次数过多');
}
