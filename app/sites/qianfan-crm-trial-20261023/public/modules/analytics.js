import { esc, money, plainMoney, avatar, sectionHead } from "../ui.js";
import { sum, metrics, pipeline } from "./shared.js";

export function analytics(S) {
  const closed = S.opportunities.filter((o) =>
    ["成交", "流失"].includes(o.stage),
  );
  const wins = closed.filter((o) => o.stage === "成交");
  const industry = [...new Set(S.customers.map((c) => c.industry))].map(
    (name) => ({
      name,
      count: S.customers.filter((c) => c.industry === name).length,
    }),
  );
  return `${metrics([
    [
      "进行中商机",
      money(
        sum(
          S.opportunities.filter((o) => !["成交", "流失"].includes(o.stage)),
          (o) => o.amount,
        ),
        true,
      ),
      "按当前未结束商机统计",
      "opportunities",
    ],
    [
      "已结束商机赢单率",
      `${closed.length ? Math.round((wins.length / closed.length) * 100) : 0}<small>%</small>`,
      `${wins.length} 个成交 / ${closed.length} 个已结束商机`,
      "chart",
    ],
    [
      "合同累计到账率",
      `${sum(S.contracts, (c) => c.amount) ? Math.round((sum(S.contracts, (c) => c.collected) / sum(S.contracts, (c) => c.amount)) * 100) : 0}<small>%</small>`,
      "累计实际到账 ÷ 合同总额",
      "wallet",
    ],
    [
      "客户资产",
      `${S.customers.length}<small>家</small>`,
      `${S.customers.filter((c) => c.level === "A").length} 家 A 级客户`,
      "customers",
    ],
  ])}<div class="dashboard-grid"><section class="panel">${sectionHead("商机阶段分布", "当前阶段快照，不代表历史转化率")}${pipeline(S)}</section><section class="panel">${sectionHead("客户行业分布", "按客户主档数量统计")}<div class="industry-list">${industry.map((i) => `<div><span>${esc(i.name || "未分类")}</span><b>${i.count}<small> 家</small></b></div>`).join("")}</div></section></div><section class="panel">${sectionHead("销售业务进展", `当前季度 ${S.quarter} · 合同目标与过程绩效分开统计`)}<div class="table-scroll"><table class="data-table"><thead><tr><th>销售</th><th>在跟进商机</th><th>预计金额</th><th>本月签约</th><th>本月合同目标</th><th>风险商机</th><th>过程原始分</th></tr></thead><tbody>${S.team.map((u) => `<tr><td><span class="owner-cell">${avatar(u.name, true)}${esc(u.name)}</span></td><td>${u.activeCount} 个</td><td>${plainMoney(u.pipeline)}</td><td>${plainMoney(u.signed)}</td><td>${plainMoney(Math.round(u.target / 3))}</td><td>${u.riskCount} 个</td><td>${u.process.raw} / 50</td></tr>`).join("")}</tbody></table></div></section>`;
}
