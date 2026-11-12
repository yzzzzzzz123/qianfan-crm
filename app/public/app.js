import {createPresenceController} from './modules/developer-presence.js';
import {canManageContractData} from './modules/contract-access.js';
import {expenseWorkspace,expenseForm,expenseRequest} from './modules/contract-expenses.js';
import {recycleWorkspace,recyclePreviewForm,mountRecycleWorkspace} from './modules/record-recycle.js';
import {reviewList,mountReviewList,reviewEditor,collectReviewChange,reviewQueue,reviewPreview,settlementReview} from './modules/data-review.js';
import {installProfitEditors} from './modules/profit-editor.js';
import {formShell,textarea} from './ui.js';
import {installSearchSelects} from './modules/search-select.js';
import {bindCommittedSearch,isCompositionEvent,isSearchComposing} from './modules/search-input.js';
import {mountMaintenance,maintenancePayload,bindMaintenanceActions} from './modules/contract-maintenance.js';
import {installTablePanning} from './modules/table-pan.js';
import {collectionDetail,contractWorkspace,contractHistoryList} from './modules/contract-workflow.js';
import {mountCollectionForm,syncCollectionForm,showCollectionError,contractFile} from './modules/collection-controller.js';
import {mountQuoteForm,quoteItemRow,syncQuoteTotal} from './modules/quotes.js';
import { api, setCsrf, setSimulationIdentity } from "./api.js";
import { sessionControl, bindIdentityPicker } from './modules/developer-session.js';
import {bindIntakeUpload,restoreIntakeUpload,setIntakeBusy,clearIntakeUpload} from './modules/intake-upload.js';
import {intakeGuideCard} from './modules/intake.js';
import {syncTargetForm} from './modules/targets.js';
import {manualChoices,manualChooser,manualCreateActions,manualFormRoles} from './modules/manual-entry.js';
import {followupFilters,reportMonthForPage,selectCustomers,customerSearchText} from './modules/shared.js';
import {mountCustomerForm,refreshCustomerTransfer,customerEditPayload} from './modules/customer-controller.js';
import {mountOpportunityForm,activityPlanPayload,opportunityEditPayload} from './modules/opportunity-controller.js';
import {activityEventDetail,mountActivityForm} from './modules/activities.js';
import {workbenchMetricDetail} from './modules/workbench.js';
import {workbenchModel} from './modules/workbench-view-model.js';
import {monthlyBoardDetail} from './modules/monthly-board.js';
import {analyticsDetail} from './modules/management-analytics.js';
import {assetDetail} from './modules/management-assets.js';
import {funnelDetail} from './modules/management-funnel.js';
import {personalDetail} from './modules/management-personal.js';
import {managementMonth,managementRange} from './modules/management-finance.js';
import {teamExportRows,teamMetricDetail} from './modules/team-management.js';
import {syncPerformanceReviewPreview,performanceQuoteDetail,selectPerformanceRows} from './modules/incentives.js';
import {createMinutesController} from './modules/minutes.js';
import {companyProfileFeedback} from './modules/customers.js';
import {salesPolicyFromForm} from './modules/commission-policy.js';
import {shiftCommissionPeriod,currentCommissionPeriod} from './modules/commission-period.js';
import {buildCommissionExport,commissionIssueRows} from './modules/commission-view-model.js';
import {
  esc,
  icon,
  avatar,
  plainMoney,
  empty,
  actionButton as button,
  aiDataActions,
} from "./ui.js";
import {
  shell,
  renderPage,
  pages,
  customerDetail,
  opportunityDetail,
  contractDetail,
  formContent,
  contractItemRow,
  filtered,
  timeline,
} from "./views.js";

installSearchSelects();
installProfitEditors();
bindIntakeUpload();
installTablePanning();
bindMaintenanceActions(()=>S);
let S = null;
let current = "workbench";
const routeState = {};
let panel = null;
let formReturn = null;
let searchTimer;
let toastTimer;
let reportMonth='';
let stateRequest=0;
let commissionPeriod='';
let identitySwitchBusy=false;
let expenseData=null,recycleFilters={},reviewReason='';
const reviewChanges=new Map();
const profileRequests=new Map();
const dialog = document.querySelector("#dialog");
const getP = () =>
  routeState[current] ||
  (routeState[current] = {
    view: current,
    q: "",
    owner: "",
    stage: "",
    level: "",
    risk: "",
    source: "",
    sort: "",
    desc: false,
    tab: "members",
  });
