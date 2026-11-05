import { esc, plainMoney, select, input, textarea, formShell } from "../ui.js";

export function formPayments(S, type, id, options) {
  if (type === "payment") {
    const c = S.contracts.find((c) => c.id === Number(id));
    return formShell(
      "登记回款",
      "已有计划请在合同详情中“确认到账”，避免重复登记。",
      `<div class="wide form-context">${esc(c.name)} · 待回款 ${plainMoney(c.outstanding)}</div>` +
        input(
          "amount",
          "金额（元）",
          "",
          "number",
          true,
          'min="0.01" step="0.01"',
        ) +
        select("status", "回款状态", ["已到账", "待到账", "逾期"]) +
        input("pay_date", "到账日期", S.today, "date", false) +
        input("promise_date", "承诺付款日", "", "date", false) +
        textarea("note", "回款说明"),
      type,
      id,
      "保存回款",
    );
  }
  if (type === "receive-payment")
    return formShell(
      "确认回款到账",
      "确认已收到该笔款项后，系统将更新合同余额。",
      input("pay_date", "实际到账日期", S.today, "date"),
      type,
      id,
      "确认到账",
    );
}
