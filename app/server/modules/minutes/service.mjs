import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {all,one,run,transaction} from '../../database.mjs';
import {assert,now} from '../../domain.mjs';
import {createMinutesClient,readSavedMinutesIdentity,readSavedMinutesProfiles} from './client.mjs';
import {createDeviceFlow,safeAuthorizationUrl,publicAuthorizationError} from './device-flow.mjs';
import {normalizeArtifacts,artifactKinds,missingArtifact} from './content.mjs';
import {fetchMinutesAudio,safeMinutesAudio} from './recordings.mjs';
import {minutesIncrementalFrom,minutesSourceSchedule,minutesSchedulerIntervalMs} from './schedule.mjs';
import {minutesDateRange} from './dates.mjs';
import {recognizeMinutes} from './recognition.mjs';
import {speakerPending} from './speaker.mjs';
import {qualityInput,analyzeQuality,createQualityComplete} from './quality.mjs';
import {createPersonalMinutesClient} from './personal-client.mjs';
import {loadPersonalTokens} from './personal-oauth.mjs';

export function createMinutesService(db,{binary=process.env.CRM_MINUTES_BINARY||path.resolve('../.private/tools/dws',process.platform==='win32'?'dws.exe':'dws'),credentialRoot=process.env.CRM_MINUTES_CREDENTIAL_ROOT||path.resolve('../.private/minutes-accounts'),corpId=process.env.DINGTALK_CORP_ID,clientFactory,personalClientFactory=createPersonalMinutesClient,readPersonalTokens=loadPersonalTokens,beginDeviceFlow,resolveEmployeeIdentity,readSavedIdentity=readSavedMinutesIdentity,readSavedProfiles=readSavedMinutesProfiles,enabled=existsSync(binary),deployment='local',fetchImpl=fetch,activityTags={},qualityComplete=createQualityComplete()}={}) {
  assert(path.isAbsolute(binary)&&path.isAbsolute(credentialRoot),'听记连接器与凭据目录必须使用绝对路径',503);
  clientFactory??=source=>createMinutesClient(source,{binary,resolveEmployeeIdentity});
  beginDeviceFlow??=createDeviceFlow({binary});
  const authorizations=new Map(),syncing=new Set(),syncTasks=new Set(),speakerRequests=new Set(),qualityRequests=new Set();
  const storedArtifacts=id=>Object.fromEntries(all(db,'SELECT * FROM minutes_artifacts WHERE record_id=?',id).map(a=>[a.kind,a]));
  let scheduleTimer=null,scheduleTask=null,scheduleClosing=false;
  const safeSources="id,member_id,corp_id,account_name,corp_name,connection_state,collect_from,last_synced_at,provider";
  const sourceSchedule=s=>minutesSourceSchedule(all(db,"SELECT status,error_message,created_at,finished_at FROM minutes_sync_runs WHERE source_id=? AND (mode='incremental' OR from_time='1970-01-01T00:00:00.000Z') ORDER BY rowid DESC LIMIT 6",s.id),{automatic:deployment==='production',configured:enabled,connected:s.connection_state==='connected'});
  const audit=(actor,action,id,detail={})=>run(db,'INSERT INTO audit(user_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)',actor?.id||null,action,'minutes',Number.isSafeInteger(id)?id:null,JSON.stringify({...detail,...(actor?._operator_id?{operator_user_id:actor._operator_id}:{}),...(typeof id==='string'?{source_or_authorization_id:id}:{})}),now());
  const current=actor=>{const user=one(db,'SELECT * FROM users WHERE id=? AND active=1 AND business_member=1 AND developer_admin=0',actor?.id);assert(user&&['admin','sales'].includes(user.role),'当前账号不可访问钉钉听记',403);return {...user,...(actor?._operator_id?{_operator_id:actor._operator_id}:{})};};
  function binding(actor){current(actor);const row=one(db,'SELECT u.ding_user_id,d.union_id FROM users u JOIN ding_identities d ON d.user_id=u.id WHERE u.id=?',actor.id);assert(corpId&&row?.ding_user_id&&row?.union_id,'请先为当前成员核验企业钉钉身份',403);return {corpId,userId:row.ding_user_id,unionId:row.union_id};}
  function credential(key){assert(/^[a-f0-9-]{36}$/.test(key),'听记凭据目录无效',503);return path.join(credentialRoot,key);}
  function source(actor,id,{own=false,connected=false}={}){const a=current(actor),row=one(db,'SELECT * FROM minutes_sources WHERE id=?',id);assert(row&&(a.role==='admin'&&!own||row.member_id===a.id),'听记账号不存在或不可访问',404);assert(one(db,'SELECT id FROM users WHERE id=? AND active=1 AND business_member=1 AND developer_admin=0',row.member_id),'听记账号归属成员已停用',403);if(connected)assert(row.connection_state==='connected','听记连接已停止，请本人重新授权',409);return row;}
  const personal=(key,memberId)=>personalClientFactory({credentialDir:credential(key),memberId,authorizationKey:key});
  const client=s=>s.provider==='personal_mcp'?personal(s.credential_key,s.member_id):clientFactory({...s,corpId:s.corp_id,userId:s.user_id,profile:s.corp_id+':'+s.user_id,credentialDir:credential(s.credential_key)});
  function recordSource(actor,r){current(actor);const s=one(db,'SELECT * FROM minutes_sources WHERE id=?',r.source_id);assert(s?.connection_state==='connected','听记连接已停止，请本人重新授权',409);assert(one(db,'SELECT id FROM users WHERE id=? AND active=1 AND business_member=1 AND developer_admin=0',s.member_id),'听记账号归属成员已停用',403);return s;}
  function target(actor,customerId,opportunityId){
    const a=current(actor);assert(!opportunityId||Number.isSafeInteger(opportunityId),'商机编号无效');assert(!customerId||Number.isSafeInteger(customerId),'客户编号无效');
    if(opportunityId){const o=one(db,'SELECT * FROM opportunities WHERE id=? AND archived_at IS NULL',opportunityId);assert(o&&(a.role==='admin'||o.owner_id===a.id||o.collaborator_pm===a.id||one(db,'SELECT 1 FROM customer_collaborators WHERE customer_id=? AND user_id=?',o.customer_id,a.id)),'商机不存在或不可访问',404);assert(!customerId||customerId===o.customer_id,'商机与客户不匹配');return {customer_id:o.customer_id,opportunity_id:o.id};}
    if(customerId){const c=one(db,'SELECT * FROM customers WHERE id=?',customerId);assert(c&&(a.role==='admin'||c.owner_id===a.id||one(db,'SELECT 1 FROM customer_collaborators WHERE customer_id=? AND user_id=?',c.id,a.id)),'客户不存在或不可访问',404);return {customer_id:c.id,opportunity_id:null};}
    return {customer_id:null,opportunity_id:null};
  }
  function record(actor,id,context={}){const a=current(actor),r=one(db,'SELECT * FROM minutes_records WHERE id=?',id);assert(r,'听记不存在',404);const owner=one(db,'SELECT member_id FROM minutes_sources WHERE id=?',r.source_id);assert(a.role==='admin'||owner?.member_id===a.id,'听记不存在或不可访问',404);if(context.customer_id||context.opportunity_id){const t=target(a,context.customer_id,context.opportunity_id);assert(r.customer_id===t.customer_id&&(!t.opportunity_id||r.opportunity_id===t.opportunity_id),'当前档案中没有这条听记',404);}else source(a,r.source_id);return r;}
  function saveArtifacts(id,values){
    for(const [kind,a] of Object.entries(normalizeArtifacts(values))){
      const previous=one(db,'SELECT * FROM minutes_artifacts WHERE record_id=? AND kind=?',id,kind);
      if(kind==='quality'&&a.state==='unavailable'&&previous?.reason?.startsWith('CRM AI 质检'))continue;
      if(['summary','transcript'].includes(kind)&&['ready','empty'].includes(a.state)&&a.content!==(previous?.content||''))run(db,"UPDATE minutes_artifacts SET state='pending',reason='CRM AI 质检 · 听记正文已更新，正在更新分析' WHERE record_id=? AND kind='quality' AND reason LIKE 'CRM AI 质检%'",id);
      run(db,`INSERT INTO minutes_artifacts VALUES(?,?,?,?,?,?,?) ON CONFLICT(record_id,kind) DO UPDATE SET state=excluded.state,content=CASE WHEN excluded.state IN ('ready','empty') THEN excluded.content ELSE minutes_artifacts.content END,reason=excluded.reason,checked_at=excluded.checked_at,succeeded_at=CASE WHEN excluded.state='ready' THEN excluded.succeeded_at ELSE minutes_artifacts.succeeded_at END`,id,kind,a.state,a.content,a.reason,now(),a.state==='ready'?now():null);
    }
  }
  function followup(id){
    const r=one(db,'SELECT r.*,s.member_id FROM minutes_records r JOIN minutes_sources s ON s.id=r.source_id WHERE r.id=?',id);
    // Only an explicit opportunity association creates an automatic summary; never infer a customer from a title.
    const old=one(db,'SELECT * FROM activities WHERE minutes_record_id=?',id);
    if(!r.opportunity_id){if(old)run(db,'DELETE FROM activities WHERE id=?',old.id);return;}
    const summary=one(db,"SELECT content FROM minutes_artifacts WHERE record_id=? AND kind='summary' AND state='ready'",id)?.content;
    if(!summary)return;
    const day=new Date(new Date(r.start_time).getTime()+8*3600000).toISOString().slice(0,10);
    if(old)run(db,'UPDATE activities SET opportunity_id=?,summary=? WHERE id=?',r.opportunity_id,summary.slice(0,20000),old.id);
    else run(db,"INSERT INTO activities(opportunity_id,user_id,source,activity_type,summary,action,activity_date,created_at,minutes_record_id) VALUES(?,?,'AI听记','听记摘要',?,'',?,?,?)",r.opportunity_id,r.member_id,summary.slice(0,20000),day,now(),id);
  }
  const authorizationContext=a=>{const c=a?.candidate?JSON.parse(a.candidate):null;return {candidate:c?.profile||c?.provider==='personal_mcp'?c:null,accountMode:c?.accountMode==='separate_account'?'separate_account':'same_account',identity:c?.crmIdentity};};
  const canConfirmOwner=(actor,accountMode)=>accountMode!=='separate_account'||!actor._operator_id||!!one(db,'SELECT 1 FROM users u JOIN ding_identities d ON d.user_id=u.id WHERE u.id=? AND u.active=1 AND u.developer_admin=1 AND u.business_member=0',actor._operator_id);
  const confirmOwner=(actor,accountMode)=>assert(canConfirmOwner(actor,accountMode),'当前操作者无权确认该成员的听记关联',403);
  async function verify(actor,candidate,{accountMode='same_account',identity}={}){
    const expected=binding(actor);
    if(identity)assert(JSON.stringify(expected)===JSON.stringify(identity),'成员身份已变化，请重新授权',409);
    if(candidate.provider==='personal_mcp'){assert(accountMode==='separate_account'&&candidate.grantKey===candidate.key,'个人听记授权来源无效',403);await personal(candidate.key,actor.id).verify();return expected;}
    assert(/^ding[a-zA-Z0-9]+$/.test(candidate.corpId),'授权组织标识无效',502);
    const c=clientFactory({...candidate,credentialDir:credential(candidate.key)});await c.verify();
    if(accountMode==='separate_account'){
      // Two independently authorized accounts need not share a directory user,
      // union ID or phone. The CRM member or verified developer confirms ownership.
      assert(typeof c.accountIdentity==='function','听记账号核验服务尚未配置',503);const actual=await c.accountIdentity();
      assert(actual?.corpId===candidate.corpId&&actual.userId===candidate.userId,'听记返回的身份与实际授权账号不一致',403);return expected;
    }
    const actual=await c.employeeIdentity(expected);
    assert(actual.corpId===expected.corpId&&actual.userId===expected.userId,'听记授权账号与当前成员不一致',403);return expected;
  }
  const publicProfile=p=>({corpId:p.corpId,userId:p.userId,profile:p.corpId+':'+p.userId,accountName:String(p.accountName||'已核验账号').slice(0,120),corpName:String(p.corpName||'已核验组织').slice(0,200)});
  async function verifiedProfiles(actor,candidate,key,expected){
    const approved=[publicProfile(candidate)];
    // CLI storage can retain another person's previous login. Only an online
    // match to this CRM member makes any of those profiles a visible option.
    for(const p of readSavedProfiles(credential(key)).slice(0,20)){
      if(approved.some(a=>a.profile===p.profile))continue;
      try{const actual=await verify(actor,{...p,key});if(JSON.stringify(actual)===JSON.stringify(expected))approved.push(publicProfile(p));}catch{}
    }
    return approved;
  }
  function expire(){for(const [id,a] of authorizations)if(a.expires<=Date.now()){a.control?.cancel();authorizations.delete(id);}run(db,"UPDATE minutes_authorizations SET status='expired',error_message='授权已过期，请重新发起',finished_at=? WHERE expires_at<=? AND status IN('starting','awaiting','verifying','pending_confirmation')",now(),now());}
  async function launchAuthorization(actor,id){
    const state=authorizations.get(id);
    try{
      let candidate;
      if(state.resume)candidate=await readSavedIdentity(credential(state.key),state.profile);
      else{
        state.control=await beginDeviceFlow({credentialDir:credential(state.key),onPrompt:p=>{if(state.cancelled)return;const url=safeAuthorizationUrl(p.url);assert(url,'钉钉授权链接无效',502);state.prompt={url,code:p.code};run(db,"UPDATE minutes_authorizations SET status='awaiting' WHERE id=? AND status IN('starting','verifying','awaiting')",id);},onVerifying:()=>{if(!state.cancelled)run(db,"UPDATE minutes_authorizations SET status='verifying' WHERE id=? AND status IN('starting','awaiting')",id);}});
        if(state.cancelled)state.control.cancel();candidate=await state.control.completion;
      }
      assert(!state.cancelled&&state.expires>Date.now(),'授权已取消或过期',409);
      const expected=await verify(actor,{...candidate,key:state.key},{accountMode:state.accountMode,identity:state.identity});
      const approved=state.accountMode==='separate_account'?[]:await verifiedProfiles(actor,candidate,state.key,expected);
      const c=clientFactory({...candidate,credentialDir:credential(state.key)});await c.list({from:state.started,to:now(),cursor:null});
      transaction(db,()=>{const latest=binding(actor);assert(JSON.stringify(latest)===JSON.stringify(expected),'成员身份已变化，请重新授权',409);const a=one(db,'SELECT status FROM minutes_authorizations WHERE id=?',id);assert(a&&['starting','awaiting','verifying'].includes(a.status),'授权已结束',409);const safe={...publicProfile(candidate),accountMode:state.accountMode,crmIdentity:expected};run(db,"UPDATE minutes_authorizations SET status='pending_confirmation',candidate=?,verified_profiles=? WHERE id=?",JSON.stringify(safe),JSON.stringify(approved),id);audit(actor,'听记授权身份核验',id,{account_mode:state.accountMode});});
    }catch(e){run(db,"UPDATE minutes_authorizations SET status='failed',error_message=?,finished_at=? WHERE id=? AND status IN('starting','awaiting','verifying')",e.status?e.message:'听记授权未完成，请重新发起',now(),id);}
    finally{clearTimeout(state.timer);state.control=null;}
  }
  async function executeSync(actor,id,{authorize=()=>current(actor),automatic=false,history=false,range=null,resume=null,runId=randomUUID()}={}){
    assert(!automatic||deployment==='production','本地禁止运行听记自动采集',403);assert(enabled,'听记连接器尚未配置，请联系项目负责人',503);authorize();const s=source(actor,id,{connected:true});assert(!syncing.has(id),'此账号正在采集，请稍后刷新',409);syncing.add(id);
    const fullHistory=automatic&&one(db,"SELECT 1 FROM minutes_sync_runs WHERE source_id=? AND from_time='1970-01-01T00:00:00.000Z' AND status IN('success','partial') LIMIT 1",id);
    const incrementalSource=fullHistory?{...s,collect_from:'1970-01-01T00:00:00.000Z'}:s;
    const from=resume?.from_time||range?.from||(history?'1970-01-01T00:00:00.000Z':minutesIncrementalFrom(incrementalSource,Date.now(),{automatic})),to=resume?.to_time||range?.to||now();
    try{
      if(resume?.id===runId)run(db,"UPDATE minutes_sync_runs SET status='running',error_message='',finished_at=NULL WHERE id=?",runId);
      else run(db,"INSERT INTO minutes_sync_runs(id,source_id,status,from_time,to_time,created_at,mode,pages,fetched,cursor) VALUES(?,?,'running',?,?,?,?,?,?,?)",runId,id,from,to,now(),history?'history':'incremental',resume?.pages||0,resume?.fetched||0,resume?.cursor||null);
      const c=client(s);await c.verify();let cursor=resume?.cursor||null;const seen=new Set();let count=resume?.fetched||0,partial=!!(resume?.pages&&one(db,"SELECT 1 FROM minutes_records r LEFT JOIN minutes_artifacts a ON a.record_id=r.id WHERE r.source_id=? AND (r.media_state='failed' OR a.state NOT IN('ready','empty')) LIMIT 1",id));
      for(let page=0;;page++){
        assert(page<100&&!seen.has(cursor),history?'历史听记本轮分页尚未读完，请继续读取；已保存页面会保留':'听记分页未完整返回，请稍后重试',502);seen.add(cursor);authorize();source(actor,id,{connected:true});
        const result=await c.list({from:history&&!range?null:from,to,cursor});assert(Array.isArray(result.items)&&(result.next===null||typeof result.next==='string'&&result.next),'听记分页返回不完整',502);
        let tags=null;if(c.tagEvidence)try{tags=await c.tagEvidence(result.items.map(r=>r.uuid));}catch{}
        const records=[];
        for(const raw of result.items){
          assert(typeof raw.uuid==='string'&&/^[-a-zA-Z0-9_]{1,240}$/.test(raw.uuid)&&typeof raw.title==='string'&&Number.isSafeInteger(raw.startTime)&&raw.startTime>0&&Number.isSafeInteger(raw.durationMicros)&&raw.durationMicros>=0,'听记记录字段不完整',502);
          const start=new Date(raw.startTime).toISOString();if((!history&&!automatic&&start<s.collect_from)||start<from||start>=to)continue;
          let media;try{media=await c.audio(raw.uuid);assert(['available','unavailable','unsupported'].includes(media.state),'录音状态无效',502);if(media.state==='available')assert(safeMinutesAudio(media.url),'录音域名未经核验',502);}catch{media={state:'failed',reason:'录音读取未完成'};}
          const artifacts=normalizeArtifacts(await c.artifacts(raw.uuid));if(media.state==='failed'||artifactKinds.some(k=>!['ready','empty'].includes(artifacts[k]?.state)))partial=true;
          records.push({raw,start,media,artifacts});
        }
        transaction(db,()=>{authorize();const latest=source(actor,id,{connected:true});assert(latest.credential_key===s.credential_key,'听记账号连接已变化',409);
          for(const {raw,start,media,artifacts} of records){run(db,`INSERT INTO minutes_records(source_id,external_id,title,start_time,duration_ms,media_state,media_reason,synced_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,start_time=excluded.start_time,duration_ms=excluded.duration_ms,media_state=excluded.media_state,media_reason=excluded.media_reason,synced_at=excluded.synced_at`,id,raw.uuid,raw.title.slice(0,500),start,Math.floor(raw.durationMicros/1000),media.state,media.reason||'',now());const saved=one(db,'SELECT id FROM minutes_records WHERE source_id=? AND external_id=?',id,raw.uuid);saveArtifacts(saved.id,artifacts);followup(saved.id);
            const old=one(db,"SELECT content FROM minutes_artifacts WHERE record_id=? AND kind='recognition'",saved.id);let previous={};try{previous=JSON.parse(old?.content||'{}');}catch{}
            const recognized=recognizeMinutes({tags:tags?.[raw.uuid]||[],verified:!!tags,recording:media.state==='available'||previous.recording_evidence==='present',member:one(db,'SELECT * FROM users WHERE id=?',s.member_id),config:activityTags});
            run(db,"INSERT INTO minutes_artifacts(record_id,kind,state,content,reason,checked_at) VALUES(?,'recognition','ready',?,?,?) ON CONFLICT(record_id,kind) DO UPDATE SET content=excluded.content,reason=excluded.reason,checked_at=excluded.checked_at",saved.id,JSON.stringify(recognized),recognized.reason,now());
          }
          count+=records.length;run(db,'UPDATE minutes_sync_runs SET pages=pages+1,fetched=?,cursor=? WHERE id=?',count,result.next,runId);
        });
        if(result.next===null)break;cursor=result.next;
      }
      if(automatic){
        // A delayed summary may be older than the reconciliation window (or
        // came from an explicit historical import). Retry a bounded, rotating
        // batch without re-importing history or rewriting manual associations.
        const started=one(db,'SELECT created_at FROM minutes_sync_runs WHERE id=?',runId).created_at;
        const pending=all(db,"SELECT r.* FROM minutes_records r WHERE r.source_id=? AND r.synced_at<? AND (r.media_state='failed' OR (SELECT COUNT(*) FROM minutes_artifacts a WHERE a.record_id=r.id)<4 OR EXISTS(SELECT 1 FROM minutes_artifacts a WHERE a.record_id=r.id AND a.state NOT IN('ready','empty'))) ORDER BY r.synced_at,r.id LIMIT 5",id,started);
        for(const r of pending){
          authorize();assert(source(actor,id,{connected:true}).credential_key===s.credential_key,'听记账号连接已变化',409);
          let media;try{media=await c.audio(r.external_id);assert(['available','unavailable','unsupported'].includes(media.state),'录音状态无效',502);if(media.state==='available')assert(safeMinutesAudio(media.url),'录音域名未经核验',502);}catch{media={state:'failed',reason:'录音读取未完成'};}
          const artifacts=normalizeArtifacts(await c.artifacts(r.external_id));if(media.state==='failed'||artifactKinds.some(k=>!['ready','empty'].includes(artifacts[k]?.state)))partial=true;
          transaction(db,()=>{authorize();assert(source(actor,id,{connected:true}).credential_key===s.credential_key,'听记账号连接已变化',409);run(db,'UPDATE minutes_records SET media_state=?,media_reason=?,synced_at=? WHERE id=?',media.state,media.reason||'',now(),r.id);saveArtifacts(r.id,artifacts);followup(r.id);});
        }
      }
      transaction(db,()=>{authorize();const latest=source(actor,id,{connected:true});if(history&&!automatic)run(db,'UPDATE minutes_sources SET last_synced_at=? WHERE id=?',now(),id);else run(db,'UPDATE minutes_sources SET synced_until=?,last_synced_at=? WHERE id=?',latest.synced_until&&latest.synced_until>to?latest.synced_until:to,now(),id);run(db,'UPDATE minutes_sync_runs SET status=?,finished_at=? WHERE id=?',partial?'partial':'success',now(),runId);audit(automatic?null:actor,history?'听记历史接口采集':'听记接口采集',id,{run_id:runId,fetched:count,status:partial?'partial':'success'});});
      return {id:runId,fetched:count,status:partial?'partial':'success',message:partial?'采集完成，部分正文或录音仍待读取':history?'历史听记读取完成':'新听记采集完成'};
    }catch(e){run(db,"UPDATE minutes_sync_runs SET status='failed',error_message=?,finished_at=? WHERE id=?",e.status?e.message:'听记接口采集未完成，已保存页面保留',now(),runId);throw e;}finally{syncing.delete(id);}
  }
  function sync(...args){const task=executeSync(...args).finally(()=>syncTasks.delete(task));syncTasks.add(task);return task;}
  function startHistory(actor,id,{authorize=()=>current(actor)}={}){
    assert(enabled,'听记连接器尚未配置，请联系项目负责人',503);authorize();source(actor,id,{connected:true});assert(!syncing.has(id),'此账号正在采集，请稍后刷新',409);
    const latest=one(db,"SELECT * FROM minutes_sync_runs WHERE source_id=? AND mode='history' ORDER BY rowid DESC LIMIT 1",id),resume=latest?.status==='failed'?latest:null,runId=resume?.id||randomUUID();
    // Return immediately; historical audio and transcripts can take minutes.
    // Each committed page stores its next cursor so a failed job can resume.
    const task=sync(actor,id,{history:true,resume,runId,authorize});void task.catch(()=>{});
    assert(one(db,"SELECT id FROM minutes_sync_runs WHERE id=? AND status='running'",runId),'历史听记任务未能启动，请稍后重试',503);
    return {id:runId,status:'running',message:resume?'正在继续读取历史听记，已保存记录保留':'正在读取历史听记，可在当前页查看进度'};
  }
  function startRange(actor,id,body,{authorize=()=>current(actor)}={}){
    assert(Object.keys(body).every(k=>['from','to'].includes(k)),'日期同步只接受起止日期');
    const range=minutesDateRange(body.from,body.to,{required:true});
    if(range.full)return startHistory(actor,id,{authorize});
    assert(enabled,'听记连接器尚未配置，请联系项目负责人',503);authorize();source(actor,id,{connected:true});assert(!syncing.has(id),'此账号正在采集，请稍后刷新',409);
    const latest=one(db,"SELECT * FROM minutes_sync_runs WHERE source_id=? AND mode='history' AND from_time=? AND to_time=? ORDER BY rowid DESC LIMIT 1",id,range.from,range.to),resume=latest?.status==='failed'?latest:null,runId=resume?.id||randomUUID();
    void sync(actor,id,{history:true,range,resume,runId,authorize}).catch(()=>{});
    return {id:runId,status:'running',message:resume?'正在从保存的分页继续同步':'所选日期的听记同步已开始'};
  }
  function list(actor,params={}){
    const a=current(actor),where=[],values=[];const context={customer_id:params.customer_id?Number(params.customer_id):null,opportunity_id:params.opportunity_id?Number(params.opportunity_id):null};
    if(context.customer_id||context.opportunity_id){const t=target(a,context.customer_id,context.opportunity_id);where.push('r.customer_id=?');values.push(t.customer_id);if(t.opportunity_id){where.push('r.opportunity_id=?');values.push(t.opportunity_id);}}
    if(a.role!=='admin'){where.push('s.member_id=?');values.push(a.id);}
    if(params.source_id){source(a,params.source_id);where.push('r.source_id=?');values.push(params.source_id);}
    if(params.q){where.push('r.title LIKE ?');values.push('%'+String(params.q).slice(0,200)+'%');}
    const range=minutesDateRange(params.from,params.to);if(range){where.push('r.start_time>=? AND r.start_time<?');values.push(range.from,range.to);}
    const clause=where.length?' WHERE '+where.join(' AND '):'',page=Math.max(1,Math.min(100000,Number(params.page)||1));
    const count=one(db,'SELECT COUNT(*) n FROM minutes_records r JOIN minutes_sources s ON s.id=r.source_id'+clause,...values).n;
    const pageSize=[10,30,50].includes(Number(params.page_size))?Number(params.page_size):10;
    const totals=one(db,`SELECT COUNT(*) total,COALESCE(SUM(r.media_state='available'),0) available,COALESCE(SUM(r.media_state='unsupported'),0) unsupported,COALESCE(SUM(r.customer_id IS NOT NULL),0) linked,COALESCE(SUM(EXISTS(SELECT 1 FROM minutes_artifacts a WHERE a.record_id=r.id AND a.kind='recognition' AND json_extract(a.content,'$.type') IN('visit','demo'))),0) recognized FROM minutes_records r JOIN minutes_sources s ON s.id=r.source_id ${clause}`,...values);
    const runWhere=[],runValues=[];if(a.role!=='admin'){runWhere.push('s.member_id=?');runValues.push(a.id);}if(params.source_id){runWhere.push('s.id=?');runValues.push(params.source_id);}
    const runs=all(db,`SELECT r.id,r.source_id,r.mode,r.status,r.from_time,r.to_time,r.pages,r.fetched,r.error_message,r.created_at,r.finished_at,s.account_name FROM minutes_sync_runs r JOIN minutes_sources s ON s.id=r.source_id ${runWhere.length?'WHERE '+runWhere.join(' AND '):''} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 20`,...runValues);
    return {records:all(db,`SELECT r.*,s.account_name,s.corp_name,s.member_id,c.name customer_name,o.name opportunity_name,(SELECT state FROM minutes_artifacts a WHERE a.record_id=r.id AND a.kind='summary') summary_state,(SELECT json_extract(content,'$.type') FROM minutes_artifacts a WHERE a.record_id=r.id AND a.kind='recognition') recognized_type,(SELECT reason FROM minutes_artifacts a WHERE a.record_id=r.id AND a.kind='recognition') recognition_reason FROM minutes_records r JOIN minutes_sources s ON s.id=r.source_id LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN opportunities o ON o.id=r.opportunity_id ${clause} ORDER BY r.start_time DESC,r.id DESC LIMIT ? OFFSET ?`,...values,pageSize,(page-1)*pageSize),count,page,page_size:pageSize,totals,runs};
  }
  function detail(actor,id,context){const r=record(actor,id,context);return {...r,artifacts:Object.fromEntries(all(db,'SELECT * FROM minutes_artifacts WHERE record_id=?',r.id).map(a=>[a.kind,a])),can_manage:current(actor).role==='admin'||one(db,'SELECT member_id FROM minutes_sources WHERE id=?',r.source_id)?.member_id===actor.id};}
  async function prepare(actor,action,id,body,authorize){
    assert(enabled,'听记连接器尚未配置，请联系项目负责人',503);authorize();
    if(action==='personal-import'){
      assert(Object.keys(body).length===1&&/^[a-f0-9-]{36}$/.test(body.authorization_key),'请选择本次已完成的个人授权');
      const identity=binding(actor),key=body.authorization_key,stored=await readPersonalTokens(credential(key));
      assert(stored.provider==='personal_mcp'&&stored.memberId===actor.id&&stored.authorizationKey===key&&stored.scope==='qwennote:read','个人听记授权不属于当前成员',403);
      const c=personal(key,actor.id);await c.verify();const result=await c.list({from:null,to:now(),cursor:null});authorize();
      return {key,identity,accountName:String(stored.label||'本人个人听记').slice(0,120),preview:result.items.slice(0,3).map(row=>({title:row.title.slice(0,500),created_at:new Date(row.startTime).toISOString()}))};
    }
    if(action==='transcript'){
      assert(Object.keys(body).every(k=>['customer_id','opportunity_id'].includes(k)),'逐字稿只接受当前查看范围');
      const r=record(actor,Number(id),body),s=recordSource(actor,r),c=client(s);await c.verify();authorize();
      const artifact=await c.transcript(r.external_id);authorize();return {artifacts:normalizeArtifacts({transcript:artifact}),sourceKey:s.credential_key,sourceCorp:s.corp_id,sourceUser:s.user_id};
    }
    if(action==='quality'){
      assert(Object.keys(body).every(k=>['customer_id','opportunity_id'].includes(k)),'会议质检只接受当前查看范围');
      const r=record(actor,Number(id),body),s=recordSource(actor,r),values=storedArtifacts(r.id),input=qualityInput(values);
      assert(!qualityRequests.has(r.id),'会议质检正在生成',409);qualityRequests.add(r.id);
      try{
        let artifact=values.quality?.state==='ready'&&values.quality.content?normalizeArtifacts({quality:values.quality}).quality:null;
        if(!artifact){await client(s).verify();authorize();try{artifact=await analyzeQuality(input,qualityComplete);}catch{artifact={state:'failed',content:'',reason:'会议质检生成暂未完成，请稍后重新打开这条听记'};}}
        authorize();return {artifacts:{quality:artifact},inputHash:input.fingerprint,sourceKey:s.credential_key,sourceCorp:s.corp_id,sourceUser:s.user_id};
      }finally{qualityRequests.delete(r.id);}
    }
    if(action==='speaker-insights'){
      assert(Object.keys(body).every(k=>['generate','customer_id','opportunity_id'].includes(k))&&typeof body.generate==='boolean','请明确选择读取或由钉钉生成');
      const r=record(actor,Number(id),body),s=recordSource(actor,r),c=client(s);
      assert(typeof c.speakerInsights==='function','当前听记连接器不支持发言人总结',503);
      assert(!speakerRequests.has(r.id),'这条听记正在读取发言人总结，请稍后重试',409);speakerRequests.add(r.id);
      try{
        await c.verify();authorize();
        let artifact=await c.speakerInsights(r.external_id);
        const pending=one(db,"SELECT state FROM minutes_artifacts WHERE record_id=? AND kind='speaker_insights'",r.id)?.state==='pending';
        if(artifact.state==='unavailable'&&pending)artifact=speakerPending();
        else if(body.generate&&artifact.state==='unavailable'){
          authorize();const fresh=recordSource(actor,record(actor,r.id,body));assert(fresh.credential_key===s.credential_key&&fresh.corp_id===s.corp_id&&fresh.user_id===s.user_id,'听记连接已变化',409);
          artifact=await c.speakerInsights(r.external_id,{generate:true});
        }
        authorize();return {artifacts:normalizeArtifacts({speaker_insights:artifact}),sourceKey:s.credential_key,sourceCorp:s.corp_id,sourceUser:s.user_id};
      }finally{speakerRequests.delete(r.id);}
    }
    if(action==='confirm'){
      const a=one(db,'SELECT * FROM minutes_authorizations WHERE id=? AND member_id=?',id,actor.id);assert(a?.status==='pending_confirmation'&&a.expires_at>now()&&body.accepted===true,'请完成本人授权并核对账号后确认',409);
      assert(Object.keys(body).length===1,'确认连接只接受归属确认');const context=authorizationContext(a);confirmOwner(actor,context.accountMode);
      const identity=await verify(actor,{...context.candidate,key:a.credential_key||id},context);authorize();return {identity,candidate:a.candidate};
    }
    if(action==='refresh'){const r=record(actor,Number(id),body),s=recordSource(actor,r);const c=client(s);await c.verify();const artifacts=normalizeArtifacts(await c.artifacts(r.external_id));authorize();return {artifacts,sourceKey:s.credential_key};}
    return null;
  }
  function mutate(actor,action,id,b,prepared){
    current(actor);expire();
    if(action==='personal-import'){
      assert(prepared?.key===b.authorization_key&&JSON.stringify(binding(actor))===JSON.stringify(prepared.identity),'当前成员或授权已变化，请重新核验',409);
      const existing=one(db,"SELECT id,status,source_id FROM minutes_authorizations WHERE member_id=? AND credential_key=? AND status IN('pending_confirmation','connected') ORDER BY created_at DESC LIMIT 1",actor.id,prepared.key);
      if(existing)return {id:existing.id,source_id:existing.source_id,message:existing.status==='connected'?'此个人授权已连接':'个人授权已核验，请核对归属成员后确认'};
      assert(!one(db,"SELECT id FROM minutes_authorizations WHERE status IN('starting','awaiting','verifying','pending_confirmation')"),'已有账号正在授权，请先完成或取消',409);
      const authId=randomUUID(),candidate={provider:'personal_mcp',grantKey:prepared.key,accountName:prepared.accountName,corpName:'个人听记',accountMode:'separate_account',crmIdentity:prepared.identity,preview:prepared.preview};
      run(db,"INSERT INTO minutes_authorizations(id,member_id,status,candidate,verified_profiles,credential_key,expires_at,created_at) VALUES(?,?,'pending_confirmation',?,'[]',?,?,?)",authId,actor.id,JSON.stringify(candidate),prepared.key,new Date(Date.now()+2*3600000).toISOString(),now());
      audit(actor,'核验个人听记只读授权',authId,{provider:'personal_mcp',account_mode:'separate_account'});return {id:authId,message:'个人听记读取已核验，等待确认当前成员归属'};
    }
    if(action==='transcript'){
      const r=record(actor,Number(id),b),s=recordSource(actor,r);assert(s.credential_key===prepared?.sourceKey&&s.corp_id===prepared.sourceCorp&&s.user_id===prepared.sourceUser,'听记连接已变化',409);
      saveArtifacts(r.id,prepared.artifacts);audit(actor,'自动读取逐字稿',r.id,{state:prepared.artifacts.transcript.state});return {id:r.id,state:prepared.artifacts.transcript.state};
    }
    if(action==='start'){
      assert(enabled,'听记连接器尚未配置，请联系项目负责人',503);const identity=binding(actor);assert(Object.keys(b).every(k=>k==='account_mode'),'授权不接受指定其他成员');const accountMode=b.account_mode??'same_account';assert(['same_account','separate_account'].includes(accountMode),'请选择有效的听记账号类型');assert(!one(db,"SELECT id FROM minutes_authorizations WHERE status IN('starting','awaiting','verifying','pending_confirmation')"),'已有账号正在授权，请先完成或取消',409);
      const authId=randomUUID(),started=now(),expires=Date.now()+600000;run(db,"INSERT INTO minutes_authorizations(id,member_id,status,expires_at,created_at,credential_key,candidate) VALUES(?,?,'starting',?,?,?,?)",authId,actor.id,new Date(expires).toISOString(),started,authId,JSON.stringify({accountMode,crmIdentity:identity}));audit(actor,'发起听记授权',authId,{account_mode:accountMode});
      return {id:authId,message:'请由当前成员在钉钉完成本人授权',afterCommit:()=>{const state={started,expires,key:authId,accountMode,identity,cancelled:false,prompt:null,control:null};authorizations.set(authId,state);state.timer=setTimeout(()=>{state.cancelled=true;state.control?.cancel();expire();},600000);state.timer.unref?.();state.task=launchAuthorization(actor,authId);}};
    }
    if(action==='retry'){
      assert(enabled,'听记连接器尚未配置',503);binding(actor);assert(Object.keys(b).every(k=>k==='profile'),'重新核验仅接受已授权组织');
      const old=one(db,'SELECT * FROM minutes_authorizations WHERE id=? AND member_id=?',id,actor.id);assert(old&&!['starting','awaiting','verifying'].includes(old.status),'授权任务尚未完成',409);
      const context=authorizationContext(old),accountMode=context.accountMode,identity=context.identity||binding(actor);assert(JSON.stringify(binding(actor))===JSON.stringify(identity),'成员身份已变化，请重新授权',409);
      const key=old.credential_key||old.id,profiles=readSavedProfiles(credential(key)).filter(p=>accountMode!=='separate_account'||p.profile===context.candidate?.profile),selected=b.profile?profiles.find(p=>p.profile===b.profile):profiles.find(p=>p.current)||profiles[0];assert(selected,'没有可重新核验的已授权组织，请重新连接钉钉',409);
      assert(!one(db,"SELECT id FROM minutes_authorizations WHERE id!=? AND status IN('starting','awaiting','verifying','pending_confirmation')",id),'已有账号正在授权，请先完成或取消',409);
      if(old.status==='pending_confirmation')run(db,"UPDATE minutes_authorizations SET status='cancelled',finished_at=? WHERE id=?",now(),id);
      const authId=randomUUID(),started=now(),expires=Date.now()+600000;run(db,"INSERT INTO minutes_authorizations(id,member_id,status,expires_at,created_at,credential_key,candidate) VALUES(?,?,'starting',?,?,?,?)",authId,actor.id,new Date(expires).toISOString(),started,key,JSON.stringify({accountMode,crmIdentity:identity}));audit(actor,'重新核验听记组织',authId,{previous_authorization:id,account_mode:accountMode});
      return {id:authId,message:'正在核验所选组织的听记账号',afterCommit:()=>{const state={started,expires,key,resume:true,profile:selected.profile,accountMode,identity,cancelled:false,prompt:null,control:null};authorizations.set(authId,state);state.timer=setTimeout(()=>{state.cancelled=true;expire();},600000);state.timer.unref?.();state.task=launchAuthorization(actor,authId);}};
    }
    if(action==='cancel'){const a=one(db,'SELECT * FROM minutes_authorizations WHERE id=? AND member_id=?',id,actor.id);assert(a,'授权任务不存在',404);assert(a.status!=='connected','已确认的账号请使用停止连接',409);run(db,"UPDATE minutes_authorizations SET status='cancelled',finished_at=? WHERE id=?",now(),id);audit(actor,'取消听记授权',id);return {message:'授权已取消',afterCommit:()=>{const s=authorizations.get(id);if(s){s.cancelled=true;s.control?.cancel();clearTimeout(s.timer);authorizations.delete(id);}}};}
    if(action==='confirm'){
      const personalAuthorization=one(db,'SELECT * FROM minutes_authorizations WHERE id=? AND member_id=?',id,actor.id),personalContext=authorizationContext(personalAuthorization);
      if(personalContext.candidate?.provider==='personal_mcp'){
        assert(Object.keys(b).length===1&&b.accepted===true&&personalAuthorization.status==='pending_confirmation'&&personalAuthorization.expires_at>now(),'请核对实际个人账号后确认连接',409);confirmOwner(actor,'separate_account');
        assert(personalAuthorization.candidate===prepared?.candidate&&JSON.stringify(binding(actor))===JSON.stringify(prepared?.identity),'成员身份或个人授权已变化，请重新核验',409);
        const c=personalContext.candidate,key=personalAuthorization.credential_key,existing=one(db,"SELECT * FROM minutes_sources WHERE provider='personal_mcp' AND credential_key=?",key);assert(!existing||existing.member_id===actor.id,'此个人授权已关联其他成员',409);
        const sourceId=existing?.id||randomUUID();
        if(existing)run(db,"UPDATE minutes_sources SET connection_state='connected' WHERE id=?",sourceId);
        else run(db,"INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at,provider) VALUES(?,?,NULL,NULL,?,'个人听记',?,'connected',?,?,'personal_mcp')",sourceId,actor.id,c.accountName,key,now(),now());
        run(db,"UPDATE minutes_authorizations SET status='connected',source_id=?,finished_at=? WHERE id=?",sourceId,now(),id);audit(actor,'确认个人听记关联',sourceId,{provider:'personal_mcp',confirmed_by_member:!actor._operator_id,confirmed_by_developer:!!actor._operator_id,acting_as_user_id:actor.id});return {source_id:sourceId,message:'个人听记已关联，正在准备读取已有听记'};
      }
      assert(Object.keys(b).length===1&&b.accepted===true,'请核对实际账号后确认连接');const a=one(db,'SELECT * FROM minutes_authorizations WHERE id=? AND member_id=?',id,actor.id);assert(a?.status==='pending_confirmation'&&a.expires_at>now(),'授权已结束或过期',409);const context=authorizationContext(a);confirmOwner(actor,context.accountMode);assert(a.candidate===prepared?.candidate&&JSON.stringify(binding(actor))===JSON.stringify(prepared?.identity),'企业身份或听记账号已变化，请重新授权',409);const c=context.candidate,old=one(db,'SELECT * FROM minutes_sources WHERE corp_id=? AND user_id=?',c.corpId,c.userId);assert(!old||old.member_id===actor.id,'此听记账号已属于其他成员',409);const own=one(db,'SELECT * FROM minutes_sources WHERE member_id=? AND corp_id=?',actor.id,c.corpId);assert(!own||own.user_id===c.userId,'当前成员已连接该组织的另一个账号，请先核对既有连接',409);const existing=old||own,sourceId=existing?.id||randomUUID(),key=a.credential_key||id;
      if(existing)run(db,"UPDATE minutes_sources SET credential_key=?,user_id=?,account_name=?,corp_name=?,connection_state='connected' WHERE id=?",key,c.userId,c.accountName,c.corpName,sourceId);
      else run(db,"INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at) VALUES(?,?,?,?,?,?,?,'connected',?,?)",sourceId,actor.id,c.corpId,c.userId,c.accountName,c.corpName,key,now(),now());
      run(db,"UPDATE minutes_authorizations SET status='connected',source_id=?,finished_at=? WHERE id=?",sourceId,now(),id);audit(actor,'确认听记账号连接',sourceId,{collects_new_only:true,account_mode:context.accountMode,profile:c.profile,confirmed_by_member:!actor._operator_id});authorizations.delete(id);return {source_id:sourceId,message:'已连接，从现在起采集新听记'};
    }
    if(action==='disconnect'){source(actor,id,{own:true});assert(!syncing.has(id),'请等待当前采集结束',409);run(db,"UPDATE minutes_sources SET connection_state='disconnected' WHERE id=?",id);audit(actor,'停止听记连接',id,{history_retained:true});return {message:'已停止连接，已有听记保留'};}
    if(action==='association'){
      assert(Object.keys(b).every(k=>['revision','customer_id','opportunity_id','reason'].includes(k))&&Number.isSafeInteger(b.revision)&&typeof b.reason==='string'&&b.reason.trim()&&b.reason.length<=500,'请提供当前版本、关联对象和说明');
      const r=record(actor,Number(id)),s=source(actor,r.source_id);assert(actor.role==='admin'||s.member_id===actor.id,'仅账号本人或管理员可维护关联',403);assert(r.revision===b.revision,'听记关联已更新，请刷新后重试',409);
      if(actor.role!=='admin'&&(r.customer_id||r.opportunity_id))target(actor,r.customer_id,r.opportunity_id);
      const t=target(actor,b.customer_id,b.opportunity_id),previous=one(db,'SELECT id,summary,opportunity_id FROM activities WHERE minutes_record_id=?',r.id);run(db,'UPDATE minutes_records SET customer_id=?,opportunity_id=?,revision=revision+1 WHERE id=?',t.customer_id,t.opportunity_id,r.id);followup(r.id);audit(actor,'维护听记业务关联',r.id,{before:{customer_id:r.customer_id,opportunity_id:r.opportunity_id,automatic_summary:previous||null},after:t,reason:b.reason});return {id:r.id,message:t.customer_id?'听记已关联业务档案':'听记关联已取消'};
    }
    if(action==='quality'){
      const r=record(actor,Number(id),b),s=recordSource(actor,r);assert(s.credential_key===prepared?.sourceKey&&s.corp_id===prepared.sourceCorp&&s.user_id===prepared.sourceUser,'听记连接已变化',409);
      assert(qualityInput(storedArtifacts(r.id)).fingerprint===prepared.inputHash,'听记正文已更新，正在重新读取',409);
      saveArtifacts(r.id,prepared.artifacts);audit(actor,'自动生成会议质检',r.id,{state:prepared.artifacts.quality.state,source:'CRM AI'});
      return {id:r.id,state:prepared.artifacts.quality.state};
    }
    if(action==='speaker-insights'){
      const r=record(actor,Number(id),b),s=recordSource(actor,r);assert(s.credential_key===prepared?.sourceKey&&s.corp_id===prepared.sourceCorp&&s.user_id===prepared.sourceUser,'听记连接已变化',409);
      saveArtifacts(r.id,prepared.artifacts);const artifact=prepared.artifacts.speaker_insights;
      audit(actor,'读取钉钉发言人总结',r.id,{requested_generation:b.generate,state:artifact.state});
      return {id:r.id,state:artifact.state,message:artifact.state==='ready'?'已读取钉钉发言人总结':artifact.reason};
    }
    if(action==='refresh'){const r=record(actor,Number(id),b),s=recordSource(actor,r);assert(s.credential_key===prepared?.sourceKey,'听记连接已变化',409);saveArtifacts(r.id,prepared.artifacts);followup(r.id);audit(actor,'重新读取听记正文',r.id);return {id:r.id,message:'已读取源接口返回的正文状态'};}
    assert(false,'听记操作不存在',404);
  }
  function summary(actor){
    const a=current(actor);expire();const sources=all(db,'SELECT '+safeSources+' FROM minutes_sources'+(a.role==='admin'?'':' WHERE member_id=?')+' ORDER BY created_at',...(a.role==='admin'?[]:[a.id])).map(s=>({...s,schedule:sourceSchedule(s),history:one(db,"SELECT id,status,pages,fetched,error_message,created_at,finished_at FROM minutes_sync_runs WHERE source_id=? AND mode='history' ORDER BY rowid DESC LIMIT 1",s.id)||null}));
    const row=one(db,'SELECT * FROM minutes_authorizations WHERE member_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',a.id),context=authorizationContext(row),c=context.candidate;
    return {enabled,automatic:deployment==='production',sources,authorization:row?{id:row.id,status:row.status,account_mode:context.accountMode,can_confirm:canConfirmOwner(actor,context.accountMode),candidate:c?{accountName:c.accountName,corpName:c.corpName,profile:c.profile||null,provider:c.provider||'dws',preview:c.provider==='personal_mcp'?c.preview||[]:[]}:null,profiles:JSON.parse(row.verified_profiles),error:publicAuthorizationError(row.error_message),expires_at:row.expires_at,prompt:row.status==='awaiting'?authorizations.get(row.id)?.prompt||null:null}:null,runs:all(db,'SELECT r.id,r.source_id,r.mode,r.status,r.from_time,r.to_time,r.pages,r.fetched,r.error_message,r.created_at,r.finished_at FROM minutes_sync_runs r JOIN minutes_sources s ON s.id=r.source_id'+(a.role==='admin'?'':' WHERE s.member_id=?')+' ORDER BY r.created_at DESC,r.rowid DESC LIMIT 10',...(a.role==='admin'?[]:[a.id]))};
  }
  async function audio(actor,id,context,range,authorize){const r=record(actor,id,context),s=recordSource(actor,r),c=client(s);await c.verify();const a=await c.audio(r.external_id);authorize();record(actor,id,context);assert(recordSource(actor,r).credential_key===s.credential_key,'听记连接已变化',409);assert(a.state==='available','源平台暂未提供可播放录音',409);const response=await fetchMinutesAudio(a.url,{range,fetchImpl});try{authorize();record(actor,id,context);assert(recordSource(actor,r).credential_key===s.credential_key,'听记连接已变化',409);}catch(e){await response.body?.cancel();throw e;}return response;}
  function scheduledSync(){
    if(deployment!=='production'||!enabled||scheduleClosing)return Promise.resolve({status:'skipped',sources:[]});
    if(scheduleTask)return scheduleTask;
    scheduleTask=(async()=>{
      const results=[];
      for(const s of all(db,"SELECT s.* FROM minutes_sources s JOIN users u ON u.id=s.member_id WHERE s.connection_state='connected' AND u.active=1 AND u.business_member=1 AND u.developer_admin=0 ORDER BY s.created_at,s.id")){
        if(scheduleClosing)break;
        if(syncing.has(s.id)||Date.parse(s.collect_from)>=Date.now()||!sourceSchedule(s).due)continue;
        const actor=one(db,'SELECT * FROM users WHERE id=?',s.member_id);
        // Resume the failed fixed window and cursor before advancing to a new
        // window. Successfully committed pages survive outages and restarts.
        const full=!!one(db,"SELECT id FROM minutes_sync_runs WHERE source_id=? AND mode='history' AND from_time='1970-01-01T00:00:00.000Z' AND status IN('success','partial') LIMIT 1",s.id);
        const attempts=all(db,"SELECT * FROM minutes_sync_runs WHERE source_id=? AND "+(full?"mode='incremental'":"mode='history' AND from_time='1970-01-01T00:00:00.000Z'")+" ORDER BY rowid DESC LIMIT 2",s.id),latest=attempts[0];let resume=latest?.status==='failed'?latest:null;
        // Provider cursors can expire during an outage. If the same checkpoint
        // fails twice, reconcile its original window again; upserts preserve
        // committed records and associations without requiring a manual reset.
        if(resume?.cursor&&attempts[1]?.status==='failed'&&attempts[1].cursor===resume.cursor&&attempts[1].from_time===resume.from_time&&attempts[1].to_time===resume.to_time)resume={...resume,cursor:null,pages:0,fetched:0};
        try{const result=await sync(actor,s.id,{automatic:true,history:!full,resume});results.push({source_id:s.id,...result});}
        catch{results.push({source_id:s.id,status:'failed'});}
      }
      return {status:results.some(r=>r.status==='failed')?'failed':results.some(r=>r.status==='partial')?'partial':'success',sources:results};
    })().finally(()=>{scheduleTask=null;});
    return scheduleTask;
  }
  function stopScheduler(){scheduleClosing=true;clearInterval(scheduleTimer);scheduleTimer=null;}
  function startScheduler(){
    if(deployment!=='production'||!enabled||scheduleClosing)return ()=>{};
    if(scheduleTimer)return stopScheduler;
    void scheduledSync().catch(()=>{});
    scheduleTimer=setInterval(()=>{void scheduledSync().catch(()=>{});},minutesSchedulerIntervalMs);scheduleTimer.unref?.();
    return stopScheduler;
  }
  function recover(){run(db,"UPDATE minutes_authorizations SET status='failed',error_message='服务重启中断了授权，请重新发起',finished_at=? WHERE status IN('starting','awaiting','verifying')",now());run(db,"UPDATE minutes_sync_runs SET status='failed',error_message='服务重启中断了采集，已保存进度，等待重试',finished_at=? WHERE status='running'",now());}
  return {summary,list,detail,prepare,mutate,sync,startHistory,startRange,audio,recover,startScheduler,scheduledSync,enabled,async shutdown(){stopScheduler();for(const s of authorizations.values()){s.cancelled=true;clearTimeout(s.timer);s.control?.cancel();}await Promise.allSettled([...syncTasks,...(scheduleTask?[scheduleTask]:[]),...[...authorizations.values()].map(s=>s.task)]);authorizations.clear();}};
}
