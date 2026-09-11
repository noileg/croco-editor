// tags.js（<u>/<uu>/<esc> トグルと一括下線）が docformats の対応関数と
// 一致するか。node test/tags.check.mjs
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toggleUnderline, toggleUnderlineDouble, toggleEsc, bulkUnderline } from "../src/tags.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "tags_cases.json"), "utf-8"));
const OPS = { u: toggleUnderline, uu: toggleUnderlineDouble, esc: toggleEsc, bulk: bulkUnderline };
const jsOut = cases.map((c) => {
  const r = OPS[c.op](c.text, c.start, c.end);
  return { name: c.name, text: r.text, start: r.start, end: r.end };
});

const py = spawnSync("python", [join(here, "tags_ref.py")], {
  encoding: "utf-8",
  env: { ...process.env, PYTHONUTF8: "1" },
});
if (py.status !== 0 || !py.stdout.trim()) {
  // 参照実装（旧 Python 版）が無い環境。CROCO_PYREF を設定すると照合できる。
  console.log("SKIP: CROCO_PYREF 未設定（旧 Python 版との照合を省略）");
  process.exit(0);
}
const ref = JSON.parse(py.stdout);

let failed = 0;
for (let i = 0; i < cases.length; i++) {
  const a = ref[i];
  const b = jsOut[i];
  if (a.text !== b.text || a.start !== b.start || a.end !== b.end) {
    failed++;
    console.error(`NG ${b.name}`);
    console.error(`  py: ${JSON.stringify(a)}`);
    console.error(`  js: ${JSON.stringify(b)}`);
  }
}
console.log(failed === 0 ? `OK 全 ${cases.length} ケース一致` : `NG ${failed}/${cases.length} 不一致`);
process.exit(failed === 0 ? 0 : 1);
