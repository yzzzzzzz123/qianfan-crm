import {canManageContractData} from './modules/contract-access.js';
import {collectionsPage,formWorkflow} from './modules/contract-workflow.js';
import {
  esc,
  icon,
  avatar,
  badge,
  actionButton as button,
  empty,
  input,
} from "./ui.js";
import { formOptions } from "./modules/shared.js";

import { workbench } from "./modules/workbench.js";
import { customers, customerDetail,formCustomers } from "./modules/customers.js";
import { opportunities, opportunityDetail,formOpportunities } from "./modules/opportunities.js";
import {formQuotes} from './modules/quotes.js';
import { activities,formActivities } from "./modules/activities.js";
import {
  contracts,
  contractDetail,
  contractItemRow,
  formContracts,
} from "./modules/contracts.js";
import { dashboard } from "./modules/dashboards.js";
import { teamManagement } from "./modules/team-management.js";
import { performance, commissions, formIncentives } from "./modules/incentives.js";
import {formSettings} from "./modules/settings.js";
import { auditView } from "./modules/audit.js";
import { intake } from './modules/intake.js';
import {targetForm} from './modules/targets.js';
import {manualEntryEnabled,manualFormRoles} from './modules/manual-entry.js';
import {minutesPage} from './modules/minutes.js';

export { filtered, timeline } from "./modules/shared.js";
export { customerDetail } from "./modules/customers.js";
export { opportunityDetail } from "./modules/opportunities.js";
export { contractDetail, contractItemRow } from "./modules/contracts.js";

export const pages = {
  intake: ['AI接收',''], workbench: ['工作台',''], customers: ['客户档案',''],
  opportunities: ['商机推进',''], activities: ['跟进记录',''], minutes:['钉钉听记',''], contracts: ['合同订单',''],
  analytics: ['经营分析',''], funnel: ['漏斗转化',''], assets: ['客户资产',''],
  collections: ['回款管理',''], performance: ['绩效评定',''], commissions: ['提成结算',''],
  personal: ['个人作战看板',''], team: ['团队管理',''], audit: ['操作记录',''],
};

export function shell(S, page) {
  const admin = S.actor.role === "admin";
  const nav = (id, ico, label, count = "") => {
    if(S.actor.role==='pm'&&['team','analytics','minutes'].includes(id))return '';
    const link=`<a href="#${id}" class="nav-item ${page === id ? "active" : ""}" ${page === id ? 'aria-current="page"' : ""}>${icon(ico)}<span>${id==='team'?'团队管理':label}</span>${count !== "" ? `<span class="nav-count">${count}</span>` : ""}</a>`;
    if(id==='team')return (admin?link:'')+nav('performance','team','绩效评定')+nav('commissions','wallet','提成结算')+(admin?nav('funnel','chart','漏斗转化')+nav('assets','customers','客户资产'):'')+(admin||S.actor.role==='sales'?nav('personal','dashboard','个人作战看板'):'');
    return link;
  };
  const riskCount = S.opportunities.filter(
    (o) => o.risk.level !== "normal",
  ).length;
  return `<aside class="sidebar" id="sidebar"><a href="#workbench" class="brand" aria-label="千帆创科 CRM 首页"><span class="brand-crop"><img src="./assets/brand.png" alt="千帆创科"></span><span class="brand-divider"></span><b>CRM</b></a><nav aria-label="主导航"><p class="nav-label">业务工作</p>${nav("intake", "note", "AI接收")}${nav("workbench", "dashboard", "工作台")}${nav("customers", "customers", "客户档案")}${nav("opportunities", "opportunities", "商机推进", riskCount || "")}${nav("activities", "activities", "跟进记录")}${nav("minutes", "activities", "钉钉听记")}${nav("contracts", "contracts", "合同订单")}${nav("collections","wallet","回款管理")}<p class="nav-label">${admin ? "团队管理" : "个人成长"}</p>${admin ? nav("analytics", "chart", "经营分析") : ""}${nav("team", "team", admin ? "团队与绩效" : "过程绩效")}${admin ? `<p class="nav-label">系统管理</p>${nav("audit", "audit", "操作记录")}` : ""}</nav><div class="sidebar-bottom"><div class="local-status"><span class="status-dot ${S.demo ? "orange" : "green"}"></span>${S.demo ? "本地演示工作区" : "当前工作区"}</div><span class="version">千帆 CRM <b>2.1</b></span></div></aside><div class="app-body"><header class="topbar"><button class="icon-btn mobile-menu" data-action="menu" aria-label="打开导航">${icon("menu")}</button><div class="breadcrumb">千帆 CRM ${icon("chevron")} <span>${pages[page]?.[0] || "工作台"}</span></div><div class="global-search">${icon("search")}<input id="global-search" placeholder="搜索客户、商机、合同" aria-label="全局搜索" autocomplete="off"><kbd>/</kbd><div id="search-results" hidden></div></div><span class="env-tag">${S.demo ? "演示环境" : "正式工作区"}</span><button class="user-menu" data-action="account" aria-label="当前账号与退出">${avatar(S.actor.name, true)}<span>${esc(S.actor.name)}<small>${admin ? "管理者" : S.actor.role==="pm"?"协作PM":"销售"}</small></span>${icon("down")}</button></header><main id="content" tabindex="-1"></main><footer class="page-footer"><span>千帆 CRM</span><span>${S.demo ? "当前为本地演示，外部集成尚未接入" : "独立部署版"}<span class="footer-dot">·</span>数据持久保存</span></footer></div>`;
}

