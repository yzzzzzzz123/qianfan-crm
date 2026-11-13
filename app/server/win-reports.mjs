import {randomUUID} from 'node:crypto';
import {all,one,run,transaction} from './database.mjs';
import {assert,now,code} from './domain.mjs';
import {readWinReportConfig,saveWinReportConfig,winReportTestGroup} from './win-report-config.mjs';
import {createWinReportSender} from './dingtalk-win-report.mjs';

const labels={pending:'待发送',sending:'发送中',sent:'已发送',failed:'发送失败',uncertain:'待核对投放结果',skipped:'当时未开启自动推送'};
export function createWinReports({db,env=process.env,deployment='local',sender=createWinReportSender({env}),logger=console,clock=()=>Date.now(),intervalMs=5000}={}){
  let active=null,stopped=false,timer=null;
  const iso=()=>new Date(clock()).toISOString();
  // A local feature toggle cannot authorize real external delivery.
  function canExecute(){
    if(sender.simulated===true)return true;
    return deployment==='production'&&process.platform!=='win32'&&env.NODE_ENV==='production'&&env.CRM_RUNTIME_ENVIRONMENT==='server'&&/^https:\/\//.test(env.PUBLIC_ORIGIN||'');
  }
  const config=()=>readWinReportConfig(db,env);
  function publicDelivery(d){return {id:d.id,group_key:d.group_key,group_name:d.group_name,status:d.status,status_label:labels[d.status],attempts:d.attempts,error_code:d.error_code,error_message:d.error_message,sent_at:d.sent_at,next_retry_at:d.next_retry_at,can_retry:['failed','uncertain'].includes(d.status),needs_verification:d.status==='uncertain'};}
  function describe(opportunityId){
    const event=one(db,"SELECT * FROM win_report_events WHERE opportunity_id=? AND kind='won'",opportunityId);
    return event?{id:event.id,created_at:event.created_at,snapshot:JSON.parse(event.snapshot),groups:all(db,'SELECT * FROM win_report_deliveries WHERE event_id=? ORDER BY id',event.id).map(publicDelivery)}:null;
  }
  function summary(){
    const c=config();
    return {...c,server_runtime:canExecute(),configured:sender.configured===true,
      tests:[{...winReportTestGroup,conversation_id:c.test_conversation_id},...c.groups].map(g=>({...g,passed:!!one(db,"SELECT 1 FROM win_report_deliveries d JOIN win_report_events e ON e.id=d.event_id WHERE e.kind='test' AND d.status='sent' AND d.group_key=? AND d.conversation_id=? AND d.robot_code=? AND d.template_id=?",g.key,g.conversation_id,c.robot_code,c.template_id)})),
      recent_tests:all(db,"SELECT d.* FROM win_report_deliveries d JOIN win_report_events e ON e.id=d.event_id WHERE e.kind='test' ORDER BY d.id DESC LIMIT 6").map(publicDelivery)};
  }
  function addEvent(eventKey,kind,opportunityId,contractId,snapshot,groups,{skip=false}={}){
    if(one(db,'SELECT id FROM win_report_events WHERE event_key=?',eventKey))return null;
    const at=iso(),c=config();
    const eventId=Number(run(db,'INSERT INTO win_report_events(event_key,kind,opportunity_id,contract_id,snapshot,created_at) VALUES(?,?,?,?,?,?)',eventKey,kind,opportunityId,contractId,JSON.stringify(snapshot),at).lastInsertRowid);
    for(const g of groups)run(db,'INSERT INTO win_report_deliveries(event_id,group_key,group_name,conversation_id,robot_code,template_id,out_track_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',eventId,g.key,g.name,g.conversation_id,c.robot_code,c.template_id,`qf-${kind}-${randomUUID()}`,skip?'skipped':'pending',at,at);
    return eventId;
  }
  function recordWin(opportunity,contract,amount,at=now()){
    const owner=one(db,'SELECT id,name,ding_user_id FROM users WHERE id=?',opportunity.owner_id);
    const customer=one(db,'SELECT name FROM customers WHERE id=?',opportunity.customer_id);
    const snapshot={owner_id:opportunity.owner_id,owner_name:owner?.name||'负责人待核对',ding_user_id:owner?.ding_user_id||null,customer_name:customer?.name||'客户待核对',sales_content:opportunity.name,contract_no:contract.contract_no||code('HT',contract.id,contract.created_at),amount,sign_date:contract.sign_date,won_at:at,test:false};
    const c=config();
    return addEvent(`first-won:${opportunity.id}`,'won',opportunity.id,contract.id,snapshot,c.groups,{skip:!c.enabled});
  }
  function saveConfig(b){return saveWinReportConfig(db,b,{env,canEnable:canExecute()&&sender.configured===true});}
  function testCard(actor,b){
    assert(canExecute(),'本地仅支持模拟测试，真实测试卡片须从服务器投放',409);
    assert(sender.configured===true,'服务器尚未配置钉钉应用凭证',409);
    assert(Object.keys(b).every(k=>['group_key','owner_id'].includes(k)),'测试卡片包含未知字段');
    const c=config(),group=b.group_key==='test'?{...winReportTestGroup,conversation_id:c.test_conversation_id}:c.groups.find(g=>g.key===b.group_key);
    assert(group,'请选择测试群或指定的正式群');
    assert(group.conversation_id&&c.robot_code&&c.template_id,'请先配置目标群、机器人和卡片模板');
    if(group.key!=='test')assert(summary().tests.find(g=>g.key==='test')?.passed,'请先跑通测试群卡片，再验证正式群',409);
    const owner=one(db,'SELECT id,name,ding_user_id,business_member,developer_admin FROM users WHERE id=? AND active=1',Number(b.owner_id||actor.id));
    assert(owner?.ding_user_id&&(owner.id===actor.id||owner.business_member===1&&owner.developer_admin===0),'请选择本人或已有已核验钉钉身份的业务负责人');
    const snapshot={owner_id:owner.id,owner_name:owner.name,ding_user_id:owner.ding_user_id,customer_name:'示例客户（测试）',sales_content:'赢单战报联调示例，不计入业务',contract_no:'TEST',amount:10000,sign_date:iso().slice(0,10),won_at:iso(),test:true};
    return addEvent(`test:${randomUUID()}`,'test',null,null,snapshot,[group]);
  }
  function retry(opportunityId,deliveryId,b){
    assert(canExecute(),'补发只能在正式服务器执行',409);
    assert(config().enabled,'自动推送已关闭，请先核对并开启战报',409);
    const d=one(db,"SELECT d.* FROM win_report_deliveries d JOIN win_report_events e ON e.id=d.event_id WHERE e.kind='won' AND e.opportunity_id=? AND d.id=?",opportunityId,deliveryId);
    assert(d,'本商机的群发送记录不存在',404);
    assert(d.group_key==='wanjin'&&config().groups.some(g=>g.key===d.group_key&&g.conversation_id===d.conversation_id),'该群已不在本次接入范围内',409);
    assert(['failed','uncertain'].includes(d.status),'只有失败或已核对的未送达记录可以补发',409);
    assert(Object.keys(b).every(k=>k==='confirmed_not_delivered'),'补发请求包含未知字段');
    if(d.status==='uncertain')assert(b.confirmed_not_delivered===true,'请先在该群核对卡片确实未送达，再确认补发',409);
    run(db,"UPDATE win_report_deliveries SET status='pending',next_retry_at=NULL,lease_until=NULL,error_code='',error_message='',updated_at=? WHERE id=?",iso(),d.id);
    return d;
  }
  async function drain(){
    let processed=0;
    while(!stopped&&canExecute()&&sender.configured===true){
      const at=iso();
      const d=transaction(db,()=>{
        // An interrupted in-flight request may already have reached DingTalk.
        run(db,"UPDATE win_report_deliveries SET status='uncertain',lease_until=NULL,error_code='INTERRUPTED',error_message='发送时服务中断，请先核对群内投放结果',updated_at=? WHERE status='sending' AND lease_until<=?",at,at);
        const c=config();
        const row=one(db,"SELECT d.*,e.kind,e.snapshot FROM win_report_deliveries d JOIN win_report_events e ON e.id=d.event_id WHERE d.status='pending' AND (d.next_retry_at IS NULL OR d.next_retry_at<=?) AND (e.kind='test' AND (d.group_key='test' OR d.group_key='wanjin') OR e.kind='won' AND ?=1 AND d.group_key='wanjin' AND d.conversation_id=? AND d.robot_code=? AND d.template_id=?) ORDER BY d.id LIMIT 1",at,c.enabled?1:0,c.groups[0].conversation_id,c.robot_code,c.template_id);
        if(!row)return null;
        run(db,"UPDATE win_report_deliveries SET status='sending',attempts=attempts+1,lease_until=?,updated_at=? WHERE id=?",new Date(clock()+120000).toISOString(),at,row.id);
        return {...row,attempts:row.attempts+1};
      });
      if(!d)break;
      try{
        await sender.send(d,JSON.parse(d.snapshot));
        run(db,"UPDATE win_report_deliveries SET status='sent',card_created=1,sent_at=?,updated_at=?,lease_until=NULL,next_retry_at=NULL,error_code='',error_message='' WHERE id=? AND status='sending'",iso(),iso(),d.id);
      }catch(error){
        const uncertain=error.uncertain!==false&&error.retryable!==true;
        const retryable=error.retryable===true&&d.attempts<5;
        const status=uncertain?'uncertain':retryable?'pending':'failed';
        const errorCode=String(error.code||'SEND_FAILED').replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,100);
        // Provider text can contain credentials or business payloads. Store fixed messages only.
        const message=uncertain?'投放结果待确认，请核对该群是否已有卡片':retryable?'发送暂未成功，将稍后重试本群':'发送失败，请核对机器人、群权限和负责人身份后补发';
        run(db,'UPDATE win_report_deliveries SET status=?,card_created=MAX(card_created,?),error_code=?,error_message=?,next_retry_at=?,lease_until=NULL,updated_at=? WHERE id=? AND status=\'sending\'',status,error.cardCreated===true?1:0,errorCode,message,retryable?new Date(clock()+Math.min(3600000,30000*2**(d.attempts-1))).toISOString():null,iso(),d.id);
      }
      processed++;
    }
    return {processed};
  }
  function kick(){
    if(stopped||!canExecute()||sender.configured!==true)return Promise.resolve({processed:0});
    if(!active)active=drain().catch(()=>{logger.error?.('赢单战报投递未完成，发送记录已保留');return {processed:0};}).finally(()=>{active=null;});
    return active;
  }
  function startScheduler(){
    if(!canExecute()||sender.configured!==true)return stop;
    const tick=async()=>{if(stopped)return;await kick();if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref?.();}};
    timer=setTimeout(tick,0);timer.unref?.();return stop;
  }
  function stop(){stopped=true;clearTimeout(timer);}
  async function shutdown(){stop();await active;}
  return {recordWin,describe,summary,saveConfig,testCard,retry,kick,startScheduler,shutdown,canExecute};
}

export function handleWinReports(context){
  const {path,method,b,actor,admin,audit,winReports,scoped}=context;
  if(path==='/api/win-reports/config'&&method==='PATCH'){
    admin(actor);winReports.saveConfig(b);audit(actor,'更新赢单战报设置','settings',null,{fields:Object.keys(b),enabled:winReports.summary().enabled});return {message:'赢单战报设置已保存'};
  }
  if(path==='/api/win-reports/test'&&method==='POST'){
    admin(actor);const id=winReports.testCard(actor,b);audit(actor,'投放赢单测试卡片','win_report',id,{group_key:b.group_key,owner_id:b.owner_id||actor.id});return {id,message:'测试卡片已进入发送队列'};
  }
  const m=path.match(/^\/api\/opportunities\/(\d+)\/win-report\/(\d+)\/retry$/);
  if(m&&method==='POST'){
    admin(actor);scoped('opportunities',m[1],actor);const delivery=winReports.retry(Number(m[1]),Number(m[2]),b);audit(actor,'补发指定群赢单战报','opportunity',Number(m[1]),{delivery_id:delivery.id,group_name:delivery.group_name,confirmed_not_delivered:b.confirmed_not_delivered===true});return {id:delivery.id,message:'已安排补发该群'};
  }
}
