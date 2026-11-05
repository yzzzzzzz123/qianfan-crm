import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const modules = readdirSync("tests")
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => f.replace(".test.mjs", ""));
const name = process.argv[2];
if (!modules.includes(name)) {
  console.error("请选择测试模块：" + modules.join(", "));
  process.exit(2);
}
const result = spawnSync(
  process.execPath,
  ["--test", `tests/${name}.test.mjs`],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
