import { openDatabase } from './server/database.mjs';
import { seedDemo } from './server/seed.mjs';
import { createService } from './server/service.mjs';
import { Buffer } from 'buffer';
const storageKey='qianfan-crm-trial-v2-db';
const sessionKey='qianfan-crm-trial-v2-session';
let csrf='';
const db=openDatabase(':memory:');
const stored=localStorage.getItem(storageKey);
if(stored) db.replace(Buffer.from(stored,'base64')); else {seedDemo(db);localStorage.setItem(storageKey,Buffer.from(db.export()).toString('base64'));}
const service=createService(db,{demo:true});
let queue=Promise.resolve();
export function setCsrf(value){csrf=value||'';}
export async function api(path,{method='GET',body={},key}={}) {
  const execute=async()=>{
    const snapshot=localStorage.getItem(storageKey);
    if(snapshot) db.replace(Buffer.from(snapshot,'base64'));
    const cookie=sessionStorage.getItem(sessionKey)||'';
    const req={headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':key||crypto.randomUUID()},socket:{remoteAddress:'browser-trial'}};
    let result;
    try {
      result=await service.handle(req,'/api'+path,method,body);
      if(method!=='GET') localStorage.setItem(storageKey,Buffer.from(db.export()).toString('base64'));
    } catch(e) {
      if(snapshot) db.replace(Buffer.from(snapshot,'base64'));
      if(e.name==='QuotaExceededError') throw new Error('浏览器存储空间不足，操作未保存。请先导出测试数据。');
      throw e;
    }
    if(result.cookie) sessionStorage.setItem(sessionKey,result.cookie.split(';')[0]);
    return result.body;
  };
  const job=()=>navigator.locks?.request?navigator.locks.request(storageKey,execute):execute();
  const pending=queue.then(job,job);queue=pending.catch(()=>{});return pending;
}
export function exportTrialData(){return localStorage.getItem(storageKey);}
export function resetTrialData(){localStorage.removeItem(storageKey);sessionStorage.removeItem(sessionKey);location.reload();}
