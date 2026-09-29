// Regression test: character counting matches the Python reference implementation.
//   node check.mjs
// Runs ref_python.py to get the reference results and compares them with the JS version.
// Where Python can't run, compares with the committed py_out.json (golden) instead.
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
  refSource = "golden: py_out.json (Python not available)";
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
console.log(`reference = ${refSource}`);
console.log(failed === 0 ? `OK all ${cases.length} cases match` : `NG ${failed}/${cases.length} cases differ`);
process.exit(failed === 0 ? 0 : 1);
