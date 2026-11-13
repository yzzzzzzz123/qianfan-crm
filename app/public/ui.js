export const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  dashboard: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  customers:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  opportunities: "M4 4h16v4l-6 6v6l-4-2v-4L4 8z",
  activities: "M12 8v4l3 2 M22 12a10 10 0 1 1-10-10 10 10 0 0 1 10 10",
  contracts:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5",
  chart: "M3 3v18h18 M7 16v-4 M12 16V7 M17 16v-7",
  team: "M7 20v-4 M12 20V9 M17 20V4 M4 20h16",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3l-1 3-3 1-2 3 2 2-1 3 2 3h3l2 3h3l1-3 3-1 2-3-2-2 1-3-2-3h-3l-2-3z",
  audit: "M9 4H5v17h14V4h-4 M9 2h6v4H9z M8 11h8 M8 15h6",
  plus: "M12 5v14 M5 12h14",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  chevron: "M9 5l7 7-7 7",
  down: "M6 9l6 6 6-6",
  close: "M6 6l12 12 M6 18L18 6",
  calendar:
    "M8 2v4 M16 2v4 M3 10h18 M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2",
  check: "M5 12l4 4L19 6",
  clock: "M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  alert:
    "M12 9v4 M12 17h.01 M10.3 3.9L1.8 18.5A1.7 1.7 0 0 0 3.2 21h17.6a1.7 1.7 0 0 0 1.4-2.5L13.7 3.9a2 2 0 0 0-3.4 0",
  download: "M12 3v12 M7 10l5 5 5-5 M5 17v4h14v-4",
  logout: "M9 21H3V3h6 M9 12h12 M16 7l5 5-5 5",
  building: "M4 21V3h12v18 M16 9h4v12 M2 21h20 M8 7h4 M8 11h4 M8 15h4",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  refresh:
    "M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-2l2 2 M4 17l2 2a7 7 0 0 0 12-2",
  edit: "M12 20h9 M16 3l5 5L9 20H4v-5z M14 5l5 5",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
  shield: "M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6z M8 12l3 3 5-6",
  note: "M4 3h16v13l-5 5H4z M15 21v-5h5 M8 8h8 M8 12h6",
  wallet:
    "M20 8V5H5a3 3 0 0 1 0-3h14 M3 5v14a2 2 0 0 0 2 2h16V8H5 M21 12h-5v5h5",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  sort: "M8 4v16 M4 8l4-4 4 4 M16 20V4 M12 16l4 4 4-4",
};
export const icon = (name, cls = "") =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.note}"/></svg>`;
export const money = (c, compact = false) => {
  const n = Number(c || 0) / 100;
  return compact && Math.abs(n) >= 10000
    ? `${(n / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}<small>万</small>`
    : `¥${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
};
export const plainMoney = (c) =>
  "¥" +
  (Number(c || 0) / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export const dateLabel = (d) =>
  d ? d.slice(0, 10).replaceAll("-", ".") : "未设置";
export const shortDate = (d) =>
  d ? d.slice(5, 10).replace("-", "月") + "日" : "未设置";
export const userName = (S, id) =>
  S.users.find((u) => u.id === Number(id))?.name || "未分配";
export const salesName = (S, record) => record.owner_id?userName(S,record.owner_id):record.owner_label||'未分配销售';
export const customerName = (S, id) => {
  if (id == null) return '待补充客户';
  const c = S.customers.find((c) => c.id === Number(id));
  return c?.short_name || c?.name || S.contracts?.find(contract=>contract.customer_id===Number(id))?.customer_name || "客户";
};
export const avatar = (name, small = false) =>
  `<span class="avatar ${small ? "small" : ""} ${String(name).length % 2 ? "blue" : "violet"}">${esc(String(name).slice(-1))}</span>`;
export const badge = (label, tone = "neutral") =>
  `<span class="badge ${tone}">${esc(label)}</span>`;
export const isWonStage = s => ['赢单','成交'].includes(s);
export const isLostStage = s => ['输单','流失'].includes(s);
export const isClosedStage = s => isWonStage(s)||isLostStage(s)||s==='搁置';
export const stageBadge = (s) =>
  badge(s, isWonStage(s) ? "success" : isClosedStage(s) ? "neutral" : "blue");
export const riskBadge = (o) =>
  isClosedStage(o.stage)
    ? badge(
        isWonStage(o.stage) ? "已赢单" : isLostStage(o.stage) ? "已输单" : "已搁置",
        isWonStage(o.stage) ? "success" : "neutral",
      )
    : o.risk.level === "normal"
      ? '<span class="quiet-status"><span class="status-dot green"></span>正常推进</span>'
      : badge(o.risk.label, o.risk.level === "critical" ? "danger" : "warning");
export const aiDataActions=new Set(['new-customer','edit-customer','new-contact','edit-contact','new-opportunity','edit-opportunity','new-activity','new-quote','new-contract','convert','new-payment','edit-contract','edit-item','receive-payment','new-user','edit-rules','commission-pay','payment-checkpoint','edit-finance-rules','edit-user-mapping','edit-document-templates','bulk-targets','toggle-user']);
const manualNewActions=new Set(['new-customer','new-contact','new-opportunity','new-activity','new-quote','new-contract','new-payment','new-user','convert']);
const manualRecordActions=new Set(['commission-pay','edit-customer','edit-contact','edit-opportunity']);
export const actionButton = (
  label,
  action,
  id = "",
  kind = "primary",
  ico = "",
) => (aiDataActions.has(action)&&!manualNewActions.has(action)&&!manualRecordActions.has(action)||['ai-start'].includes(action))
  ? ''
  : `<button class="btn ${kind}" data-action="${action}" data-id="${esc(id)}">${ico ? icon(ico) : ""}${esc(label)}</button>`;
export const sectionHead = (title, sub = "", right = "") =>
  `<div class="section-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ""}</div>${right}</div>`;
export function stageTrack(S, o) {
  const flow=['线索','需求','方案','商务'],at=flow.indexOf(o.stage);
  return `<span class="stage-track" aria-label="阶段：${esc(o.stage)}">${flow.map((stage,i)=>`<i title="${stage}" class="${at>=0&&i<at?'complete':i===at?'current':''}"></i>`).join('')}${isClosedStage(o.stage)?`<span class="branch-mini">${esc(o.stage)}分支</span>`:''}</span>`;
}
export function stageRail(S,o) {
  const flow=['线索','需求','方案','商务'],branches=['赢单','输单','搁置'],at=flow.indexOf(o.stage);
  return `<div class="opportunity-stage-path"><div class="opp-stage-rail" role="group" aria-label="推进阶段">${flow.map((stage,i)=>`<span class="${i===at?'current':at>=0&&i<at?'done':''}" ${i===at?'aria-current="step"':''}><i>${at>=0&&i<at?icon('check'):''}</i>${stage}</span>`).join('')}</div><div class="stage-branch-label">状态分支</div><div class="stage-branches" role="group" aria-label="并列状态分支">${branches.map(stage=>`<span class="stage-branch ${stage===o.stage?'current':''}" data-stage-branch="${stage}" ${stage===o.stage?'aria-current="true"':''}>${stageBadge(stage)}</span>`).join('')}</div><p class="stage-branch-help">赢单、输单为结束状态；搁置后可恢复推进。</p></div>`;
}
export const empty = (
  title = "没有匹配的记录",
  description = "试试调整搜索词或筛选条件。",
  button = "",
) =>
  `<div class="empty">${icon("search")}<h3>${esc(title)}</h3><p>${esc(description)}</p>${button}</div>`;
export function select(name, label, options, value = "", extra = "") {
  return `<label class="field">${esc(label)}<select name="${name}" ${extra}>${options
    .map((o) => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(t)}</option>`;
    })
    .join("")}</select></label>`;
}
export function input(
  name,
  label,
  value = "",
  type = "text",
  required = true,
  extra = "",
) {
  return `<label class="field">${esc(label)}${required ? '<span class="required">*</span>' : ""}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? "required" : ""} ${extra}></label>`;
}
export function textarea(name, label, value = "", required = false) {
  return `<label class="field wide">${esc(label)}${required ? '<span class="required">*</span>' : ""}<textarea name="${name}" rows="3" ${required ? "required" : ""}>${esc(value)}</textarea></label>`;
}
export function formShell(
  title,
  description,
  fields,
  type,
  id = "",
  submit = "保存",
  {className = '', footerSummary = ''} = {},
) {
  return `<form data-form="${type}" data-id="${esc(id)}" data-key="${crypto.randomUUID()}"${className?` class="${esc(className)}"`:''}><header class="dialog-head"><div><h2>${esc(title)}</h2>${description?`<p>${esc(description)}</p>`:''}</div><button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="dialog-body form-grid"><p class="form-error wide" role="alert" tabindex="-1"></p>${fields}</div><footer class="dialog-footer">${footerSummary}<button type="button" class="btn ghost" data-action="close">取消</button><button class="btn primary" type="submit">${esc(submit)}</button></footer></form>`;
}
