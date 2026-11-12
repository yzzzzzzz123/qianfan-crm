import {
  esc,
  icon,
  plainMoney,
  dateLabel,
  shortDate,
  userName,salesName,
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
  isClosedStage,
  isLostStage,
} from "../ui.js";
import {opportunityActualAmount,opportunityActualProduct} from './opportunity-view-model.js';
export {selectOpportunities,opportunityMatchesQuery,opportunityActualAmount,opportunityActualProduct} from './opportunity-view-model.js';

export const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
export const reportMonthForPage=(page,selectedMonth,today)=>page==='performance'&&selectedMonth?selectedMonth:today.slice(0,7);

export const needsFollowup = (record, today) => !isClosedStage(record.stage) &&
  (!!record.follow_date && record.follow_date <= today || !!record.risk && record.risk.level !== 'normal');

export function followupFilters(S, P) {
  const scoped=['analytics','personal'].includes(P.view);
  return {risk:'today',followupScope:true,stage:'',q:'',level:'',owner:scoped?(P.owner||(P.view==='personal'?String(S.actor.id):'')):'',
    customerLevel:scoped?P.level||'':'',saleType:scoped?P.saleType||'':'',from:scoped?P.from||'':'',to:scoped?P.to||'':''};
}

export const fieldOwner = (S, v = "", preserveMissing = false) =>
  select(
    "owner_id",
    "负责人",
    [...(preserveMissing ? [['', '原始资料未提供']] : []), ...S.users.filter((u) => u.active && u.role!=='pm').map((u) => [u.id, u.name])],
    preserveMissing ? '' : v || S.actor.id,
  );

export const ownerOptions = (S, current = "") =>
  `<select id="filter-owner" aria-label="筛选负责人"><option value="">全部负责人</option>${S.users
    .filter((u) => u.active)
    .map(
      (u) =>
        `<option value="${u.id}" ${String(u.id) === current ? "selected" : ""}>${esc(u.name)}</option>`,
    )
    .join("")}</select>`;

