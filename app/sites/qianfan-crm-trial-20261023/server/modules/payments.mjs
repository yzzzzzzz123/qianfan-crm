import {
  assert,
  text,
  choice,
  cents,
  validDate,
  now,
  today,
} from "../domain.mjs";
import { one } from "../database.mjs";

/** payments: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handlePayments(context) {
  const { path, method, b, actor, db, insert, update, scoped, admin, audit } =
    context;
  let m;
  if (path === "/api/payments" && method === "POST") {
    admin(actor);
    const c = scoped("contracts", b.contract_id, actor);
    const amount = cents(b.amount, "回款金额");
    const status = choice(
      b.status || "已到账",
      ["已到账", "待到账", "逾期"],
      "回款状态",
    );
    const sum = one(
      db,
      "SELECT COALESCE(SUM(amount),0) total FROM payments WHERE contract_id=? AND status='已到账'",
      c.id,
    ).total;
    assert(
      status !== "已到账" || sum + amount <= c.amount,
      "本次到账金额超过合同未回款金额",
    );
    const id = insert("payments", {
      contract_id: c.id,
      amount,
      status,
      pay_date:
        status === "已到账"
          ? validDate(b.pay_date || today(), "到账日期")
          : null,
      promise_date: validDate(b.promise_date, "承诺付款日", true),
      note: text(b.note || "", "回款说明", 1000, false),
      created_at: now(),
    });
    audit(actor, "登记回款", "contract", c.id, {
      payment_id: id,
      amount,
      status,
    });
    return {
      id,
      message:
        status === "已到账" ? "到账已登记，合同余额已更新" : "回款计划已登记",
    };
  }
  if (
    (m = path.match(/^\/api\/payments\/(\d+)\/receive$/)) &&
    method === "POST"
  ) {
    admin(actor);
    const p = one(db, "SELECT * FROM payments WHERE id=?", Number(m[1]));
    assert(p, "回款计划不存在", 404);
    assert(p.status !== "已到账", "该笔回款已到账", 409);
    const c = scoped("contracts", p.contract_id, actor);
    const sum = one(
      db,
      "SELECT COALESCE(SUM(amount),0) total FROM payments WHERE contract_id=? AND status='已到账'",
      c.id,
    ).total;
    assert(
      sum + p.amount <= c.amount,
      "该计划金额超过合同未回款金额，请核对已有到账记录",
    );
    update("payments", p.id, {
      status: "已到账",
      pay_date: validDate(b.pay_date || today(), "到账日期"),
    });
    audit(actor, "确认回款到账", "contract", c.id, {
      payment_id: p.id,
      amount: p.amount,
    });
    return { id: p.id, message: "回款已确认到账" };
  }
}
