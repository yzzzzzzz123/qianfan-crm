import {
  esc,
  icon,
  avatar,
  actionButton as button,
  empty,
  input,
} from "./ui.js";
import { formOptions } from "./modules/shared.js";

import { workbench } from "./modules/workbench.js";
import { customers, customerDetail } from "./modules/customers.js";
import { opportunities, opportunityDetail } from "./modules/opportunities.js";
import { activities } from "./modules/activities.js";
import {
  contracts,
  contractDetail,
  contractItemRow,
} from "./modules/contracts.js";
import { analytics } from "./modules/analytics.js";
import { team } from "./modules/team.js";
import { settings } from "./modules/settings.js";
import { auditView } from "./modules/audit.js";
import { formCustomers } from "./modules/customers.js";
import { formOpportunities } from "./modules/opportunities.js";
import { formActivities } from "./modules/activities.js";
import { formQuotes } from "./modules/quotes.js";
import { formContracts } from "./modules/contracts.js";
import { formPayments } from "./modules/payments.js";
import { formTeam } from "./modules/team.js";
import { formSettings } from "./modules/settings.js";

export { filtered, timeline } from "./modules/shared.js";
export { customerDetail } from "./modules/customers.js";
export { opportunityDetail } from "./modules/opportunities.js";
export { contractDetail, contractItemRow } from "./modules/contracts.js";

export const pages = {
  workbench: ["工作台", "把每一次跟进，推进一步。"],
  customers: ["客户档案", "统一管理客户关系，让每次沟通都有上下文。"],
  opportunities: ["商机推进", "看清阶段、下一步与需要介入的商机。"],
  activities: ["跟进记录", "让沟通有记录，让行动有下文。"],
  contracts: ["合同与回款", "从签约到到账，每个节点都有据可查。"],
  analytics: ["经营分析", "从客户、商机和到账记录，了解业务进展。"],
  team: ["团队与绩效", "关注过程投入，及时识别需要支持的同事。"],
  settings: ["设置", "管理团队成员、阶段规则和系统连接。"],
  audit: ["操作记录", "关键变更留痕，方便核对与追溯。"],
};

export function shell(S, page) {
  const admin = S.actor.role === "admin";
  const nav = (id, ico, label, count = "") =>
    `<a href="#${id}" class="nav-item ${page === id ? "active" : ""}" ${page === id ? 'aria-current="page"' : ""}>${icon(ico)}<span>${label}</span>${count !== "" ? `<span class="nav-count">${count}</span>` : ""}</a>`;
  const riskCount = S.opportunities.filter(
    (o) => o.risk.level !== "normal",
  ).length;
  return `<aside class="sidebar" id="sidebar"><a href="#workbench" class="brand" aria-label="千帆创科 CRM 首页"><span class="brand-crop"><img src="/assets/brand.png" alt="千帆创科"></span><span class="brand-divider"></span><b>CRM</b></a><div class="workspace-label"><span class="workspace-mark">千</span><span>千帆创科商务部<small>客户与销售协同</small></span></div><nav aria-label="主导航"><p class="nav-label">业务工作</p>${nav("workbench", "dashboard", "工作台")}${nav("customers", "customers", "客户档案")}${nav("opportunities", "opportunities", "商机推进", riskCount || "")}${nav("activities", "activities", "跟进记录")}${nav("contracts", "contracts", "合同与回款")}<p class="nav-label">${admin ? "团队管理" : "个人成长"}</p>${admin ? nav("analytics", "chart", "经营分析") : ""}${nav("team", "team", admin ? "团队与绩效" : "过程绩效")}${admin ? `<p class="nav-label">系统管理</p>${nav("settings", "settings", "设置")}${nav("audit", "audit", "操作记录")}` : ""}</nav><div class="sidebar-bottom"><div class="local-status"><span class="status-dot ${S.demo ? "orange" : "green"}"></span>${S.demo ? "浏览器独立试用" : "独立部署工作区"}</div><p>${S.demo ? "示例数据 · 可实际操作" : "数据保存在当前服务器"}</p><span class="version">千帆 CRM <b>2.0</b></span></div></aside><div class="app-body"><header class="topbar"><button class="icon-btn mobile-menu" data-action="menu" aria-label="打开导航">${icon("menu")}</button><div class="breadcrumb">千帆 CRM ${icon("chevron")} <span>${pages[page]?.[0] || "工作台"}</span></div><div class="global-search">${icon("search")}<input id="global-search" placeholder="搜索客户、商机、合同" aria-label="全局搜索" autocomplete="off"><kbd>/</kbd><div id="search-results" hidden></div></div><span class="env-tag">${S.demo ? "演示环境" : "正式工作区"}</span><button class="user-menu" data-action="account" aria-label="当前账号与退出">${avatar(S.actor.name, true)}<span>${esc(S.actor.name)}<small>${admin ? "管理员" : "销售"}</small></span>${icon("down")}</button></header><main id="content" tabindex="-1"></main><footer class="page-footer"><span>千帆创科 · 每一步，都有进展</span><span>${S.demo ? "仅当前浏览器保存 · 外部集成未接入" : "独立部署版"}<span class="footer-dot">·</span>数据持久保存</span></footer></div>`;
}

