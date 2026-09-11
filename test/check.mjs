// 字数カウントの移植が Python 参照実装と一致しているかを確かめる回帰テスト。
//   node check.mjs
// ref_python.py を実行して現行 editor_app.analyze の結果を取り、JS 版と突き合わせる。
// Python が実行できない環境では、コミット済みの py_out.json（ゴールデン）と比較する。
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyze } from "../src/count.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf-8"));
const jsOut = cases.map((c) => {
  const { total, splitIndex } = analyze(c.text, c.limit, c.strip, c.ws);
  return { name: c.name, total, splitIndex };
});

let ref;
let refSource;
const py = spawnSync("python", [join(here, "ref_python.py")], {
  encoding: "utf-8",
  env: { ...process.env, PYTHONUTF8: "1" },
});
if (py.status === 0 && py.stdout.trim()) {
  ref = JSON.parse(py.stdout);
  refSource = "live: editor_app.analyze";
} else {
  ref = JSON.parse(readFileSync(join(here, "py_out.json"), "utf-8"));
  refSource = "golden: py_out.json (Python 実行不可)";
}

let failed = 0;
for (let i = 0; i < cases.length; i++) {
  const a = ref[i];
  const b = jsOut[i];
  if (!a || a.total !== b.total || a.splitIndex !== b.splitIndex) {
    failed++;
    console.error(
      `NG ${b.name}: py={total:${a?.total},split:${a?.splitIndex}} js={total:${b.total},split:${b.splitIndex}}`,
    );
  }
}
console.log(`参照 = ${refSource}`);
console.log(failed === 0 ? `OK 全 ${cases.length} ケース一致` : `NG ${failed}/${cases.length} ケース不一致`);
process.exit(failed === 0 ? 0 : 1);
