import {createPresence} from './modules/presence.mjs';
import {canManageContractData,assertContractDataAccess,isContractCorrectionRoute} from './contract-access.mjs';
import {handleContractExpenses,readContractExpenses} from './modules/contract-expenses.mjs';
import {handleDataReview,readDataReview} from './modules/data-review.mjs';
import {readSettlementReview} from './modules/settlement-review.mjs';
import {handleAdminRecords,readRecycle,readUnifiedRecycle,previewRecycle} from './modules/admin-records.mjs';
import { createHash, randomUUID } from "node:crypto";
import { one, run, transaction } from "./database.mjs";
import { AppError, assert, now, text } from "./domain.mjs";
import { createAuth, publicUser } from "./modules/auth.mjs";
import { buildState } from "./modules/reporting-prd.mjs";
import { handleCustomers, readCustomerTransfer } from "./modules/customers.mjs";
import { handleOpportunities } from "./modules/opportunities.mjs";
import { handleActivities } from "./modules/activities.mjs";
import { handleQuotes } from "./modules/quotes.mjs";
import { handleContracts } from "./modules/contracts.mjs";
import { handlePayments } from "./modules/payments.mjs";
import { handleTeam } from "./modules/team.mjs";
import { handleSettings } from "./modules/settings.mjs";
import { handleIncentives } from "./modules/incentives.mjs";
import { createDingTalk } from './dingtalk.mjs';
import { handleSetup } from './modules/setup.mjs';
import { renderDocument } from './modules/documents.mjs';
import { createIntakeAI } from './ai-intake.mjs';
import { handleAIImports, prepareIntake, saveIntake, readBatch } from './modules/ai-imports.mjs';
import { readSources, readAttachment } from './modules/source-records.mjs';
import {createMinutesService} from './modules/minutes/service.mjs';
import {createCompanyProfiles,createCompanyProfileProvider} from './company-profile.mjs';
import {createCompanyProfileQueue} from './company-profile-queue.mjs';
import {createCompanyProfileWorker} from './company-profile-worker.mjs';
import {createSalesAdviceAI,salesAdviceSnapshot,salesAdviceResponse} from './sales-advice.mjs';
import {createContractAnalysis} from './contract-analysis.mjs';
import {readContractHistory} from './modules/contract-history.mjs';
import {createWinReports,handleWinReports} from './win-reports.mjs';

