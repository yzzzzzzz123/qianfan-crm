import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
const source = path.resolve(process.env.DB_PATH || "data/crm.sqlite");
if (!existsSync(source)) throw new Error("数据库不存在，请设置 DB_PATH");
mkdirSync("backups", { recursive: true });
const target = path.resolve(
  "backups",
  `crm-${new Date().toISOString().replaceAll(":", "-")}.sqlite`,
);
const db = new DatabaseSync(source);
db.prepare("VACUUM INTO ?").run(target);
const check = new DatabaseSync(target, { readOnly: true });
const result = check.prepare("PRAGMA integrity_check").get();
if (result.integrity_check !== "ok") throw new Error("备份完整性校验失败");
check.close();
db.close();
console.log("备份成功并通过完整性检查：" + target);