export function pageHeader(S, P) {
  const page = P.view;
  let buttons=page==='minutes'?button('刷新列表','minutes-list-refresh','','secondary','refresh'):'';
  if(manualEntryEnabled(S,P))buttons=button('手动导入','manual-entry','','primary','plus');
  if(page==='activities'&&manualEntryEnabled(S,P))buttons=button('记录跟进','new-activity','','primary','plus');
  if(page==='customers'&&['admin','sales'].includes(S.actor.role))buttons=button('新建联系人','new-contact','','secondary','plus')+button('新建客户','new-customer','','primary','plus');
  if(page==='opportunities'&&['admin','sales'].includes(S.actor.role))buttons=button('新建商机','new-opportunity','','primary','plus');
  if(page==='contracts'&&canManageContractData(S))buttons=(S.actor.role==='admin'?button('迁移核对','data-review','','secondary'):'')+button('删除与恢复','records-recycle','','secondary')+button('历史台账','contract-history','','secondary','clock')+button('新增合同','new-contract','','primary','plus');
  if(page==='collections'&&canManageContractData(S))buttons=button('新增收款计划','new-payment-plan','','secondary','plus')+button('登记实际到账','new-payment','','primary','wallet');
  if(S.actor.role==='admin'&&page==='customers')buttons=button('维护客户等级','customer-levels','','secondary','edit')+buttons;
  if(S.actor.role==='admin'&&page==='opportunities')buttons=button('维护阶段规则','stage-rules','','secondary','edit')+buttons;
  if(S.actor.role==='admin'&&page==='contracts')buttons=button('维护公司模板','document-templates','','secondary','edit')+buttons;
  if(['customers','contracts','performance'].includes(page))buttons=button('导出台账','export','','secondary','download')+buttons;
  if(page==='commissions')buttons=button('导出','commission-export-choose','','secondary','download')+buttons;
  const d = new Date(S.today + "T12:00:00+08:00");
  const date = d.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Shanghai",
  });
  if(page==='collections'&&canManageContractData(S))buttons=(S.actor.role==='admin'?button('迁移核对','data-review','','secondary'):'')+button('删除与恢复','records-recycle','','secondary')+buttons;
  if(page==='performance'&&S.actor.role==='admin')buttons=button('结算差额核对','settlement-review','','secondary')+buttons;
  const workbenchTitle={admin:'团队工作台',sales:'我的工作台',pm:'协作工作台'}[S.actor.role]||'工作台';
  const management=['analytics','team','funnel','assets','personal'].includes(page);
  return `<div class="page-heading ${page==='minutes'?'minutes-heading':page==='workbench'?'workbench-heading':management?'management-heading':''}"><div><h1>${page==='workbench'?workbenchTitle:S.actor.role==='sales'&&page==='team'?'过程绩效':page==='minutes'&&S.actor.role==='sales'?'我的钉钉听记':pages[page][0]}</h1>${page==='minutes'?`<p>${S.actor.role==='admin'?'查看所有成员已授权的闪记、录音与同步进度，可按账号筛选。':'本人创建的闪记与录音，默认查看全部听记。'}</p>`:''}${page==='workbench'?`<p>${date}</p>`:''}</div><div class="heading-actions">${buttons}</div></div>`;
}

