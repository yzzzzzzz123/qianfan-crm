import { randomBytes, createHash } from "node:crypto";
import { all, one, run } from "../database.mjs";
import { assert, verifyPassword } from "../domain.mjs";

export const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  role: u.role,
  username: u.username,
  active: !!u.active,
});
const sha = (s) => createHash("sha256").update(s).digest("hex");
export function createAuth(db, { demo = false, secure = false } = {}) {
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
    return actor ? { actor, csrf: s.csrf } : null;
  }
  function createSession(user) {
    const token = randomBytes(32).toString("hex");
    const csrf = randomBytes(24).toString("hex");
    run(db, "DELETE FROM sessions WHERE expires<?", Date.now());
    run(
      db,
      "INSERT INTO sessions VALUES(?,?,?,?)",
      sha(token),
      user.id,
      csrf,
      Date.now() + 12 * 3600000,
    );
    return {
      body: { actor: publicUser(user), csrf, demo },
      cookie: `qf_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? "; Secure" : ""}`,
    };
  }

  function login(req, b) {
    const key = req.socket?.remoteAddress || "local";
    const at = attempts.get(key) || [];
    const recent = at.filter((t) => t > Date.now() - 15 * 60000);
    assert(recent.length < 10, "登录尝试过多，请15分钟后再试", 429);
    recent.push(Date.now());
    attempts.set(key, recent);
    let user;
    if (demo && b.demo_user_id) {
      user = one(
        db,
        "SELECT * FROM users WHERE id=? AND active=1",
        Number(b.demo_user_id),
      );
    } else {
      user = one(
        db,
        "SELECT * FROM users WHERE username=? AND active=1",
        String(b.username || ""),
      );
      const ok = verifyPassword(String(b.password || ""), user?.password || "");
      assert(ok, "账号或密码不正确", 401);
    }
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
      cookie: `qf_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
    };
  }
  const options = () => ({
    body: {
      demo,
      users: demo
        ? all(db, "SELECT * FROM users WHERE active=1").map(publicUser)
        : [],
    },
  });
  return { session, login, logout, options };
}
