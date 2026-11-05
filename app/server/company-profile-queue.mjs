import {randomUUID} from 'node:crypto';
import {companyIdentity} from './company-profile.mjs';
import {sqlCompanyIdentity} from './company-profile-queue-schema.mjs';

const statuses=['complete','pending','running','partial','mismatch','not_found','failed','waiting_quota'];
const manualWaiting=row=>row.manual_only===1&&!['complete','not_found','mismatch','running'].includes(row.status);
const codes=new Set(['QCC_QUOTA_EXHAUSTED','QCC_AUTH_INVALID','QCC_RATE_LIMITED','QCC_TRANSIENT','QCC_IDENTITY_REQUIRED','QCC_RESPONSE_INVALID','COMPANY_AI_UNAVAILABLE']);
const reasons={QCC_QUOTA_EXHAUSTED:'企查查积分不足，已保留进度，等待次日额度恢复',QCC_AUTH_INVALID:'企查查授权无效，请核对运行配置后手动重试',QCC_RATE_LIMITED:'企查查调用频率受限，将按退避时间重试',QCC_TRANSIENT:'企业资料接口暂时不可用，将有限重试',QCC_IDENTITY_REQUIRED:'企业主体不明确，请人工核对后重试',QCC_RESPONSE_INVALID:'企业资料响应无法核验，请核对后手动重试'};
reasons.COMPANY_AI_UNAVAILABLE='企查查暂不可用，Qwen 联网查询也未完成，请稍后手动重试';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const encodeCheckpoint=value=>{
  if(!object(value))throw new Error('Invalid checkpoint');
  const text=JSON.stringify(value);
  if(text.length>256000||/"(?:apiKey|api_key|authorization|access_token|refresh_token|protected_key|secret|cookie)"\s*:/i.test(text))throw new Error('Invalid checkpoint');
  return text;
};
export function nextCompanyQuotaRetry(at) {
  // Official daily gifts arrive at 02:00 Beijing time; leave five minutes.
  const offset=8*3600000,day=86400000;
  const current=new Date(at).getTime(),today=Math.floor((current+offset)/day)*day-offset+125*60000;
  return new Date(today>current?today:today+day).toISOString();
}

