import {
  esc,
  icon,
  plainMoney,
  dateLabel,
  shortDate,
  userName,
  badge,
  stageBadge,
  riskBadge,
  actionButton as button,
  sectionHead,
  empty,
  select,
  input,
  textarea,
  formShell,
} from "../ui.js";
import {
  sum,
  filtered,
  metrics,
  oppTable,
  filters,
  timeline,
} from "./shared.js";

export function opportunities(S, P) {
  const list = filtered(S, P, S.opportunities);
  const active = S.opportunities.filter(
    (o) => !["成交", "流失"].includes(o.stage),
  );
  return `<div class="list-summary"><div class="segment"><button data-action="risk-filter" data-id="" class="${!P.risk ? "selected" : ""}">全部商机 <b>${S.opportunities.length}</b></button><button data-action="risk-filter" data-id="today" class="${P.risk === "today" ? "selected" : ""}">待跟进 <b>${active.filter((o) => o.follow_date && o.follow_date <= S.today).length}</b></button><button data-action="risk-filter" data-id="risk" class="${P.risk === "risk" ? "selected" : ""}">风险商机 <b>${active.filter((o) => o.risk.level !== "normal").length}</b></button></div><span>当前列表预计金额 <b>${plainMoney(sum(list, (o) => o.amount))}</b></span></div><section class="panel">${filters(S, P, "opportunities")}${oppTable(S, list)}<div class="table-footer">共 ${list.length} 条商机<span>阶段变化与跟进实时留痕</span></div></section>`;
}

export function opportunityDetail(S, id) {
  const o = S.opportunities.find((o) => o.id === Number(id));
  if (!o) return empty("商机不存在");
  const c = S.customers.find((c) => c.id === o.customer_id);
  const a = S.activities.filter((a) => a.opportunity_id === o.id);
  const quotes = S.quotes.filter((q) => q.opportunity_id === o.id);
  const contract = S.contracts.find((c) => c.opportunity_id === o.id);
  const closed = ["成交", "流失"].includes(o.stage);
  const contacts = S.contacts.filter((p) => p.customer_id === o.customer_id);
  return `<header class="dialog-head"><div><span class="detail-type">${esc(o.code)} ${stageBadge(o.stage)}</span><h2>${esc(o.name)}</h2><p>${esc(c?.name)} · ${esc(userName(S, o.owner_id))}负责</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon("close")}</button></header><div class="drawer-body"><div class="opp-stage-rail">${S.stages
    .map(
      (s, i) =>
        `<span class="${s === o.stage ? "current" : o.stage !== "流失" && i < S.stages.indexOf(o.stage) ? "done" : ""}"><i>${o.stage !== "流失" && i < S.stages.indexOf(o.stage) ? icon("check") : ""}</i>${esc(s)}</span>`,
    )
    .join(
      "",
    )}</div><div class="detail-metrics"><div><span>预计金额</span><b>${plainMoney(o.amount)}</b></div><div><span>预计成交</span><b>${dateLabel(o.expected_date)}</b></div><div><span>推进状态</span>${riskBadge(o)}</div></div><div class="detail-actionbar">${button("记录跟进", "new-activity", o.id, "primary", "note")}${!closed ? button("推进阶段", "edit-opportunity", o.id, "secondary", "arrow") + button("登记报价", "new-quote", o.id, "secondary", "contracts") : ""}${S.actor.role === "admin" && !closed ? button("成交转合同", "convert", o.id, "secondary", "check") : ""}${contract ? button("查看合同", "contract", contract.id, "secondary", "contracts") : ""}</div><div class="next-step-block"><div>${icon("arrow")}<b>下一步行动</b><span>${o.follow_date === S.today ? "今天" : shortDate(o.follow_date)}</span></div><p>${esc(o.next_action || "待安排")}</p></div><section class="detail-section">${sectionHead("阶段建议", "", badge("规则建议 · 非大模型生成", "blue"))}<div class="suggestion"><p>${esc(S.rules.sop[o.stage])}</p>${o.risk.overdue ? `<p class="text-warning">已超过约定跟进日期 ${o.risk.overdue} 天，先确认客户反馈，再更新下一步。</p>` : ""}${!contacts.some((p) => p.role === "决策人") && !closed ? "<p>决策人信息尚未补齐，建议在下一次沟通中确认决策链。</p>" : ""}</div>${o.stage === "流失" ? `<p class="prose">流失原因：${esc(o.lost_reason)}</p>` : ""}</section>${quotes.length ? `<section class="detail-section">${sectionHead("报价记录", `${quotes.length} 份记录 · 正式模板待提供`)}${quotes.map((q) => `<div class="quote-line"><span><b>${esc(q.code)}</b><small>有效期至 ${dateLabel(q.valid_until)}</small></span><b>${plainMoney(q.amount)}</b></div>`).join("")}</section>` : ""}<section class="detail-section">${sectionHead("跟进时间线", `${a.length} 条跟进与系统里程碑`)}${timeline(S, a, false)}</section></div>`;
}

export function formOpportunities(S, type, id, options) {
  const { customerOptions } = options;
  if (type === "opportunity") {
    if (!customerOptions.length)
      return formShell(
        "新建商机",
        "先建立客户档案，再录入商机。",
        `<div class="wide">${empty("还没有可维护的客户", "先建立客户档案，明确归属。", button("新建客户", "new-customer", "", "primary", "plus"))}</div>`,
        type,
        id,
        "创建商机",
      );
    return formShell(
      "新建商机",
      "商机先手工录入，下一步动作和日期必填。",
      select(
        "customer_id",
        "关联客户",
        customerOptions,
        id || customerOptions[0][0],
      ) +
        input("name", "商机名称") +
        input(
          "amount",
          "预计金额（元）",
          "",
          "number",
          true,
          'min="0" step="0.01"',
        ) +
        select("product_type", "产品类型", ["标品", "实施", "混合"]) +
        select("stage", "当前阶段", S.stages.slice(0, 7), "线索") +
        select("source", "商机来源", ["自建", "分发"]) +
        select("nature", "订单性质", ["新签", "续签"]) +
        input("expected_date", "预计成交日期", "", "date", false) +
        textarea("next_action", "下一步动作", "", true) +
        input("follow_date", "下次跟进日期", S.today, "date"),
      type,
      id,
      "创建商机",
    );
  }
  if (type === "edit-opportunity") {
    const o = S.opportunities.find((o) => o.id === Number(id));
    return formShell(
      "推进商机",
      "调整阶段时会自动写入系统里程碑。",
      select(
        "stage",
        "销售阶段",
        S.stages.filter((s) => s !== "成交"),
        o.stage,
      ) +
        input(
          "amount",
          "预计金额（元）",
          o.amount / 100,
          "number",
          true,
          'min="0" step="0.01"',
        ) +
        textarea("next_action", "下一步动作", o.next_action, true) +
        input(
          "follow_date",
          "下次跟进日期",
          o.follow_date || "",
          "date",
          false,
        ) +
        input(
          "expected_date",
          "预计成交日期",
          o.expected_date || "",
          "date",
          false,
        ) +
        textarea(
          "lost_reason",
          "流失原因（选择流失时必填）",
          o.lost_reason || "",
        ),
      type,
      id,
      "保存推进",
    );
  }
}
