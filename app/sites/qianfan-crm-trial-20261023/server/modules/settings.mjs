import { assert, text, choice, STAGES, now, hashPassword } from "../domain.mjs";
import { one, run } from "../database.mjs";

/** settings: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleSettings(context) {
  const { path, method, b, actor, db, insert, update, admin, audit, getRules } =
    context;
  let m;
  if (path === "/api/rules" && method === "PATCH") {
    admin(actor);
    const rules = getRules();
    if (b.thresholds) {
      for (const [s, v] of Object.entries(b.thresholds)) {
        assert(Object.hasOwn(rules.thresholds, s), "阶段无效");
        assert(
          Number.isInteger(Number(v)) && v >= 1 && v <= 90,
          "停滞阈值应为1至90天",
        );
        rules.thresholds[s] = Number(v);
      }
    }
    if (b.sop) {
      for (const [s, v] of Object.entries(b.sop)) {
        choice(s, STAGES, "阶段");
        rules.sop[s] = text(v, "阶段动作", 1500);
      }
    }
    run(
      db,
      "UPDATE settings SET value=? WHERE key=?",
      JSON.stringify(rules),
      "rules",
    );
    audit(actor, "更新业务规则", "settings", null, {
      fields: Object.keys(b),
    });
    return { message: "阶段规则已保存" };
  }
  if (path === "/api/users" && method === "POST") {
    admin(actor);
    const name = text(b.name, "姓名", 40);
    const username = text(b.username, "账号", 60);
    assert(
      /^[a-zA-Z0-9_.-]{3,60}$/.test(username),
      "账号需为3至60位字母、数字或下划线",
    );
    assert(
      !one(db, "SELECT id FROM users WHERE username=?", username),
      "账号已存在",
      409,
    );
    assert(
      typeof b.password === "string" &&
        b.password.length >= 12 &&
        b.password.length <= 128,
      "密码需为12至128位",
    );
    const id = insert("users", {
      name,
      username,
      role: choice(b.role, ["admin", "sales"], "角色"),
      password: hashPassword(b.password),
      created_at: now(),
    });
    audit(actor, "添加成员", "user", id, { name, role: b.role });
    return { id, message: "成员已添加" };
  }
  if ((m = path.match(/^\/api\/users\/(\d+)$/)) && method === "PATCH") {
    admin(actor);
    const id = Number(m[1]);
    assert(id !== actor.id, "不能停用当前登录账号");
    const u = one(db, "SELECT * FROM users WHERE id=?", id);
    assert(u, "成员不存在", 404);
    assert(typeof b.active === "boolean", "成员状态无效");
    if (!b.active && u.role === "admin")
      assert(
        one(db, "SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1")
          .n > 1,
        "至少保留一名管理员",
      );
    update("users", id, { active: b.active ? 1 : 0 });
    if (!b.active) run(db, "DELETE FROM sessions WHERE user_id=?", id);
    audit(actor, b.active ? "启用成员" : "停用成员", "user", id);
    return { message: "成员状态已更新" };
  }
}