export function pageHeader(S, P) {
  const page = P.view;
  let buttons = "";
  if (page === "workbench" || page === "opportunities")
    buttons =
      button("记录跟进", "new-activity", "", "secondary", "note") +
      button("新建商机", "new-opportunity", "", "primary", "plus");
  if (page === "customers")
    buttons =
      button("导出台账", "export", "", "secondary", "download") +
      button("新建客户", "new-customer", "", "primary", "plus");
  if (page === "activities")
    buttons = button("记录跟进", "new-activity", "", "primary", "plus");
  if (page === "contracts")
    buttons =
      button("导出台账", "export", "", "secondary", "download") +
      (S.actor.role === "admin"
        ? button("新建合同", "new-contract", "", "primary", "plus")
        : "");
  if (page === "team" && S.actor.role === "admin")
    buttons = button("设置季度目标", "target", "", "primary", "edit");
  if (page === "analytics")
    buttons = button("刷新数据", "reload", "", "secondary", "refresh");
  const d = new Date(S.today + "T12:00:00+08:00");
  const date = d.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Shanghai",
  });
  return `<div class="page-heading"><div><h1>${page === "workbench" ? `${esc(S.actor.name)}，${new Date().getHours() < 12 ? "上午" : "下午"}好` : S.actor.role === "sales" && page === "team" ? "过程绩效" : pages[page][0]}</h1><p>${page === "workbench" ? `${date} <span class="dot-divider">·</span> ${S.actor.role === "admin" ? "一起关注今天最值得推进的事。" : "从今天的跟进开始，推进手中的商机。"}` : pages[page][1]}</p></div><div class="heading-actions">${buttons}</div></div>`;
}

export function renderPage(S, P) {
  const adminOnly = ["settings", "audit", "analytics"];
  if (S.actor.role !== "admin" && adminOnly.includes(P.view))
    return empty("当前账号无权访问", "请使用左侧导航进入可访问的页面。");
  const render =
    {
      workbench,
      customers,
      opportunities,
      activities,
      contracts,
      analytics,
      team,
      settings,
      audit: auditView,
    }[P.view] || workbench;
  return pageHeader(S, P) + render(S, P);
}

const formHandlers = [
  formCustomers,
  formOpportunities,
  formActivities,
  formQuotes,
  formContracts,
  formPayments,
  formTeam,
  formSettings,
];
export function formContent(S, type, id) {
  const options = formOptions(S);
  for (const handler of formHandlers) {
    const html = handler(S, type, id, options);
    if (html !== undefined) return html;
  }
  return empty("暂不支持此操作");
}
