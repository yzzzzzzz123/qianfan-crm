import { createHash } from "node:crypto";
import { one, run, transaction } from "./database.mjs";
import { AppError, assert, now } from "./domain.mjs";
import { createAuth, publicUser } from "./modules/auth.mjs";
import { buildState } from "./modules/reporting.mjs";
import { handleCustomers } from "./modules/customers.mjs";
import { handleOpportunities } from "./modules/opportunities.mjs";
import { handleActivities } from "./modules/activities.mjs";
import { handleQuotes } from "./modules/quotes.mjs";
import { handleContracts } from "./modules/contracts.mjs";
import { handlePayments } from "./modules/payments.mjs";
import { handleTeam } from "./modules/team.mjs";
import { handleSettings } from "./modules/settings.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
export function createService(
  db,
  { demo = false, secure = false, publicOrigin = "" } = {},
) {
  const auth = createAuth(db, { demo, secure });
  const getRules = () =>
    JSON.parse(
      one(db, "SELECT value FROM settings WHERE key=?", "rules").value,
    );
  const audit = (actor, action, entity, id, detail = {}) =>
    run(
      db,
      "INSERT INTO audit(user_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)",
      actor.id,
      action,
      entity,
      id,
      JSON.stringify(detail),
      now(),
    );
  const insert = (table, row) => {
    const k = Object.keys(row);
    return Number(
      run(
        db,
        `INSERT INTO ${table}(${k.join(",")}) VALUES(${k.map(() => "?").join(",")})`,
        ...Object.values(row),
      ).lastInsertRowid,
    );
  };
  const update = (table, id, row) => {
    const k = Object.keys(row);
    run(
      db,
      `UPDATE ${table} SET ${k.map((x) => x + "=?").join(",")} WHERE id=?`,
      ...Object.values(row),
      id,
    );
  };
  function scoped(table, id, actor) {
    const r = one(db, `SELECT * FROM ${table} WHERE id=?`, Number(id));
    assert(r, "记录不存在", 404);
    assert(
      actor.role === "admin" || r.owner_id === actor.id,
      "无权操作此记录",
      403,
    );
    return r;
  }
  const admin = (actor) =>
    assert(actor.role === "admin", "此操作仅管理员可执行", 403);
  function owner(value, actor) {
    const id = actor.role === "admin" ? Number(value || actor.id) : actor.id;
    assert(
      one(db, "SELECT id FROM users WHERE id=? AND active=1", id),
      "请选择有效负责人",
    );
    return id;
  }
  const state = (actor) => buildState({ db, getRules, demo }, actor);
  const handlers = [
    handleCustomers,
    handleOpportunities,
    handleActivities,
    handleQuotes,
    handleContracts,
    handlePayments,
    handleTeam,
    handleSettings,
  ];
  function mutate(path, method, b, actor) {
    const context = {
      path,
      method,
      b,
      actor,
      db,
      insert,
      update,
      scoped,
      admin,
      owner,
      audit,
      getRules,
    };
    for (const handleModule of handlers) {
      const result = handleModule(context);
      if (result !== undefined) return result;
    }
    throw new AppError("接口不存在", 404);
  }
  async function handle(req, path, method, b = {}) {
    if (path === "/api/health")
      return { body: { ok: true, version: "2.0.0", demo } };
    if (path === "/api/auth/options" && method === "GET") return auth.options();
    if (method !== "GET") {
      const origin = req.headers.origin;
      if (origin) {
        const expected =
          publicOrigin || `${secure ? "https" : "http"}://${req.headers.host}`;
        assert(origin === expected, "请求来源不匹配", 403);
      }
      assert(
        (req.headers["content-type"] || "").startsWith("application/json"),
        "请使用 JSON 请求",
        415,
      );
    }
    if (path === "/api/auth/login" && method === "POST")
      return auth.login(req, b);
    const s = auth.session(req);
    assert(s, "请先登录", 401);
    const { actor } = s;
    if (method === "GET") {
      if (path === "/api/auth/me")
        return { body: { actor: publicUser(actor), csrf: s.csrf, demo } };
      if (path === "/api/state") return { body: state(actor) };
      throw new AppError("接口不存在", 404);
    }
    assert(
      req.headers["x-csrf-token"] === s.csrf,
      "会话校验失败，请刷新页面后重试",
      403,
    );
    if (path === "/api/auth/logout") return auth.logout(req);
    assert(["POST", "PATCH"].includes(method), "请求方法不支持", 405);
    const key = req.headers["idempotency-key"];
    assert(
      typeof key === "string" && /^[a-zA-Z0-9-]{16,100}$/.test(key),
      "缺少有效操作编号，请刷新后重试",
    );
    const unique = `${actor.id}:${method}:${path}:${key}`;
    const hash = sha(JSON.stringify(b));
    const body = transaction(db, () => {
      const existing = one(db, "SELECT * FROM mutations WHERE key=?", unique);
      if (existing) {
        assert(existing.hash === hash, "重复操作编号对应不同内容", 409);
        return JSON.parse(existing.response);
      }
      const result = mutate(path, method, b, actor);
      run(
        db,
        "INSERT INTO mutations VALUES(?,?,?,?)",
        unique,
        hash,
        JSON.stringify(result),
        now(),
      );
      return result;
    });
    return { body };
  }
  return { handle, state };
}
