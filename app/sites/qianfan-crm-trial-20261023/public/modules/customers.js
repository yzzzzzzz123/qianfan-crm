import {
  esc,
  icon,
  plainMoney,
  userName,
  avatar,
  badge,
  stageBadge,
  actionButton as button,
  sectionHead,
  empty,
  select,
  input,
  textarea,
  formShell,
} from "../ui.js";
import { fieldOwner, filtered, filters, timeline } from "./shared.js";

export function customers(S, P) {
  const list = filtered(S, P, S.customers);
  return `<div class="list-summary"><div class="segment"><button class="selected" data-action="noop">全部客户 <b>${S.customers.length}</b></button></div><span>客户主档团队共享，联系信息按归属可见</span></div><section class="panel">${filters(S, P, "customers")}${list.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>客户名称</th><th>行业 / 地区</th><th>等级</th><th>负责人</th><th>客户状态</th><th>进行中商机</th><th></th></tr></thead><tbody>${list.map((c) => `<tr><td><div class="company-cell"><span class="company-symbol">${esc((c.short_name || c.name).slice(0, 1))}</span><div><button class="record-title" data-action="customer" data-id="${c.id}">${esc(c.name)}</button><span class="record-meta">${esc(c.short_name || "未设置简称")}${c.shared ? " · 共享主档" : ""}</span></div></div></td><td>${esc(c.industry || "未设置")}<span class="record-meta">${esc(c.region || "未设置地区")}</span></td><td><span class="level level-${c.level}">${c.level}</span></td><td><span class="owner-cell">${avatar(userName(S, c.owner_id), true)}${esc(userName(S, c.owner_id))}</span></td><td>${badge(c.status, c.status === "成交" ? "success" : c.status === "潜在" ? "blue" : "neutral")}</td><td>${c.shared ? '<span class="muted">按权限可见</span>' : S.opportunities.filter((o) => o.customer_id === c.id && !["成交", "流失"].includes(o.stage)).length + " 个"}</td><td><button class="icon-btn" data-action="customer" data-id="${c.id}" aria-label="查看${esc(c.name)}">${icon("chevron")}</button></td></tr>`).join("")}</tbody></table></div>` : empty()}<div class="table-footer">共 ${list.length} 位客户<span>客户信息以 CRM 为准</span></div></section>`;
}

export function customerDetail(S, id) {
  const c = S.customers.find((c) => c.id === Number(id));
  if (!c) return empty("客户不存在");
  const own = S.actor.role === "admin" || c.owner_id === S.actor.id;
  const contacts = S.contacts.filter((x) => x.customer_id === c.id);
  const opps = S.opportunities.filter((o) => o.customer_id === c.id);
  return `<header class="dialog-head"><div><span class="detail-type">客户档案 ${badge(c.level + "级", "blue")}</span><h2>${esc(c.name)}</h2><p>${esc(c.industry || "未分类")} · ${esc(c.region || "未设置地区")}</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon("close")}</button></header><div class="drawer-body"><div class="detail-actionbar">${own ? button("编辑档案", "edit-customer", c.id, "secondary", "edit") + button("新建商机", "new-opportunity", c.id, "primary", "plus") : badge("共享主档 · 联系信息按归属可见")}</div><dl class="detail-facts"><div><dt>负责人</dt><dd>${esc(userName(S, c.owner_id))}</dd></div><div><dt>客户状态</dt><dd>${badge(c.status, c.status === "成交" ? "success" : "blue")}</dd></div>${!c.shared ? `<div><dt>客户规模</dt><dd>${esc(c.scale || "待补充")}</dd></div><div><dt>信用代码</dt><dd>${esc(c.credit_code || "待补充")}</dd></div>` : ""}</dl>${c.shared ? "" : `<section class="detail-section">${sectionHead("联系人与决策链", "", button("添加联系人", "new-contact", c.id, "ghost", "plus"))}<div class="contact-list">${contacts.map((p) => `<div class="contact-item">${avatar(p.name, true)}<div><b>${esc(p.name)} <span>${esc(p.title)}</span></b><p>${esc(p.phone || "未填写电话")}</p></div>${badge(p.role, p.role === "决策人" ? "blue" : "neutral")}${badge(p.attitude, p.attitude === "支持" ? "success" : "neutral")}</div>`).join("") || '<p class="muted">还没有联系人，补齐决策链能让跟进更具体。</p>'}</div></section>`}<section class="detail-section">${sectionHead("关联商机", `${opps.length} 个商机`)}${opps.map((o) => `<button class="linked-record" data-action="opportunity" data-id="${o.id}"><span><b>${esc(o.name)}</b><small>${plainMoney(o.amount)} · ${esc(o.next_action)}</small></span>${stageBadge(o.stage)}${icon("chevron")}</button>`).join("") || '<p class="muted">暂无可见的关联商机。</p>'}</section>${!c.shared ? `<section class="detail-section"><h3>客户备注</h3><p class="prose">${esc(c.note || "暂无备注")}</p></section><section class="detail-section">${sectionHead("客户沟通记录")}${timeline(S, S.activities.filter((a) => opps.some((o) => o.id === a.opportunity_id)).slice(0, 12), false)}</section>` : ""}</div>`;
}

export function formCustomers(S, type, id, options) {
  if (type === "customer" || type === "edit-customer") {
    const c = S.customers.find((c) => c.id === Number(id)) || {};
    return formShell(
      type === "customer" ? "新建客户" : "编辑客户档案",
      "建立清晰的客户归属与基础信息。",
      input("name", "客户全称", c.name || "") +
        input("short_name", "客户简称", c.short_name || "", "text", false) +
        input("industry", "行业", c.industry || "", "text", false) +
        input("region", "地区", c.region || "", "text", false) +
        select("level", "客户等级", ["A", "B", "C"], c.level || "B") +
        (S.actor.role === "admin" ? fieldOwner(S, c.owner_id) : "") +
        input("scale", "客户规模", c.scale || "", "text", false) +
        input(
          "credit_code",
          "统一社会信用代码",
          c.credit_code || "",
          "text",
          false,
        ) +
        (type === "edit-customer"
          ? select(
              "status",
              "客户状态",
              ["潜在", "成交", "流失", "冻结"],
              c.status,
            )
          : "") +
        (type === "edit-customer" && S.actor.role === "admin"
          ? input("reason", "调整归属原因（改负责人时必填）", "", "text", false)
          : "") +
        textarea("note", "客户备注", c.note || ""),
      type,
      id,
      type === "customer" ? "创建客户" : "保存档案",
    );
  }
  if (type === "contact")
    return formShell(
      "添加联系人",
      "补齐决策链，记录联系人的角色与态度。",
      input("name", "姓名") +
        input("title", "职位", "", "text", false) +
        input("phone", "电话", "", "tel", false) +
        select("role", "决策角色", ["决策人", "影响者", "使用人", "把关人"]) +
        select("attitude", "当前态度", ["中立", "支持", "反对"]) +
        textarea("note", "备注"),
      type,
      id,
      "添加联系人",
    );
}
