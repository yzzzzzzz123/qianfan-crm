import { assert, cents, quarter } from "../domain.mjs";
import { one, run } from "../database.mjs";

/** team: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleTeam(context) {
  const { path, method, b, actor, db, admin, audit } = context;
  if (path === "/api/targets" && method === "POST") {
    admin(actor);
    const u = one(
      db,
      "SELECT id FROM users WHERE id=? AND role='sales' AND active=1",
      Number(b.user_id),
    );
    assert(u, "请选择销售");
    const q = b.quarter || quarter();
    assert(/^\d{4}Q[1-4]$/.test(q), "季度格式应为2026Q4");
    const amount = cents(b.amount, "季度目标", true);
    run(
      db,
      "INSERT INTO targets VALUES(?,?,?) ON CONFLICT(user_id,quarter) DO UPDATE SET amount=excluded.amount",
      u.id,
      q,
      amount,
    );
    audit(actor, "配置季度目标", "user", u.id, { quarter: q, amount });
    return { message: "季度目标已保存" };
  }
}
