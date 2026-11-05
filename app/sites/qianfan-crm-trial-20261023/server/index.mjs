import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, one } from "./database.mjs";
import { createService } from "./service.mjs";
import { seedDemo } from "./seed.mjs";
import { AppError } from "./domain.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createApp({
  filename = ":memory:",
  demo = false,
  secure = false,
  publicOrigin = "",
  logger = console,
} = {}) {
  const db = openDatabase(filename);
  const workspaceMode = one(
    db,
    "SELECT value FROM settings WHERE key=?",
    "workspace_mode",
  )?.value;
  if (
    demo &&
    one(db, "SELECT id FROM users LIMIT 1") &&
    workspaceMode !== "demo"
  ) {
    db.close();
    throw new Error("该数据库不是演示工作区，禁止开启演示身份入口");
  }
  if (secure && workspaceMode === "demo") {
    db.close();
    throw new Error("演示数据库不能作为生产数据库启动");
  }
  if (demo) seedDemo(db);
  const service = createService(db, { demo, secure, publicOrigin });
  const server = http.createServer(async (req, res) => {
    const headers = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "Cache-Control": "no-store",
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        let body = {};
        if (["POST", "PATCH", "PUT"].includes(req.method)) {
          let chunks = [];
          let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > 1000000) throw new AppError("提交内容过大", 413);
            chunks.push(chunk);
          }
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            throw new AppError("提交内容不是有效 JSON");
          }
          if (!body || Array.isArray(body) || typeof body !== "object")
            throw new AppError("请求内容应为对象");
        }
        const r = await service.handle(req, url.pathname, req.method, body);
        if (r.cookie) headers["Set-Cookie"] = r.cookie;
        res.writeHead(200, {
          ...headers,
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(r.body));
        return;
      }
      if (!["GET", "HEAD"].includes(req.method))
        throw new AppError("请求方法不支持", 405);
      const relative = decodeURIComponent(
        url.pathname === "/" ? "/index.html" : url.pathname,
      );
      const full = path.resolve(root, "public", "." + relative);
      if (!full.startsWith(path.join(root, "public") + path.sep))
        throw new AppError("无权访问", 403);
      const content = await fs.promises.readFile(full).catch(() => {
        throw new AppError("页面不存在", 404);
      });
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        ...headers,
        "Content-Type": mime[path.extname(full)] || "application/octet-stream",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) logger.error("[request]", e);
      res.writeHead(status, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(
        JSON.stringify({
          error: status === 500 ? "服务暂时无法完成操作，请重试" : e.message,
        }),
      );
    }
  });
  return { server, db, service };
}
if (
  (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ||
  process.env.QF_START === "true"
)
  start();
export function start() {
  const demo = process.env.DEMO_MODE === "true";
  const secure = process.env.NODE_ENV === "production";
  if (secure && demo) throw new Error("生产环境禁止开启演示身份入口");
  const filename = path.resolve(
    root,
    process.env.DB_PATH || (demo ? "data/demo.sqlite" : "data/crm.sqlite"),
  );
  const app = createApp({
    filename,
    demo,
    secure,
    publicOrigin: process.env.PUBLIC_ORIGIN || "",
  });
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3100);
  app.server.listen(port, host, () =>
    console.log(
      `千帆 CRM v2 · ${demo ? "本地演示" : "独立运行"} · http://${host}:${port}`,
    ),
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () =>
      app.server.close(() => {
        app.db.close();
        process.exit(0);
      }),
    );
  return app;
}
