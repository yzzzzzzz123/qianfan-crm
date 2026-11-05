import {
  esc,
  icon,
  plainMoney,
  dateLabel,
  shortDate,
  userName,
  customerName,
  avatar,
  badge,
  stageBadge,
  riskBadge,
  actionButton as button,
  stageTrack,
  empty,
  select,
  input,
} from "../ui.js";

export const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

export const fieldOwner = (S, v = "") =>
  select(
    "owner_id",
    "负责人",
    S.users.filter((u) => u.active).map((u) => [u.id, u.name]),
    v || S.actor.id,
  );

export const ownerOptions = (S, current = "") =>
  `<select id="filter-owner" aria-label="筛选负责人"><option value="">全部负责人</option>${S.users
    .filter((u) => u.active)
    .map(
      (u) =>
        `<option value="${u.id}" ${String(u.id) === current ? "selected" : ""}>${esc(u.name)}</option>`,
    )
    .join("")}</select>`;

export function filtered(S, P, list) {
  let result = list.filter((r) => !P.owner || r.owner_id === Number(P.owner));
  if (P.q) {
    const q = P.q.toLowerCase();
    result = result.filter((r) =>
      [
        r.name,
        r.code,
        r.industry,
        r.region,
        r.note,
        customerName(S, r.customer_id),
      ].some((v) =>
        String(v || "")
          .toLowerCase()
          .includes(q),
      ),
    );
  }
  if (P.stage) result = result.filter((r) => r.stage === P.stage);
  if (P.level) result = result.filter((r) => r.level === P.level);
  if (P.risk)
    result = result.filter((r) =>
      P.risk === "risk"
        ? r.risk?.level !== "normal"
        : P.risk === "today"
          ? r.follow_date &&
            r.follow_date <= S.today &&
            !["成交", "流失"].includes(r.stage)
          : true,
    );
  if (P.sort) {
    result = [...result].sort((a, b) =>
      typeof a[P.sort] === "number"
        ? (a[P.sort] - b[P.sort]) * (P.desc ? -1 : 1)
        : String(a[P.sort] || "").localeCompare(
            String(b[P.sort] || ""),
            "zh-CN",
          ) * (P.desc ? -1 : 1),
    );
  }
  return result;
}

export function metrics(items) {
  return `<section class="metrics" aria-label="业务简报">${items.map(([label, value, sub, ico]) => `<div class="metric"><div class="metric-label">${esc(label)}${icon(ico)}</div><div class="metric-value">${value}</div><p>${sub}</p></div>`).join("")}</section>`;
}

export function oppTable(S, list, compact = false) {
  return list.length
    ? `<div class="table-scroll"><table class="data-table ${compact ? "compact" : ""}"><thead><tr><th>商机 / 客户</th><th>当前阶段</th><th><button data-action="sort" data-id="amount">预计金额 ${icon("sort")}</button></th>${!compact ? "<th>负责人</th>" : ""}<th>下一步 / 跟进时间</th><th>推进状态</th><th class="row-tail"></th></tr></thead><tbody>${list.map((o) => `<tr><td><button class="record-title" data-action="opportunity" data-id="${o.id}">${esc(o.name)}</button><span class="record-meta">${esc(customerName(S, o.customer_id))}${!compact ? ` · ${esc(o.code)}` : ""}</span></td><td>${stageBadge(o.stage)}${stageTrack(S, o)}</td><td class="number strong">${plainMoney(o.amount)}</td>${!compact ? `<td><span class="owner-cell">${avatar(userName(S, o.owner_id), true)}${esc(userName(S, o.owner_id))}</span></td>` : ""}<td><span class="next-action">${esc(o.next_action)}</span><span class="record-meta ${o.risk.overdue ? "text-warning" : ""}">${o.follow_date ? (o.follow_date === S.today ? "今天跟进" : `${shortDate(o.follow_date)}${o.risk.overdue ? ` · 已逾期 ${o.risk.overdue} 天` : ""}`) : "未设置跟进日期"}</span></td><td>${riskBadge(o)}</td><td><button class="icon-btn" data-action="opportunity" data-id="${o.id}" aria-label="查看${esc(o.name)}">${icon("chevron")}</button></td></tr>`).join("")}</tbody></table></div>`
    : empty(
        "没有匹配的商机",
        "清空筛选，或开始记录下一条商机。",
        button("新建商机", "new-opportunity", "", "secondary", "plus"),
      );
}

