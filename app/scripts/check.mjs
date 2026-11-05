import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
let failed = false;
const publicSources = [];
function checkFolder(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const p = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      checkFolder(p);
      continue;
    }
    if (!/\.(mjs|js)$/.test(entry.name)) continue;
    if (folder === "public" || folder.startsWith("public" + path.sep))
      publicSources.push(p);
    const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
    if (r.status) {
      process.stderr.write(r.stderr);
      failed = true;
    }
  }
}
for (const folder of ["public", "server", "scripts", "tests"])
  checkFolder(folder);
const app = publicSources.map((p) => readFileSync(p, "utf8")).join("\n");
if (/onclick=|onchange=|oninput=/.test(app)) {
  console.error("禁止内联事件处理器");
  failed = true;
}
if (failed) process.exit(1);
console.log("源码语法检查通过；界面无内联事件处理器。");
