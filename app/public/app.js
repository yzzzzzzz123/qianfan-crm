import {mountMaintenance,maintenancePayload,bindMaintenanceActions} from './modules/contract-maintenance.js';
import {installTablePanning} from './modules/table-pan.js';
import {collectionDetail} from './modules/contract-workflow.js';
import { api, setCsrf, setSimulationIdentity } from "./api.js";
import { sessionControl, bindIdentityPicker } from './modules/developer-session.js';
import {bindIntakeUpload,restoreIntakeUpload,setIntakeBusy,clearIntakeUpload} from './modules/intake-upload.js';
import {intakeGuideCard} from './modules/intake.js';
import {syncTargetForm} from './modules/targets.js';
import {manualChoices,manualChooser,manualCreateActions,manualFormRoles} from './modules/manual-entry.js';
import {followupFilters,reportMonthForPage} from './modules/shared.js';
import {createMinutesController} from './modules/minutes.js';
import {companyProfileFeedback} from './modules/customers.js';
import {salesPolicyFromForm} from './modules/commission-policy.js';
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
  quoteItemRow,
  filtered,
  timeline,
} from "./views.js";

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
const toast = (msg, error = false) => {
  const el = document.querySelector("#toast");
  el.className = error ? "error visible" : "visible";
  el.innerHTML = icon(error ? "alert" : "check") + `<span>${esc(msg)}</span>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 4500);
};
const minutesController=createMinutesController({getS:()=>S,getP,openHtml,content,reload,toast});
function content() {
  minutesController.beforeRender();
  document.querySelector("#content").innerHTML = renderPage(S, getP());
  void minutesController.mountFilters();
  if(current==='intake')restoreIntakeUpload();
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
async function reload() {
  const request=++stateRequest,page=current;
  const query=new URLSearchParams();if(page==='performance'&&reportMonth)query.set('month',reportMonth);if(commissionPeriod)query.set('commissionPeriod',commissionPeriod);
  const state=await api('/state'+(query.size?'?'+query:''));
  if(request!==stateRequest||current!==page)return;
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
}
let profilePolling=false,lastProfilePoll=0;
setInterval(async()=>{
  if(profilePolling||!S||document.hidden||!(current==='customers'||panel?.type==='customer')||dialog.querySelector('form'))return;
  const progress=S.company_profiles,counts=progress?.counts||{};
  const busy=profileRequests.size>0||Number(counts.pending||0)+Number(counts.running||0)>0;
  if(Date.now()-lastProfilePoll<(busy?5000:15000))return;
  lastProfilePoll=Date.now();profilePolling=true;
  const opened=dialog.open&&panel?.type==='customer'?{...panel,scrollTop:dialog.scrollTop}:null;
  try{
    await reload();
    if(opened&&dialog.open&&panel?.type==='customer'&&panel.id===opened.id){openPanel('customer',opened.id);dialog.scrollTop=opened.scrollTop;}
  }catch{/* Existing page and input state remain available after a failed poll. */}
  finally{profilePolling=false;}
},5000);
function openHtml(html, drawer = false) {
  dialog.className = drawer ? "drawer" : "form-dialog";
  dialog.innerHTML = html;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function openPanel(type, id) {
  panel = { type, id: Number(id) };
  formReturn = null;
  const html = {
    customer: customerDetail,
    opportunity: opportunityDetail,
    contract: contractDetail,
    collection: collectionDetail,
  }[type](S, id);
  openHtml(html, true);
}
function openForm(type, id = "", quarter = "") {
  formReturn = panel;
  openHtml(formContent(S, type, id, quarter), false);
  if(['contract-maintain','contract-project'].includes(type))mountMaintenance(dialog.querySelector('form'));
  if(type==='target'&&dialog.querySelector('form[data-form="target"]'))syncTargetForm(dialog.querySelector('form'),S);
  if(['payment','payment-maintain'].includes(type)){syncPaymentFields(dialog.querySelector('form'));syncPaymentContext(dialog.querySelector('form'));}
  if(type==='quote')syncQuoteTotal(dialog.querySelector('form'));
  if(type==='contact')syncContactMethods(dialog.querySelector('form'));
  if(type==='activity'&&dialog.querySelector('form'))dialog.querySelector('form').dataset.contextOpportunity=id||'';
}
function syncPaymentFields(form) {
  if(!form)return;
  const received=form.elements.status.value==='已到账';
  const prior=form.dataset.form==='payment-maintain'?S.contracts.flatMap(c=>c.payments).find(p=>p.id===Number(form.dataset.id)):null;
  const unchanged=prior&&form.elements.status.value===prior.status&&Number(form.elements.amount.value)===prior.amount/100;
  form.elements.pay_date.required=received&&!(unchanged&&!prior.pay_date);
  form.elements.promise_date.required=!received&&!(unchanged&&!prior.promise_date);
}
function syncPaymentContext(form){
  const box=form?.querySelector('#payment-contract-context');if(!box)return;
  const c=S.contracts.find(c=>c.id===Number(form.elements.contract_id.value));
  box.textContent=c?`${c.name} · 合同金额 ${plainMoney(c.amount)} · 已回款 ${plainMoney(c.collected)} · 未回款 ${plainMoney(c.outstanding)} · 销售小二 ${S.users.find(u=>u.id===c.owner_id)?.name||'待补充'}`:'请选择系统中已有合同';
}
function syncQuoteTotal(form) {
  if(!form)return;
  const total=[...form.querySelectorAll('.quote-item-row')].reduce((sum,row)=>{
    const quantity=Number(row.querySelector('[data-field="quantity"]').value||0),price=Math.round(Number(row.querySelector('[data-field="list_price"]').value||0)*100),discount=Number(row.querySelector('[data-field="discount_percent"]').value||0)/100;
    return sum+Math.round(Math.round(price*quantity)*discount);
  },0)/100;
  form.querySelector('#quote-total').textContent=total.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function syncContactMethods(form) {
  if(!form)return;
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
    openPanel(p.type, p.id);
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
    if(['contract-delete','payment-maintain','contract-maintain','contract-project','item-margin','payment-plan','contract-extract','collection-receive'].includes(action)){openForm(action,id);return;}
    if(action==='collection'){openPanel('collection',id);return;}
    if(action==='contract-collections'){if(dialog.open)dialog.close();panel=null;formReturn=null;navigate('collections',{contractId:Number(id),q:'',owner:'',stage:'',level:'',customerLevel:'',saleType:'',from:'',to:'',risk:''});return;}
    if(action==='commission-last-month'){const date=new Date(S.today+'T12:00:00Z');date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-1);commissionPeriod=date.toISOString().slice(0,7);await reload();return;}
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
    if(action==='archive-contract'){if(S.actor.role!=='admin')throw new Error('仅管理员可归档合同');openForm('archive-contract',id);return;}
    if(action==='payment-allocation'){openForm('payment-allocation',id);return;}
    if(action==='commission-pay'){openForm('commission-pay',id);return;}
    if(action==='record-attachment'){downloadFile(await api('/attachments/'+id));return;}
    if(Object.hasOwn(manualCreateActions,action)){openForm(manualCreateActions[action],id||'');return;}
    if(action==='ai-destination') {
      const view=el.dataset.view;if(!Object.hasOwn(pages,view))throw new Error('导入去向无效');
      if(['customer','opportunity','contract'].includes(el.dataset.detail)){openPanel(el.dataset.detail,el.dataset.record);return;}
      navigate(view);
      return;
    }
    if(action==='ai-start'||action==='maintenance-attachments'||aiDataActions.has(action)) {
      const intent=action==='maintenance-attachments'?'edit-contract':el.dataset.intent||action;
      const names={'edit-customer':'客户','new-contact':'客户','edit-contact':'联系人','edit-opportunity':'商机','new-activity':'商机','new-quote':'商机',convert:'商机','new-payment':'合同','edit-contract':'合同','edit-item':'合同行项','receive-payment':'付款计划','edit-user-mapping':'成员','toggle-user':'成员','commission-pay':'提成','payment-checkpoint':'付款计划'};
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
    const forms = { 'sales-commission-policy':'sales-commission-policy','finance-rules':'finance-rules','stage-rules':'rules','document-templates':'document-templates','performance-rules':'performance-rules','customer-level':'customer-level','customer-levels':'customer-levels','commission-confirm':'commission-confirm', 'performance-review':'performance-review', target:'target' };
    if (forms[action]) {
      openForm(forms[action], id, el.dataset.quarter||'');
      return;
    }
    if(action==='person-board') {navigate('personal',{owner:id});return;}
    if(action==='export-team') {exportList('team');return;}
    if (action === "stage-filter") {
      navigate("opportunities", { stage: id, risk: "", q: "", owner: "" });
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
      Object.assign(getP(), {
        q: "",
        owner: "",
        stage: "",
        level: "",
        risk: "",
        sort: "",
        from:'',to:'',source:'',saleType:'',customerLevel:'',
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
  if(form.querySelector('[type=submit]').disabled)return;
  const b = Object.fromEntries(new FormData(form));
  const submittedPage=getP();
  const submit = form.querySelector("[type=submit]");
  const label = submit.innerHTML;
  const error = form.querySelector(".form-error");
  error.textContent = "";
  submit.disabled = true;
  submit.innerHTML = '<span class="loader mini"></span> 正在保存…';
  try {
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
    if (type === "contact") {
      path = "/contacts";
      body.customer_id = b.customer_id||id;
    }
    if (type === 'edit-contact') { path='/contacts/'+id; method='PATCH'; }
    if (type === "opportunity") path = "/opportunities";
    if(type==='opportunity'&&(body.product_amount==null||String(body.product_amount).trim()===''))throw new Error('请填写cash金额（元）；无产品金额时请明确填写0');
    if (type === "edit-opportunity") {
      path = "/opportunities/" + id;
      method = "PATCH";
      if(Object.hasOwn(body,'product_amount')&&(body.product_amount==null||String(body.product_amount).trim()==='')){
        const previous=S.opportunities.find(record=>record.id===id);
        if(previous?.product_amount==null)delete body.product_amount;
        else throw new Error('已有cash金额不能清空；无产品金额时请明确填写0');
      }
    }
    if (type === "activity") path = "/activities";
    if (type === "quote") {
      path = "/quotes";
      body.opportunity_id = b.opportunity_id||id;
      body.items=[...form.querySelectorAll('.quote-item-row')].map(row=>{
        const item=Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input=>[input.dataset.field,input.value]));
        item.discount_rate=Number(item.discount_percent)/100;delete item.discount_percent;return item;
      });
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
    if(['contract-maintain','contract-project'].includes(type)){
      path='/contracts/'+id;method='PATCH';
      if(form.querySelector('.maintenance-items')){path='/contracts/'+id+'/maintenance';body=maintenancePayload(form);}else{const prior=S.contracts.find(c=>c.id===id);for(const key of Object.keys(body))if(key!=='reason'&&String(body[key]??'')===String(prior?.[key]??''))delete body[key];}
      returnTo={type:type==='contract-project'?'collection':'contract',id};
    }
    if(type==='contract-delete'){path='/contracts/'+id;method='DELETE';body.confirmed=body.confirmed==='on';returnTo=null;}
    if(type==='payment-maintain'){path='/payments/'+id+'/details';method='PATCH';const parent=S.contracts.find(c=>c.payments.some(p=>p.id===id));returnTo={type:current==='collections'?'collection':'contract',id:parent.id};}
      if(type==='item-margin'){
        path='/items/'+id;method='PATCH';
        const prior=S.contracts.flatMap(c=>c.items).find(i=>i.id===id);
        if(body.margin===''||prior?.margin!=null&&Number(body.margin)===prior.margin/100)delete body.margin;
        for(const key of ['name','kind','payment_date','valid_until'])if(String(body[key]??'')===String(prior?.[key]??''))delete body[key];
      if(body.margin_percent!=='')body.margin_rate=Number(body.margin_percent)/100;
      delete body.margin_percent;
      const parent=S.contracts.find(c=>c.items.some(i=>i.id===id));returnTo={type:'contract',id:parent.id};
    }
    if(type==='collection-receive'){path='/payments/'+id+'/receive';const parent=S.contracts.find(c=>c.payments.some(p=>p.id===id));returnTo={type:'contract',id:parent.id};}
    if(type==='payment-plan'){path='/payments/'+id;method='PATCH';}
    if(type==='contract-extract'){path='/contracts/'+id+'/extract-attachment';body={attachment_id:Number(body.attachment_id)};returnTo={type:'contract',id};}
    if((type==='contract'||type==='convert')&&body.items)body.items=body.items.map(item=>{const value={...item};if(value.margin_percent!==undefined&&value.margin_percent!=='')value.margin_rate=Number(value.margin_percent)/100;delete value.margin_percent;return value;});
    if (type === "payment") {
      path = "/payments";
      body.contract_id = b.contract_id||id;
    }
    if(type==='archive-contract'){path='/contracts/'+id+'/archive';body.both_stamped=b.both_stamped==='on';body.archive_attachment_id=Number(b.archive_attachment_id);}
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
    if(type==='commission-confirm')path='/commissions/confirm';
    if(type==='commission-pay')path='/commissions/'+id+'/pay';
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
    if(type==='payment')returnTo={type:'contract',id:Number(body.contract_id)};
    if(type==='archive-contract')returnTo={type:'contract',id:Number(id)};
    if (returnTo&&showSavedDetail&&current===submittedPage.view&&!dialog.open) openPanel(returnTo.type, returnTo.id);
    toast(result.message || "已保存");
  } catch (err) {
    error.textContent = err.message;
    if(error.isConnected)error.scrollIntoView({ block: "nearest" });else toast(err.message,true);
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
  if(current==='intake'&&e.target.id==='ai-guide-table') {
    getP().guideTable=e.target.value;
    const fields=document.querySelector('#ai-guide-fields');
    if(fields)fields.innerHTML=intakeGuideCard(S,e.target.value);
    return;
  }
  if(e.target.matches('form[data-form="activity"] [name="opportunity_id"]')) {
    const form=e.target.form,previous=S.opportunities.find(o=>o.id===Number(form.dataset.contextOpportunity)),next=S.opportunities.find(o=>o.id===Number(e.target.value));
    if(form.elements.action.value===(previous?.next_action||''))form.elements.action.value=next?.next_action||'';
    if(form.elements.follow_date.value===(previous?.follow_date||S.today))form.elements.follow_date.value=next?.follow_date||S.today;
    form.dataset.contextOpportunity=e.target.value;
  }
  if(e.target.matches('form[data-form="payment"] [name="status"],form[data-form="payment-maintain"] [name="status"],form[data-form="payment-maintain"] [name="amount"]'))syncPaymentFields(e.target.form);
  if(e.target.matches('form[data-form="payment"] [name="contract_id"]'))syncPaymentContext(e.target.form);
  if(e.target.matches('form[data-form="target"] [name="user_id"],form[data-form="target"] [name="quarter"]'))syncTargetForm(e.target.form,S);
  if(e.target.id==='target-quarter'){getP().targetQuarter=e.target.value;content();return;}
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
    const date=S.today,year=date.slice(0,4);
    commissionPeriod=e.target.value==='month'?date.slice(0,7):S.commission.legacy_mode==='year'?year:`${year}Q${Math.ceil(Number(date.slice(5,7))/3)}`;
    try {await reload();}catch(error){toast(error.message,true);}return;
  }
  if(['report-month','commission-period'].includes(e.target.id)) {
    if(e.target.id==='report-month')reportMonth=e.target.value;else commissionPeriod=e.target.value;
    try {await reload();}catch(error){toast(error.message,true);}
  }
});
document.addEventListener("input", (e) => {
  if (!S) return;
  if(e.target.matches('form[data-form="performance-rules"] [name="performance:process_weight"],form[data-form="performance-rules"] [name="performance:result_weight"]')){
    const value=Number(e.target.value),other=e.target.name==='performance:process_weight'?'performance:result_weight':'performance:process_weight';
    if(e.target.value!==''&&Number.isFinite(value)&&value>=0&&value<=100)e.target.form.elements.namedItem(other).value=String(Math.round((100-value)*100)/100);
  }
  if(e.target.closest('.quote-item-row'))syncQuoteTotal(e.target.form);
  if(e.target.matches('form[data-form="contact"] [name="phone"],form[data-form="contact"] [name="wechat"],form[data-form="contact"] [name="dingtalk"]'))syncContactMethods(e.target.form);
  if(e.target.matches('form[data-form="performance-review"] [name="adjustment"],form[data-form="performance-review"] [name="final_score"]')) {
    e.target.form.elements.reason.required=e.target.form.elements.adjustment.value!==''||e.target.form.elements.final_score.value!=='';
  }
  if (e.target.id === "list-search") {
    clearTimeout(searchTimer);
    const value = e.target.value;
    const page=getP();
    searchTimer = setTimeout(() => {
      if(current!==page.view)return;
      page.q = value;
      content();
      const input = document.querySelector("#list-search");
      if(!input)return;
      input.focus();
      input.setSelectionRange(value.length, value.length);
    }, 180);
  }
  if (e.target.id === "global-search") {
    const q = e.target.value.trim().toLowerCase();
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
      .filter((r) => (r.name + r.meta).toLowerCase().includes(q))
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
  }
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
    if(S.period!==reportMonthForPage(current,reportMonth,S.today)) {
      document.querySelector('#content').innerHTML='<div class="empty" role="status">正在读取当前页面数据…</div>';
      try {await reload();} catch(error) {toast(error.message,true);}
    } else render();
    window.scrollTo(0, 0);
  }
});

function exportList(typeOverride) {
  const P = getP();
  const type = typeOverride||P.view;
  let rows;
  if (type === "customers")
    rows = [
      ["客户名称", "简称", "行业", "地区", "手动等级", "负责人", "状态"],
      ...filtered(S, P, S.customers).map((c) => [
        c.name,
        c.short_name,
        c.industry,
        c.region,
        c.manual_level || '',
        S.users.find((u) => u.id === c.owner_id)?.name,
        c.status,
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
  else if(type==='team')rows=[['销售','本月新签(元)','本月回款(元)','漏斗金额(元)','风险商机','近7天跟进','绩效分','等级'],...S.team.filter(u=>!P.owner||u.id===Number(P.owner)).map(u=>[u.name,u.signed/100,u.collected/100,u.pipeline/100,u.riskCount,u.followCount,u.performance?.total??'',u.performance?.grade??''])];
  else if(type==='performance')rows=[['销售','月份','过程原始分','过程折算分','合同结果分','总分','等级','绩效工资系数','状态'],...S.performance.filter(p=>!P.owner||p.user_id===Number(P.owner)).map(p=>[p.name,p.month,p.raw,p.processPoints,p.resultPoints,p.total,p.grade,p.salary_factor,p.status])];
  else if(type==='commissions')rows=[['销售','周期','类型','计提基数(元)','综合比例','应计提成(元)','已确认(元)','本次差额(元)','产品回款(元)','产品比例','产品提成(元)','服务合同金额(元)','服务提成(元)','核对提示'],...S.commission.previews.filter(p=>!P.owner||p.sales_id===Number(P.owner)).map(p=>[p.name,p.period,p.kind==='personal'?'个人':'团队管理',p.base/100,p.rate,p.total/100,p.confirmed/100,p.due/100,p.components?.[0].base/100||0,p.components?.[0].rate??'',p.components?.[0].total/100||0,p.components?.[1].base/100||0,p.components?.[1].total/100||0,(p.issues||[]).join('；')])];
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
  a.download = `千帆CRM-${pages[type][0]}-${S.today}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast("台账已导出");
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