export function pipeline(S) {
  const active = S.opportunities.filter(
    (o) => !["成交", "流失"].includes(o.stage),
  );
  const stage = S.stages
    .slice(0, 7)
    .map((s) => ({ name: s, opps: active.filter((o) => o.stage === s) }));
  const max = Math.max(1, ...stage.map((s) => s.opps.length));
  return `<div class="pipeline">${stage.map((s, i) => `<button class="pipeline-row" data-action="stage-filter" data-id="${esc(s.name)}"><span class="pipeline-stage">${esc(s.name)}</span><span class="pipeline-bar band-${Math.round((s.opps.length / max) * 10)} color-${i}"><i></i></span><b>${s.opps.length}<small>个</small></b><span class="pipeline-amount">${plainMoney(sum(s.opps, (o) => o.amount))}</span></button>`).join("")}</div>`;
}

export function filters(S, P, kind) {
  return `<div class="filterbar"><label class="list-search">${icon("search")}<input id="list-search" value="${esc(P.q)}" placeholder="${kind === "customers" ? "搜索客户名称、行业或地区" : kind === "contracts" ? "搜索合同名称、编号或客户" : "搜索商机名称、编号或客户"}" aria-label="搜索当前列表"></label><div class="filter-selects">${kind === "opportunities" ? `<select id="filter-stage" aria-label="筛选阶段"><option value="">全部阶段</option>${S.stages.map((s) => `<option ${P.stage === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>` : ""}${kind === "customers" ? `<select id="filter-level" aria-label="筛选客户等级"><option value="">全部等级</option>${["A", "B", "C"].map((s) => `<option value="${s}" ${P.level === s ? "selected" : ""}>${s}级客户</option>`).join("")}</select>` : ""}${S.actor.role === "admin" ? ownerOptions(S, P.owner) : ""}${button("重置筛选", "reset-filters", "", "ghost", "refresh")}</div></div>`;
}

export function timeline(S, activities, showOpp = true) {
  let last = "";
  return `<div class="timeline-list">${
    activities
      .map((a) => {
        const o = S.opportunities.find((o) => o.id === a.opportunity_id);
        const day = a.activity_date;
        const heading =
          last !== day
            ? `<h3 class="timeline-day">${day === S.today ? "今天" : dateLabel(day)}<span>${new Date(day + "T12:00:00").toLocaleDateString("zh-CN", { weekday: "long" })}</span></h3>`
            : "";
        last = day;
        return `${heading}<article class="timeline-entry"><div class="timeline-icon ${a.activity_type === "系统" ? "system" : ""}">${icon(a.activity_type === "现场拜访" ? "building" : a.activity_type === "系统" ? "check" : "note")}</div><div class="timeline-main"><div class="timeline-meta"><b>${esc(userName(S, a.user_id))}</b>${badge(a.source, a.activity_type === "系统" ? "neutral" : "blue")}<span>${dateLabel(a.activity_date)}</span></div>${showOpp ? `<button class="record-title timeline-title" data-action="opportunity" data-id="${a.opportunity_id}">${esc(o?.name)} <span>· ${esc(customerName(S, o?.customer_id))}</span></button>` : ""}<p>${esc(a.summary)}</p>${a.action ? `<div class="timeline-next">${icon("arrow")}<span>下一步：${esc(a.action)}</span></div>` : ""}</div></article>`;
      })
      .join("") ||
    empty(
      "还没有跟进记录",
      "记录一次沟通，并约定下一步动作。",
      button("记录跟进", "new-activity", "", "secondary", "plus"),
    )
  }</div>`;
}

export function formOptions(S) {
  const ownCustomers = S.customers.filter((c) => !c.shared);
  const customerOptions = ownCustomers.map((c) => [
    c.id,
    c.short_name || c.name,
  ]);
  const oppOptions = S.opportunities
    .filter((o) => !["流失"].includes(o.stage))
    .map((o) => [o.id, `${customerName(S, o.customer_id)} · ${o.name}`]);
  return { customerOptions, oppOptions };
}