export function createCompanyProfileQueue({db,provider,commitResult=()=>{},clock=Date.now,deployment='local',localAutomation,leaseMs=120000,maxRetries=3}={}) {
  if(!db||!provider||typeof commitResult!=='function'||!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>600000||!Number.isInteger(maxRetries)||maxRetries<1||maxRetries>5)throw new Error('Invalid company profile queue options');
  const one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
  const time=()=>new Date(clock()).toISOString();
  const tx=fn=>{if(db.isTransaction)return fn();db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
  const permitted=manual=>manual===true||deployment==='production'||(deployment==='local'&&localAutomation?.authorized===true&&localAutomation?.runtimeChecked===true&&localAutomation?.scope==='qianfan-company-profile');
  function readJob(id){const row=one("SELECT j.customer_id,j.identity_version,j.identity_fingerprint,j.status,j.manual_only,j.attempts,j.retry_count,j.next_retry_at,j.error_code,j.reason,j.created_at,j.updated_at,j.finished_at,json_extract(j.checkpoint,'$.registration.state') registration_state,c.name,c.credit_code FROM company_profile_jobs j JOIN customers c ON c.id=j.customer_id WHERE customer_id=?",Number(id));if(!row)return null;const {registration_state,name,credit_code,...safe}=row,progressCurrent=row.identity_fingerprint===companyIdentity({name,credit_code});return {...safe,manual_only:row.manual_only===1,awaiting_manual:manualWaiting(row),next_retry_at:row.manual_only===1?null:row.next_retry_at,complete:row.status==='complete',stage:row.status==='complete'?'complete':progressCurrent&&registration_state==='ready'?'profile':'registration'};}
  function summary(){
    const rows=all('SELECT j.status,j.manual_only,j.checkpoint,j.next_retry_at,j.identity_fingerprint,c.name,c.credit_code FROM company_profile_jobs j JOIN customers c ON c.id=j.customer_id'),counts=Object.fromEntries(statuses.map(status=>[status,0])),control=one('SELECT paused_until,pause_reason FROM company_profile_queue_control WHERE id=1');
    let estimated=0,manualCredits=0,manualCount=0,automaticCount=0;for(const row of rows){counts[row.status]++;const waiting=manualWaiting(row);if(waiting)manualCount++;const eligible=['pending','running','waiting_quota'].includes(row.status)||(['partial','failed'].includes(row.status)&&row.next_retry_at);if(waiting||eligible){const checkpoint=row.identity_fingerprint===companyIdentity(row)?JSON.parse(row.checkpoint):{},cost=(checkpoint.registration?0:3)+(checkpoint.profile?0:1);estimated+=cost;if(row.manual_only)manualCredits+=cost;else automaticCount++;}}
    const next=one("SELECT MIN(next_retry_at) value FROM company_profile_jobs WHERE manual_only=0 AND next_retry_at IS NOT NULL AND status IN('pending','partial','failed','waiting_quota')").value;
    const authPaused=control.pause_reason==='QCC_AUTH_INVALID',quotaPaused=control.paused_until&&control.paused_until>time();
    return {counts:{...counts,manual:manualCount,total:rows.length},total:rows.length,manual_remaining_count:manualCount,automatic_remaining_count:automaticCount,pause_reason:provider.fallbackConfigured?'':authPaused?reasons.QCC_AUTH_INVALID:quotaPaused?(automaticCount?reasons.QCC_QUOTA_EXHAUSTED:'企查查积分不足，手动查询也需等待额度恢复'):'',next_retry_at:authPaused||!automaticCount?null:quotaPaused?control.paused_until:next,estimated_remaining_credits:estimated,estimated_manual_credits:manualCredits,estimated_automatic_credits:estimated-manualCredits};
  }
  function enqueueCustomer(id,{retry=false,priority=0,force=false,manual=false}={}){
    const customer=one('SELECT id,name,credit_code FROM customers WHERE id=?',Number(id));if(!customer)return null;
    const at=time();run(`INSERT OR IGNORE INTO company_profile_jobs(customer_id,identity_key,created_at,updated_at) SELECT id,${sqlCompanyIdentity()},?,? FROM customers WHERE id=?`,at,at,customer.id);
    const rank=Math.min(100,Math.max(0,Number.isInteger(priority)?priority:0));
    run('UPDATE company_profile_jobs SET priority=MAX(priority,?) WHERE customer_id=?',rank,customer.id);
    if(retry||force||manual===true)run("UPDATE company_profile_jobs SET status='pending',checkpoint=CASE WHEN ? THEN '{}' ELSE checkpoint END,retry_count=0,next_retry_at=NULL,error_code='',reason='',finished_at=NULL,updated_at=? WHERE customer_id=? AND status!='running'",force?1:0,at,customer.id);
    return readJob(customer.id);
  }
  function enqueueAll({retryAuth=false,manual=false}={}){return tx(()=>{
    if(retryAuth&&one('SELECT pause_reason FROM company_profile_queue_control WHERE id=1').pause_reason==='QCC_AUTH_INVALID'){
      const at=time();
      run("UPDATE company_profile_queue_control SET pause_reason=CASE WHEN paused_until>? THEN 'QCC_QUOTA_EXHAUSTED' ELSE '' END,paused_until=CASE WHEN paused_until>? THEN paused_until ELSE NULL END,updated_at=? WHERE id=1",at,at,at);
      run("UPDATE company_profile_jobs SET status='pending',retry_count=0,next_retry_at=NULL,error_code='',reason='',finished_at=NULL,updated_at=? WHERE error_code='QCC_AUTH_INVALID' AND status IN('failed','partial') AND (manual_only=0 OR ?=1)",at,manual===true?1:0);
    }
    for(const row of all('SELECT id FROM customers'))enqueueCustomer(row.id);
    if(manual===true)run("UPDATE company_profile_jobs SET status='pending',retry_count=0,next_retry_at=NULL,error_code='',reason='',finished_at=NULL,updated_at=? WHERE manual_only=1 AND status IN('pending','waiting_quota','partial','failed')",time());
    return summary();
  });}
  function markRemainingManual(){return tx(()=>{
    const result=run("UPDATE company_profile_jobs SET manual_only=1,status='failed',next_retry_at=NULL,lease_token=NULL,lease_until=NULL,error_code='MANUAL_REQUIRED',reason='剩余历史企业资料已改为手动查询',finished_at=NULL,updated_at=? WHERE status IN('pending','waiting_quota') OR (status IN('partial','failed') AND next_retry_at IS NOT NULL)",time());
    return {marked:Number(result.changes),...summary()};
  });}
  const matches=(job,token)=>{const current=one('SELECT * FROM company_profile_jobs WHERE customer_id=?',job.customer_id),customer=one('SELECT * FROM customers WHERE id=?',job.customer_id),control=one('SELECT lease_token FROM company_profile_queue_control WHERE id=1');return current?.lease_token===token&&current.identity_version===job.identity_version&&control?.lease_token===token&&customer&&companyIdentity(customer)===job.identity_fingerprint?{job:current,customer}:null;};
  function checkpoint(job,token,value){const encoded=encodeCheckpoint(value);return tx(()=>{const current=matches(job,token);if(!current)throw new Error('Company identity or lease changed');const until=new Date(clock()+leaseMs).toISOString();run('UPDATE company_profile_jobs SET checkpoint=?,lease_until=?,updated_at=? WHERE customer_id=?',encoded,until,time(),job.customer_id);run('UPDATE company_profile_queue_control SET lease_until=?,updated_at=? WHERE id=1 AND lease_token=?',until,time(),token);});}
  function claim(manual,customerId){return tx(()=>{
    const at=time(),control=one('SELECT * FROM company_profile_queue_control WHERE id=1');
    const primaryPause=control.pause_reason==='QCC_AUTH_INVALID'?'QCC_AUTH_INVALID':control.paused_until&&control.paused_until>at?'QCC_QUOTA_EXHAUSTED':null;
    if(primaryPause&&!provider.fallbackConfigured)return primaryPause==='QCC_AUTH_INVALID'?{state:'paused',reason:reasons.QCC_AUTH_INVALID}:{state:'waiting_quota',next_retry_at:control.paused_until};
    if(control.lease_token&&control.lease_until>at)return {state:'busy'};
    run("UPDATE company_profile_jobs SET status=CASE WHEN manual_only=1 THEN 'failed' WHEN checkpoint='{}' THEN 'pending' ELSE 'partial' END,next_retry_at=CASE WHEN manual_only=1 THEN NULL ELSE ? END,error_code=CASE WHEN manual_only=1 THEN 'MANUAL_REQUIRED' ELSE error_code END,reason=CASE WHEN manual_only=1 THEN '上次手动查询已中断，请手动继续' ELSE reason END,lease_token=NULL,lease_until=NULL,updated_at=? WHERE status='running' AND (lease_until IS NULL OR lease_until<=?)",at,at,at);
    if(!primaryPause)run("UPDATE company_profile_queue_control SET lease_token=NULL,lease_until=NULL,paused_until=NULL,pause_reason='' WHERE id=1");
    const job=one("SELECT * FROM company_profile_jobs WHERE (?=1 OR manual_only=0) AND (? IS NULL OR customer_id=?) AND (status='pending' OR (status IN('partial','failed','waiting_quota') AND next_retry_at IS NOT NULL AND next_retry_at<=?)) ORDER BY priority DESC,CASE WHEN status='waiting_quota' THEN 0 ELSE 1 END,customer_id LIMIT 1",manual?1:0,customerId??null,customerId??null,at);
    if(!job)return {state:'idle'};
    const customer=one('SELECT * FROM customers WHERE id=?',job.customer_id),fingerprint=companyIdentity(customer),token=randomUUID(),until=new Date(clock()+leaseMs).toISOString();
    const saved=job.identity_fingerprint===fingerprint?job.checkpoint:'{}';
    run("UPDATE company_profile_jobs SET status='running',identity_fingerprint=?,checkpoint=?,attempts=attempts+1,lease_token=?,lease_until=?,next_retry_at=NULL,updated_at=? WHERE customer_id=?",fingerprint,saved,token,until,at,job.customer_id);
    run('UPDATE company_profile_queue_control SET lease_token=?,lease_until=?,updated_at=? WHERE id=1',token,until,at);
    return {state:'claimed',job:{...job,identity_fingerprint:fingerprint,checkpoint:saved},customer,token,primaryPause};
  });}
  function persist(job,token,result,{errorCode='',retryAt=null,retryCount=job.retry_count,pauseUntil=null}={}){
    return tx(()=>{
      const current=matches(job,token);if(!current)return false;
      const at=time(),status=result.state==='ready'?'complete':errorCode==='QCC_QUOTA_EXHAUSTED'?'waiting_quota':result.state;
      if(!statuses.includes(status))throw new Error('Invalid provider result state');
      const queue={customer_id:job.customer_id,identity_version:job.identity_version,identity_fingerprint:job.identity_fingerprint,status,manual_only:job.manual_only===1,error_code:errorCode,next_retry_at:retryAt};
      const value=commitResult(current.customer,{...result,complete:status==='complete',queue});
      if(value&&typeof value.then==='function')throw new Error('Queue commit callback must be synchronous');
      const reason=errorCode&&job.manual_only===1&&['QCC_QUOTA_EXHAUSTED','QCC_RATE_LIMITED','QCC_TRANSIENT'].includes(errorCode)?(errorCode==='QCC_QUOTA_EXHAUSTED'?'企查查积分不足，已保留进度；额度恢复后请手动查询':'企业资料查询暂未完成，已保留进度，请手动重试'):errorCode?reasons[errorCode]:String(result.reason||'').slice(0,1000);
      run('UPDATE company_profile_jobs SET status=?,retry_count=?,next_retry_at=?,lease_token=NULL,lease_until=NULL,error_code=?,reason=?,updated_at=?,finished_at=? WHERE customer_id=?',status,retryCount,retryAt,errorCode,reason,at,retryAt?null:at,job.customer_id);
      run("UPDATE company_profile_queue_control SET lease_token=NULL,lease_until=NULL,paused_until=CASE WHEN ? IS NOT NULL THEN ? ELSE paused_until END,pause_reason=CASE WHEN pause_reason='QCC_AUTH_INVALID' THEN pause_reason WHEN ? IS NOT NULL THEN 'QCC_QUOTA_EXHAUSTED' ELSE pause_reason END,updated_at=? WHERE id=1 AND lease_token=?",pauseUntil,pauseUntil,pauseUntil,at,token);
      return true;
    });
  }
  async function runNext({manual=false,customerId}={}){
    if(customerId!==undefined&&(!Number.isSafeInteger(customerId)||customerId<=0))throw new Error('Invalid company profile customer ID');
    if(!permitted(manual))return {state:'disabled'};
    if(!provider.configured)return {state:'not_configured'};
    const selected=claim(manual===true,customerId);if(selected.state!=='claimed')return selected;
    const {job,customer,token}=selected;
    let lastCheckpoint=JSON.parse(job.checkpoint);
    const onCheckpoint=async value=>{checkpoint(job,token,value);lastCheckpoint=value;};
    const onPrimaryFailure=async error=>{
      if(error.code==='QCC_QUOTA_EXHAUSTED'){
        const until=nextCompanyQuotaRetry(time());
        tx(()=>run("UPDATE company_profile_queue_control SET paused_until=?,pause_reason=CASE WHEN pause_reason='QCC_AUTH_INVALID' THEN pause_reason ELSE 'QCC_QUOTA_EXHAUSTED' END,updated_at=? WHERE id=1",until,time()));
      }
      if(error.code==='QCC_AUTH_INVALID')tx(()=>run("UPDATE company_profile_queue_control SET pause_reason='QCC_AUTH_INVALID',updated_at=? WHERE id=1",time()));
      checkpoint(job,token,lastCheckpoint);
    };
    // Search + Qwen may outlive the original lease. Renew only the owned job;
    // identity/lease changes still reject every checkpoint and final commit.
    const heartbeat=setInterval(()=>{try{checkpoint(job,token,lastCheckpoint);}catch{}},Math.max(500,Math.floor(leaseMs/3)));
    heartbeat.unref?.();
    try {
      const result=await provider.lookup({id:customer.id,name:customer.name,credit_code:customer.credit_code},{checkpoint:lastCheckpoint,onCheckpoint,onPrimaryFailure,primaryPause:selected.primaryPause});
      if(!object(result)||!['ready','partial','mismatch','not_found'].includes(result.state)||!object(result.details)||result.state==='ready'&&result.complete!==true)throw Object.assign(new Error('Invalid provider result'),{code:'QCC_RESPONSE_INVALID'});
      if(result.checkpoint)await onCheckpoint(result.checkpoint);
      persist(job,token,result);
    }catch(error){
      const code=codes.has(error?.code)?error.code:'QCC_TRANSIENT';
      try {
        // Quota is account-wide even when the just-queried customer changed.
        if(code==='QCC_QUOTA_EXHAUSTED'){const until=nextCompanyQuotaRetry(time());tx(()=>run("UPDATE company_profile_queue_control SET paused_until=?,pause_reason=CASE WHEN pause_reason='QCC_AUTH_INVALID' THEN pause_reason ELSE 'QCC_QUOTA_EXHAUSTED' END,updated_at=? WHERE id=1 AND (paused_until IS NULL OR paused_until<?)",until,time(),until));}
        if(code==='QCC_AUTH_INVALID')tx(()=>run("UPDATE company_profile_queue_control SET pause_reason='QCC_AUTH_INVALID',updated_at=? WHERE id=1",time()));
        if(error?.checkpoint)await onCheckpoint(error.checkpoint);
        const retryCount=code==='QCC_QUOTA_EXHAUSTED'?job.retry_count:job.retry_count+1;
        const retryable=['QCC_TRANSIENT','QCC_RATE_LIMITED'].includes(code)&&retryCount<maxRetries;
        const backoff=Math.min(86400000,Math.max([60000,300000,1800000][Math.min(retryCount-1,2)]||60000,Number.isFinite(error?.retryAfterMs)?error.retryAfterMs:0));
        const quotaUntil=code==='QCC_QUOTA_EXHAUSTED'?nextCompanyQuotaRetry(time()):null;
        const retryAt=job.manual_only===1?null:quotaUntil|| (retryable?new Date(clock()+backoff).toISOString():null);
        const details=object(error?.partialResult?.details)?error.partialResult.details:object(lastCheckpoint.registration?.details)?lastCheckpoint.registration.details:{};
        const state=code==='QCC_IDENTITY_REQUIRED'?'mismatch':Object.keys(details).length?'partial':'failed';
        persist(job,token,{state,complete:false,details,reason:reasons[code],checkpoint:lastCheckpoint},{errorCode:code,retryAt,retryCount,pauseUntil:quotaUntil});
      }catch{/* Lost identity/lease or a rejected commit cannot overwrite a newer task. */}
    }finally{
      clearInterval(heartbeat);
      run("UPDATE company_profile_queue_control SET lease_token=NULL,lease_until=NULL WHERE id=1 AND lease_token=? AND NOT EXISTS(SELECT 1 FROM company_profile_jobs WHERE lease_token=? AND status='running')",token,token);
    }
    return {state:'processed',job:readJob(job.customer_id)};
  }
  return {enqueueAll,enqueueCustomer,markRemainingManual,read:readJob,summary,runNext};
}