const managementMonthPages = ['team', 'personal'];
const selectedStateMonth = () => managementMonthPages.includes(current) ? getP().managementMonth || '' : current === 'performance' ? reportMonth : '';
const managementDrawers = {
  'management-analytics-detail': ['analytics', analyticsDetail],
  'management-asset-detail': ['assets', assetDetail],
  'management-funnel-detail': ['funnel', funnelDetail],
  'personal-detail': ['personal', personalDetail],
  'team-metric': ['team', teamMetricDetail],
};
const toast = (msg, error = false) => {
  const el = document.querySelector("#toast");
  el.className = error ? "error visible" : "visible";
  el.innerHTML = icon(error ? "alert" : "check") + `<span>${esc(msg)}</span>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 4500);
};
const minutesController=createMinutesController({getS:()=>S,getP,openHtml,content,reload,toast});
async function showExpenses(contractId){expenseData=await api('/contracts/'+contractId+'/expenses');openHtml(expenseWorkspace(S,expenseData),true);}
async function showRecycle(filters={}){recycleFilters=filters;const query=new URLSearchParams(Object.entries(filters).filter(([,v])=>v!==''&&v!=null));const data=await api('/records/recycle?'+query);openHtml(recycleWorkspace(S,data),true);mountRecycleWorkspace(dialog.querySelector('.recycle-workspace'),{search:showRecycle,preview:showRecyclePreview,onError:e=>toast(e.message,true)});}
async function showRecyclePreview({type,id}){const data=await api('/records/recycle/preview?'+new URLSearchParams({type,id}));openHtml(recyclePreviewForm(S,data));}
async function showReview(){const data=await api('/data-review');openHtml(reviewList(S,data,[...reviewChanges.values()]),true);}
const livePresence=createPresenceController({getState:()=>S,getPage:()=>current,api});
function content() {
  minutesController.beforeRender();
  document.querySelector("#content").innerHTML = renderPage(S, getP());
  void minutesController.mountFilters();
  if(current==='intake')restoreIntakeUpload();
  livePresence.mount();
  document.title = `千帆 CRM · ${pages[current][0]}`;
}
function render() {
  document.querySelector("#app").innerHTML = shell(S, current);
  if(S.developer) {
    document.querySelector('.user-menu').remove();
    document.querySelector('.env-tag').remove();
    document.querySelector('.topbar').insertAdjacentHTML('beforeend',sessionControl(S));
    bindIdentityPicker();
  }
  content();
}
async function reload({background=false}={}) {
  const request=++stateRequest,page=current;
  const query=new URLSearchParams(),month=selectedStateMonth();
  if(month)query.set('month',month);
  if(commissionPeriod)query.set('commissionPeriod',commissionPeriod);
  const state=await api('/state'+(query.size?'?'+query:''));
  if(request!==stateRequest||current!==page||background&&isSearchComposing())return false;
  S=state;
  for(const [id,actorId] of profileRequests){
    if(S.actor.id!==actorId){profileRequests.delete(id);continue;}
    const profile=S.customers.find(c=>c.id===id)?.company_profile;
    if(!profile){profileRequests.delete(id);continue;}
    const feedback=companyProfileFeedback(profile);
    if(!feedback.pending){profileRequests.delete(id);toast(feedback.message,feedback.error);}
  }
  if(S.developer)setSimulationIdentity(S.actor.id);
  render();
  return true;
}
let commissionRefreshing=false;
const commissionDetailKey=detail=>{
  const card=detail.closest('[data-sales-id]');
  if(card)return `person:${card.dataset.salesId}:${card.dataset.commissionKind}:${detail.className}`;
  const section=detail.closest('section'),siblings=[...(section?.querySelectorAll('details')||[])];
  return `${section?.className}:${detail.className}:${siblings.indexOf(detail)}`;
};
async function refreshRealtimeCommissions(manual=false){
  if(commissionRefreshing||!S||current!=='commissions'||document.hidden||dialog.open||panel)return;
  if(!manual&&(document.activeElement?.matches('input,select,textarea')||document.querySelector('.commission-live [aria-expanded="true"]')))return;
  commissionRefreshing=true;
  const actor=S.actor.id,period=S.commission.period,scrollY=window.scrollY;
  const opened=new Map([...document.querySelectorAll('.commission-live details')].map(detail=>[commissionDetailKey(detail),detail.open]));
  try{
    if(!await reload({background:!manual}))return;
    if(current==='commissions'&&S.actor.id===actor&&S.commission.period===period){
      for(const detail of document.querySelectorAll('.commission-live details'))if(opened.has(commissionDetailKey(detail)))detail.open=opened.get(commissionDetailKey(detail));
      window.scrollTo(0,scrollY);
    }
    if(manual)toast('实时提成已更新');
  }catch(error){if(manual)toast(error.message,true);}
  finally{commissionRefreshing=false;}
}
setInterval(()=>{void refreshRealtimeCommissions();},15000);
let auditWorkspaceRefreshing=false;
async function refreshAuditWorkspace(manual=false) {
  if(auditWorkspaceRefreshing||!S||!['activities','performance'].includes(current)||document.hidden||dialog.open||panel)return;
  if(!manual&&(document.activeElement?.matches('input,select,textarea')||document.querySelector('#content [aria-expanded="true"]')))return;
  auditWorkspaceRefreshing=true;
  const page=current,actor=S.actor.id,scroll=window.scrollY;
  const key=detail=>`${detail.closest('[data-performance-user]')?.dataset.performanceUser||''}:${detail.dataset.detailKey||detail.dataset.activityId||detail.className}:${detail.closest('[data-activity-id]')?.dataset.activityId||''}`;
  const opened=new Map([...document.querySelectorAll('#content details')].map(detail=>[key(detail),detail.open]));
  try {
    if(!await reload({background:!manual}))return;
    if(current===page&&S.actor.id===actor){
      for(const detail of document.querySelectorAll('#content details'))if(opened.has(key(detail)))detail.open=opened.get(key(detail));
      window.scrollTo(0,scroll);
    }
    if(manual)toast('数据已更新');
  }catch(error){if(manual)toast(error.message,true);}
  finally{auditWorkspaceRefreshing=false;}
}
setInterval(()=>{void refreshAuditWorkspace();},30000);
window.addEventListener('focus',()=>{void refreshRealtimeCommissions();});
window.addEventListener('focus',()=>{void refreshAuditWorkspace();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshRealtimeCommissions();});
let profilePolling=false,lastProfilePoll=0;
setInterval(async()=>{
  if(profilePolling||!S||document.hidden||!(current==='customers'||panel?.type==='customer')||dialog.querySelector('form')||isSearchComposing())return;
  const progress=S.company_profiles,counts=progress?.counts||{};
  const busy=profileRequests.size>0||Number(counts.pending||0)+Number(counts.running||0)>0;
  if(Date.now()-lastProfilePoll<(busy?5000:15000))return;
  lastProfilePoll=Date.now();profilePolling=true;
  const opened=dialog.open&&panel?.type==='customer'?{...panel,scrollTop:dialog.scrollTop,...customerSections()}:null;
  try{
    const loaded=await reload({background:true});
    if(loaded&&opened&&dialog.open&&panel?.type==='customer'&&panel.id===opened.id){openPanel('customer',opened.id,opened);dialog.scrollTop=opened.scrollTop;}
  }catch{/* Existing page and input state remain available after a failed poll. */}
  finally{profilePolling=false;}
},5000);
function openHtml(html, drawer = false) {
  dialog.className = drawer ? "drawer" : "form-dialog";
  dialog.innerHTML = html;
  const reviewRoot=dialog.querySelector('.review-workspace');if(reviewRoot)mountReviewList(reviewRoot);
  if(!dialog.querySelector('[data-action="close"]'))dialog.insertAdjacentHTML('afterbegin',`<button type="button" class="icon-btn empty-close" data-action="close" aria-label="关闭">${icon('close')}</button>`);
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function customerSections(){
  return panel?.type==='customer'?{customerSections:Object.fromEntries([...dialog.querySelectorAll('[data-customer-section]')].map(el=>[el.dataset.customerSection,el.open]))}:{};
}
function openPanel(type, id, options={}) {
  minutesController.leaveDetail();
  if(['contract','collection'].includes(type))options={...options,tab:options.tab||(type==='collection'?'payments':'overview')};
  panel = { type, id: Number(id),...options };
  formReturn = null;
  const html = {
    customer: customerDetail,
    opportunity: opportunityDetail,
    contract: contractDetail,
    collection: collectionDetail,
  }[type](S, id,options);
  openHtml(html, true);
  if(type==='customer'&&options.customerSections)for(const el of dialog.querySelectorAll('[data-customer-section]'))if(Object.hasOwn(options.customerSections,el.dataset.customerSection))el.open=options.customerSections[el.dataset.customerSection];
  if(Number.isFinite(options.scrollTop))dialog.scrollTop=options.scrollTop;
  if(options.paymentId){
    const receipt=dialog.querySelector(`[data-receipt-id="${Number(options.paymentId)}"]`);
    receipt?.scrollIntoView({block:'center'});
    receipt?.focus({preventScroll:true});
  }
}
function openForm(type, id = "", quarter = "") {
  formReturn = panel?{...panel,scrollTop:dialog.scrollTop,...customerSections()}:null;
  openHtml(formContent(S, type, id, quarter), false);
  if(['contract-maintain','contract-items'].includes(type)){
    const form=dialog.querySelector('form'),record=S.contracts.find(c=>c.id===Number(id));
    if(form){form.dataset.locked='false';mountMaintenance(form,record);}
  }
  if(type==='target'&&dialog.querySelector('form[data-form="target"]'))syncTargetForm(dialog.querySelector('form'),S);
  if(['payment','payment-maintain'].includes(type)){syncPaymentFields(dialog.querySelector('form'));syncPaymentContext(dialog.querySelector('form'));}
  if(type==='quote')mountQuoteForm(dialog.querySelector('form'),S);
  if(['contact','edit-contact'].includes(type))syncContactMethods(dialog.querySelector('form'));
  mountCustomerForm(dialog.querySelector('form'),S,{api});
  if(type==='activity'&&dialog.querySelector('form'))dialog.querySelector('form').dataset.contextOpportunity=id||'';
  mountOpportunityForm(dialog.querySelector('form'),S);
  mountActivityForm(dialog.querySelector('form'),S);
  syncPerformanceReviewPreview(dialog.querySelector('form'),S);
  mountCollectionForm(dialog.querySelector('form'),S);
  if(S.actor.role==='admin'&&['contract-maintain','contract-meta','contract-items','payment-maintain','payment-allocation','item-margin','contract-delete'].includes(type))dialog.querySelector('.form-error')?.insertAdjacentHTML('afterend','<div class="wide admin-repair-note">管理员数据修正：请填写处理原因；当前汇总和未确认试算会更新，已确认结算快照保留。</div>');
}
function syncPaymentFields(form) {
  if(form)syncCollectionForm(form,S);
}
function syncPaymentContext(form){
  if(form)syncCollectionForm(form,S);
}
function syncContactMethods(form) {
  if(!form)return;
  if(form.dataset.form==='edit-contact'&&!['phone','wechat','dingtalk'].some(name=>form.elements[name].value.trim())){
    const original=S.contacts.find(p=>p.id===Number(form.dataset.id));
    if(original&&!['phone','wechat','dingtalk'].some(name=>String(original[name]||'').trim())){form.elements.phone.setCustomValidity('');return;}
  }
  const provided=['phone','wechat','dingtalk'].some(name=>form.elements[name].value.trim());
  form.elements.phone.setCustomValidity(provided?'':'电话、微信、钉钉至少填写一项。');
}
function downloadFile(file) {
  const body=file.base64?Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0)):file.html;
  const url=URL.createObjectURL(new Blob([body],{type:file.mime_type||(file.base64?'application/octet-stream':'text/html;charset=utf-8')}));
  const link=document.createElement('a');link.href=url;link.download=file.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function close() {
  if (formReturn) {
    const p = formReturn;
    formReturn = null;
    openPanel(p.type, p.id,p);
  } else {
    dialog.close();
    panel = null;
  }
}
function navigate(view, filters = {}) {
  clearTimeout(searchTimer);
  if (current !== view) {
    current = view;
    getP();
  }
  Object.assign(getP(), filters);
  if (location.hash.slice(1) !== view) location.hash = view;
  else render();
}
async function openCommissionIssue(el){
  const issue=commissionIssueRows(S,getP()).find(row=>row.key===el.dataset.taskKey);
  if(!issue){toast('该事项已更新，请刷新后查看',true);return;}
  const salesId=Number(issue.sales_id),contractId=Number(issue.contract_id);
  if(S.actor.role==='pm'||S.actor.role!=='admin'&&(issue.responsibility==='admin'||salesId!==S.actor.id)){
    toast('这项信息需要管理员处理',true);return;
  }
  const action=issue.action;
  if(action==='sales-policy'){
    if(S.actor.role!=='admin'){toast('提成规则由管理员维护',true);return;}
    openForm('sales-commission-policy');return;
  }
  if(action==='performance'){
    if(S.actor.role!=='admin'){toast('绩效信息由管理员维护',true);return;}
    reportMonth=/^\d{4}-\d{2}$/.test(issue.period)?issue.period:S.today.slice(0,7);
    current='performance';getP().owner=String(salesId);
    history.replaceState(null,'','#performance');
    await reload();
    const performance=S.performance.find(p=>p.user_id===salesId);
    if(!performance){toast('该成员的历史绩效需在团队管理中核对',true);return;}
    if(!performance.quarterly_target){openForm('target',salesId,`${reportMonth.slice(0,4)}Q${Math.ceil(Number(reportMonth.slice(5,7))/3)}`);return;}
    if(performance.status!=='confirmed')openForm('performance-review',salesId);
    return;
  }
  const contract=S.contracts.find(c=>c.id===(contractId||issue.contract_id));
  if(!contract||S.actor.role==='sales'&&contract.owner_id!==S.actor.id){toast('当前账号无法维护这份合同',true);return;}
  const tab=action==='payment-allocation'?'payments':'overview';
  const receipt=issue.payment_id==null?null:contract.payments?.find(p=>p.id===Number(issue.payment_id)&&p.status==='已到账');
  if(issue.payment_id!=null&&!receipt){toast('这笔到账流水已更新，请刷新提成后核对',true);return;}
  openPanel('contract',contract.id,{tab,paymentId:receipt?.id});
  if(receipt&&canManageContractData(S)&&!contract.read_only){
    const code=issue.blocking_code||issue.code;
    if(code==='receipt_date_missing'){
      openForm('payment-maintain',receipt.id);
      dialog.querySelector('[name="pay_date"]')?.focus();
    }else if(code==='receipt_split_missing'){
      openForm('payment-allocation',receipt.id);
      dialog.querySelector('[name="product_amount"]')?.focus();
    }
  }
  if(action==='contract-items'&&canManageContractData(S))openForm('contract-items',contract.id);
}
async function showLogin(message = "") {
  panel = null;
  formReturn = null;
  if (dialog.open) dialog.close();
  const options = await api("/auth/options");
  S = null;
  document.querySelector("#app").innerHTML =
    `<main class="login-screen"><section class="login-story"><span class="login-brand"><span class="brand-crop"><img src="./assets/brand.png" alt="千帆创科"></span><b>CRM</b></span><div class="login-story-copy"><h1>客户与销售工作，<br>在这里有序推进。</h1><p>从客户建档到合同回款，<br>保留每一次沟通，明确每一步行动。</p><div class="login-process"><span>客户</span>${icon("arrow")}<span>商机</span>${icon("arrow")}<span>合同</span>${icon("arrow")}<span>回款</span></div></div><span class="login-caption">千帆创科 · 销售协同工作区</span></section><section class="login-main"><div class="login-box"><h2>进入千帆 CRM</h2><p>${options.demo ? "选择演示身份，体验完整业务流程。" : "请使用管理员分配的账号登录。"}</p>${message ? `<p class="form-error">${esc(message)}</p>` : ""}${options.demo ? `<div class="demo-logins">${options.users.map((u) => `<button data-action="demo-login" data-id="${u.id}">${avatar(u.name)}<span><b>${esc(u.name)}</b><small>${u.role === "admin" ? "管理员 · 团队业务全览" : "销售 · 本人客户与商机"}</small></span>${icon("arrow")}</button>`).join("")}</div><div class="login-note">${icon("shield")}<span>本地演示环境，数据可实际保存。<br>示例客户和金额不代表真实业务。</span></div><details class="local-login"><summary>使用账号密码登录</summary>` : ""}<form data-form="login"><label class="field">账号<input name="username" required autocomplete="username" placeholder="输入登录账号"></label><label class="field">密码<input name="password" type="password" required autocomplete="current-password" placeholder="输入密码"></label><p class="form-error" role="alert"></p><button class="btn primary full-width" type="submit">登录工作区 ${icon("arrow")}</button></form>${options.demo ? "</details>" : ""}<p class="login-bottom">钉钉身份登录待应用配置后接入</p></div></section></main>`;
  if(options.dingtalk)document.querySelector('.login-box h2').insertAdjacentHTML('afterend',button('使用钉钉登录','dingtalk-login','','primary full-width','shield'));
  if(options.dingtalk&&!options.demo) {
    document.querySelector('form[data-form="login"]')?.remove();
    document.querySelector('.login-box > p')?.replaceChildren(document.createTextNode('使用企业钉钉扫码授权，进入团队工作区。'));
    const note=document.querySelector('.login-bottom');if(note)note.textContent='企业身份由服务端核验，岗位权限按账号隔离。';
  }
}
async function login(body) {
  const a = await api("/auth/login", { method: "POST", body });
  setCsrf(a.csrf);
  current = Object.hasOwn(pages, location.hash.slice(1))
    ? location.hash.slice(1)
    : a.actor.role==='admin'?'team':'workbench';
  await reload();
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if(el.matches("tr.record-row")&&(e.target.closest("button,a,input,select,textarea,summary,label")||window.getSelection()?.toString()))return;
  const action = el.dataset.action,
    id = el.dataset.id;
  if (action === "noop") return;
  try {
    const drawer = Object.hasOwn(managementDrawers, action) ? managementDrawers[action] : null;
    if(drawer?.[0]===current){
      const html=drawer[1](S,getP(),id);
      if(html){panel=null;formReturn=null;openHtml(html,true);}
      return;
    }
    if(action==='management-range'&&current==='analytics'){
      if(!['this-month','last-month','this-quarter','custom'].includes(id))return;
      const P=getP(),range=id==='custom'?managementRange(S,P):{from:'',to:''};
      Object.assign(P,range,{managementPreset:id,analyticsFiltersOpen:true});
      content();
      document.querySelector('[data-action="management-range"][aria-pressed="true"]')?.focus();
      return;
    }
    if(action==='monthly-board-detail'&&((current==='customers'&&id?.startsWith('customer-'))||(current==='opportunities'&&id?.startsWith('opportunity-')))){
      const html=monthlyBoardDetail(S,getP(),id);
      if(html){panel=null;formReturn=null;openHtml(html,true);}
      return;
    }
    if(current==='workbench'){
      const P=getP();
      if(action==='workbench-metric'){
        if(id==='tasks'){
          P.workbenchTask='all';
          P.workbenchAll=true;
          content();
          const tasks=document.querySelector('#workbench-tasks');
          tasks.focus({preventScroll:true});
          tasks.scrollIntoView({block:'start'});
        }else{
          const html=workbenchMetricDetail(S,P.owner,id);
          if(html){panel=null;formReturn=null;openHtml(html,true);}
        }
        return;
      }
      if(action==='workbench-task-filter'){
        P.workbenchTask=id;
        P.workbenchAll=false;
        content();
        document.querySelector('[data-action="workbench-task-filter"][aria-pressed="true"]')?.focus({preventScroll:true});
        return;
      }
      if(action==='workbench-task-expand'){
        P.workbenchAll=!P.workbenchAll;
        content();
        if(P.workbenchAll)document.querySelector('[data-action="workbench-task-expand"]')?.focus({preventScroll:true});
        else{
          const tasks=document.querySelector('#workbench-tasks');
          tasks.focus({preventScroll:true});
          tasks.scrollIntoView({block:'start'});
        }
        return;
      }
      if(action==='workbench-active'){
        const {owner}=workbenchModel(S,P.owner);
        navigate('opportunities',{opportunityView:'work',risk:'active',owner,stage:'',q:'',customerLevel:'',saleType:'',from:'',to:''});
        return;
      }
      if(action==='workbench-timeline'){
        const {owner}=workbenchModel(S,P.owner);
        navigate('activities',{activityOwner:owner,activityFrom:'',activityTo:'',activityCustomer:'',activityOpportunity:'',activitySource:'',activityType:'',activityQ:'',activityStatus:'active',activityPage:1,source:''});
        return;
      }
    }
    if(['activity-refresh','performance-refresh'].includes(action)){await refreshAuditWorkspace(true);return;}
    if(action==='activity-reset'){
      Object.assign(getP(),{activityFrom:'',activityTo:'',activityOwner:'',activityCustomer:'',activityOpportunity:'',activitySource:'',activityType:'',activityQ:'',activityStatus:'',activityPage:1,source:''});content();return;
    }
    if(action==='activity-page'){getP().activityPage=Number(id)||1;content();document.querySelector('.activity-workspace')?.scrollIntoView({block:'start'});return;}
    if(action==='performance-status-filter'){getP().performanceStatus=id||'all';content();return;}
    if(action==='performance-target'){openForm('target',id,el.dataset.quarter||'');return;}
    if(['activity-event-detail','activity-legacy-detail'].includes(action)){
      panel=null;formReturn=null;openHtml(activityEventDetail(S,Number(id),action==='activity-legacy-detail'),true);
      const review=current==='performance'&&S.performance.find(p=>p.user_id===Number(el.dataset.userId));
      if(review?.status==='confirmed')dialog.querySelector('.dialog-body')?.insertAdjacentHTML('afterbegin',`<p class="activity-lock-note">当前原始记录可能已更新；${esc(review.month)} 绩效评分以卡片保存的锁定快照为准。</p>`);
      return;
    }
    if(['activity-event-edit','activity-event-void','activity-legacy-edit','activity-legacy-void'].includes(action)){panel=null;openForm(action,id);return;}
    if(action==='performance-quote-detail'){panel=null;formReturn=null;openHtml(performanceQuoteDetail(S,Number(id),Number(el.dataset.userId)),true);return;}
    if(action.startsWith('minutes-')){await minutesController.click(action,id,el);return;}
    if (action === "demo-login") {
      el.disabled = true;
      try {
        await login({ demo_user_id: Number(id) });
      } finally {
        el.disabled = false;
      }
      return;
    }
    if(action==='dingtalk-login') {const r=await api('/auth/dingtalk/start');location.assign(r.url);return;}
    if(action==='developer-select') {await switchIdentity(id);return;}
    if(action==='workflow-view'){
      if(!['daily','ledger'].includes(id))return;
      getP().tableView=id;content();return;
    }
    if(action==='workflow-filter'){getP().workflowFilter=id||'';content();return;}
    if(action==='workspace-tab'){
      if(!['overview','payments','attachments','history'].includes(id))return;
      if(panel)panel.tab=id;
      for(const section of dialog.querySelectorAll('[data-workspace-panel]'))section.hidden=section.dataset.workspacePanel!==id;
      for(const tab of dialog.querySelectorAll('[data-action="workspace-tab"]')){tab.classList.toggle('active',tab.dataset.id===id);tab.setAttribute('aria-selected',String(tab.dataset.id===id));}
      return;
    }
    if(action==='receipt-fill-balance'){
      const form=el.closest('form'),p=S.contracts.flatMap(c=>c.payments).find(p=>p.id===Number(id));
      if(form&&p){form.elements.amount.value=(p.remaining_amount??p.amount)/100;form.elements.amount.dispatchEvent(new Event('input',{bubbles:true}));form.elements.amount.focus();}return;
    }
    if(action==='contract-expenses'){await showExpenses(id);return;}
    if(action==='expense-restore'){await showRecyclePreview({type:'expense',id});return;}
    if(['expense-new','expense-edit','expense-delete'].includes(action)){
      const contractId=action==='expense-new'?Number(id):expenseData?.contract.id;
      if(!contractId)throw new Error('请从合同费用支出列表选择记录');
      expenseData=await api('/contracts/'+contractId+'/expenses');openHtml(expenseForm(S,action,id,expenseData));return;
    }
    if(action==='admin-recycle'||action==='records-recycle'){await showRecycle(action==='admin-recycle'?{contract_id:id}:{});return;}
    if(action==='admin-restore-contract'||action==='admin-restore-item'||action==='admin-restore-record'){
      const type=action==='admin-restore-contract'?'contract':action==='admin-restore-item'?'item':null;
      if(type){await showRecyclePreview({type,id});return;}
      await showRecycle({});return;
    }
    if(action==='data-review'||action==='review-list'){await showReview();return;}
    if(action==='review-contract'){const data=await api('/data-review?contract_id='+id);openHtml(reviewEditor(S,{...data.detail,review_change:reviewChanges.get(Number(id))}));return;}
    if(action==='review-queue'||action==='review-open-queue'){openHtml(reviewQueue([...reviewChanges.values()],reviewReason),true);return;}
    if(action==='review-remove'){reviewChanges.delete(Number(id));openHtml(reviewQueue([...reviewChanges.values()],reviewReason),true);return;}
    if(action==='settlement-review'){const data=await api('/settlement-review'+(id?'?contract_id='+id:''));openHtml(settlementReview(S,data),true);return;}
    if(action.startsWith('admin-delete-')||action.startsWith('admin-restore-')||action==='admin-resume-contract'){
      const routes={'admin-restore-plan':['/payments/'+id+'/reopen','POST','恢复收款计划'],'admin-restore-item':['/items/'+id+'/restore','POST','恢复明细'],'admin-delete-payment':['/payments/'+id,'DELETE','删除回款／计划'],'admin-delete-attachment':['/attachments/'+id,'DELETE','删除合同附件'],'admin-restore-record':['/record-recycle/'+id+'/restore','POST','恢复记录'],'admin-restore-contract':['/contracts/'+id+'/restore','POST','恢复合同'],'admin-resume-contract':['/contracts/'+id+'/resume','POST','恢复履约']};
      const [path,method,title]=routes[action];openHtml(formShell(title,'数据处理：保留原因和历史记录，保存后重新核对当前汇总。',`<input type="hidden" name="path" value="${path}"><input type="hidden" name="method" value="${method}">`+textarea('reason','处理原因','',true)+`<label class="wide"><input type="checkbox" name="confirmed" required>确认本次处理，历史记录继续保留</label>`,'admin-record',id,title));return;
    }
    if(action==='contract-history'){
      const result=await api('/contracts/history');panel=null;formReturn=null;openHtml(contractHistoryList(S,result.contracts),true);return;
    }
    if(action==='contract-history-detail'){
      const result=await api('/contracts/'+id+'/history');panel=null;formReturn=null;openHtml(contractWorkspace(S,result,{readonly:true,context:'history'}),true);return;
    }
    if(action==='manual-entry') {
      const choices=manualChoices(S,getP());
      if(choices.length===1)openForm(choices[0].type,choices[0].id??'');
      else {panel=null;formReturn=null;openHtml(manualChooser(S,getP()));}
      return;
    }
    if(action==='manual-open') {
      const choice=manualChoices(S,getP()).find(c=>c.type===el.dataset.type&&String(c.id??'')===String(id??''));
      if(!choice||!manualFormRoles[choice.type]?.includes(S.actor.role))throw new Error('当前账号不能新建此类记录');
      openForm(choice.type,choice.id??'');return;
    }
    if(['contract-delete','contract-meta','contract-items','contract-upload','contract-terminate','payment-void','payment-reconcile','payment-maintain','contract-maintain','contract-project','item-margin','payment-plan','contract-extract','collection-receive'].includes(action)){openForm(action,id);return;}
    if(action==='collection'){openPanel('collection',id);return;}
    if(action==='contract-collections'){if(dialog.open)dialog.close();panel=null;formReturn=null;navigate('collections',{contractId:Number(id),q:'',owner:'',stage:'',level:'',customerLevel:'',saleType:'',from:'',to:'',risk:''});return;}
    if(action==='commission-last-month'){const date=new Date(S.today+'T12:00:00Z');date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-1);commissionPeriod=date.toISOString().slice(0,7);await reload();return;}
    if(['commission-previous-period','commission-next-period','commission-current-period'].includes(action)){
      const selected=S.commission.period||S.today.slice(0,7);
      commissionPeriod=action==='commission-current-period'?currentCommissionPeriod(selected,S.today):shiftCommissionPeriod(selected,action==='commission-previous-period'?-1:1);
      await reload();return;
    }
    if(action==='commission-issue'){await openCommissionIssue(el);return;}
    if(action==='commission-export-choose'){
      openHtml(`<header class="dialog-head"><div><h2>导出提成数据</h2><p>${esc(S.commission.period)} · 按当前人员、搜索和状态筛选导出</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="dialog-body commission-export-options"><button class="btn secondary" data-action="commission-export-summary">导出人员汇总</button><p>按销售和实际计算周期列示实时金额。</p><button class="btn secondary" data-action="commission-export-detail">导出合同明细</button><p>核对合同、基数、比例与当前计提金额。</p><button class="btn secondary" data-action="commission-export-issues">导出待完善清单</button><p>列出问题、责任人与建议处理方式，方便集中补资料。</p></div>`);return;
    }
    if(['commission-export-summary','commission-export-detail','commission-export-issues'].includes(action)){
      exportList('commissions',action==='commission-export-detail'?'detail':action==='commission-export-issues'?'issues':'summary');return;
    }
    if(action==='commission-refresh'){await refreshRealtimeCommissions(true);return;}
    if(action==='collections-clear'){getP().contractId='';content();return;}
    if(action==='opportunity-advice'){
      const selected=S.opportunities.find(o=>o.id===Number(id));if(!selected)throw new Error('商机不存在');
      el.disabled=true;
      try{const value=await api('/opportunities/'+id+'/ai-advice',{method:'POST',body:{}});selected.ai_advice=value;if(panel?.type==='opportunity'&&panel.id===Number(id))openPanel('opportunity',id);}
      finally{if(el.isConnected)el.disabled=false;}return;
    }
    if(action==='company-profile-refresh'||action==='refresh-company-profile'){
      el.disabled=true;try{
        toast('正在查询企业资料');
        const result=await api('/customers/'+id+'/company-profile/refresh',{method:'POST',body:{}});
        const feedback=companyProfileFeedback(result.company_profile);
        if(feedback.pending)profileRequests.set(Number(id),S.actor.id);
        else toast(feedback.message,feedback.error);
        await reload();if(panel?.type==='customer'&&panel.id===Number(id))openPanel('customer',id);
      }finally{if(el.isConnected)el.disabled=false;}return;
    }
    if(action==='query-all-company-profiles'){
      el.disabled=true;
      try{const result=await api('/company-profiles/query-all',{method:'POST',body:{}});await reload();toast(result.pause_reason||'已手动启动剩余资料查询，进度会自动更新',!!result.pause_reason);}
      finally{if(el.isConnected)el.disabled=false;}return;
    }
    if(action==='archive-contract'){if(!canManageContractData(S))throw new Error('当前角色不能确认合同签署');openForm('archive-contract',id);return;}
    if(action==='payment-allocation'){openForm('payment-allocation',id);return;}
    if(action==='record-attachment'){downloadFile(await api('/attachments/'+id));return;}
    if(Object.hasOwn(manualCreateActions,action)){openForm(manualCreateActions[action],id||'');return;}
    if(action==='ai-destination') {
      const view=el.dataset.view;if(!Object.hasOwn(pages,view))throw new Error('导入去向无效');
      if(['customer','opportunity','contract'].includes(el.dataset.detail)){openPanel(el.dataset.detail,el.dataset.record);return;}
      navigate(view);
      return;
    }
    if(['edit-customer','edit-contact','customer-transfer','edit-opportunity','opportunity-stage'].includes(action)){openForm(action,id);return;}
    if(action==='opportunity-view'){getP().opportunityView=id;getP().risk='';getP().sort='';if(id==='ledger')getP().owner='';content();return;}
    if(action==='customer-transfer-refresh'){await refreshCustomerTransfer(el.closest('form'));return;}
    if(action==='customer-scope'){getP().customerScope=id;getP().owner='';content();return;}
    if(action==='customer-duplicate-open'){openPanel('customer',id);return;}
    if(action==='copy-contact'){
      const value=el.dataset.value||'';if(!value)return;
      try{await navigator.clipboard.writeText(value);toast('联系方式已复制');}
      catch{toast('无法自动复制，请选中联系方式手动复制。',true);}return;
    }
    if(action==='ai-start'||action==='maintenance-attachments'||aiDataActions.has(action)) {
      const intent=action==='maintenance-attachments'?'edit-contract':el.dataset.intent||action;
      const names={'edit-customer':'客户','new-contact':'客户','edit-contact':'联系人','edit-opportunity':'商机','new-activity':'商机','new-quote':'商机',convert:'商机','new-payment':'合同','edit-contract':'合同','edit-item':'合同行项','receive-payment':'收款计划','edit-user-mapping':'成员','toggle-user':'成员','commission-pay':'提成','payment-checkpoint':'收款计划'};
      const context=id?{intent,id:Number(id),label:`${names[intent]||'业务记录'}维护`}:{intent,label:'资料识别与维护'};
      if(dialog.open)dialog.close();panel=null;formReturn=null;
      navigate('intake');getP().intakeContext=context;getP().batch=null;getP().previousBatch=null;content();return;
    }
    if(action==='ai-batch') {const page=getP();const batch=await api('/ai/batches/'+id);page.batch=batch;page.previousBatch=null;if(current===page.view){content();document.querySelector('.ai-preview')?.scrollIntoView({block:'start'});}return;}
    if(action==='ai-supplement') {getP().previousBatch=Number(id);getP().batch=null;content();document.querySelector('.ai-receiver textarea').focus();return;}
    if(action==='ai-validate'||action==='ai-cancel') {const page=getP();el.disabled=true;try{const r=await api(`/ai/batches/${id}/${action==='ai-validate'?'validate':'cancel'}`,{method:'POST',body:{}});page.batch=await api('/ai/batches/'+id);await reload();toast(r.message,r.valid===false);}finally{el.disabled=false;}return;}
    if(action==='ai-file') {const file=await api('/ai/files/'+id);const data=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([data],{type:'application/octet-stream'}));const a=document.createElement('a');a.href=url;a.download=file.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
    if(action==='download-quote'||action==='download-contract') {
      const kind=action==='download-quote'?'quote':'contract';
      const file=await api(`/documents/${kind}/${id}`);
      downloadFile(file);
      toast(file.official?'已导出公司模板文件':'已导出内部核对稿');return;
    }
    if (action === "close") {
      close();
      return;
    }
    if (action === "menu") {
      document.querySelector("#sidebar").classList.toggle("open");
      return;
    }
    if (action === "reload") {
      el.disabled = true;
      await reload();
      toast("数据已刷新");
      return;
    }
    if (["customer", "opportunity", "contract"].includes(action)) {
      openPanel(action, id);
      return;
    }
    const forms = { 'sales-commission-policy':'sales-commission-policy','finance-rules':'finance-rules','stage-rules':'rules','document-templates':'document-templates','performance-rules':'performance-rules','customer-level':'customer-level','customer-levels':'customer-levels','performance-review':'performance-review', target:'target' };
    if (forms[action]) {
      openForm(forms[action], id, el.dataset.quarter||'');
      return;
    }
    if(action==='person-board') {
      const month=managementMonth(S,{managementMonth:el.dataset.month});
      navigate('personal',{owner:id,managementMonth:month,from:'',to:'',level:'',saleType:''});
      return;
    }
    if(action==='personal-workbench'&&current==='personal'&&S.actor.role==='admin'){
      navigate('workbench',{owner:id,workbenchTask:'all',workbenchAll:false});return;
    }
    if(action==='team-member-performance'&&['team','personal'].includes(current)){
      reportMonth=managementMonth(S,{managementMonth:el.dataset.month});
      navigate('performance',{performanceOwner:id,performanceQ:'',performanceStatus:'all'});return;
    }
    if(action==='team-member-commission'&&current==='team'){
      commissionPeriod=managementMonth(S,{managementMonth:el.dataset.month});
      navigate('commissions',{owner:id,commissionQ:'',commissionStatus:'',commissionHistoryPeriod:''});return;
    }
    if(action==='export-team') {exportList('team');return;}
    if (action === "stage-filter") {
      const previous=getP(),fromDashboard=['analytics','funnel','personal','assets'].includes(current);
      navigate("opportunities", {opportunityView:'work',stage:id,risk:['赢单','输单','搁置'].includes(id)?'all':'active',q:'',owner:fromDashboard?(previous.owner||(current==='personal'?String(S.actor.id):'')):previous.owner||'',customerLevel:fromDashboard?previous.level||'':previous.customerLevel||'',saleType:previous.saleType||'',from:previous.from||'',to:previous.to||''});
      return;
    }
    if (action === "due-filter") {
      navigate("opportunities", followupFilters(S,getP()));
      return;
    }
    if (action === "risk-filter") {
      getP().risk = id;
      content();
      return;
    }
    if (action === "reset-filters") {
      if(current==='analytics')getP().analyticsFiltersOpen=true;
      Object.assign(getP(), {
        followupScope: false,
        q: "",
        owner: "",
        stage: "",
        level: "",
        risk: "",
        sort: "",
        from:'',to:'',source:'',saleType:'',customerLevel:'',
        managementPreset:'this-month',
        workflowFilter:'',
      });
      content();
      return;
    }
    if (action === "source-filter") {
      getP().source = id;
      content();
      return;
    }
    if (action === "sort") {
      const P = getP();
      P.desc = P.sort === id ? !P.desc : true;
      P.sort = id;
      content();
      return;
    }
    if (action === "add-item") {
      const rows = dialog.querySelectorAll(".item-row");
      if (rows.length >= 30) {
        toast("最多添加30个行项", true);
        return;
      }
      dialog
        .querySelector("#contract-items")
        .insertAdjacentHTML("beforeend", contractItemRow(S, rows.length));
      return;
    }
    if(action==='add-quote-item') {
      const rows=dialog.querySelectorAll('.quote-item-row');if(rows.length>=30){toast('最多添加30项报价明细',true);return;}
      dialog.querySelector('#quote-items').insertAdjacentHTML('beforeend',quoteItemRow(rows.length));syncQuoteTotal(dialog.querySelector('form'));return;
    }
    if(action==='remove-quote-item') {
      if(dialog.querySelectorAll('.quote-item-row').length<=1){toast('至少保留一项报价明细',true);return;}
      el.closest('.quote-item-row').remove();syncQuoteTotal(dialog.querySelector('form'));return;
    }
    if (action === "remove-item") {
      if (dialog.querySelectorAll(".item-row").length <= 1) {
        toast("至少保留一个合同行项", true);
        return;
      }
      el.closest(".item-row").remove();
      return;
    }
    if (action === "account") {
      panel = null;
      openHtml(
        `<header class="dialog-head"><div><h2>当前账号</h2><p>${esc(S.actor.name)} · ${S.actor.role === "admin" ? "管理员" : "销售"}</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon("close")}</button></header><div class="dialog-body"><p>登录身份由服务端会话确认。</p>${S.demo ? '<p class="muted">退出后可以选择其他演示身份，检查不同角色的数据范围。</p>' : ""}</div><footer class="dialog-footer">${button("关闭", "close", "", "ghost")}${button(S.demo ? "退出并切换身份" : "退出登录", "logout", "", "secondary", "logout")}</footer>`,
      );
      return;
    }
    if (action === "logout") {
      await api("/auth/logout", { method: "POST", body: {} });
      livePresence.stop();
      setSimulationIdentity('');
      setCsrf("");
      await showLogin();
      return;
    }
    if (action === "export") {
      exportList();
      return;
    }
    if (action === "toggle-user") {
      const u = S.users.find((u) => u.id === Number(id));
      panel = null;
      openHtml(
        `<form data-form="toggle-user" data-id="${u.id}" data-key="${crypto.randomUUID()}"><header class="dialog-head"><div><h2>${u.active ? "停用" : "启用"} ${esc(u.name)}</h2><p>${u.active ? "停用后，该成员的现有登录会话立即失效，业务记录保留。" : "启用后，该成员可以再次登录。"}</p></div><button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon("close")}</button></header><div class="dialog-body"><p class="form-error" role="alert"></p></div><footer class="dialog-footer"><button type="button" class="btn ghost" data-action="close">取消</button><button class="btn ${u.active ? "danger" : "primary"}" type="submit">确认${u.active ? "停用" : "启用"}</button></footer></form>`,
      );
      return;
    }
    if (action === "person-evidence") {
      const u = S.users.find((u) => u.id === Number(id));
      const kind = el.dataset.kind;
      const ownOpp = S.opportunities.filter((o) => o.owner_id === u.id);
      const oppIds = new Set(ownOpp.map((o) => o.id));
      const rows =
        kind === "新增漏斗"
          ? ownOpp.filter((o) => o.created_at.startsWith(S.period))
          : kind === "对客报价"
            ? S.quotes.filter(
                (q) => q.user_id === u.id && q.created_at.startsWith(S.period),
              )
            : S.activities.filter(
                (a) =>
                  oppIds.has(a.opportunity_id) &&
                  a.activity_type === kind &&
                  a.activity_date.startsWith(S.period),
              );
      panel = null;
      openHtml(
        `<header class="dialog-head"><div><h2>${esc(u.name)} · ${esc(kind)}</h2><p>${S.period} · ${rows.length} 条计分依据</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon("close")}</button></header><div class="drawer-body">${
          kind === "线上会议" || kind === "现场拜访"
            ? timeline(S, rows)
            : rows
                .map((r) => {
                  const o =
                    kind === "新增漏斗"
                      ? r
                      : S.opportunities.find((o) => o.id === r.opportunity_id);
                  return `<button class="linked-record" data-action="opportunity" data-id="${o.id}"><span><b>${esc(o.name)}</b><small>${plainMoney(r.amount)}</small></span>${icon("chevron")}</button>`;
                })
                .join("") ||
              empty("本月暂无该项记录", "真实业务记录会自动进入过程统计。")
        }</div>`,
        true,
      );
      return;
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  if(form.dataset.form.startsWith('minutes-')){try{await minutesController.submit(form);}catch(err){toast(err.message,true);}return;}
  const type = form.dataset.form,
    id = Number(form.dataset.id);
  if(type==='locked-record'){close();return;}
  if(form.querySelector('[type=submit]').disabled)return;
  const b = Object.fromEntries(new FormData(form));
  const submittedPage=getP();
  const submittedScroll={top:window.scrollY,left:document.querySelector('.workflow-ledger-table')?.parentElement.scrollLeft||0};
  const submit = form.querySelector("[type=submit]");
  const label = submit.innerHTML;
  const error = form.querySelector(".form-error");
  error.textContent = "";
  submit.disabled = true;
  submit.innerHTML = '<span class="loader mini"></span> 正在保存…';
  try {
    if(type==='review-stage'){const change=collectReviewChange(form);reviewChanges.set(change.contract_id,change);openHtml(reviewQueue([...reviewChanges.values()],reviewReason),true);toast('已加入待核对清单，尚未保存业务数据');return;}
    if(type==='review-preview'){const changes=JSON.parse(b.changes);reviewReason=b.reason;const result=await api('/data-review/preview',{method:'POST',body:{changes,reason:b.reason},key:form.dataset.key});openHtml(reviewPreview(result,changes,b.reason),true);return;}
    if(type==='review-apply'){if(b.confirmed!=='on')throw new Error('请核对预览并确认');const payload=JSON.parse(b.payload);const result=await api('/data-review/apply',{method:'POST',body:payload,key:form.dataset.key});reviewChanges.clear();reviewReason='';await reload();await showReview();toast(result.message);return;}
    if(type.startsWith('expense-')){const request=expenseRequest(type,id,b);if(!request)throw new Error('费用操作无效');const result=await api(request.path,{method:request.method,body:request.body,key:form.dataset.key});await reload();await showExpenses(request.contractId);toast(result.message||'合同费用已保存');return;}
    if(type==='ai-intake') {
      const page=getP();setIntakeBusy(form,true);
      const files=[...form.querySelector('[name=files]').files];
      if(files.length>5||files.some(f=>f.size>10*1024*1024)||files.reduce((n,f)=>n+f.size,0)>20*1024*1024)throw new Error('最多5个文件，单文件10MB、总计20MB');
      const uploaded=await Promise.all(files.map(file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,base64:String(reader.result).split(',')[1]});reader.onerror=()=>reject(new Error('读取文件失败，请重新选择'));reader.readAsDataURL(file);})));
      submit.innerHTML='<span class="loader mini"></span> 正在识别资料并校验…';
      const result=await api('/ai/intake',{method:'POST',body:{text:b.text||'',files:uploaded,context:page.intakeContext||{},...(b.previous_batch_id?{previous_batch_id:Number(b.previous_batch_id)}:{})},key:form.dataset.key});
      page.batch=await api('/ai/batches/'+result.id);page.previousBatch=null;page.intakeContext=null;clearIntakeUpload(form);
      await reload();if(current==='intake')document.querySelector('.ai-preview')?.scrollIntoView({block:'start'});toast(result.message,result.valid===false);return;
    }
    if(type==='ai-confirm') {
      const page=getP();
      const result=await api(`/ai/batches/${id}/confirm`,{method:'POST',body:{version:Number(form.dataset.version),acknowledged:b.acknowledged==='on'},key:form.dataset.key});
      page.batch=await api('/ai/batches/'+id);await reload();toast(result.message);return;
    }
    if (type === "login") {
      await login(b);
      return;
    }
    let path = "",
      method = "POST",
      body = b;
    let returnTo = formReturn;
    if (type === "customer") path = "/customers";
    if(type==='customer')body.duplicate_ack=b.duplicate_ack==='on';
    if (type === "edit-customer") {
      path = "/customers/" + id;
      method = "PATCH";
    }
    if(type==='customer-transfer'){path='/customers/'+id;method='PATCH';}
    if (type === "contact") {
      path = "/contacts";
      body.customer_id = b.customer_id||id;
    }
    if (type === 'edit-contact') { path='/contacts/'+id; method='PATCH'; }
    if(['edit-customer','edit-contact','customer-transfer'].includes(type)){
      body=customerEditPayload(S,type,id,b);
      if(!Object.keys(body).length){close();toast('没有需要保存的修改');return;}
    }
    if (type === "opportunity") path = "/opportunities";
    if(type==='opportunity'&&(body.product_amount==null||String(body.product_amount).trim()===''))throw new Error('请填写cash金额（元）；无产品金额时请明确填写0');
    if (type === "edit-opportunity"||type==='opportunity-stage') {
      path = "/opportunities/" + id;
      method = "PATCH";
      body=opportunityEditPayload(S,type,id,b);
      if(!Object.keys(body).length){close();toast('没有需要保存的修改');return;}
      if(Object.hasOwn(body,'product_amount')&&(body.product_amount==null||String(body.product_amount).trim()==='')){
        const previous=S.opportunities.find(record=>record.id===id);
        if(previous?.product_amount==null)delete body.product_amount;
        else throw new Error('已有cash金额不能清空；无产品金额时请明确填写0');
      }
    }
    if (type === "activity") {path = "/activities";body=activityPlanPayload(form,b);}
    if(type==='activity-event-edit'){path='/activity-events/'+id;method='PATCH';}
    if(type==='activity-event-void'){path='/activity-events/'+id+'/void';body={...b,confirmed:true};}
    if(type==='activity-legacy-edit'){path='/activities/'+id;method='PATCH';}
    if(type==='activity-legacy-void'){path='/activities/'+id+'/void';body={...b,confirmed:true};}
    if (type === "quote") {
      path = "/quotes";
      const file=await contractFile(form,'报价附件');
      const items=[...form.querySelectorAll('.quote-item-row')].map(row=>{
        const item=Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input=>[input.dataset.field,input.value]));
        item.discount_rate=Number(item.discount_percent)/100;delete item.discount_percent;return item;
      });
      body={opportunity_id:b.opportunity_id||id,items,note:b.note,...(file?{file}:{})};
    }
    if (type === "contract" || type === "convert") {
      path = "/contracts";
      if (type === "convert") body.opportunity_id = id;
      if(body.owner_id==='')delete body.owner_id;
      body.items = [...form.querySelectorAll(".item-row")].map((row) =>
        Object.fromEntries(
          [...row.querySelectorAll("[data-field]")].map((i) => [
            i.dataset.field,
            i.value,
          ]),
        ),
      );
    }
    if(['contract-maintain','contract-project','contract-meta','contract-items'].includes(type)){
      path='/contracts/'+id;method='PATCH';
      if(form.querySelector('.maintenance-items')){path='/contracts/'+id+'/maintenance';body=maintenancePayload(form);}else{const prior=S.contracts.find(c=>c.id===id);for(const key of Object.keys(body))if(key!=='reason'&&String(body[key]??'')===String(prior?.[key]??''))delete body[key];}
      returnTo=formReturn||{type:type==='contract-project'?'collection':'contract',id,tab:'overview'};
    }
    if(type==='contract-delete'){path='/contracts/'+id;method='DELETE';body.confirmed=body.confirmed==='on';returnTo=null;}
    if(type==='payment-maintain'){path='/payments/'+id+'/details';method='PATCH';const parent=S.contracts.find(c=>c.payments.some(p=>p.id===id));returnTo={type:current==='collections'?'collection':'contract',id:parent.id};}
    if(type==='payment-maintain'){
      const prior=S.contracts.flatMap(c=>c.payments).find(p=>p.id===id);
      body.duplicate_confirmed=b.duplicate_confirmed==='on';
      if(prior.status==='已到账'){body.promise_date=prior.promise_date||undefined;body.checkpoint_date=prior.checkpoint_date||undefined;}
    }
      if(type==='item-margin'){
        path='/items/'+id;method='PATCH';
        const prior=S.contracts.flatMap(c=>c.items).find(i=>i.id===id);
        if(body.margin===''||prior?.margin!=null&&Number(body.margin)===prior.margin/100)delete body.margin;
        for(const key of ['name','kind','payment_date','valid_until'])if(String(body[key]??'')===String(prior?.[key]??''))delete body[key];
      if(body.margin_percent!==undefined&&body.margin_percent!=='')body.margin_rate=Number(body.margin_percent)/100;
      delete body.margin_percent;
      const parent=S.contracts.find(c=>c.items.some(i=>i.id===id));returnTo={type:'contract',id:parent.id};
    }
    if(type==='collection-receive'){path='/payments/'+id+'/receive';body.duplicate_confirmed=b.duplicate_confirmed==='on';}
    if(type==='payment-plan'){path='/payments/'+id;method='PATCH';}
    if(type==='contract-extract'){path='/contracts/'+id+'/extract-attachment';body={attachment_id:Number(body.attachment_id)};returnTo={type:'contract',id};}
    if((type==='contract'||type==='convert')&&body.items)body.items=body.items.map(item=>{const value={...item};if(value.margin_percent!==undefined&&value.margin_percent!=='')value.margin_rate=Number(value.margin_percent)/100;delete value.margin_percent;return value;});
    if (type === "payment") {
      path = "/payments";
      body.contract_id = b.contract_id||id;
      body.status='已到账';body.duplicate_confirmed=b.duplicate_confirmed==='on';
    }
    if(type==='payment-plan-create'){path='/payments';body.contract_id=b.contract_id||id;body.status='待到账';}
    if(type==='payment-void'){path='/payments/'+id+'/void-plan';body.confirmed=b.confirmed==='on';}
    if(type==='payment-reconcile'){path='/payments/'+id+'/reconcile';}
    if(type==='archive-contract'){
      path='/contracts/'+id+'/archive';const file=await contractFile(form);
      body={both_stamped:b.both_stamped==='on',...(b.archive_attachment_id?{archive_attachment_id:Number(b.archive_attachment_id)}:{}),...(file?{file}:{})};
    }
    if(type==='contract-upload'){path='/contracts/'+id+'/attachments';const file=await contractFile(form);if(!file)throw new Error('请选择要上传的合同附件');body={file};returnTo={...(formReturn||{type:'contract',id}),tab:'attachments',scrollTop:0};}
    if(type==='contract-terminate'){path='/contracts/'+id+(canManageContractData(S)?'/termination':'/termination-request');body={reason:b.reason,...(canManageContractData(S)?{decision:b.decision||'approved',confirmed:b.confirmed==='on'}:{})};returnTo={...(formReturn||{type:'contract',id}),tab:'overview',scrollTop:0};}
    if (type === "receive-payment") path = "/payments/" + id + "/receive";
    if (type === "edit-contract") {
      path = "/contracts/" + id;
      method = "PATCH";
    }
    if (type === "edit-item") {
      path = "/items/" + id;
      method = "PATCH";
      const i = S.contracts.flatMap((c) => c.items).find((i) => i.id === id);
      if (Number(body.margin) === i.margin / 100) delete body.margin;
    }
    if (type === "target") path = "/targets";
    if (type === "user") {path = "/users";body.dingtalk_only=true;}
    if (type === "toggle-user") {
      path = "/users/" + id;
      method = "PATCH";
      body = { active: !S.users.find((u) => u.id === id).active };
    }
    if (type === "rules") {
      path = "/rules";
      method = "PATCH";
      body = { thresholds: {}, sop: {} };
      for (const [k, v] of Object.entries(b)) {
        if (k.startsWith("threshold:"))
          body.thresholds[k.slice(10)] = Number(v);
        if (k.startsWith("sop:")) body.sop[k.slice(4)] = v;
      }
    }
    if(type==='customer-level'){path='/customers/'+id;method='PATCH';}
    if(type==='performance-review') {path='/performance/review';body.user_id=id;}
    if(type==='performance-rules') {path='/rules';method='PATCH';body={performance:Object.fromEntries(Object.entries(b).filter(([k])=>k.startsWith('performance:')).map(([k,v])=>[k.slice(12),Number(v)]))};}
    if(type==='payment-allocation')path='/payments/'+id+'/allocation';
    if(type==='payment-checkpoint')path='/payments/'+id+'/checkpoint';
    if(type==='user-mapping') {path='/users/'+id;method='PATCH';}
    if(type==='bulk-targets')path='/targets/bulk';
    if(type==='document-templates') {path='/integrations/config';method='PATCH';body={documents:{...b,confirmed:b.confirmed==='true'}};}
    if(type==='customer-levels'){path='/rules';method='PATCH';body={customer_levels:b.levels.split(/[,，\n]/).map(v=>v.trim()).filter(Boolean)};}
    if(type==='finance-rules') {
      path='/rules';method='PATCH';body={commission:{}};
      for(const [key,value] of Object.entries(b)) {
        if(key.startsWith('commission:')) {const k=key.slice(11);body.commission[k]=k==='period'?value:k==='unlock_by_payment'?value==='true':k==='threshold'?Math.round(Number(value)*100):k==='manager_id'?Number(value):Number(value)/100;}
      }
    }
    if(type==='sales-commission-policy') {path='/rules';method='PATCH';body={commission:{sales_policy:salesPolicyFromForm(S.rules.commission.sales_policy,b)}};}
    if(['payment','payment-plan-create','payment-plan','payment-void','payment-reconcile','payment-maintain','payment-allocation','collection-receive'].includes(type)){
      const parent=body.contract_id?S.contracts.find(c=>c.id===Number(body.contract_id)):S.contracts.find(c=>c.payments.some(p=>p.id===id));
      if(parent)returnTo={type:formReturn?.type==='contract'?'contract':formReturn?.type==='collection'?'collection':current==='collections'?'collection':'contract',id:parent.id,tab:'payments',scrollTop:formReturn?.tab==='payments'?formReturn.scrollTop||0:0,paymentId:formReturn?.paymentId};
    }
    if(['contract-maintain','contract-items','contract-meta','contract-delete','payment-maintain','payment-allocation','item-margin'].includes(type)&&canManageContractData(S)){body.data_correction=true;}
    if(type==='item-margin'){delete body.amount;delete body.margin_percent;}
    if(type==='admin-record'){path=b.path;method=b.method;body={reason:b.reason,confirmed:b.confirmed==='on'};returnTo=null;}
    const result = await api(path, { method, body, key: form.dataset.key });
    const showSavedDetail=dialog.open&&dialog.contains(form);
    if(showSavedDetail){dialog.close();panel=null;formReturn=null;}
    try {
      await reload();
    } catch (err) {
      toast("保存已成功，但列表刷新失败；请点击刷新重新读取。", true);
      return;
    }
    if (type === "customer") returnTo = { type: "customer", id: result.id };
    if (type === "opportunity")
      returnTo = { type: "opportunity", id: result.id };
    if (type === "contract" || type === "convert")
      returnTo = { type: "contract", id: result.id };
    if(type==='contact')returnTo={type:'customer',id:Number(body.customer_id)};
    if(type==='quote'||type==='activity')returnTo={type:'opportunity',id:Number(body.opportunity_id)};
    if(type==='activity'&&current==='activities')returnTo=null;
    if(type==='archive-contract')returnTo={type:'contract',id:Number(id),tab:'payments',scrollTop:0};
    if(['contracts','collections'].includes(current)&&current===submittedPage.view){window.scrollTo(0,submittedScroll.top);const table=document.querySelector('.workflow-ledger-table');if(table)table.parentElement.scrollLeft=submittedScroll.left;}
    if (returnTo&&showSavedDetail&&current===submittedPage.view&&!dialog.open) openPanel(returnTo.type, returnTo.id,returnTo);
    if(['activity-event-edit','activity-event-void','activity-legacy-edit','activity-legacy-void'].includes(type)&&showSavedDetail&&current===submittedPage.view&&!dialog.open)openHtml(activityEventDetail(S,result.id),true);
    if(type==='admin-record'&&form.querySelector('.recycle-preview-context'))await showRecycle(recycleFilters);
    toast(result.message || "已保存");
  } catch (err) {
    showCollectionError(form,err);
    error.textContent = err.message;
    if(error.isConnected){error.scrollIntoView({block:'start'});error.focus({preventScroll:true});}else toast(err.message,true);
  } finally {
    if(type==='ai-intake')setIntakeBusy(form,false);
    form.removeAttribute('aria-busy');
    submit.disabled = false;
    submit.innerHTML = label;
  }
});
async function switchIdentity(id) {
  if(identitySwitchBusy||!S?.developer)return;
  if(Number(id)===S.actor.id){document.querySelector('#developer-picker').open=false;return;}
  identitySwitchBusy=true;
  const controls=document.querySelector('.developer-session-controls');
  controls.querySelectorAll('button,input').forEach(el=>el.disabled=true);
  controls.querySelector('summary').setAttribute('aria-disabled','true');
  try {
    const result=await api('/developer/identity',{method:'POST',body:{memberId:Number(id)}});
    setSimulationIdentity(result.actor.id);
    // Reload the complete workspace so filters, drawers and cached records cannot cross identities.
    history.replaceState(null,'','#workbench');
    location.reload();
  } catch(error) {
    identitySwitchBusy=false;
    controls.querySelectorAll('button,input').forEach(el=>el.disabled=false);
    controls.querySelector('summary').removeAttribute('aria-disabled');
    throw error;
  }
}

document.addEventListener("change", async (e) => {
  if (!S) return;
  if(current==='analytics'&&e.target.closest('.analytics-filters'))getP().analyticsFiltersOpen=true;
  if(e.target.id==='management-month'&&managementMonthPages.includes(current)){
    const P=getP(),previous=P.managementMonth;
    P.managementMonth=managementMonth(S,{managementMonth:e.target.value});
    try {await reload();}catch(error){
      P.managementMonth=previous;
      if(current===P.view)content();
      toast(error.message,true);
    }
    return;
  }
  if(current==='analytics'&&['filter-from','filter-to'].includes(e.target.id)){
    Object.assign(getP(),{
      from:document.querySelector('#filter-from').value,
      to:document.querySelector('#filter-to').value,
      managementPreset:'custom',
    });
    content();return;
  }
  if(current==='team'&&['team-risk-stage','team-risk-level'].includes(e.target.id)){
    getP()[e.target.id==='team-risk-stage'?'teamRiskStage':'teamRiskLevel']=e.target.value;
    content();return;
  }
  if(current==='workbench'&&e.target.id==='workbench-owner'){
    Object.assign(getP(),{owner:e.target.value,workbenchTask:'all',workbenchAll:false});
    content();
    return;
  }
  const auditFilters={'activity-from':'activityFrom','activity-to':'activityTo','activity-owner':'activityOwner','activity-customer':'activityCustomer','activity-opportunity':'activityOpportunity','activity-source':'activitySource','activity-type':'activityType','activity-status':'activityStatus','performance-status':'performanceStatus','performance-owner':'performanceOwner'};
  if(auditFilters[e.target.id]){
    getP()[auditFilters[e.target.id]]=e.target.value;
    if(e.target.id.startsWith('activity-')){getP().activityPage=1;if(e.target.id==='activity-source')getP().source='';if(e.target.id==='activity-customer')getP().activityOpportunity='';}
    content();return;
  }
  if(current==='intake'&&e.target.id==='ai-guide-table') {
    getP().guideTable=e.target.value;
    const fields=document.querySelector('#ai-guide-fields');
    if(fields)fields.innerHTML=intakeGuideCard(S,e.target.value);
    return;
  }
  if(e.target.id==='opportunity-sort'){getP().opportunitySort=e.target.value;content();return;}
  if(e.target.matches('form[data-form="payment"] [name="status"],form[data-form="payment-maintain"] [name="status"],form[data-form="payment-maintain"] [name="amount"]'))syncPaymentFields(e.target.form);
  if(e.target.matches('form[data-form="payment"] [name="contract_id"]'))syncPaymentContext(e.target.form);
  if(e.target.matches('form[data-form="target"] [name="user_id"],form[data-form="target"] [name="quarter"]'))syncTargetForm(e.target.form,S);
  if(e.target.id==='target-quarter'){
    const P=getP();
    P.targetQuarter=e.target.value;
    if(current==='team')P.teamTargetsOpen=true;
    content();return;
  }
  if(['commission-status','commission-history-period'].includes(e.target.id)){
    getP()[e.target.id==='commission-status'?'commissionStatus':'commissionHistoryPeriod']=e.target.value;content();return;
  }
  const map = {
    "filter-owner": "owner",
    "filter-stage": "stage",
    "filter-level": "level",
    'filter-from':'from','filter-to':'to','filter-sale-type':'saleType','filter-risk':'risk',
  };
  if (map[e.target.id]) {
    getP()[map[e.target.id]] = e.target.value;
    content();
  }
  if(e.target.id==='commission-period-mode') {
    const selected=S.commission.period||S.today.slice(0,7),quarter=selected.match(/^(\d{4})Q([1-4])$/);
    const date=/^\d{4}-\d{2}$/.test(selected)?selected+'-01':quarter?`${quarter[1]}-${String((Number(quarter[2])-1)*3+1).padStart(2,'0')}-01`:selected.slice(0,4)+'-01-01',year=date.slice(0,4);
    commissionPeriod=e.target.value==='month'?date.slice(0,7):S.commission.legacy_mode==='year'?year:`${year}Q${Math.ceil(Number(date.slice(5,7))/3)}`;
    try {await reload();}catch(error){toast(error.message,true);}return;
  }
  if(['report-month','commission-period'].includes(e.target.id)) {
    if(e.target.id==='report-month')reportMonth=e.target.value;else commissionPeriod=e.target.value;
    try {await reload();}catch(error){toast(error.message,true);}
  }
});
document.addEventListener('toggle',event=>{
  if(current==='team'&&event.target.matches?.('.team-targets'))getP().teamTargetsOpen=event.target.open;
  if(current==='analytics'&&event.target.matches?.('.analytics-filters'))getP().analyticsFiltersOpen=event.target.open;
},true);
const searchFields={
  'list-search':'q',
  'activity-search':'activityQ',
  'performance-search':'performanceQ',
  'commission-search':'commissionQ',
};
bindCommittedSearch(document,Object.keys(searchFields).map(id=>`#${id}`).join(','),input=>{
  if(!S)return;
  clearTimeout(searchTimer);
  const page=getP(),key=searchFields[input.id];
  page[key]=input.value;
  if(key==='activityQ')page.activityPage=1;
  function refresh(){
    if(current!==page.view||!input.isConnected)return;
    if(isSearchComposing()){
      searchTimer=setTimeout(refresh,180);
      return;
    }
    const focused=document.activeElement===input;
    const {selectionStart,selectionEnd,selectionDirection}=input;
    content();
    const replacement=document.getElementById(input.id);
    if(focused&&replacement){
      replacement.focus({preventScroll:true});
      replacement.setSelectionRange(selectionStart,selectionEnd,selectionDirection);
    }
  }
  searchTimer=setTimeout(refresh,180);
},()=>clearTimeout(searchTimer));
document.addEventListener("input", (e) => {
  if (!S) return;
  if(e.target.matches('form[data-form="performance-rules"] [name="performance:process_weight"],form[data-form="performance-rules"] [name="performance:result_weight"]')){
    const value=Number(e.target.value),other=e.target.name==='performance:process_weight'?'performance:result_weight':'performance:process_weight';
    if(e.target.value!==''&&Number.isFinite(value)&&value>=0&&value<=100)e.target.form.elements.namedItem(other).value=String(Math.round((100-value)*100)/100);
  }
  if(e.target.matches('form[data-form="contact"] [name="phone"],form[data-form="contact"] [name="wechat"],form[data-form="contact"] [name="dingtalk"],form[data-form="edit-contact"] [name="phone"],form[data-form="edit-contact"] [name="wechat"],form[data-form="edit-contact"] [name="dingtalk"]'))syncContactMethods(e.target.form);
  if(e.target.matches('form[data-form="performance-review"] [name="adjustment"],form[data-form="performance-review"] [name="final_score"]')) {
    syncPerformanceReviewPreview(e.target.form,S);
  }
});
bindCommittedSearch(document,'#global-search',input=>{
    if(!S)return;
    const q = input.value.trim().toLowerCase();
    const area = document.querySelector("#search-results");
    if (!q) {
      area.hidden = true;
      return;
    }
    const records = [
      ...S.customers.map((c) => ({
        type: "customer",
        label: "客户",
        id: c.id,
        name: c.name,
        meta: c.industry,
        search:customerSearchText(S,c),
      })),
      ...S.opportunities.map((o) => ({
        type: "opportunity",
        label: "商机",
        id: o.id,
        name: o.name,
        meta: o.code,
      })),
      ...S.contracts.map((c) => ({
        type: "contract",
        label: "合同",
        id: c.id,
        name: c.name,
        meta: c.code,
      })),
    ]
      .filter((r) => (r.search||(r.name + r.meta).toLowerCase()).includes(q.normalize('NFKC')))
      .slice(0, 9);
    area.hidden = false;
    area.innerHTML = records.length
      ? records
          .map(
            (r) =>
              `<button data-action="${r.type}" data-id="${r.id}"><span class="search-type">${r.label}</span><span><b>${esc(r.name)}</b><small>${esc(r.meta)}</small></span>${icon("chevron")}</button>`,
          )
          .join("")
      : '<p class="search-empty">没有找到匹配记录</p>';
});
document.addEventListener("click", (e) => {
  const picker=document.querySelector('#developer-picker');
  if(picker&&!e.target.closest('#developer-picker'))picker.open=false;
  if (!e.target.closest(".global-search")) {
    const results = document.querySelector("#search-results");
    if (results) results.hidden = true;
  }
});
document.addEventListener("keydown", (e) => {
  if(isCompositionEvent(e))return;
  if (
    e.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) &&
    !dialog.open
  ) {
    e.preventDefault();
    document.querySelector("#global-search")?.focus();
  }
  if (e.key === "Escape") {
    const r = document.querySelector("#search-results");
    if (r) r.hidden = true;
  }
});
dialog.addEventListener("cancel", (e) => {
  e.preventDefault();
  if(isSearchComposing())return;
  close();
});
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      close();
  }
});
window.addEventListener("hashchange", async () => {
  clearTimeout(searchTimer);
  const view = location.hash.slice(1);
  current = Object.hasOwn(pages, view) ? view : "workbench";
  stateRequest++;
  if (S) {
    if (dialog.open) dialog.close();
    panel = null;
    formReturn = null;
    const expectedMonth=selectedStateMonth()||reportMonthForPage(current,reportMonth,S.today);
    const commissionChanged=current==='commissions'&&commissionPeriod&&S.commission.period!==commissionPeriod;
    if(current==='performance'||current==='activities'||S.period!==expectedMonth||commissionChanged) {
      document.querySelector('#content').innerHTML='<div class="empty" role="status">正在读取当前页面数据…</div>';
      try {await reload();} catch(error) {toast(error.message,true);}
    } else render();
    window.scrollTo(0, 0);
  }
});

