// Regression test for the preview's line breaks and list items (src/preview.js).
// They must be read the same way as the .docx/.html export: a single newline is a
// line break, and a list item ends at its own line.
//   node test/preview.check.mjs
import { renderMarkdown } from "../src/preview.js";

let bad = 0;
function check(name, cond, html) {
  console.log((cond ? "OK   " : "NG   ") + name);
  if (!cond) {
    console.log(html);
    bad++;
  }
}

// Drop the scroll-sync attributes and newlines so the checks only see the structure
function render(text) {
  return renderMarkdown(text).replace(/ data-src-line="\d+"/g, "").replace(/\n/g, "");
}

let html = render("一行目。\n二行目。");
check("a single newline in a paragraph is a line break", html === "<p>一行目。<br>二行目。</p>", html);

html = render("- 項目A\n- 項目B\n続きの段落。");
check(
  "an unindented line right after a list item is a paragraph outside the list",
  html === "<ul><li>項目A</li><li>項目B</li></ul><p>続きの段落。</p>",
  html,
);

html = render("- 項目\n  字下げした続き");
check("an indented line stays in the list item", html === "<ul><li>項目<br>字下げした続き</li></ul>", html);

html = render("- 外\n  - 内\n  外の続き");
check(
  "in a nested list, a line indented to the outer item stays in the outer item",
  html === "<ul><li>外<ul><li>内</li></ul>外の続き</li></ul>",
  html,
);

html = render("> 引用\n続き");
check("a lazy line after a blockquote still continues the quote", html === "<blockquote><p>引用<br>続き</p></blockquote>", html);

html = render("段落。\n- 項目");
check("a list right after a paragraph line still starts a list", html === "<p>段落。</p><ul><li>項目</li></ul>", html);

if (bad) {
  console.log(`\n${bad} failed`);
  process.exit(1);
}
console.log("\nall passed");
