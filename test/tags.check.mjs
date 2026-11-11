// Whether tags.js (<u>/<uu>/<esc> toggles and bulk underline) matches the Python
// reference, and whether each result's `changes` turn the old text into its `text`.
// node test/tags.check.mjs
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ChangeSet, Text } from "@codemirror/state";
import { toggleUnderline, toggleUnderlineDouble, toggleEsc, bulkUnderline } from "../src/tags.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "tags_cases.json"), "utf-8"));
const OPS = { u: toggleUnderline, uu: toggleUnderlineDouble, esc: toggleEsc, bulk: bulkUnderline };
const jsOut = cases.map((c) => {
  const r = OPS[c.op](c.text, c.start, c.end);
  return { name: c.name, text: r.text, start: r.start, end: r.end };
});

// The editor applies `changes` instead of replacing the whole text, so applying them
// to the old text must give exactly `text`. These extra cases are not compared with the
// Python reference.
const CHANGE_CASES = [
  ...cases,
  { name: "esc-unwrap-inner-uppercase", op: "esc", text: "p<ESC>note</ESC>q", start: 1, end: 16 },
  { name: "esc-wrap-multiline", op: "esc", text: "一行目\n二行目\n三行目", start: 2, end: 7 },
  { name: "esc-unwrap-outer-multiline", op: "esc", text: "一<esc>行目\n二行</esc>目", start: 6, end: 11 },
  { name: "esc-wrap-empty-at-caret", op: "esc", text: "abc", start: 1, end: 1 },
];
let changeBad = 0;
for (const c of CHANGE_CASES) {
  const r = OPS[c.op](c.text, c.start, c.end);
  const applied = ChangeSet.of(r.changes, c.text.length)
    .apply(Text.of(c.text.split("\n")))
    .toString();
  if (applied !== r.text) {
    changeBad++;
    console.error(`NG changes ${c.name}`);
    console.error(`  text:    ${JSON.stringify(r.text)}`);
    console.error(`  applied: ${JSON.stringify(applied)}`);
  }
}
console.log(
  changeBad === 0
    ? `OK changes reproduce the text in all ${CHANGE_CASES.length} cases`
    : `NG changes differ from the text in ${changeBad}/${CHANGE_CASES.length} cases`,
);

const py = spawnSync("python", [join(here, "tags_ref.py")], {
  encoding: "utf-8",
  env: { ...process.env, PYTHONUTF8: "1" },
});
if (py.status !== 0 || !py.stdout.trim()) {
  // No reference implementation here. Set CROCO_PYREF to compare.
  console.log("SKIP: CROCO_PYREF not set (comparison with the Python reference skipped)");
  process.exit(changeBad === 0 ? 0 : 1);
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
console.log(failed === 0 ? `OK all ${cases.length} cases match` : `NG ${failed}/${cases.length} differ`);
process.exit(failed === 0 && changeBad === 0 ? 0 : 1);
