import { esc, icon, sectionHead, empty } from "../ui.js";

export function auditView(S) {
  return `<section class="panel">${sectionHead("关键操作记录", "展示最近 200 条操作，按发生时间倒序")}<div class="table-scroll"><table class="data-table"><thead><tr><th>操作</th><th>执行人</th><th>关联对象</th><th>时间</th></tr></thead><tbody>${S.audit.map((a) => `<tr><td><span class="audit-action">${icon("check")}${esc(a.action)}</span></td><td>${esc(a.user_name || "系统")}</td><td>${esc({ customer: "客户", opportunity: "商机", contract: "合同", user: "成员", settings: "规则", system: "系统" }[a.entity] || a.entity)}${a.entity_id ? " #" + a.entity_id : ""}</td><td class="muted">${new Date(a.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</td></tr>`).join("")}</tbody></table></div>${S.audit.length ? "" : empty("还没有操作记录", "创建客户或记录跟进后会在这里留下记录。")}</section>`;
}
