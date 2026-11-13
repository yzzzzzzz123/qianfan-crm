import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openDatabase, one } from "./database.mjs";
import { createService } from "./service.mjs";
import { seedDemo } from "./seed.mjs";
import { AppError } from "./domain.mjs";
import { startDailyRefresh } from './scheduler.mjs';
import {validateLocalCompanyProfileAutomation} from '../../local/company-profile-automation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createApp({
  filename = ":memory:",
  demo = false,
  secure = false,
  publicOrigin = "",
  logger = console,
  scheduled = false,
  identityProvider,
  aiProvider,
  salesAdviceProvider,
  companyProfileProvider,
  companyProfileLocalAutomation,
  minutesOptions,
  winReportOptions,
  deployment='local',
  localIdentitySwitch = false,
  developerIdentitySwitch = localIdentitySwitch,
  basePath = '/',
  production = secure,
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
  if ((secure||production) && workspaceMode === "demo") {
    db.close();
    throw new Error("演示数据库不能作为生产数据库启动");
  }
  if (demo) seedDemo(db);
  if(!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(basePath)){db.close();throw new Error('访问路径须为以斜线开头和结尾的固定路径');}
  const service = createService(db, { demo, secure, publicOrigin, identityProvider, aiProvider, salesAdviceProvider, companyProfileProvider, companyProfileLocalAutomation, minutesOptions, winReportOptions, deployment, developerIdentitySwitch, basePath });
  const server = http.createServer(async (req, res) => {
    const headers = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "Cache-Control": "no-store",
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        req.requestId = randomUUID();
        headers['X-Request-Id'] = req.requestId;
        let body = {};
        if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
          let chunks = [];
          let length = 0;
          const upload = url.pathname === '/api/quotes' || /^\/api\/contracts\/\d+\/(attachments|archive)$/.test(url.pathname);
          const maxLength = url.pathname === '/api/ai/intake' ? 30*1024*1024 : upload ? 16*1024*1024 : 1000000;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > maxLength) throw new AppError("提交内容过大", 413);
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
        if(r.redirect) {res.writeHead(303,{...headers,Location:r.redirect});res.end();return;}
        if(r.audio){
          const mediaHeaders={'Content-Type':r.audio.headers.get('content-type')||'application/octet-stream'};
          for(const name of ['content-length','content-range','accept-ranges']){const value=r.audio.headers.get(name);if(value)mediaHeaders[name]=value;}
          res.writeHead(r.audio.status,{...headers,...mediaHeaders});
          let size=0;for await(const chunk of r.audio.body){size+=chunk.length;if(size>128*1024*1024){res.destroy();break;}if(res.destroyed)break;res.write(chunk);}res.end();return;
        }
        res.writeHead(200, {
          ...headers,
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(r.body));
        return;
      }
      if (!["GET", "HEAD"].includes(req.method))
        throw new AppError("请求方法不支持", 405);
      let relative;
      try {relative=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);}catch{throw new AppError('网址编码无效',400);}
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
      if(res.headersSent){res.destroy();return;}
      const status = e.status || 500;
      if (status === 500) logger.error("[request]", e);
      res.writeHead(status, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(
        JSON.stringify({
          error: status === 500 ? "服务暂时无法完成操作，请重试" : e.message,
          ...(e.code ? { code: e.code } : {}),
          ...(req.requestId ? { requestId: req.requestId } : {}),
        }),
      );
    }
  });
  if(scheduled) {const stop=startDailyRefresh(db,logger,{deployment:production&&secure?'production':'local'});server.once('close',stop);}
  const stopMinutes=service.minutes.startScheduler();server.once('close',()=>{stopMinutes();void service.minutes.shutdown();});
  const stopCompanyProfiles=service.companyProfileQueue.startScheduler();
  server.once('close',()=>{stopCompanyProfiles();});
  const stopWinReports=service.winReports.startScheduler();
  server.once('close',()=>{stopWinReports();});
  return { server, db, service };
}
if (
  (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ||
  process.env.QF_START === "true"
)
  start();
export function start({companyProfileLocalAutomation}={}) {
  const demo = process.env.DEMO_MODE === "true";
  const production = process.env.NODE_ENV === "production";
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3100);
  const localHttp=process.env.CRM_LOCAL_PRODUCTION==='true'&&host==='127.0.0.1'&&process.env.PUBLIC_ORIGIN===`http://127.0.0.1:${port}`;
  const secure=production&&!localHttp;
  if (production && demo) throw new Error("生产环境禁止开启演示身份入口");
  if(production&&(!process.env.DINGTALK_CLIENT_ID||!process.env.DINGTALK_CLIENT_SECRET||!process.env.DINGTALK_CORP_ID))throw new Error('生产运行须配置完整钉钉企业身份');
  const filename = path.resolve(
    root,
    process.env.DB_PATH || (demo ? "data/demo.sqlite" : "data/crm.sqlite"),
  );
  const app = createApp({
    filename,
    companyProfileLocalAutomation:validateLocalCompanyProfileAutomation(companyProfileLocalAutomation,{localHttp,projectRoot:path.resolve(root,'..'),filename,origin:process.env.PUBLIC_ORIGIN||''}),
    demo,
    secure,
    production,
    publicOrigin: process.env.PUBLIC_ORIGIN || "",
    scheduled:false,
    deployment:production&&secure&&process.platform!=='win32'&&process.env.CRM_RUNTIME_ENVIRONMENT==='server'?'production':'local',
    localIdentitySwitch:localHttp,
    developerIdentitySwitch:localHttp||(secure&&process.env.CRM_DEVELOPER_SWITCH==='true'),
    basePath:process.env.PUBLIC_BASE_PATH||'/',
  });
  app.server.listen(port, host, () =>
    console.log(
      `千帆 CRM v2 · ${demo ? "本地演示" : "独立运行"} · http://${host}:${port}`,
    ),
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () =>
      app.server.close(async () => {
        await app.service.minutes.shutdown();
        await app.service.companyProfileQueue.shutdown();
        await app.service.winReports.shutdown();
        app.db.close();
        process.exit(0);
      }),
    );
  return app;
}