const sha = (s) => createHash("sha256").update(s).digest("hex");
export function createService(
  db,
  { demo = false, secure = false, publicOrigin = "", identityProvider, aiProvider, salesAdviceProvider, companyProfileProvider, companyProfileLocalAutomation, minutesOptions={}, winReportOptions={}, deployment='local', localIdentitySwitch = false, developerIdentitySwitch = localIdentitySwitch, basePath = '/' } = {},
) {
  const auth = createAuth(db, { demo, secure, basePath });
  const presence = createPresence(db);
  const ding = identityProvider || createDingTalk({secure,basePath});
  const winReports=createWinReports({db,env:demo?{}:process.env,...winReportOptions,deployment});
  const ai = aiProvider || createIntakeAI();
  const salesAI=salesAdviceProvider||createSalesAdviceAI({env:demo?{}:process.env});
  const adviceCache=new Map(),pendingAdvice=new Set(),pendingProfile=new Set();
  const minutes=createMinutesService(db,{resolveEmployeeIdentity:ding.verifyMinutesIdentity,...minutesOptions,deployment});
  minutes.recover();
  const pendingIntakes=new Set();
  const getRules = () =>
    JSON.parse(
      one(db, "SELECT value FROM settings WHERE key=?", "rules").value,
    );
  const audit = (actor, action, entity, id, detail = {}) =>
    run(
      db,
      "INSERT INTO audit(user_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)",
      actor.id,
      action,
      entity,
      id,
      JSON.stringify({...detail,...(actor._request_id?{request_id:actor._request_id}:{}),...(actor._operator_id?{operator_user_id:actor._operator_id,acting_as_user_id:actor.id}:{})}),
      now(),
    );
  const insert = (table, row) => {
    const k = Object.keys(row);
    return Number(
      run(
        db,
        `INSERT INTO ${table}(${k.join(",")}) VALUES(${k.map(() => "?").join(",")})`,
        ...Object.values(row),
      ).lastInsertRowid,
    );
  };
  const update = (table, id, row) => {
    const k = Object.keys(row);
    run(
      db,
      `UPDATE ${table} SET ${k.map((x) => x + "=?").join(",")} WHERE id=?`,
      ...Object.values(row),
      id,
    );
  };
  function scoped(table, id, actor, access = "edit") {
    const r = one(db, `SELECT * FROM ${table} WHERE id=?`, Number(id));
    assert(r, "记录不存在", 404);
    assert(table!=='opportunities'||!r.archived_at,'该历史商机已退出当前业务列表',410);
    assert(table!=='contracts'||!r.retired_at||access==='history'&&canManageContractData(actor),'该历史合同已退出当前业务列表',410);
    assert(
      actor.role === "admin" || (actor.role === "sales" && r.owner_id === actor.id) ||
      (access === "follow" && (r.collaborator_pm === actor.id || one(db,"SELECT 1 FROM customer_collaborators WHERE customer_id=? AND user_id=?",table === "customers" ? r.id : r.customer_id,actor.id))),
      "无权操作此记录",
      403,
    );
    return r;
  }
  const admin = (actor) =>
    assert(actor.role === "admin", "此操作仅管理员可执行", 403);
  function owner(value, actor) {
    const id = actor.role === "admin" ? Number(value || actor.id) : actor.id;
    assert(
      one(db, "SELECT id FROM users WHERE id=? AND active=1 AND role!='pm' AND business_member=1 AND developer_admin=0", id),
      "请选择有效负责人",
    );
    return id;
  }
  const companyProvider=companyProfileProvider||createCompanyProfileProvider({env:demo?{}:process.env});
  const companyProfiles=createCompanyProfiles({db,scoped,audit,provider:companyProvider});
  const profileQueue=createCompanyProfileQueue({db,provider:companyProvider,deployment,localAutomation:companyProfileLocalAutomation,commitResult:(customer,result)=>companyProfiles.saveResult(customer,result)});
  const profileWorker=createCompanyProfileWorker({queue:profileQueue,configured:companyProvider.configured===true,deployment,localAutomation:companyProfileLocalAutomation});
  const companyProfileQueue={...profileQueue,...profileWorker};
  const queueSummary=()=>({...profileQueue.summary(),configured:!!companyProvider.configured,automatic:profileWorker.automatic});
  const contractAnalysis=createContractAnalysis({db,ai,scoped,audit});
  const state = (actor, options = {}) => {
    const value={...buildState({ db, getRules, demo, ding, ai, minutes, ...options }, actor),minutes:actor.role==='pm'?null:{...minutes.summary(actor),...minutes.list(actor)}};
    value.customers=value.customers.map(c=>({...c,...(!c.shared?{company_profile:{...companyProfiles.read(c),job:profileQueue.read(c.id)}}:{})}));
    value.company_profiles=actor.role==='admin'?queueSummary():{configured:!!companyProvider.configured,automatic:profileWorker.automatic};
    value.contracts=value.contracts.map(c=>({...c,...(actor.role!=='pm'?{contract_analysis:contractAnalysis.describe(c.id,actor)}:{})}));
    value.ai.salesAdvice={configured:!!salesAI.configured,model:salesAI.model||'deepseek-v4-1-flash'};
    if(actor.role==='admin'){
      value.win_reports=winReports.summary();
      value.opportunities=value.opportunities.map(o=>({...o,win_report:winReports.describe(o.id)}));
    }
    return value;
  };
  const handlers = [
    handleWinReports,
    handleDataReview,
    handleContractExpenses,
    handleAdminRecords,
    handleCustomers,
    handleOpportunities,
    handleActivities,
    handleQuotes,
    handleContracts,
    handlePayments,
    handleTeam,
    handleSettings,
    handleIncentives,
    handleSetup,
    handleAIImports,
  ];
  function mutate(path, method, b, actor, minutesPrepared) {
    if(path==='/api/minutes/personal/import'&&method==='POST')return minutes.mutate(actor,'personal-import',null,b,minutesPrepared);
    const minutesRoute=path.match(/^\/api\/minutes\/(start|authorizations\/([a-f0-9-]{36})\/(confirm|cancel|retry)|sources\/([a-f0-9-]{36})\/(disconnect)|records\/(\d+)\/(association|refresh|speaker-insights|quality|transcript))$/);
    if(minutesRoute&&method==='POST')return minutes.mutate(actor,minutesRoute[1]==='start'?'start':minutesRoute[3]||minutesRoute[5]||minutesRoute[7],minutesRoute[2]||minutesRoute[4]||minutesRoute[6],b,minutesPrepared);
    if(b.data_correction!==undefined){if(actor.role!=='admin'){assertContractDataAccess(actor);assert(isContractCorrectionRoute(path),'当前角色不能修正此类资料',403);}assert(b.data_correction===true,'修正标志无效');text(b.reason,'资料修正原因',1000);}
    const context = {
      path,
      method,
      b,
      actor,
      db,
      insert,
      update,
      scoped,
      admin,
      owner,
      audit,
      getRules,
      mutate,
      state,
      companyProfiles,
      winReports,
    };
    for (const handleModule of handlers) {
      const result = handleModule(context);
      if (result !== undefined) return result;
    }
    throw new AppError("接口不存在", 404);
  }
  async function handle(req, path, method, b = {}) {
    assert(!path.startsWith('/api/integrations/ppl'),'PPL在线同步已停用，客户和商机由CRM维护',410);
    assert(!path.startsWith('/api/capture/')&&!path.startsWith('/api/change-requests'),'此旧资料入口已停用，请使用AI接收或业务页面表单',410);
    if (path === "/api/health")
      return { body: { ok: true, version: "2.1.0", demo, schemaVersion:one(db,'SELECT MAX(version) version FROM schema_version').version, ai:{configured:!!ai.configured,model:ai.model},companyProfile:{configured:!!companyProvider.configured,automatic:profileWorker.automatic,provider:companyProvider.provider||'',fallback:companyProvider.fallbackConfigured?'deepseek':null} } };
    if (path === "/api/auth/options" && method === "GET") {const result=auth.options();result.body.dingtalk=ding.loginConfigured;return result;}
    if(path==='/api/auth/dingtalk/start'&&method==='GET')return ding.start();
    if (method !== "GET") {
      const origin = req.headers.origin;
      if (origin) {
        const expected =
          publicOrigin || `${secure ? "https" : "http"}://${req.headers.host}`;
        assert(origin === expected, "请求来源不匹配", 403);
      }
      assert(
        (req.headers["content-type"] || "").startsWith("application/json"),
        "请使用 JSON 请求",
        415,
      );
    }
    if(path==='/api/auth/dingtalk/callback'&&['GET','POST'].includes(method)) {
      const params=new URL(req.url||path,'http://localhost').searchParams;
      const supplied=method==='GET'?{code:params.get('authCode')||params.get('code'),state:params.get('state')}:b;
      const identity=await ding.identity(req,supplied);
      const unionId=typeof identity==='string'?identity:identity.unionId;
      const user=one(db,'SELECT u.* FROM users u JOIN ding_identities d ON d.user_id=u.id WHERE d.union_id=? AND u.active=1',unionId);
      assert(user,'该钉钉账号尚未分配团队角色，请联系管理者',403);
      if (typeof identity === 'object' && identity.userId && user.ding_user_id) assert(identity.userId === user.ding_user_id, '企业身份与已绑定账号不一致，请联系管理者核对', 403);
      const result=auth.createSession(user,{method:'dingtalk',seconds:typeof identity==='object'?identity.seconds:7200});
      audit(user,'钉钉身份登录','user',user.id);
      result.cookie=[result.cookie,`qf_ding_state=; Path=${basePath}api/auth/dingtalk; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`];if(method==='GET')result.redirect=basePath;return result;
    }
    if (path === "/api/auth/login" && method === "POST") {
      assert(demo,'请使用钉钉登录团队工作区',403);
      return auth.login(req, b);
    }
    const s = auth.session(req);
    assert(s, "请先登录", 401);
    const operator={...s.actor,_request_id:req.requestId||randomUUID()};
    const canSwitch=developerIdentitySwitch&&operator.developer_admin===1&&s.auth_method==='dingtalk'&&!!one(db,'SELECT 1 FROM ding_identities WHERE user_id=?',operator.id);
    const developerAssert=(condition,message,status,code)=>{if(!condition){const error=new AppError(message,status);error.code=code;throw error;}};
    let actor=operator;
    const target=req.headers['x-crm-act-as'];
    const businessPath=!path.startsWith('/api/auth/')&&!path.startsWith('/api/developer/');
    if(businessPath&&(target||operator.business_member===0||operator.developer_admin===1)) {
      developerAssert(canSwitch,'当前登录者无权切换身份',403,'DEVELOPER_FORBIDDEN');
      developerAssert(!target||(/^\d+$/.test(String(target))&&Number.isSafeInteger(Number(target))),'切换身份无效',400,'DEVELOPER_TARGET_INVALID');
      const user=target?businessUser(Number(target)):defaultBusinessUser();
      developerAssert(user,target?'目标用户不是可用的业务成员':'暂无可切换的业务成员',403,'DEVELOPER_TARGET_UNAVAILABLE');
      actor={...user,_request_id:operator._request_id,...(user.id!==operator.id?{_operator_id:operator.id}:{})};
    }
    if (method === "GET") {
      if(path==='/api/company-profiles/status'){admin(actor);return {body:queueSummary()};}
      const params=new URL(req.url||path,'http://localhost').searchParams;
      const customerTransfer=path.match(/^\/api\/customers\/(\d+)\/transfer-preview$/);
      if(customerTransfer)return {body:readCustomerTransfer({db,admin,scoped,owner},actor,Number(customerTransfer[1]),params)};
      const context={customer_id:params.has('customer_id')?Number(params.get('customer_id')):null,opportunity_id:params.has('opportunity_id')?Number(params.get('opportunity_id')):null};
      if(path.startsWith('/api/minutes'))for(const key of ['customer_id','opportunity_id'])if(params.has(key))assert(/^\d+$/.test(params.get(key))&&Number.isSafeInteger(context[key])&&context[key]>0,'听记查看范围无效');
      if(path==='/api/minutes')return {body:minutes.list(actor,Object.fromEntries(params))};
      if(path==='/api/minutes/runs')return {body:minutes.listRuns(actor,Object.fromEntries(params))};
      if(path==='/api/minutes/connections')return {body:minutes.summary(actor)};
      const minuteRecord=path.match(/^\/api\/minutes\/records\/(\d+)(\/audio)?$/);
      if(minuteRecord){if(minuteRecord[2])return {audio:await minutes.audio(actor,Number(minuteRecord[1]),context,req.headers.range,()=>recheck())};return {body:minutes.detail(actor,Number(minuteRecord[1]),context)};}
      if (path === "/api/auth/me")
        return { body: { actor: publicUser(operator), csrf: s.csrf, demo,developer:canSwitch } };
      if(path==='/api/developer/presence') {
        developerAssert(canSwitch,'仅开发人员可查看在线状态',403,'DEVELOPER_FORBIDDEN');
        return {body:presence.read()};
      }
      if(path==='/api/developer/identities') {
        developerAssert(canSwitch,'当前登录者无权切换身份',403,'DEVELOPER_FORBIDDEN');
        return {body:allUsers()};
      }
      if (path === "/api/state") {
        const params = new URL(req.url || path, "http://localhost").searchParams;
        const value=state(actor, { month: params.get("month") || undefined, commissionPeriod: params.get("commissionPeriod") || undefined });
        value.developer=canSwitch?{operator:publicUser(operator),impersonating:actor.id!==operator.id,users:allUsers()}:null;
        return { body:value };
      }
      const recycle=path.match(/^\/api\/contracts\/(\d+)\/recycle$/);if(recycle)return {body:readRecycle({db},actor,recycle[1])};
      if(path==='/api/data-review')return {body:readDataReview({db},actor,params)};
      if(path==='/api/settlement-review')return {body:readSettlementReview({db,getRules},actor,params)};
      if(path==='/api/records/recycle')return {body:readUnifiedRecycle({db},actor,params)};
      if(path==='/api/records/recycle/preview')return {body:previewRecycle({db},actor,params)};
      const expenseRead=path.match(/^\/api\/contracts\/(\d+)\/expenses$/);if(expenseRead)return {body:readContractExpenses({db,scoped},actor,Number(expenseRead[1]))};
      if(path==='/api/contracts/history')return {body:readContractHistory({db,scoped},actor)};
      const contractHistory=path.match(/^\/api\/contracts\/(\d+)\/history$/);
      if(contractHistory)return {body:readContractHistory({db,scoped},actor,Number(contractHistory[1]))};
      const document = renderDocument({db,scoped}, path, actor);
      if (document) return {body:document};
      if(path==='/api/source-records')return {body:readSources({db,scoped},new URL(req.url||path,'http://localhost').searchParams,actor)};
      const attachment=path.match(/^\/api\/attachments\/(\d+)$/);
      if(attachment)return {body:readAttachment({db,scoped},Number(attachment[1]),actor)};
      const batch=path.match(/^\/api\/ai\/batches\/(\d+)$/);
      if(batch)return {body:readBatch(db,Number(batch[1]),actor)};
      const file=path.match(/^\/api\/ai\/files\/(\d+)$/);
      if(file) {const row=one(db,'SELECT * FROM ai_uploads WHERE id=?',Number(file[1]));assert(row,'附件不存在',404);readBatch(db,row.batch_id,actor);return {body:{filename:row.filename,base64:Buffer.from(row.content).toString('base64')}};}
      throw new AppError("接口不存在", 404);
    }
    if(path==='/api/auth/presence'&&method==='POST') {
      assert(req.headers['x-csrf-token']===s.csrf,'会话校验失败，请刷新页面后重试',403);
      return {body:presence.touch(s,b)};
    }
    if(actor.id!==operator.id) {
      audit(operator,'developer.test_request','user',actor.id,{operator_user_id:operator.id,acting_as_user_id:actor.id,target:publicUser(actor),method,path,stage:'attempt'});
    }
    assert(
      req.headers["x-csrf-token"] === s.csrf,
      "会话校验失败，请刷新页面后重试",
      403,
    );
    if (path === "/api/auth/logout") {presence.leave(s.sessionId);return auth.logout(req);}
    assert(["POST", "PATCH", "DELETE"].includes(method), "请求方法不支持", 405);
    const key = req.headers["idempotency-key"];
    assert(
      typeof key === "string" && /^[a-zA-Z0-9-]{16,100}$/.test(key),
      "缺少有效操作编号，请刷新后重试",
    );
    const unique = `${operator.id}:${actor.id}:${method}:${path}:${key}`;
    const hash = sha(JSON.stringify(b));
    function mutationResponse(saved,conflict='操作编号冲突'){
      assert(saved.hash===hash,conflict,409);
      const response=JSON.parse(saved.response);
      assert(response?.reset!==true,'原业务已清理，请刷新后以新操作提交',409);
      return response;
    }
    function recheck(){
      const currentSession=auth.session(req);assert(currentSession&&currentSession.actor.id===operator.id&&currentSession.csrf===s.csrf,'登录状态已失效，请重新登录',401);
      assert(currentSession.actor.role===operator.role&&currentSession.actor.developer_admin===operator.developer_admin&&currentSession.actor.business_member===operator.business_member,'账号权限已变化',403);
      const member=businessUser(actor.id);assert(member&&member.role===actor.role,'当前业务成员已停用或权限变化',403);
      if(actor.id!==operator.id)assert(developerIdentitySwitch&&currentSession.auth_method==='dingtalk'&&currentSession.actor.developer_admin===1&&one(db,'SELECT 1 FROM ding_identities WHERE user_id=?',operator.id),'当前登录者无权切换身份',403);
    }
    const adviceRoute=path.match(/^\/api\/opportunities\/(\d+)\/ai-advice$/);
    if(adviceRoute&&method==='POST'){
      assert(Object.keys(b).length===0,'阶段分析不接受外部指定客户、产品或跟进内容');
      recheck();const id=Number(adviceRoute[1]),snapshot=salesAdviceSnapshot({state,scoped},actor,id);
      const cached=adviceCache.get(unique);
      if(cached){assert(cached.hash===hash,'操作编号冲突',409);assert(cached.fingerprint===snapshot.fingerprint,'商机或跟进资料已变化，请重新点击分析',409);return {body:cached.body};}
      const pendingKey=actor.id+':'+id;
      assert(!pendingAdvice.has(pendingKey)&&pendingAdvice.size<2,'AI正在分析，请稍后重试',429);
      assert(salesAI.configured,'紫猫云 DeepSeek尚未配置，请联系管理员配置AI凭据',503);
      pendingAdvice.add(pendingKey);
      try{
        let advice;
        try{advice=await salesAI.analyze(snapshot.context);}catch(error){if(error instanceof AppError)throw error;throw new AppError('AI分析服务暂时不可用，请稍后重试；未修改商机或跟进记录',502);}
        recheck();const latest=salesAdviceSnapshot({state,scoped},actor,id);
        assert(latest.fingerprint===snapshot.fingerprint,'商机、客户或跟进资料在分析期间发生变化，请重新分析',409);
        const result=salesAdviceResponse(id,snapshot,advice,salesAI.model);
        adviceCache.set(unique,{hash,fingerprint:snapshot.fingerprint,body:result});
        if(adviceCache.size>200)adviceCache.delete(adviceCache.keys().next().value);
        return {body:result};
      }finally{pendingAdvice.delete(pendingKey);}
    }
    const profileRoute=path.match(/^\/api\/customers\/(\d+)\/company-profile\/refresh$/);
    if(path==='/api/company-profiles/query-all'&&method==='POST'){
      assert(Object.keys(b).length===0,'全量企业信息查询不接受外部指定接口或客户清单');
      recheck();admin(actor);assert(companyProvider.configured,'企业信息接口尚未配置',503);
      const existing=one(db,'SELECT * FROM mutations WHERE key=?',unique);
      if(existing){mutationResponse(existing);return {body:queueSummary()};}
      transaction(db,()=>{recheck();admin(actor);profileQueue.enqueueAll({manual:true,retryAuth:true});audit(actor,'手动查询剩余企业资料','customer',null,{scope:'remaining-customers'});run(db,'INSERT INTO mutations VALUES(?,?,?,?)',unique,hash,'{}',now());});
      void profileWorker.kick({manual:true}).catch(()=>{});
      return {body:queueSummary()};
    }
    if(profileRoute&&method==='POST'){
      assert(Object.keys(b).length===0,'企业信息读取不接受外部指定的客户或接口参数');
      recheck();const id=Number(profileRoute[1]);scoped('customers',id,actor);
      const existing=one(db,'SELECT * FROM mutations WHERE key=?',unique);
      if(existing){mutationResponse(existing);return {body:{customer_id:id,company_profile:companyProfiles.read(scoped('customers',id,actor))}};}
      if(profileWorker.automatic||profileQueue.read(id)?.manual_only){
        transaction(db,()=>{recheck();scoped('customers',id,actor);const job=profileQueue.read(id);assert(job?.status!=='running','该客户的企业信息正在读取，请稍后重试',429);profileQueue.enqueueCustomer(id,{retry:true,manual:true,priority:100,force:job?.status==='complete'});run(db,'INSERT INTO mutations VALUES(?,?,?,?)',unique,hash,JSON.stringify({customer_id:id}),now());});
        void profileWorker.kick({manual:true,customerId:id,maxJobs:1}).catch(()=>{});
        return {body:{customer_id:id,company_profile:{...companyProfiles.read(scoped('customers',id,actor)),job:profileQueue.read(id)}}};
      }
      assert(!pendingProfile.has(id),'该客户的企业信息正在读取，请稍后重试',429);pendingProfile.add(id);
      try{const result=await companyProfiles.refresh(actor,id,recheck);run(db,'INSERT INTO mutations VALUES(?,?,?,?)',unique,hash,JSON.stringify({customer_id:id}),now());return {body:result};}
      finally{pendingProfile.delete(id);}
    }
    const extractionRoute=path.match(/^\/api\/contracts\/(\d+)\/extract-attachment$/);
    if(extractionRoute&&method==='POST'){
      recheck();assertContractDataAccess(actor);const id=Number(extractionRoute[1]);scoped('contracts',id,actor);
      assert(Object.keys(b).length===1&&Number.isSafeInteger(b.attachment_id)&&b.attachment_id>0,'请选择该合同的一个原附件');
      assert(one(db,"SELECT id FROM attachments WHERE id=? AND entity='contract' AND entity_id=?",b.attachment_id,id),'请选择本合同的原附件',404);
      const existing=one(db,'SELECT * FROM mutations WHERE key=?',unique);
      if(existing){
        const prior=mutationResponse(existing),current=contractAnalysis.describe(id,actor);
        assert(current&&current.generated_at===prior.generated_at&&current.state===prior.state&&current.filename===prior.filename,'合同或附件识别结果已变化，请重新点击提取',409);
        return {body:prior};
      }
      const result=await contractAnalysis.extract(actor,id,b.attachment_id,{authorize:recheck});recheck();
      const body={contract_id:id,attachment_id:b.attachment_id,...result};
      run(db,'INSERT INTO mutations VALUES(?,?,?,?)',unique,hash,JSON.stringify(body),now());return {body};
    }
    let minutesPrepared;
    if(path.startsWith('/api/minutes/')&&method==='POST'){
      const existing=one(db,'SELECT * FROM mutations WHERE key=?',unique);if(existing)return {body:mutationResponse(existing)};
      if(path==='/api/minutes/personal/import')minutesPrepared=await minutes.prepare(actor,'personal-import',null,b,recheck);
      const retryMinutesRun=path.match(/^\/api\/minutes\/runs\/([a-f0-9-]{36})\/retry$/);
      if(retryMinutesRun){assert(Object.keys(b).length===0,'重试仅恢复原任务，不接受改变账号或同步范围');recheck();const body=await minutes.retryRun(actor,retryMinutesRun[1],{authorize:recheck});recheck();run(db,'INSERT INTO mutations VALUES(?,?,?,?)',unique,hash,JSON.stringify(body),now());return {body};}
      const syncRoute=path.match(/^\/api\/minutes\/sources\/([a-f0-9-]{36})\/(sync|history|range)$/);
      if(syncRoute){if(syncRoute[2]!=='range')assert(Object.keys(b).length===0,'听记读取不接受指定其他账号或组织');recheck();const body=syncRoute[2]==='range'?minutes.startRange(actor,syncRoute[1],b,{authorize:recheck}):syncRoute[2]==='history'?minutes.startHistory(actor,syncRoute[1],{authorize:recheck}):await minutes.sync(actor,syncRoute[1],{authorize:recheck});recheck();run(db,'INSERT INTO mutations VALUES(?,?,?,?)',unique,hash,JSON.stringify(body),now());return {body};}
      const prepareRoute=path.match(/^\/api\/minutes\/(?:authorizations\/([a-f0-9-]{36})\/(confirm)|records\/(\d+)\/(refresh|speaker-insights|quality|transcript))$/);
      if(prepareRoute)minutesPrepared=await minutes.prepare(actor,prepareRoute[2]||prepareRoute[4],prepareRoute[1]||prepareRoute[3],b,recheck);
    }
    if(['/api/developer/switch','/api/developer/identity'].includes(path)&&method==='POST') {
      developerAssert(canSwitch,'当前登录者无权切换身份',403,'DEVELOPER_FORBIDDEN');
      const supplied=path.endsWith('/identity')?b.memberId:b.user_id;
      developerAssert(/^\d+$/.test(String(supplied))&&Number.isSafeInteger(Number(supplied)),'请选择业务成员',400,'DEVELOPER_TARGET_INVALID');
      const id=Number(supplied);
      const user=businessUser(id);developerAssert(user,'目标用户不是可用的业务成员',404,'DEVELOPER_TARGET_UNAVAILABLE');
      audit(operator,'developer.identity_selected','user',id,{operator_user_id:operator.id,acting_as_user_id:id,target:publicUser(user),simulation:true});
      return {body:{actor:publicUser(user),operator:publicUser(operator),message:'已切换为'+user.name}};
    }
    // Network reads happen before the short write transaction, never while holding SQLite locks.
    let intake;
    if(path==='/api/ai/intake'&&method==='POST') {
      const previous=one(db,'SELECT * FROM mutations WHERE key=?',unique);
      if(previous)return {body:mutationResponse(previous)};
      assert(!pendingIntakes.has(actor.id),'你的上一批资料仍在解析，请稍后重试',429);
      pendingIntakes.add(actor.id);
      try {
        if(b.previous_batch_id!==undefined) {
          assert(Number.isSafeInteger(b.previous_batch_id),'原批次编号无效');
          const previousBatch=readBatch(db,b.previous_batch_id,actor);assert(previousBatch.state==='draft','只能补充未入库的原批次',409);
          assert(!b.files||Array.isArray(b.files),'附件格式无效');
          b={...b,context:previousBatch.source_context,text:previousBatch.source_text+'\n用户补充说明：\n'+String(b.text||''),files:[...db.prepare('SELECT filename,content FROM ai_uploads WHERE batch_id=?').all(previousBatch.id).map(f=>({name:f.filename,base64:Buffer.from(f.content).toString('base64')})),...(b.files||[])]};
        }
        intake=await prepareIntake({db,actor,state},b,ai);
      } finally {pendingIntakes.delete(actor.id);}
    }
    let replayed=false;
    const body = transaction(db, () => {
      if(intake) {
        const currentSession=auth.session(req);
        assert(currentSession && currentSession.actor.id===operator.id && currentSession.csrf===s.csrf,'登录状态已失效，请重新登录后重试',401);
        assert(['role','business_member','developer_admin'].every(key=>currentSession.actor[key]===operator[key]),'账号权限已变化，请刷新后重试',403);
        if(path==='/api/auth/presence'&&method==='POST') {
      assert(req.headers['x-csrf-token']===s.csrf,'会话校验失败，请刷新页面后重试',403);
      return {body:presence.touch(s,b)};
    }
    if(actor.id!==operator.id) {
          const currentActor=businessUser(actor.id);
          assert(developerIdentitySwitch && currentSession.auth_method==='dingtalk' && currentSession.actor.developer_admin===1 && one(db,'SELECT 1 FROM ding_identities WHERE user_id=?',operator.id),'当前登录者无权切换身份',403);
          assert(currentActor && currentActor.role===actor.role,'所选成员的状态或权限已变化，请重新选择',403);
        }
      }
      const existing = one(db, "SELECT * FROM mutations WHERE key=?", unique);
      if (existing) {
        replayed=true;
        return mutationResponse(existing,'重复操作编号对应不同内容');
      }
      if(path.startsWith('/api/minutes/'))recheck();
      const result = intake ? (intake.existingId?{id:intake.existingId,message:'相同资料已有接收记录，未重复调用AI或写入业务'}:saveIntake({db,insert,update,actor,admin,scoped,audit,state,mutate,getRules},b,intake)) : mutate(path, method, b, actor,minutesPrepared);
      run(
        db,
        "INSERT INTO mutations VALUES(?,?,?,?)",
        unique,
        hash,
        JSON.stringify(result),
        now(),
      );
      return result;
    });
    body.afterCommit?.();delete body.afterCommit;
    if(!replayed){
      void winReports.kick();
      const customerIds=path==='/api/customers'&&method==='POST'?[body.id]:(Array.isArray(body.result)?body.result:[]).filter(r=>r.type==='customer'&&r.action==='create').map(r=>r.id);
      if(profileWorker.automatic){
        for(const id of new Set(customerIds))profileQueue.enqueueCustomer(id,{priority:100});
        void profileWorker.kick().catch(()=>{});
      }
      for(const id of profileWorker.automatic?[]:new Set(customerIds)){
        let claimed=false;
        try{assert(!pendingProfile.has(id),'该客户的企业信息正在读取，请稍后重试',429);pendingProfile.add(id);claimed=true;await companyProfiles.refresh(actor,id,recheck);}
        catch{/* The committed customer remains available; failed/stale reads are shown in its profile. */}
        finally{if(claimed)pendingProfile.delete(id);}
      }
      if(actor.role==='admin'&&Array.isArray(body.result)){
        const attachments=new Set();
        for(const item of body.result){
          if(item.type==='contract_attachment')attachments.add(item.id);
          if(item.type==='contract_archive'){
            const archived=one(db,'SELECT archive_attachment_id FROM contracts WHERE id=?',item.id);
            if(archived?.archive_attachment_id)attachments.add(archived.archive_attachment_id);
          }
        }
        for(const attachmentId of attachments){
          const attachment=one(db,"SELECT entity_id FROM attachments WHERE id=? AND entity='contract'",attachmentId);
          if(!attachment)continue;
          try{await contractAnalysis.extract(actor,attachment.entity_id,attachmentId,{authorize:recheck});}
          catch{/* The committed upload stays intact; analysis state is read from contract details. */}
        }
      }
    }
    return { body };
  }
  return { handle, state, minutes, companyProfileQueue, winReports };
  function allUsers() {return db.prepare("SELECT id,name,role,active FROM users WHERE active=1 AND business_member=1 AND developer_admin=0 ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'sales' THEN 1 ELSE 2 END,name,id").all();}
  function businessUser(id) {return one(db,'SELECT * FROM users WHERE id=? AND active=1 AND business_member=1 AND developer_admin=0',id);}
  function defaultBusinessUser() {
    const manager=getRules().commission.manager_id;
    return (manager&&businessUser(manager))||businessUser(allUsers()[0]?.id||0);
  }
}
