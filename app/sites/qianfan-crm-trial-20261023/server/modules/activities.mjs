import { assert, text, choice, validDate, now, today } from "../domain.mjs";
import { one } from "../database.mjs";

/** activities: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleActivities(context) {
  const { path, method, b, actor, db, insert, update, scoped, audit } = context;
  if (path === "/api/activities" && method === "POST") {
    const o = scoped("opportunities", b.opportunity_id, actor);
    const type = choice(
      b.activity_type || "手动跟进",
      ["手动跟进", "线上会议", "现场拜访", "晚会复盘"],
      "跟进类型",
    );
    const summary = text(b.summary, "跟进内容", 5000);
    const date = validDate(b.activity_date || today(), "跟进日期");
    assert(date <= today(), "跟进日期不能晚于今天");
    const action = text(b.action || "", "下一步动作", 500, false);
    const follow = validDate(b.follow_date, "下次跟进日期", true);
    const existing = one(
      db,
      "SELECT * FROM activities WHERE opportunity_id=? AND user_id=? AND source=? AND activity_date=?",
      o.id,
      actor.id,
      type,
      date,
    );
    let id;
    if (existing) {
      assert(
        (existing.summary + "\n" + summary).length <= 20000,
        "当日跟进内容过长，请拆分记录",
      );
      id = existing.id;
      update("activities", id, {
        summary: existing.summary + "\n" + summary,
        action: action || existing.action,
      });
    } else {
      id = insert("activities", {
        opportunity_id: o.id,
        user_id: actor.id,
        source: type,
        activity_type: type,
        summary,
        action,
        activity_date: date,
        created_at: now(),
      });
    }
    const row = { updated_at: now() };
    if (action) row.next_action = action;
    if (follow) row.follow_date = follow;
    update("opportunities", o.id, row);
    audit(actor, existing ? "归并跟进" : "记录跟进", "opportunity", o.id, {
      activity_id: id,
      source: type,
    });
    return {
      id,
      message: existing ? "已归并到同日同类型跟进" : "跟进已记录",
    };
  }
}