const normalizedSearch=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();
export function customerSearchText(S,c){
  const contacts=c.shared?[]:(S.contacts||[]).filter(p=>p.customer_id===c.id&&!p.archived_at);
  return normalizedSearch([c.name,c.short_name,c.industry,c.region,c.credit_code,c.parent_company,c.group_name,c.tags,c.compliance_flag,c.note,
    ...contacts.flatMap(p=>[p.name,p.title,p.phone,p.wechat,p.dingtalk,p.phone?.replace(/[\s-]/g,'')])].filter(Boolean).join(' '));
}
export function customerMatchesQuery(S,c,query){
  const text=customerSearchText(S,c);
  return normalizedSearch(query).split(' ').filter(Boolean).every(part=>text.includes(part));
}
export function selectCustomers(S,P={}){
  const scope=P.customerScope||(S.actor.role==='sales'?'mine':'all');
  let list=(S.customers||[]).filter(c=>scope==='mine'?c.owner_id===S.actor.id:scope==='shared'?c.shared===true:true);
  if(P.q)list=list.filter(c=>customerMatchesQuery(S,c,P.q));
  return filtered(S,{...P,q:''},list);
}

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
  if (P.level) result = result.filter((r) => (r.manual_level||'') === P.level);
  if (P.customerLevel) result = result.filter(r=>S.customers.some(c=>c.id===r.customer_id&&c.manual_level===P.customerLevel));
  if (P.saleType) result = result.filter(r=>r.sale_type===P.saleType);
  if (P.from || P.to) result = result.filter(r=>r.created_at&&(!P.from||r.created_at.slice(0,10)>=P.from)&&(!P.to||r.created_at.slice(0,10)<=P.to));
  if (P.risk)
    result = result.filter((r) =>
      P.risk === "risk"
        ? r.risk?.level !== "normal"
        : P.risk === "today"
          ? needsFollowup(r,S.today)
          : true,
    );
  if(P.risk==='active')result=result.filter(r=>!isClosedStage(r.stage));
  if(P.risk==='won')result=result.filter(r=>r.stage==='赢单');
  if (P.sort) {
    result = [...result].sort((a, b) =>
      P.sort==='stage'?S.stages.indexOf(a.stage)-S.stages.indexOf(b.stage):P.sort==='follow_date'&&(!a.follow_date||!b.follow_date)?(!a.follow_date?1:0)-(!b.follow_date?1:0):typeof a[P.sort] === "number"
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
    ? `<div class="table-scroll"><table class="data-table ${compact ? "compact" : ""}"><thead><tr><th>客户 / 售卖产品</th><th><button data-action="sort" data-id="stage">当前阶段 ${icon("sort")}</button></th><th><button data-action="sort" data-id="amount">商机 / 签约金额 ${icon("sort")}</button></th>${!compact ? "<th>销售</th><th>销售 / 订单类型</th>" : ""}<th><button data-action="sort" data-id="follow_date">下一步 / 跟进时间 ${icon("sort")}</button></th><th>推进状态</th></tr></thead><tbody>${list.map((o) => `<tr class="record-row" tabindex="0" data-action="opportunity" data-id="${o.id}" aria-label="查看${esc(customerName(S,o.customer_id))}的商机"><td><span class="record-title company-title">${esc(customerName(S,o.customer_id))}</span><span class="record-meta">${esc(o.name)}${!compact ? ` · ${esc(o.code)}` : ""}</span></td><td>${stageBadge(o.stage)}${stageTrack(S, o)}</td><td class="number strong">${opportunityActualAmount(o)==null?"待核对":plainMoney(opportunityActualAmount(o))}${!compact?`<span class="record-meta">${isClosedStage(o.stage)&&["赢单","成交"].includes(o.stage)?"有效签约产品":"预计产品"} ${opportunityActualProduct(o)==null?"未提供":plainMoney(opportunityActualProduct(o))}</span>`:""}</td>${!compact ? `<td><span class="owner-cell">${avatar(salesName(S,o), true)}${esc(salesName(S,o))}</span></td><td>${esc(o.sale_type||"待补充")}<span class="record-meta">${esc(o.order_type||"待补充")}</span></td>` : ""}<td><span class="next-action">${esc(o.next_action)}</span><span class="record-meta ${o.risk.overdue ? "text-warning" : ""}">${o.follow_date ? (o.follow_date === S.today ? "今天跟进" : `${shortDate(o.follow_date)}${o.risk.overdue ? ` · 已逾期 ${o.risk.overdue} 天` : ""}`) : "未设置跟进日期"}</span></td><td>${riskBadge(o)}</td></tr>`).join("")}</tbody></table></div>`
    : empty(
        "没有匹配的商机",
        "可调整筛选条件。",
      );
}

export function pipeline(S,interactive=true) {
  const active = S.opportunities.filter(
    (o) => !isClosedStage(o.stage),
  );
  const stage = S.stages
    .filter(s=>!isClosedStage(s))
    .map((s) => ({ name:s, amount:sum(active.filter(o=>o.stage===s),o=>o.amount||0) }));
  const max=Math.max(1,...stage.map(s=>s.amount));
  return `<div class="pipeline amount-pipeline">${stage.map((s,i)=>`<${interactive?'button':'div'} class="pipeline-row" ${interactive?`data-action="stage-filter" data-id="${esc(s.name)}"`:''}><span class="pipeline-stage">${esc(s.name)}</span><span class="pipeline-bar band-${Math.round(s.amount/max*10)} color-${i}"><i></i></span><span class="pipeline-amount">${plainMoney(s.amount)}</span></${interactive?'button':'div'}>`).join('')}</div>`;
}

export function filters(S, P, kind) {
  return `<div class="filterbar"><label class="list-search">${icon("search")}<input id="list-search" value="${esc(P.q)}" placeholder="${kind === "customers" ? "搜索名称、简称、联系人或信用代码" : kind === "contracts" ? "搜索合同名称、编号或客户" : "搜索售卖产品、编号或客户"}" aria-label="搜索当前列表"></label><div class="filter-selects">${kind === "opportunities" ? `<select id="filter-stage" aria-label="筛选阶段"><option value="">全部阶段</option>${S.stages.map((s) => `<option ${P.stage === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>` : ""}${kind === "customers" ? `<select id="filter-level" aria-label="筛选客户等级"><option value="">全部等级</option>${(S.rules.customer_levels||["A", "B", "C"]).map((s) => `<option value="${esc(s)}" ${P.level === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>` : ""}${S.actor.role === "admin" && kind !== "opportunities" ? ownerOptions(S, P.owner) : ""}${button("重置筛选", "reset-filters", "", "ghost", "refresh")}</div></div>`;
}

export function timeline(S, activities, showOpp = true, opportunityId = "") {
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
        return `${heading}<article class="timeline-entry"><div class="timeline-icon ${a.activity_type === "系统" ? "system" : ""}">${icon(a.activity_type === "现场拜访" ? "building" : a.activity_type === "系统" ? "check" : "note")}</div><div class="timeline-main"><div class="timeline-meta"><b>${esc(userName(S, a.user_id))}</b>${badge(a.source, a.activity_type === "系统" ? "neutral" : "blue")}<span>${dateLabel(a.activity_date)}</span></div>${showOpp ? `<button class="record-title timeline-title" data-action="opportunity" data-id="${a.opportunity_id}">${esc(o?.name)} <span>· ${esc(customerName(S, o?.customer_id))}</span></button>` : ""}${a.source_notice?`<p class="activity-lock-note">${esc(a.source_notice)}</p>`:""}<p>${esc(a.summary)}</p>${a.action ? `<div class="timeline-next">${icon("arrow")}<span>下一步：${esc(a.action)}</span></div>` : ""}</div></article>`;
      })
      .join("") ||
    empty(
      "还没有跟进记录",
      "",
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
    .filter((o) => !isLostStage(o.stage))
    .map((o) => [o.id, `${customerName(S, o.customer_id)} · ${o.name}`]);
  return { customerOptions, oppOptions };
}
