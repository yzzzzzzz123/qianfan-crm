import { input, textarea, formShell } from "../ui.js";

export function formQuotes(S, type, id, options) {
  if (type === "quote") {
    const o = S.opportunities.find((o) => o.id === Number(id));
    const end = new Date(new Date(S.today).getTime() + 15 * 86400000)
      .toISOString()
      .slice(0, 10);
    return formShell(
      "登记报价",
      "保存报价要素后可导出文件；公司模板可在合同订单中维护。",
      input(
        "amount",
        "报价金额（元）",
        o.amount / 100,
        "number",
        true,
        'min="0.01" step="0.01"',
      ) +
        input("valid_until", "有效期至", end, "date") +
        textarea("note", "报价说明"),
      type,
      id,
      "登记报价",
    );
  }
}
