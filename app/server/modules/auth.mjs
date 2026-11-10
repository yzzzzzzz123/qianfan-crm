import { randomBytes, createHash } from "node:crypto";
import { all, one, run } from "../database.mjs";
import { assert } from "../domain.mjs";

export const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  role: u.role,
  username: u.username,
  active: !!u.active,
  ding_user_id:u.ding_user_id||null,
  developer_admin:u.developer_admin===1,
  business_member:u.business_member!==0,
});
const sha = (s) => createHash("sha256").update(s).digest("hex");
export function createAuth(db, { demo = false, secure = false, basePath = '/' } = {}) {
  const attempts = new Map();
  function session(req) {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("qf_session="))
      ?.slice(11);
    if (!token) return null;
    const s = one(
      db,
      "SELECT * FROM sessions WHERE token=? AND expires>?",
      sha(token),
      Date.now(),
    );
    if (!s) return null;
    const actor = one(
      db,
      "SELECT * FROM users WHERE id=? AND active=1",
      s.user_id,
    );
    return actor ? { actor, csrf: s.csrf, auth_method:s.auth_method, sessionId:s.token, expires:s.expires } : null;
  }
  function createSession(user, {method=demo?'demo':'dingtalk',seconds=43200}={}) {
    const token = randomBytes(32).toString("hex");
    const csrf = randomBytes(24).toString("hex");
    run(db, "DELETE FROM sessions WHERE expires<?", Date.now());
    run(
      db,
      "INSERT INTO sessions(token,user_id,csrf,expires,auth_method) VALUES(?,?,?,?,?)",
      sha(token),
      user.id,
      csrf,
      Date.now() + seconds * 1000,
      method,
    );
    return {
      body: { actor: publicUser(user), csrf, demo },
      cookie: `qf_session=${token}; Path=${basePath}; HttpOnly; SameSite=${method==='dingtalk'?'Lax':'Strict'}; Max-Age=${seconds}${secure ? "; Secure" : ""}`,
    };
  }

  function login(req, b) {
    assert(demo,'请使用钉钉登录团队工作区',403);
    assert(b.username===undefined&&b.password===undefined,'密码登录已停用，请使用钉钉登录',403);
    const key = req.socket?.remoteAddress || "local";
    const at = attempts.get(key) || [];
    const recent = at.filter((t) => t > Date.now() - 15 * 60000);
    assert(recent.length < 10, "登录尝试过多，请15分钟后再试", 429);
    recent.push(Date.now());
    attempts.set(key, recent);
    const user = one(
        db,
        "SELECT * FROM users WHERE id=? AND active=1",
        Number(b.demo_user_id),
      );
    assert(user, "账号不可用", 401);
    attempts.delete(key);
    return createSession(user);
  }
  function logout(req) {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("qf_session="))
      ?.slice(11);
    if (token) run(db, "DELETE FROM sessions WHERE token=?", sha(token));
    return {
      body: { ok: true },
      cookie: `qf_session=; Path=${basePath}; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
    };
  }
  const options = () => ({
    body: {
      demo,
      users: demo
        ? all(db, "SELECT * FROM users WHERE active=1 AND business_member=1 AND developer_admin=0").map(publicUser)
        : [],
    },
  });
  return { session, login, logout, options, createSession };
}
