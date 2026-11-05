import {
  esc,
  icon,
  money,
  shortDate,
  userName,salesName,
  customerName,
  avatar,
  badge,
  actionButton as button,
  sectionHead,
  empty,
  isClosedStage,
} from "../ui.js";
import { sum, metrics, oppTable, pipeline, needsFollowup } from "./shared.js";

export function workbench(S, range = {}) {
  const customRange=!!(range.from||range.to),month=S.today.slice(0,7);
  const inRange=date=>!!date&&(customRange?(!range.from||date.slice(0,10)>=range.from)&&(!range.to||date.slice(0,10)<=range.to):date.startsWith(month));
  const active = S.opportunities.filter(
    (o) => !isClosedStage(o.stage),
  );
  const due = active
    .filter(o=>needsFollowup(o,S.today))
    .sort(
      (a, b) =>
        (b.risk.level === "critical") - (a.risk.level === "critical") ||
        (a.follow_date || "").localeCompare(b.follow_date || ""),
    );
  const signed = S.contracts.filter((c) => c.lifecycle!=='草稿'&&inRange(c.sign_date));
  const payments = (S.paymentContracts||S.contracts)
    .flatMap((c) => c.payments)
    .filter((p) => p.status === "已到账" && inRange(p.pay_date));
  const recent = S.activities
    .filter((a) => a.activity_type !== "系统")
    .slice(0, 4);
  return `${customRange?`<p class="form-context">统计区间：${esc(range.from||'最早记录')} 至 ${esc(range.to||'最新记录')}。合同按签约日期，到账按实际到账日期。</p>`:''}${metrics([
    [
      "在跟进商机",
      money(
        sum(active, (o) => o.amount),
        true,
      ),
      `${active.length} 个商机正在推进`,
      "opportunities",
    ],
    [
      customRange?"区间新签合同":"本月新签合同",
      money(
        sum(signed, (c) => c.amount),
        true,
      ),
      `${signed.length} 份合同已签约`,
      "contracts",
    ],
    [
      customRange?"区间实际到账":"本月实际到账",
      money(
        sum(payments, (p) => p.amount),
        true,
      ),
      "仅统计已确认到账记录",
      "wallet",
    ],
    [
      "今天需要关注",
      `${due.length}<small>项</small>`,
      `${active.filter((o) => o.risk.level !== "normal").length} 个风险商机需要跟进`,
      "clock",
    ],
  ])}<div class="dashboard-grid"><section class="panel pipeline-panel">${sectionHead("商机金额漏斗", "按合同总额")}${pipeline(S)}<div class="panel-foot"><span class="push-right">单位：人民币</span></div></section><section class="panel action-panel">${sectionHead("今日行动", "", badge(`${due.length} 项待关注`, "warning"))}<div class="action-list">${
    due
      .slice(0, 4)
      .map(
        (o, i) =>
          `<button class="action-item" data-action="opportunity" data-id="${o.id}"><span class="action-check ${i === 0 ? "urgent" : ""}">${icon(i === 0 ? "alert" : "clock")}</span><span class="action-copy"><b>${esc(customerName(S, o.customer_id))}<span>${esc(o.stage)}</span></b><span>${esc(o.next_action)}</span><small>${esc(salesName(S,o))} <i>·</i> ${o.risk.overdue ? `逾期 ${o.risk.overdue} 天` : o.follow_date === S.today ? "今天" : shortDate(o.follow_date)}</small></span>${icon("chevron")}</button>`,
      )
      .join("") || empty("今天的行动已安排妥当", "可以继续推进其他商机。")
  }</div><button class="panel-link" data-action="due-filter">查看全部待跟进 ${icon("arrow")}</button></section></div><section class="panel focus-panel">${sectionHead("重点推进商机", "", `<a class="text-link" href="#opportunities">全部商机 ${icon("arrow")}</a>`)}${oppTable(S, [...due, ...active.filter((o) => !due.includes(o))].slice(0, 4), true)}</section><section class="panel recent-panel">${sectionHead("最近跟进", "", `<a class="text-link" href="#activities">查看时间线 ${icon("arrow")}</a>`)}<div class="recent-grid">${recent
    .map((a) => {
      const o = S.opportunities.find((o) => o.id === a.opportunity_id);
      return `<button class="recent-item" data-action="opportunity" data-id="${a.opportunity_id}">${avatar(userName(S, a.user_id), true)}<span><b>${esc(customerName(S, o?.customer_id))}</b><span>${esc(a.summary)}</span><small>${esc(userName(S, a.user_id))} · ${esc(a.source)} · ${shortDate(a.activity_date)}</small></span></button>`;
    })
    .join("")}</div></section>`;
}
