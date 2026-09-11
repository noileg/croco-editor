// docformats.js（docx/html 変換）が docformats.py と一致するか。
//   node test/fmt.check.mjs
// Python 参照（fmt_ref.py）と突き合わせる。Node には DOMParser が無いので
// jsdom で差し込む。
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

global.DOMParser = new JSDOM().window.DOMParser;

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "fmt_cases.json"), "utf-8"));

const {
  markdownToHtml,
  htmlToMarkdown,
  markdownToDocx,
  docxToMarkdown,
} = await import("../src/docformats.js");

const py = spawnSync("python", [join(here, "fmt_ref.py")], {
  encoding: "utf-8",
  env: { ...process.env, PYTHONUTF8: "1" },
  maxBuffer: 32 * 1024 * 1024,
});
if (py.status !== 0 || !py.stdout.trim()) {
  console.log("SKIP: CROCO_PYREF 未設定（旧 Python 版との照合を省略）");
  process.exit(0);
}
const ref = JSON.parse(py.stdout);

let failed = 0;
const show = (label, a, b) => {
  console.error(`  --- ${label} ---`);
  console.error(`  py: ${JSON.stringify(a)}`);
  console.error(`  js: ${JSON.stringify(b)}`);
};

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const r = ref[i];
  const jsHtml = markdownToHtml(c.md, "");
  const jsHtmlRt = htmlToMarkdown(jsHtml);
  const jsDocxBytes = markdownToDocx(c.md);
  const jsDocxRt = docxToMarkdown(jsDocxBytes);
  // JS が作った docx を Python の reader が読み戻せるか（＝Word 可読の代理）
  const pyReadsJsDocx = spawnSync(
    "python",
    ["-c", "import sys,docformats; sys.stdout.buffer.write(docformats.docx_to_markdown(sys.stdin.buffer.read()).encode('utf-8'))"],
    { input: Buffer.from(jsDocxBytes), encoding: "utf-8", env: { ...process.env, PYTHONUTF8: "1", PYTHONPATH: process.env.CROCO_PYREF || "" } },
  ).stdout;

  const checks = [
    ["md_to_html", r.md_to_html, jsHtml],
    ["html_roundtrip", r.html_roundtrip, jsHtmlRt],
    ["docx_roundtrip", r.docx_roundtrip, jsDocxRt],
    ["docx_document_xml", r.docx_document_xml, new TextDecoder().decode(extractDocXml(jsDocxBytes))],
    ["py_reads_js_docx", r.docx_roundtrip, pyReadsJsDocx],
  ];
  let bad = false;
  for (const [label, a, b] of checks) {
    if (a !== b) {
      if (!bad) console.error(`NG ${c.name}`);
      bad = true;
      show(label, a, b);
    }
  }
  if (bad) failed++;
}

console.log(failed === 0 ? `OK 全 ${cases.length} ケース一致` : `NG ${failed}/${cases.length} 不一致`);
process.exit(failed === 0 ? 0 : 1);

// jsDocx から word/document.xml を取り出す（fflate）
import { unzipSync } from "fflate";
function extractDocXml(bytes) {
  return unzipSync(bytes)["word/document.xml"];
}
