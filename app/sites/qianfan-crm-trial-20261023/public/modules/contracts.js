import {
  esc,
  icon,
  money,
  plainMoney,
  dateLabel,
  userName,
  customerName,
  badge,
  actionButton as button,
  sectionHead,
  empty,
  select,
  input,
  textarea,
  formShell,
} from "../ui.js";
import { sum, filtered, metrics, filters } from "./shared.js";

export function contracts(S, P) {
  const list = filtered(S, P, S.contracts);
  const overdue = S.contracts.flatMap((c) =>
    c.payments.filter((p) => p.status === "逾期"),
  );
  return `${metrics([
    [
      "合同总额",
      money(
        sum(S.contracts, (c) => c.amount),
        true,
      ),
      `${S.contracts.length} 份有效合同`,
      "contracts",
    ],
    [
      "累计到账",
      money(
        sum(S.contracts, (c) => c.collected),
        true,
      ),
      "按实际到账记录累计",
      "wallet",
    ],
    [
      "待回款金额",
      money(
        sum(S.contracts, (c) => c.outstanding),
        true,
      ),
      "合同额减去实际到账",
      "clock",
    ],
    [
      "逾期回款计划",
      money(
        sum(overdue, (p) => p.amount),
        true,
      ),
      `${overdue.length} 笔计划需要确认`,
      "alert",
    ],
  ])}<section class="panel">${filters(S, P, "contracts")}${list.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>合同 / 客户</th><th>合同金额</th><th>已到账 / 待回款</th><th>签约 / 到期日</th><th>履约状态</th><th>负责人</th><th></th></tr></thead><tbody>${list.map((c) => `<tr><td><button class="record-title" data-action="contract" data-id="${c.id}">${esc(c.name)}</button><span class="record-meta">${esc(c.code)} · ${esc(customerName(S, c.customer_id))}</span></td><td class="number strong">${plainMoney(c.amount)}</td><td><span class="text-success number">${plainMoney(c.collected)}</span><span class="record-meta number">待回款 ${plainMoney(c.outstanding)}</span></td><td>${dateLabel(c.sign_date)}<span class="record-meta">${dateLabel(c.valid_until)} 到期</span></td><td>${badge(c.accept_status, c.accept_status === "已验收" ? "success" : "blue")}${c.payments.some((p) => p.status === "逾期") ? '<span class="record-meta text-warning">有逾期回款</span>' : ""}</td><td>${esc(userName(S, c.owner_id))}</td><td><button class="icon-btn" data-action="contract" data-id="${c.id}" aria-label="查看合同">${icon("chevron")}</button></td></tr>`).join("")}</tbody></table></div>` : empty("还没有合同", "管理员可以从商机成交转合同，或手工建立台账。")}<div class="table-footer">共 ${list.length} 份合同<span>正式文件生成待统一模板</span></div></section>`;
}

export function contractDetail(S, id) {
  const c = S.contracts.find((c) => c.id === Number(id));
  if (!c) return empty("合同不存在");
  const admin = S.actor.role === "admin";
  return `<header class="dialog-head"><div><span class="detail-type">${esc(c.code)} ${badge(c.accept_status, "blue")}</span><h2>${esc(c.name)}</h2><p>${esc(customerName(S, c.customer_id))} · ${esc(userName(S, c.owner_id))}负责</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon("close")}</button></header><div class="drawer-body"><div class="detail-metrics"><div><span>合同金额</span><b>${plainMoney(c.amount)}</b></div><div><span>实际到账</span><b class="text-success">${plainMoney(c.collected)}</b></div><div><span>待回款</span><b>${plainMoney(c.outstanding)}</b></div></div><div class="detail-actionbar">${admin ? button("登记回款", "new-payment", c.id, "primary", "wallet") + button("更新履约", "edit-contract", c.id, "secondary", "edit") : badge("合同与回款只读")}${c.opportunity_id ? button("查看商机", "opportunity", c.opportunity_id, "ghost", "link") : ""}</div><dl class="detail-facts"><div><dt>签约日期</dt><dd>${dateLabel(c.sign_date)}</dd></div><div><dt>合同到期</dt><dd>${dateLabel(c.valid_until)}</dd></div></dl><section class="detail-section">${sectionHead("合同行项", "标品、实施分别核算，付款日与到期日分开记录")}<div class="table-scroll"><table class="data-table detail-table"><thead><tr><th>内容 / 类型</th><th>金额 / 毛利</th><th>付款日 / 到期日</th>${admin ? "<th></th>" : ""}</tr></thead><tbody>${c.items.map((i) => `<tr><td><b>${esc(i.name)}</b><span class="record-meta">${esc(i.kind)}</span></td><td>${plainMoney(i.amount)}<span class="record-meta">毛利 ${plainMoney(i.margin)}</span></td><td>${dateLabel(i.payment_date)}<span class="record-meta">${dateLabel(i.valid_until)}</span></td>${admin ? `<td><button class="icon-btn" data-action="edit-item" data-id="${i.id}" aria-label="编辑合同行项">${icon("edit")}</button></td>` : ""}</tr>`).join("")}</tbody></table></div></section><section class="detail-section">${sectionHead("回款记录与计划", "确认到账后才计入合同已回款")}<div class="payment-list">${c.payments.map((p) => `<div class="payment-line"><span class="payment-icon ${p.status === "已到账" ? "received" : ""}">${icon(p.status === "已到账" ? "check" : "clock")}</span><div><b>${plainMoney(p.amount)}</b><p>${esc(p.note || "无备注")}</p><small>${p.status === "已到账" ? "到账日期 " + dateLabel(p.pay_date) : "承诺付款 " + dateLabel(p.promise_date)}</small></div><div class="payment-state">${badge(p.status, p.status === "已到账" ? "success" : p.status === "逾期" ? "danger" : "warning")}${admin && p.status !== "已到账" ? `<button class="text-link" data-action="receive-payment" data-id="${p.id}">确认到账</button>` : ""}</div></div>`).join("") || '<p class="muted">暂无回款记录。</p>'}</div></section><section class="detail-section"><h3>交付范围</h3><p class="prose">${esc(c.scope || "待补充")}</p></section></div>`;
}

export function contractItemRow(S, index, initial = {}) {
  return `<div class="item-row" data-item="${index}"><label class="field">行项名称<input data-field="name" required value="${esc(initial.name || "")}" placeholder="如：企业版授权 / 实施服务"></label><label class="field">类型<select data-field="kind"><option ${initial.kind === "标品" ? "selected" : ""}>标品</option><option ${initial.kind === "实施" ? "selected" : ""}>实施</option></select></label><label class="field">金额（元）<input type="number" data-field="amount" required min="0.01" step="0.01" value="${esc(initial.amount ?? "")}"></label><button type="button" class="icon-btn" data-action="remove-item" aria-label="移除此行项">${icon("close")}</button></div>`;
}

export function formContracts(S, type, id, options) {
  const { customerOptions } = options;
  if (type === "contract" || type === "convert") {
    const o = S.opportunities.find((o) => o.id === Number(id));
    const rows = contractItemRow(S, 0, {
      name: o?.name || "",
      kind: o?.product_type === "实施" ? "实施" : "标品",
      amount: o ? o.amount / 100 : "",
    });
    return formShell(
      type === "convert" ? "成交并生成合同" : "新建合同台账",
      "保存成功后关联商机变为成交，合同金额按行项合计。",
      `${type === "contract" ? select("customer_id", "关联客户", customerOptions) : `<div class="wide form-context">${esc(customerName(S, o.customer_id))} · ${esc(o.code)}</div>`}` +
        input("name", "合同名称", o?.name || "") +
        input("sign_date", "签约日期", S.today, "date") +
        input("valid_until", "合同到期日", "", "date", false) +
        textarea("scope", "交付范围") +
        `<div class="wide items-editor"><div class="section-head"><h3>合同行项</h3><button type="button" class="btn ghost" data-action="add-item">${icon("plus")}添加行项</button></div><div id="contract-items">${rows}</div><p class="field-help">标品按来源与订单性质核算毛利；实施按 50% 核算。毛利可在合同中由管理员改判并留痕。</p></div>`,
      type,
      id,
      "保存合同",
    );
  }
  if (type === "edit-contract") {
    const c = S.contracts.find((c) => c.id === Number(id));
    return formShell(
      "更新合同履约",
      "金额由合同行项确定，本面板维护交付与验收。",
      select(
        "accept_status",
        "履约状态",
        ["待交付", "交付中", "待验收", "已验收"],
        c.accept_status,
      ) +
        input("valid_until", "合同到期日", c.valid_until || "", "date", false) +
        textarea("scope", "交付范围", c.scope),
      type,
      id,
    );
  }
  if (type === "edit-item") {
    const i = S.contracts
      .flatMap((c) => c.items)
      .find((i) => i.id === Number(id));
    return formShell(
      "维护合同行项",
      i.name,
      input("payment_date", "付款日", i.payment_date || "", "date", false) +
        input("valid_until", "到期日", i.valid_until || "", "date", false) +
        input(
          "margin",
          "毛利基数（元）",
          i.margin / 100,
          "number",
          true,
          'min="0" step="0.01"',
        ) +
        textarea("reason", "改判原因（毛利变更时必填）"),
      type,
      id,
    );
  }
}
