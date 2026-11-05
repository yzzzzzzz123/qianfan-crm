import { assert, cents, quarter } from "../domain.mjs";
import { one, run } from "../database.mjs";

/** team: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleTeam(context) {
  const { path, method, b, actor, db, admin, audit } = context;
  if (path === "/api/targets" && method === "POST") {
    admin(actor);
    const u = one(
      db,
      "SELECT id FROM users WHERE id=? AND role='sales' AND active=1 AND business_member=1 AND developer_admin=0",
      Number(b.user_id),
    );
    assert(u, "请选择销售");
    const q = b.quarter || quarter();
    assert(/^\d{4}Q[1-4]$/.test(q), "季度格式应为2026Q4");
    const amount = cents(b.amount, "季度目标");
    const startMonth=(Number(q.slice(-1))-1)*3+1;
    for(let month=startMonth;month<startMonth+3;month++) assert(!one(db,"SELECT id FROM performance_reviews WHERE user_id=? AND month=? AND status='confirmed'",u.id,`${q.slice(0,4)}-${String(month).padStart(2,'0')}`),'该季度存在已确认绩效，合同目标已锁定',409);
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