function exportList(typeOverride,commissionSection='summary') {
  const P = getP();
  const type = typeOverride||P.view;
  let rows;
  if (type === "customers")
    rows = [
      ["客户名称", "简称", "行业", "地区", "客户等级", "负责人", "合作情况", "管理状态"],
      ...selectCustomers(S, P).map((c) => [
        c.name,
        c.short_name,
        c.industry,
        c.region,
        c.manual_level || '',
        S.users.find((u) => u.id === c.owner_id)?.name,
        c.relationship_status||'待核对',
        c.management_status||(['冻结','流失'].includes(c.status)?c.status:'正常'),
      ]),
    ];
  else if (type === "contracts")
    rows = [
      [
        "合同编号",
        "合同名称",
        "合同金额(元)",
        "已到账(元)",
        "待回款(元)",
        "签约日期",
      ],
      ...filtered(S, P, S.contracts).map((c) => [
        c.code,
        c.name,
        c.amount / 100,
        c.collected / 100,
        c.outstanding / 100,
        c.sign_date,
      ]),
    ];
  else if(type==='team')rows=teamExportRows(S,P);
  else if(type==='performance')rows=[['销售','月份','系统过程分','计入过程分','过程折算分','合同结果分','系统总分','人工最终分','最终总分','等级','绩效工资系数','状态','调整原因'],...selectPerformanceRows(S,P).map(p=>[p.name,p.month,p.automatic_raw??p.process.raw,p.raw,p.processPoints,p.resultPoints,p.system_total??p.automatic_total,p.final_score,p.total,p.grade,p.salary_factor,p.status,p.reason])];
  else if(type==='commissions') {
    const exports=buildCommissionExport(S,P);
    rows=commissionSection==='detail'?exports.detailRows:commissionSection==='issues'?exports.issueRows:exports.summaryRows;
  }
  else return;
  const cell = (v) => {
    let value = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(value)) value = "'" + value;
    return '"' + value.replaceAll('"', '""') + '"';
  };
  const blob = new Blob(
    ["\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const exportTitle=type==='commissions'?commissionSection==='detail'?'提成合同明细':commissionSection==='issues'?'提成待完善清单':'实时提成人员汇总':pages[type][0];
  a.download = `千帆CRM-${exportTitle}-${type==='commissions'?S.commission.period+'-':''}${S.today}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(type==='commissions'?"实时提成已导出":"台账已导出");
}

try {
  const callback=new URLSearchParams(location.search);
  if(callback.has('authCode')) {
    const body={code:callback.get('authCode'),state:callback.get('state')};history.replaceState(null,'',location.pathname+location.hash);
    const signed=await api('/auth/dingtalk/callback',{method:'POST',body});setCsrf(signed.csrf);
  }
  const me = await api("/auth/me");
  setCsrf(me.csrf);
  const personalReturn=sessionStorage.getItem('qf_personal_return');
  let returningToPersonal=false;
  if(personalReturn&&!me.developer){
    sessionStorage.removeItem('qf_personal_return');const destination=new URL(personalReturn,location.origin);
    if(destination.origin===location.origin&&destination.pathname===new URL('./personal-minutes.html',location.href).pathname){location.replace(destination.href);returningToPersonal=true;}
  }
  if(!returningToPersonal){
  current = Object.hasOwn(pages, location.hash.slice(1))
    ? location.hash.slice(1)
    : me.actor.role==='admin'?'team':'workbench';
  await reload();
  }
} catch (e) {
  try {
    await showLogin(e.status === 401 ? "" : e.message);
  } catch (err) {
    document.querySelector("#app").innerHTML =
      `<main class="boot">${icon("alert")}<h2>暂时无法连接工作区</h2><p>${esc(err.message)}</p><button class="btn primary" data-action="reload-app">重新连接</button></main>`;
    document
      .querySelector("[data-action=reload-app]")
      .addEventListener("click", () => location.reload());
  }
}

document.addEventListener('keydown',e=>{const row=e.target.closest('tr.record-row');if(row===e.target&&['Enter',' '].includes(e.key)){e.preventDefault();row.click();}});
