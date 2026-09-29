// Whether docformats.js (docx/html conversion) matches the Python reference.
//   node test/fmt.check.mjs
// Compares with the Python reference (fmt_ref.py). Node has no DOMParser, so jsdom
// provides one.
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
// The Python reference produces Japanese placeholders and titles.
const { setLang } = await import("../src/i18n.js");
setLang("ja");

const py = spawnSync("python", [join(here, "fmt_ref.py")], {
  encoding: "utf-8",
  env: { ...process.env, PYTHONUTF8: "1" },
  maxBuffer: 32 * 1024 * 1024,
});
if (py.status !== 0 || !py.stdout.trim()) {
  console.log("SKIP: CROCO_PYREF not set (comparison with the Python reference skipped)");
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
  // Can the Python reader read back the docx made by JS? (a stand-in for "Word can open it")
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

console.log(failed === 0 ? `OK all ${cases.length} cases match` : `NG ${failed}/${cases.length} differ`);
process.exit(failed === 0 ? 0 : 1);

// Extract word/document.xml from the docx bytes (fflate)
import { unzipSync } from "fflate";
function extractDocXml(bytes) {
  return unzipSync(bytes)["word/document.xml"];
}