export function renderPage(S, P) {
  if(!Object.hasOwn(pages,P.view))return empty('页面不存在','请使用左侧导航进入可访问的页面。');
  const adminOnly = ["audit", "analytics", "funnel", "assets", "team"];
  if (S.actor.role !== "admin" && adminOnly.includes(P.view))
    return empty("当前账号无权访问", "请使用左侧导航进入可访问的页面。");
  if(S.actor.role==='pm'&&['performance','commissions'].includes(P.view))return empty('当前账号无权访问','协作PM仅可访问关联交付与回款资料。');
  const render =
    {
      workbench,
      intake,
      customers,
      opportunities,
      activities,
      minutes:minutesPage,
      contracts,
      analytics: dashboard, funnel: dashboard, assets: dashboard, collections:collectionsPage, personal: dashboard,
      performance, commissions,
      team: (state, params) => `<link rel="stylesheet" href="./modules/management.css">${teamManagement(state, params)}`,
      audit: auditView,
    }[P.view] || workbench;
  return pageHeader(S, P) + render(S, P);
}

export function formContent(S, type, id, quarter) {
  if(['contract-delete','payment-maintain','contract-maintain','contract-project','contract-meta','contract-items','contract-upload','contract-terminate','payment-plan-create','payment-void','payment-reconcile','item-margin','payment-plan','contract-extract','collection-receive'].includes(type))return formWorkflow(S,type,id);
  if(type==='customer-level')return formCustomers(S,type,id,formOptions(S));
  if(type==='payment-allocation')return formContracts(S,type,id,formOptions(S));
  if(type==='target')return targetForm(S,id,quarter);
  if(type==='performance-review')return formIncentives(S,type,id);
  if(['activity-event-edit','activity-event-void','activity-legacy-edit','activity-legacy-void'].includes(type))return formActivities(S,type,id,{});
  if(manualFormRoles[type]&&!manualFormRoles[type].includes(S.actor.role))return empty('无权手动录入此类资料','请使用当前账号可维护的业务类型。');
  const options=formOptions(S);
  if(['customer','contact','edit-customer','edit-contact','customer-transfer'].includes(type)) {
    if(['edit-customer','edit-contact','customer-transfer'].includes(type)){
      const record=type==='edit-contact'?S.contacts.find(p=>p.id===Number(id)):S.customers.find(c=>c.id===Number(id));
      const customer=type==='edit-contact'?S.customers.find(c=>c.id===record?.customer_id):record;
      if(!customer)return empty('客户不存在或无权访问');
      if(!['admin','sales'].includes(S.actor.role)||S.actor.role!=='admin'&&customer.owner_id!==S.actor.id||type==='customer-transfer'&&S.actor.role!=='admin')return empty('当前账号无权维护此客户');
    }
    if(type==='contact'&&!options.customerOptions.length)return empty('请先新建客户','联系人必须关联已有客户。',button('新建客户','new-customer','','primary','plus'));
    return formCustomers(S,type,id,options);
  }
  if(['opportunity','edit-opportunity','opportunity-stage'].includes(type)){
    if(type!=='opportunity'){
      const o=S.opportunities.find(o=>o.id===Number(id));
      if(!o)return empty('商机不存在或无权访问');
      if(S.actor.role!=='admin'&&(S.actor.role!=='sales'||o.owner_id!==S.actor.id))return empty('当前账号无权维护此商机');
    }
    return formOpportunities(S,type,id,options);
  }
  if(['activity','quote'].includes(type)&&!options.oppOptions.length)return empty('请先新建商机','跟进与报价必须关联已有商机。',S.actor.role!=='pm'?button('新建商机','new-opportunity','','primary','plus'):'');
  if(type==='activity')return formActivities(S,type,id,options);
  if(type==='quote')return formQuotes(S,id,options);
  if(['contract','convert','payment','archive-contract'].includes(type)) {
    if(type==='contract'&&!options.customerOptions.length)return empty('请先新建客户','合同必须关联客户或商机。',button('新建客户','new-customer','','primary','plus'));
    if(type==='payment'&&!S.contracts.length)return empty('请先新建合同','回款必须关联已有合同。',button('新建合同','new-contract','','primary','plus'));
    return formContracts(S,type,id,options);
  }
  if(['document-templates','rules','finance-rules','sales-commission-policy','customer-levels','performance-rules'].includes(type))return formSettings(S,type,id,options);
  if(['commission-confirm','commission-pay','commission-live-pay'].includes(type))return empty('提成按最新资料实时计算','当前只查看实时金额和异常提示，无需确认或登记发放。');
  return empty('资料统一交给AI接收','上传文件或描述要新增、修改的数据，校验通过后再确认入库。',button('前往AI接收','ai-start','','primary','note'));
}
