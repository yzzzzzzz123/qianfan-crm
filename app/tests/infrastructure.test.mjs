import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { one, run } from "../server/database.mjs";
import { fixture } from "./helpers/fixture.mjs";

test("M11-A01 备份命令在源库运行时生成可恢复一致性快照", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "qf-backup-"));
  const filename = path.join(folder, "live.sqlite");
  const app = createApp({ filename, demo: true });
  let restored;
  try {
    run(app.db, "UPDATE customers SET note=? WHERE id=1", "备份恢复验收");
    const script = fileURLToPath(
      new URL("../scripts/backup.mjs", import.meta.url),
    );
    const r = spawnSync(process.execPath, [script], {
      cwd: folder,
      env: { ...process.env, DB_PATH: filename },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const backup = path.join(
      folder,
      "backups",
      readdirSync(path.join(folder, "backups"))[0],
    );
    restored = new DatabaseSync(backup, { readOnly: true });
    assert.equal(
      restored.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.equal(
      restored.prepare("SELECT note FROM customers WHERE id=1").get().note,
      "备份恢复验收",
    );
    assert.equal(
      restored.prepare("SELECT COUNT(*) n FROM contracts").get().n,
      2,
    );
  } finally {
    restored?.close();
    app.db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("M11-A02 正常重启保留已改客户与规则，不重新覆盖演示数据", async (t) => {
  const folder = mkdtempSync(path.join(tmpdir(), "qf-crm-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const filename = path.join(folder, "test.sqlite");
  const a = createApp({ filename, demo: true });
  run(a.db, "UPDATE customers SET note=? WHERE id=1", "重启须保留");
  run(
    a.db,
    "UPDATE settings SET value=json_set(value,'$.thresholds.线索',2) WHERE key=?",
    "rules",
  );
  a.db.close();
  const b = createApp({ filename, demo: true });
  assert.equal(
    one(b.db, "SELECT note FROM customers WHERE id=1").note,
    "重启须保留",
  );
  assert.equal(
    JSON.parse(
      one(b.db, "SELECT value FROM settings WHERE key=?", "rules").value,
    ).thresholds.线索,
    2,
  );
  b.db.close();
});

test("M11-A03 静态资源安全策略与不存在的接口行为明确", async (t) => {
  const f = await fixture(t);
  const r = await fetch(f.base + "/");
  assert.equal(r.status, 200);
  assert.ok(
    r.headers.get("content-security-policy").includes("script-src 'self'"),
  );
  const denied = await fetch(f.base + "/server/database.mjs");
  assert.equal(denied.status, 404);
  const actor = await f.login(1);
  assert.equal((await f.request("/missing", { actor })).status, 404);
});
