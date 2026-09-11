// Markdown ⇄ .docx / .html。下線（<u>/<uu>）を保ったまま持ち運ぶ変換層。
// 現行 docformats.py からの移植。役割・注意点は docformats.py 冒頭を参照。
//   取り込み： docxToMarkdown(Uint8Array) / htmlToMarkdown(string) / htmlFromZip(Uint8Array)
//   書き出し： markdownToDocx(string) -> Uint8Array / markdownToHtml(string, title) -> string
//   入口：    isImportOnly(ext) / readMarkdown(ext, Uint8Array) / toBytes(ext, text, crlf)
import { zipSync, unzipSync } from "fflate";

// =====================================================================
// 記法の正規表現（docformats.py と同じ）
// =====================================================================
const RE_BAD_XML = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const RE_U_TAG = /<\/?u\s*>/gi;
const RE_UU_TAG = /<\/?uu\s*>/gi;
const RE_ESC_TAG = /<\/?esc\s*>/gi;
const RE_UBLOCK_TAG = /<\/?ublock\s*>/gi;
const RE_QBLOCK_TAG = /<\/?qblock\s*>/gi;
const RE_HEAD = /^\s*(#{1,6})\s+(.*)$/;
const RE_HR = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const RE_FENCE = /^\s*(```|~~~)/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_LIST = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const RE_TABLE_ROW = /^\s*\|.*\|\s*$/;
const RE_TABLE_SEP = /^\s*\|[\s|:-]+\|\s*$/;
const RE_LEADING_DECOR = /^(?:<u>|<\/u>|<uu>|<\/uu>)+/i;
const RE_INLINE_CODE = /`[^`\n]+`/g;

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

const DOCX_EXT = [".docx"];
const HTML_EXT = [".html", ".htm", ".zip"];

// =====================================================================
// 小さいヘルパ
// =====================================================================
function esc(text) {
  return text
    .replace(RE_BAD_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function htmlEscape(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function decodeBytes(bytes) {
  const u8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (u8.indexOf("�") < 0) return u8.replace(/^﻿/, "");
  try {
    return new TextDecoder("shift_jis", { fatal: false }).decode(bytes);
  } catch {
    return u8.replace(/^﻿/, "");
  }
}

// --- <esc>…</esc>（外側スパン。閉じ忘れは末尾まで） -------------------
function escSpans(text) {
  const spans = [];
  let start = null;
  RE_ESC_TAG.lastIndex = 0;
  let m;
  while ((m = RE_ESC_TAG.exec(text)) !== null) {
    if (m[0][1] === "/") {
      if (start !== null) {
        spans.push([start, m.index + m[0].length]);
        start = null;
      }
    } else if (start === null) start = m.index;
  }
  if (start !== null) spans.push([start, text.length]);
  return spans;
}
export function stripEsc(text) {
  const spans = escSpans(text);
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    out = out.slice(0, spans[i][0]) + out.slice(spans[i][1]);
  }
  return out;
}

// --- <ublock>/<qblock> の展開（docformats.py と同じ規則。行数は変えない）
function expandUblock(text) {
  return text.replace(/<ublock\s*>/gi, "<u>").replace(/<\/ublock\s*>/gi, "</u>");
}
function expandQblock(text) {
  return text.replace(/<qblock\s*>([\s\S]*?)<\/qblock\s*>/gi, (_, inner) =>
    inner
      .split("\n")
      .map((line) => (line ? "> " + line : ">"))
      .join("\n"),
  );
}

function codeSpanMask(text) {
  const mask = new Uint8Array(text.length);
  RE_INLINE_CODE.lastIndex = 0;
  let m;
  while ((m = RE_INLINE_CODE.exec(text)) !== null) {
    for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = 1;
  }
  return mask;
}
// underline_spans / underline_double_spans（中身の範囲。インラインコード内は無視）
function pairSpans(text, re) {
  const spans = [];
  const inCode = codeSpanMask(text);
  let open = null;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (inCode[m.index]) continue;
    if (m[0][1] === "/") {
      if (open !== null) {
        spans.push([open, m.index]);
        open = null;
      }
    } else if (open === null) open = m.index + m[0].length;
  }
  if (open !== null) spans.push([open, text.length]);
  return spans;
}
const underlineSpans = (t) => pairSpans(t, RE_U_TAG);
const underlineDoubleSpans = (t) => pairSpans(t, RE_UU_TAG);

// =====================================================================
// 段落／リストをまたぐ下線の繋ぎ直し
// =====================================================================
function maskFromSpans(len, spans) {
  const mask = new Uint8Array(len);
  for (const [s, e] of spans) for (let i = s; i < Math.min(e, len); i++) mask[i] = 1;
  return mask;
}

function carryUnderlineAcrossParagraphs(text) {
  const uSpans = underlineSpans(text);
  const uuSpans = underlineDoubleSpans(text);
  if (!uSpans.length && !uuSpans.length) return text;
  const mu = maskFromSpans(text.length, uSpans);
  const muu = maskFromSpans(text.length, uuSpans);

  const gaps = [];
  const re = /\n[ \t]*\n(?:[ \t]*\n)*/g;
  let m;
  while ((m = re.exec(text)) !== null) gaps.push([m.index, m.index + m[0].length]);
  if (!gaps.length) return text;

  const out = [];
  let pos = 0;
  for (const [gs, ge] of gaps) {
    out.push(text.slice(pos, gs));
    const before = gs - 1;
    if (before >= 0) {
      if (mu[before]) out.push("</u>");
      if (muu[before]) out.push("</uu>");
    }
    out.push(text.slice(gs, ge));
    if (ge < text.length) {
      if (muu[ge]) out.push("<uu>");
      if (mu[ge]) out.push("<u>");
    }
    pos = ge;
  }
  out.push(text.slice(pos));
  return out.join("");
}

function carryUnderlineAcrossListItems(text) {
  const uSpans = underlineSpans(text);
  const uuSpans = underlineDoubleSpans(text);
  if (!uSpans.length && !uuSpans.length) return text;
  const mu = maskFromSpans(text.length, uSpans);
  const muu = maskFromSpans(text.length, uuSpans);
  const isTag = new Uint8Array(text.length);
  for (const re of [RE_U_TAG, RE_UU_TAG]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      for (let i = m.index; i < m.index + m[0].length; i++) isTag[i] = 1;
    }
  }
  const rawLines = text.split("\n");
  const bodies = rawLines.map((l) => l.replace(RE_LEADING_DECOR, ""));
  const isList = bodies.map((b) => RE_LIST.test(b));
  const isBlank = bodies.map((b) => b.trim() === "");
  const isFragile = bodies.map((b) => RE_HR.test(b) || RE_FENCE.test(b));

  const boundaries = [];
  let pos = 0;
  for (let i = 0; i < rawLines.length - 1; i++) {
    const nl = pos + rawLines[i].length;
    if (
      (isList[i] || isList[i + 1]) &&
      !isBlank[i] &&
      !isBlank[i + 1] &&
      !isFragile[i] &&
      !isFragile[i + 1]
    ) {
      boundaries.push(nl);
    }
    pos = nl + 1;
  }
  if (!boundaries.length) return text;

  const out = [];
  pos = 0;
  for (const nl of boundaries) {
    out.push(text.slice(pos, nl));
    const before = nl - 1;
    if (before >= 0) {
      if (mu[before]) out.push("</u>");
      if (muu[before]) out.push("</uu>");
    }
    out.push("\n");
    const after = nl + 1;
    if (after < text.length) {
      if (muu[after]) out.push("<uu>");
      if (mu[after]) out.push("<u>");
    }
    pos = after;
  }
  out.push(text.slice(pos));
  return out.join("");
}

// 行ごとに (元の行, 行頭の下線タグ, タグを除いた本体)
function splitLeadingDecor(line) {
  const m = RE_LEADING_DECOR.exec(line);
  if (!m) return ["", line];
  return [m[0], line.slice(m[0].length)];
}
function decorLines(text) {
  const rawLines = text.split("\n");
  const lines = [];
  const decors = [];
  const bodies = [];
  let pending = "";
  for (const raw of rawLines) {
    const [decor, body] = splitLeadingDecor(raw);
    if (decor && body.trim() === "") {
      pending += decor;
      continue;
    }
    lines.push(raw);
    decors.push(pending + decor);
    bodies.push(body);
    pending = "";
  }
  return { lines, decors, bodies };
}

// =====================================================================
// インライン装飾のトークナイザ（parse_inline）
// =====================================================================
const RE_INLINE_TOKEN = new RegExp(
  "(?<uuopen><uu\\s*>)|(?<uuclose><\\/uu\\s*>)" +
    "|(?<uopen><u\\s*>)|(?<uclose><\\/u\\s*>)" +
    "|(?<code>`[^`\\n]+`)" +
    "|(?<image>!\\[[^\\]\\n]*\\]\\([^)\\n]*\\))" +
    "|(?<link>\\[[^\\]\\n]*\\]\\([^)\\n]*\\))" +
    "|(?<b>\\*\\*|__)|(?<s>~~)" +
    "|(?<i>(?<![A-Za-z0-9_*])\\*(?!\\*)|(?<![A-Za-z0-9_])_(?!_))",
  "gi",
);
const RE_LINK_PARTS = /^!?\[([^\]\n]*)\]\(([^)\n]*)\)$/;

export function parseInline(text) {
  const state = { b: false, i: false, s: false, u: false, uu: false };
  const segs = [];
  let pos = 0;
  RE_INLINE_TOKEN.lastIndex = 0;
  let m;
  while ((m = RE_INLINE_TOKEN.exec(text)) !== null) {
    if (m.index === RE_INLINE_TOKEN.lastIndex) RE_INLINE_TOKEN.lastIndex++;
    if (m.index > pos) segs.push([text.slice(pos, m.index), { ...state }]);
    pos = m.index + m[0].length;
    const g = m.groups;
    if (g.uopen) state.u = true;
    else if (g.uclose) state.u = false;
    else if (g.uuopen) state.uu = true;
    else if (g.uuclose) state.uu = false;
    else if (g.b) state.b = !state.b;
    else if (g.i) state.i = !state.i;
    else if (g.s) state.s = !state.s;
    else if (g.code) segs.push([m[0].slice(1, -1), { ...state, code: true }]);
    else if (g.image) {
      const p = RE_LINK_PARTS.exec(m[0]);
      if (p && p[1]) segs.push([`[画像: ${p[1]}]`, { ...state }]);
    } else if (g.link) {
      const p = RE_LINK_PARTS.exec(m[0]);
      if (p) segs.push([p[1] || p[2], { ...state, link: p[2] }]);
    }
  }
  if (pos < text.length) segs.push([text.slice(pos), { ...state }]);
  return segs.filter(([t]) => t);
}

// =====================================================================
// 装飾つき文字列 → Markdown（docx/html の取り込みで使う）
// =====================================================================
function wrap(text, marks) {
  if (!marks.length) return text;
  const core = text.trim();
  if (!core) return text;
  const lead = text.slice(0, text.length - text.trimStart().length);
  const trail = text.slice(text.trimEnd().length);
  let c = core;
  for (let i = marks.length - 1; i >= 0; i--) c = marks[i][0] + c + marks[i][1];
  return lead + c + trail;
}
function marksFor(style) {
  const marks = [];
  if (style.uu) marks.push(["<uu>", "</uu>"]);
  if (style.u) marks.push(["<u>", "</u>"]);
  if (style.s) marks.push(["~~", "~~"]);
  if (style.b) marks.push(["**", "**"]);
  if (style.i) marks.push(["*", "*"]);
  if (style.code) marks.push(["`", "`"]);
  return marks;
}
function segmentsMd(segments) {
  const merged = [];
  for (const [text, style] of segments) {
    if (!text) continue;
    const keys = ["b", "i", "u", "uu", "s", "code", "link"];
    const flat = keys.map((k) => style[k] || false).join(",");
    if (merged.length && merged[merged.length - 1].flat === flat) {
      merged[merged.length - 1].text += text;
    } else {
      merged.push({ text, flat, style });
    }
  }
  const out = [];
  for (const { text, style } of merged) {
    const url = style.link;
    if (url) {
      const label = wrap(text, marksFor(style)).trim() || url;
      out.push(`[${label}](${url})`);
    } else {
      out.push(wrap(text, marksFor(style)));
    }
  }
  return out.join("");
}
function joinBlocks(blocks) {
  const lines = [];
  let prev = "";
  for (const [kind, text] of blocks) {
    if (lines.length && !(kind === prev && (kind.startsWith("list") || kind.startsWith("quote")))) {
      lines.push("");
    }
    lines.push(text);
    prev = kind;
  }
  const body = lines.join("\n").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return body.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

// =====================================================================
// .html を読む（_HtmlReader を DOM 走査で再現）
// =====================================================================
const RE_CSS_RULE = /([^{}]+)\{([^{}]*)\}/g;
function parseCss(source) {
  const table = {};
  let m;
  RE_CSS_RULE.lastIndex = 0;
  while ((m = RE_CSS_RULE.exec(source)) !== null) {
    const decls = {};
    for (const part of m[2].split(";")) {
      const i = part.indexOf(":");
      if (i > 0) decls[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim().toLowerCase();
    }
    if (!Object.keys(decls).length) continue;
    for (let sel of m[1].split(",")) {
      sel = sel.trim();
      const f = /^(?:[a-z0-9]+)?\.([A-Za-z0-9_-]+)$/.exec(sel);
      if (f) table[f[1]] = { ...(table[f[1]] || {}), ...decls };
    }
  }
  return table;
}
function applyCss(props, base) {
  const style = { ...base };
  if ("font-weight" in props) {
    const w = props["font-weight"];
    style.b = w === "bold" || w === "bolder" || (/^\d+$/.test(w) && Number(w) >= 600);
  }
  if ("font-style" in props) style.i = props["font-style"] === "italic" || props["font-style"] === "oblique";
  const deco = props["text-decoration-line"] || props["text-decoration"];
  if (deco != null) {
    const isDouble = deco.indexOf("double") >= 0 || props["text-decoration-style"] === "double";
    style.u = deco.indexOf("underline") >= 0 && !isDouble;
    style.uu = deco.indexOf("underline") >= 0 && isDouble;
    style.s = deco.indexOf("line-through") >= 0;
  }
  return style;
}
function plainUrl(href) {
  const f = /^https?:\/\/(?:www\.)?google\.com\/url\?(.*)$/i.exec(href);
  if (!f) return href;
  for (const part of f[1].split("&")) {
    if (part.startsWith("q=")) return decodeURIComponent(part.slice(2));
  }
  return href;
}

class HtmlReader {
  constructor() {
    this.css = {};
    this.styles = [{}];
    this.blocks = [];
    this.buffer = [];
    this.headLevel = 0;
    this.lists = [];
    this.quoteDepth = 0;
    this.inPre = false;
    this.table = null;
    this.row = null;
  }
  static HEADS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
  static VOID = new Set([
    "br", "hr", "img", "input", "meta", "link", "col", "wbr",
    "source", "area", "base", "embed", "param", "track",
  ]);

  flush() {
    if (this.row !== null) return;
    const text = segmentsMd(this.buffer).trim();
    this.buffer = [];
    if (!text) return;
    if (this.headLevel) {
      this.blocks.push(["head", "#".repeat(this.headLevel) + " " + text]);
    } else if (this.lists.length) {
      const depth = this.lists.length - 1;
      const cur = this.lists[this.lists.length - 1];
      const bullet = cur.kind === "ol" ? `${cur.counter}. ` : "- ";
      cur.counter += 1;
      this.blocks.push([`list-${cur.kind}`, "  ".repeat(depth) + bullet + text]);
    } else if (this.quoteDepth) {
      this.blocks.push(["quote", "> " + text.replace(/\n/g, "\n> ")]);
    } else {
      this.blocks.push(["para", text]);
    }
  }

  start(tag, attrs) {
    tag = tag.toLowerCase();
    const props = {};
    for (const name of (attrs.class || "").split(/\s+/)) {
      if (this.css[name]) Object.assign(props, this.css[name]);
    }
    for (const part of (attrs.style || "").split(";")) {
      const i = part.indexOf(":");
      if (i > 0) props[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim().toLowerCase();
    }
    let style = applyCss(props, this.styles[this.styles.length - 1]);
    if (tag === "b" || tag === "strong") style.b = true;
    else if (tag === "i" || tag === "em" || tag === "cite") style.i = true;
    else if (tag === "u" || tag === "ins") style.u = true;
    else if (tag === "s" || tag === "strike" || tag === "del") style.s = true;
    else if ((tag === "code" || tag === "tt" || tag === "samp" || tag === "kbd") && !this.inPre) style.code = true;
    else if (tag === "a") {
      const href = plainUrl(attrs.href || "");
      if (href && !href.startsWith("#")) style.link = href;
      style.u = false;
      style.uu = false;
    }
    if (!HtmlReader.VOID.has(tag)) this.styles.push(style);

    if (tag === "br") this.buffer.push(["\n", { ...style }]);
    else if (tag === "hr") {
      this.flush();
      this.blocks.push(["rule", "---"]);
    } else if (HtmlReader.HEADS[tag]) {
      this.flush();
      this.headLevel = HtmlReader.HEADS[tag];
    } else if (tag === "ul" || tag === "ol") {
      this.flush();
      this.lists.push({ kind: tag, counter: 1 });
    } else if (tag === "li") this.flush();
    else if (tag === "blockquote") {
      this.flush();
      this.quoteDepth += 1;
    } else if (tag === "pre") {
      this.flush();
      this.inPre = true;
    } else if (tag === "table") {
      this.flush();
      this.table = [];
    } else if (tag === "tr" && this.table !== null) this.row = [];
    else if ((tag === "td" || tag === "th") && this.row !== null) this.buffer = [];
    else if (tag === "p" || tag === "div" || tag === "section" || tag === "article" || tag === "figcaption") {
      this.flush();
    }
  }

  data(text) {
    if (this.inPre) {
      this.buffer.push([text, {}]);
      return;
    }
    const t = text.replace(/ /g, " ").replace(/\s+/g, " ");
    if (t.trim() || (this.buffer.length && t)) {
      this.buffer.push([t, { ...this.styles[this.styles.length - 1] }]);
    }
  }

  end(tag) {
    tag = tag.toLowerCase();
    if (!HtmlReader.VOID.has(tag) && this.styles.length > 1) this.styles.pop();

    if ((tag === "td" || tag === "th") && this.row !== null) {
      const cell = segmentsMd(this.buffer).trim().replace(/\n/g, " ");
      this.buffer = [];
      this.row.push(cell.replace(/\|/g, "\\|"));
    } else if (tag === "tr" && this.table !== null && this.row !== null) {
      this.table.push(this.row);
      this.row = null;
    } else if (tag === "table" && this.table !== null) {
      const rows = this.table.filter((r) => r.some((c) => c));
      this.table = null;
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const padded = rows.map((r) => r.concat(Array(width - r.length).fill("")));
        const lines = [
          "| " + padded[0].join(" | ") + " |",
          "|" + Array(width).fill("---").join("|") + "|",
        ];
        for (let i = 1; i < padded.length; i++) lines.push("| " + padded[i].join(" | ") + " |");
        this.blocks.push(["table", lines.join("\n")]);
      }
    } else if (HtmlReader.HEADS[tag]) {
      this.flush();
      this.headLevel = 0;
    } else if (tag === "ul" || tag === "ol") {
      this.flush();
      if (this.lists.length) this.lists.pop();
    } else if (tag === "li") this.flush();
    else if (tag === "blockquote") {
      this.flush();
      this.quoteDepth = Math.max(0, this.quoteDepth - 1);
    } else if (tag === "pre") {
      const text = this.buffer.map(([t]) => t).join("");
      this.buffer = [];
      this.inPre = false;
      if (text.trim()) this.blocks.push(["code", "```\n" + text.replace(/^\n+|\n+$/g, "") + "\n```"]);
    } else if (tag === "p" || tag === "div" || tag === "section" || tag === "article" || tag === "figcaption") {
      this.flush();
    }
  }

  result() {
    this.flush();
    return joinBlocks(this.blocks);
  }
}

export function htmlToMarkdown(source) {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const reader = new HtmlReader();
  // <style> を先に集める（Docs のクラス指定下線）
  for (const st of doc.querySelectorAll("style")) reader.css = { ...reader.css, ...parseCss(st.textContent || "") };
  const SKIP = new Set(["script", "noscript", "title", "style"]);
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        reader.data(child.nodeValue || "");
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        if (SKIP.has(tag)) continue;
        const attrs = {};
        for (const a of child.attributes) attrs[a.name.toLowerCase()] = a.value || "";
        reader.start(tag, attrs);
        if (!HtmlReader.VOID.has(tag)) walk(child);
        reader.end(tag);
      }
    }
  };
  walk(doc.body || doc.documentElement);
  return reader.result();
}

export function htmlFromZip(bytes) {
  const files = unzipSync(bytes);
  const names = Object.keys(files).filter((n) => /\.html?$/i.test(n));
  if (!names.length) throw new Error("zip の中に .html がありません");
  names.sort((a, b) => a.length - b.length);
  return decodeBytes(files[names[0]]);
}

// =====================================================================
// .docx を読む
// =====================================================================
function wq(tag) {
  return tag; // 名前空間は localName で見る（下の findChildren がやる）
}
function children(node, localName) {
  const out = [];
  for (const c of node.childNodes) {
    if (c.nodeType === 1 && c.localName === localName) out.push(c);
  }
  return out;
}
function firstChild(node, localName) {
  for (const c of node.childNodes) {
    if (c.nodeType === 1 && c.localName === localName) return c;
  }
  return null;
}
function wval(node) {
  if (!node) return "";
  return node.getAttributeNS(W, "val") || node.getAttribute("w:val") || "";
}
function wflag(rpr, name) {
  if (!rpr) return false;
  const node = firstChild(rpr, name);
  if (!node) return false;
  const v = (wval(node) || "true").toLowerCase();
  return !["0", "false", "none", "off"].includes(v);
}
function underlineKind(rpr) {
  if (!rpr) return "";
  const node = firstChild(rpr, "u");
  if (!node) return "";
  const v = (wval(node) || "single").toLowerCase();
  if (["none", "0", "false", "off"].includes(v)) return "";
  return v === "double" ? "double" : "single";
}
function isCode(rpr) {
  if (!rpr) return false;
  const fonts = firstChild(rpr, "rFonts");
  if (!fonts) return false;
  const a = (fonts.getAttributeNS(W, "ascii") || fonts.getAttribute("w:ascii") || "").toLowerCase();
  return a === "consolas";
}
function runText(run) {
  const parts = [];
  for (const node of run.childNodes) {
    if (node.nodeType !== 1) continue;
    const ln = node.localName;
    if (ln === "t") parts.push(node.textContent || "");
    else if (ln === "br" || ln === "cr") parts.push("\n");
    else if (ln === "tab") parts.push("\t");
    else if (ln === "noBreakHyphen") parts.push("-");
  }
  return parts.join("");
}
function runStyle(run) {
  const rpr = firstChild(run, "rPr");
  const u = underlineKind(rpr);
  return {
    b: wflag(rpr, "b") || wflag(rpr, "bCs"),
    i: wflag(rpr, "i") || wflag(rpr, "iCs"),
    u: u === "single",
    uu: u === "double",
    s: wflag(rpr, "strike") || wflag(rpr, "dstrike"),
    code: isCode(rpr),
  };
}
function inlineSegments(parent, rels) {
  const segs = [];
  for (const node of parent.childNodes) {
    if (node.nodeType !== 1) continue;
    const ln = node.localName;
    if (ln === "r") segs.push([runText(node), runStyle(node)]);
    else if (ln === "hyperlink") {
      let url = rels[node.getAttributeNS(R, "id") || node.getAttribute("r:id") || ""] || "";
      const anchor = node.getAttributeNS(W, "anchor") || node.getAttribute("w:anchor");
      if (!url && anchor) url = "#" + anchor;
      for (const run of node.getElementsByTagName("*")) {
        if (run.localName !== "r") continue;
        const style = runStyle(run);
        style.link = url;
        segs.push([runText(run), style]);
      }
    } else if (ln === "smartTag" || ln === "sdt" || ln === "ins") {
      segs.push(...inlineSegments(node, rels));
    }
  }
  return segs;
}
function headingLevel(style, ppr) {
  const flat = style.replace(/ /g, "").replace(/　/g, "").toLowerCase();
  if (flat.startsWith("subtitle")) return 2;
  if (flat.startsWith("title")) return 1;
  const f = /^(?:heading|見出し)(\d)$/.exec(flat);
  if (f) return Math.min(6, Number(f[1]));
  if (ppr) {
    const node = firstChild(ppr, "outlineLvl");
    if (node && /^\d+$/.test(wval(node))) return Math.min(6, Number(wval(node)) + 1);
  }
  return 0;
}
function paragraphMd(para, rels, numbering) {
  const body = segmentsMd(inlineSegments(para, rels));
  const ppr = firstChild(para, "pPr");
  const style = ppr ? wval(firstChild(ppr, "pStyle")) : "";
  const level = headingLevel(style, ppr);
  if (level && body.trim()) return ["head", "#".repeat(level) + " " + body.trim()];
  if (style.toLowerCase().indexOf("quote") >= 0) return ["quote", ("> " + body.trim()).replace(/\s+$/, "")];
  const numpr = ppr ? firstChild(ppr, "numPr") : null;
  if (numpr) {
    const raw = wval(firstChild(numpr, "ilvl"));
    const depth = /^\d+$/.test(raw) ? Number(raw) : 0;
    const fmt = numbering[`${wval(firstChild(numpr, "numId"))},${depth}`] || "bullet";
    const bullet = fmt === "bullet" ? "- " : "1. ";
    return [`list-${fmt === "bullet" ? "ul" : "ol"}`, "  ".repeat(depth) + bullet + body.trim()];
  }
  return ["para", body];
}
function tableMd(table, rels) {
  const rows = [];
  for (const row of children(table, "tr")) {
    const cells = [];
    for (const cell of children(row, "tc")) {
      const texts = children(cell, "p").map((p) => segmentsMd(inlineSegments(p, rels)).trim());
      const joined = texts.filter((t) => t).join(" ").replace(/\|/g, "\\|");
      cells.push(joined.replace(/\n/g, " "));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => r.concat(Array(width - r.length).fill("")));
  const lines = ["| " + padded[0].join(" | ") + " |", "|" + Array(width).fill("---").join("|") + "|"];
  for (let i = 1; i < padded.length; i++) lines.push("| " + padded[i].join(" | ") + " |");
  return lines.join("\n");
}
function readRels(files) {
  const raw = files["word/_rels/document.xml.rels"];
  if (!raw) return {};
  const doc = new DOMParser().parseFromString(decodeBytes(raw), "text/xml");
  const rels = {};
  for (const node of doc.documentElement.childNodes) {
    if (node.nodeType !== 1) continue;
    const target = node.getAttribute("Target") || "";
    if (node.getAttribute("TargetMode") === "External" || /^(https?|mailto:)/.test(target)) {
      rels[node.getAttribute("Id") || ""] = target;
    }
  }
  return rels;
}
function readNumbering(files) {
  const raw = files["word/numbering.xml"];
  if (!raw) return {};
  let doc;
  try {
    doc = new DOMParser().parseFromString(decodeBytes(raw), "text/xml");
  } catch {
    return {};
  }
  const root = doc.documentElement;
  const abstract = {};
  for (const node of root.getElementsByTagName("*")) {
    if (node.localName !== "abstractNum") continue;
    const levels = {};
    for (const lvl of node.getElementsByTagName("*")) {
      if (lvl.localName !== "lvl") continue;
      const raw2 = lvl.getAttributeNS(W, "ilvl") || lvl.getAttribute("w:ilvl") || "0";
      levels[/^\d+$/.test(raw2) ? Number(raw2) : 0] = wval(firstChild(lvl, "numFmt"));
    }
    abstract[node.getAttributeNS(W, "abstractNumId") || node.getAttribute("w:abstractNumId") || ""] = levels;
  }
  const table = {};
  for (const node of root.getElementsByTagName("*")) {
    if (node.localName !== "num") continue;
    const levels = abstract[wval(firstChild(node, "abstractNumId"))] || {};
    for (const [depth, fmt] of Object.entries(levels)) {
      table[`${node.getAttributeNS(W, "numId") || node.getAttribute("w:numId") || ""},${depth}`] = fmt;
    }
  }
  return table;
}

export function docxToMarkdown(bytes) {
  const files = unzipSync(bytes);
  const doc = new DOMParser().parseFromString(decodeBytes(files["word/document.xml"]), "text/xml");
  const rels = readRels(files);
  const numbering = readNumbering(files);
  let body = null;
  for (const n of doc.documentElement.childNodes) {
    if (n.nodeType === 1 && n.localName === "body") body = n;
  }
  if (!body) return "";
  const blocks = [];
  for (const node of body.childNodes) {
    if (node.nodeType !== 1) continue;
    if (node.localName === "p") blocks.push(paragraphMd(node, rels, numbering));
    else if (node.localName === "tbl") {
      const t = tableMd(node, rels);
      if (t) blocks.push(["table", t]);
    }
  }
  return joinBlocks(blocks);
}

// =====================================================================
// .html を書く
// =====================================================================
const HTML_STYLE = `
body { font-family: "Yu Mincho", "游明朝", "MS Mincho", serif;
       line-height: 1.9; max-width: 46em; margin: 3em auto; padding: 0 1.5em;
       color: #1b1b1b; }
h1, h2, h3, h4, h5, h6 { line-height: 1.5; margin: 1.6em 0 .6em; }
p { margin: 0 0 1em; text-indent: 0; }
blockquote { margin: 0 0 1em; padding: .2em 1em; border-left: 3px solid #ccc;
             color: #555; }
code { font-family: Consolas, monospace; background: #f0efec; padding: .1em .35em; }
pre { background: #f0efec; padding: .8em 1em; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; margin: 0 0 1em; }
th, td { border: 1px solid #ccc; padding: .35em .7em; }
hr { border: none; border-top: 1px solid #ccc; margin: 2em 0; }
`;

function inlineHtml(text) {
  const out = [];
  for (const [chunk, style] of parseInline(text)) {
    let body = htmlEscape(chunk).replace(/\n/g, "<br>");
    if (style.code) body = `<code>${body}</code>`;
    if (style.b) body = `<strong>${body}</strong>`;
    if (style.i) body = `<em>${body}</em>`;
    if (style.s) body = `<del>${body}</del>`;
    if (style.uu) body = `<span style="text-decoration:underline;text-decoration-style:double">${body}</span>`;
    else if (style.u) body = `<u>${body}</u>`;
    if (style.link) body = `<a href="${htmlEscape(style.link)}">${body}</a>`;
    out.push(body);
  }
  return out.join("");
}
function splitTableRow(line) {
  const body = line.trim().replace(/^\||\|$/g, "");
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

export function markdownToHtml(text, title = "") {
  text = stripEsc(text);
  text = expandUblock(text);
  text = expandQblock(text);
  text = carryUnderlineAcrossParagraphs(text);
  text = carryUnderlineAcrossListItems(text);
  const { lines, decors, bodies } = decorLines(text);
  const out = [];
  let index = 0;
  let openList = "";
  let carried = "";
  while (index < lines.length) {
    if (carried) {
      decors[index] = carried + decors[index];
      carried = "";
    }
    const line = bodies[index];
    const decor = decors[index];

    if (RE_FENCE.test(line)) {
      index++;
      const block = [];
      while (index < lines.length && !RE_FENCE.test(bodies[index])) block.push(lines[index++]);
      index++;
      out.push("<pre><code>" + htmlEscape(block.join("\n")) + "</code></pre>");
      carried = decor;
      continue;
    }
    const item = RE_LIST.exec(line);
    if (item) {
      const kind = item[2] ? "ul" : "ol";
      if (openList !== kind) {
        if (openList) out.push(`</${openList}>`);
        out.push(`<${kind}>`);
        openList = kind;
      }
      out.push("<li>" + inlineHtml(decor + item[4]) + "</li>");
      index++;
      continue;
    }
    if (openList) {
      out.push(`</${openList}>`);
      openList = "";
    }
    if (!line.trim()) {
      index++;
      continue;
    }
    if (RE_HR.test(line)) {
      out.push("<hr>");
      carried = decor;
      index++;
      continue;
    }
    const head = RE_HEAD.exec(line);
    if (head) {
      const level = head[1].length;
      out.push(`<h${level}>${inlineHtml(decor + head[2])}</h${level}>`);
      index++;
      continue;
    }
    if (RE_TABLE_ROW.test(line)) {
      const rows = [];
      while (index < lines.length && RE_TABLE_ROW.test(bodies[index])) {
        if (!RE_TABLE_SEP.test(bodies[index])) rows.push(splitTableRow(lines[index]));
        index++;
      }
      if (rows.length) {
        const th = rows[0].map((c) => `<th>${inlineHtml(c)}</th>`).join("");
        const tb = rows
          .slice(1)
          .map((r) => "<tr>" + r.map((c) => `<td>${inlineHtml(c)}</td>`).join("") + "</tr>")
          .join("");
        out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      }
      continue;
    }
    if (RE_QUOTE.test(line)) {
      const block = [];
      while (index < lines.length) {
        const m = RE_QUOTE.exec(bodies[index]);
        if (!m) break;
        block.push(decors[index] + m[1]);
        index++;
      }
      out.push("<blockquote><p>" + inlineHtml(block.join("\n")) + "</p></blockquote>");
      continue;
    }
    const block = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !(
        RE_HEAD.test(bodies[index]) ||
        RE_HR.test(bodies[index]) ||
        RE_LIST.test(bodies[index]) ||
        RE_QUOTE.test(bodies[index]) ||
        RE_TABLE_ROW.test(bodies[index]) ||
        RE_FENCE.test(bodies[index])
      )
    ) {
      block.push(decors[index] + bodies[index]);
      index++;
    }
    out.push("<p>" + inlineHtml(block.join("\n")) + "</p>");
  }
  if (openList) out.push(`</${openList}>`);
  const heading = htmlEscape(title || "文書");
  return (
    '<!DOCTYPE html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n' +
    `<title>${heading}</title>\n<style>${HTML_STYLE}</style>\n</head>\n<body>\n` +
    out.join("\n") +
    "\n</body>\n</html>\n"
  );
}

// =====================================================================
// .docx を書く
// =====================================================================
function runXml(text, style) {
  const props = [];
  if (style.link) props.push('<w:rStyle w:val="Hyperlink"/>');
  if (style.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
  if (style.b) props.push("<w:b/>");
  if (style.i) props.push("<w:i/>");
  if (style.s) props.push("<w:strike/>");
  if (style.uu) props.push('<w:u w:val="double"/>');
  else if (style.u) props.push('<w:u w:val="single"/>');
  const rpr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  const body = [];
  text.split("\n").forEach((chunk, i) => {
    if (i) body.push("<w:br/>");
    if (chunk) body.push(`<w:t xml:space="preserve">${esc(chunk)}</w:t>`);
  });
  return body.length ? `<w:r>${rpr}${body.join("")}</w:r>` : "";
}

class DocxWriter {
  constructor() {
    this.links = [];
  }
  runs(text) {
    const out = [];
    for (const [chunk, style] of parseInline(text)) {
      const url = style.link;
      if (url && /^(https?:|mailto:)/i.test(url)) {
        this.links.push(url);
        out.push(`<w:hyperlink r:id="rIdL${this.links.length}">${runXml(chunk, style)}</w:hyperlink>`);
      } else {
        out.push(runXml(chunk, style));
      }
    }
    return out.join("");
  }
  paragraph(text, style = "", extra = "") {
    const props = [];
    if (style) props.push(`<w:pStyle w:val="${style}"/>`);
    if (extra) props.push(extra);
    const ppr = props.length ? `<w:pPr>${props.join("")}</w:pPr>` : "";
    return `<w:p>${ppr}${this.runs(text)}</w:p>`;
  }
  listItem(text, depth, ordered) {
    const extra =
      `<w:numPr><w:ilvl w:val="${Math.min(depth, 3)}"/>` +
      `<w:numId w:val="${ordered ? 2 : 1}"/></w:numPr>`;
    return this.paragraph(text, "ListParagraph", extra);
  }
  table(rows) {
    const width = Math.max(...rows.map((r) => r.length));
    const sides = ["top", "left", "bottom", "right", "insideH", "insideV"];
    const borders = sides.map((s) => `<w:${s} w:val="single" w:sz="4" w:color="BFBFBF"/>`).join("");
    const grid = Array(width).fill(`<w:gridCol w:w="${Math.floor(9070 / width)}"/>`).join("");
    const out = [
      `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>` +
        `<w:tblBorders>${borders}</w:tblBorders></w:tblPr>` +
        `<w:tblGrid>${grid}</w:tblGrid>`,
    ];
    rows.forEach((row, index) => {
      const cells = [];
      const full = row.concat(Array(width - row.length).fill(""));
      for (const cell of full) {
        const head = index === 0 ? "<w:rPr><w:b/></w:rPr>" : "";
        const paragraph =
          `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>` +
          `${this.runs(cell) || `<w:r>${head}</w:r>`}</w:p>`;
        cells.push(`<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph}</w:tc>`);
      }
      out.push(`<w:tr>${cells.join("")}</w:tr>`);
    });
    out.push("</w:tbl>");
    out.push("<w:p/>");
    return out.join("");
  }
}

function bodyXml(text, writer) {
  const { lines, decors, bodies } = decorLines(text);
  const out = [];
  let index = 0;
  let carried = "";
  while (index < lines.length) {
    if (carried) {
      decors[index] = carried + decors[index];
      carried = "";
    }
    const line = bodies[index];
    const decor = decors[index];

    if (RE_FENCE.test(line)) {
      index++;
      const block = [];
      while (index < lines.length && !RE_FENCE.test(bodies[index])) block.push(lines[index++]);
      index++;
      for (const row of block) {
        out.push(
          `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>${runXml(row, { code: true })}</w:p>`,
        );
      }
      carried = decor;
      continue;
    }
    if (!line.trim()) {
      index++;
      continue;
    }
    if (RE_HR.test(line)) {
      out.push(
        '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>',
      );
      carried = decor;
      index++;
      continue;
    }
    const head = RE_HEAD.exec(line);
    if (head) {
      out.push(writer.paragraph(decor + head[2], `Heading${head[1].length}`));
      index++;
      continue;
    }
    if (RE_TABLE_ROW.test(line)) {
      const rows = [];
      while (index < lines.length && RE_TABLE_ROW.test(bodies[index])) {
        if (!RE_TABLE_SEP.test(bodies[index])) rows.push(splitTableRow(lines[index]));
        index++;
      }
      if (rows.length) out.push(writer.table(rows));
      continue;
    }
    const quote = RE_QUOTE.exec(line);
    if (quote) {
      const block = [];
      while (index < lines.length) {
        const m = RE_QUOTE.exec(bodies[index]);
        if (!m) break;
        block.push(decors[index] + m[1]);
        index++;
      }
      out.push(writer.paragraph(block.join("\n"), "Quote"));
      continue;
    }
    const item = RE_LIST.exec(line);
    if (item) {
      out.push(writer.listItem(decor + item[4], Math.floor(item[1].length / 2), item[2] == null));
      index++;
      continue;
    }
    const block = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !(
        RE_HEAD.test(bodies[index]) ||
        RE_HR.test(bodies[index]) ||
        RE_LIST.test(bodies[index]) ||
        RE_QUOTE.test(bodies[index]) ||
        RE_TABLE_ROW.test(bodies[index]) ||
        RE_FENCE.test(bodies[index])
      )
    ) {
      block.push(decors[index] + bodies[index]);
      index++;
    }
    out.push(writer.paragraph(block.join("\n")));
  }
  return out.join("") || "<w:p/>";
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
  "</Types>";

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<Relationships xmlns="${PKG_REL}">` +
  `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
  "</Relationships>";

function stylesXml() {
  const sizes = [32, 28, 24, 22, 21, 21];
  const heads = sizes
    .map((size, i) => {
      const level = i + 1;
      return (
        `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
        `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/>` +
        `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/>` +
        `<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`
      );
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<w:styles xmlns:w="${W}">` +
    "<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val=\"21\"/></w:rPr></w:rPrDefault>" +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    "</w:docDefaults>" +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    heads +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/>' +
    '<w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="480"/></w:pPr>' +
    '<w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="HTML Preformatted"/>' +
    '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>' +
    '<w:ind w:left="360"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>' +
    '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/><w:contextualSpacing/></w:pPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
    '<w:rPr><w:color w:val="1155CC"/><w:u w:val="single"/></w:rPr></w:style>' +
    "</w:styles>"
  );
}
function numberingXml() {
  const levels = (bullet) => {
    const out = [];
    for (let depth = 0; depth < 4; depth++) {
      const mark = bullet ? "●○■◇"[depth] : "%" + (depth + 1) + ".";
      const fmt = bullet ? "bullet" : "decimal";
      out.push(
        `<w:lvl w:ilvl="${depth}"><w:start w:val="1"/>` +
          `<w:numFmt w:val="${fmt}"/><w:lvlText w:val="${mark}"/>` +
          `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${480 + depth * 420}" ` +
          `w:hanging="360"/></w:pPr></w:lvl>`,
      );
    }
    return out.join("");
  };
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<w:numbering xmlns:w="${W}">` +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    levels(true) +
    "</w:abstractNum>" +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    levels(false) +
    "</w:abstractNum>" +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    "</w:numbering>"
  );
}

export function markdownToDocx(text) {
  text = stripEsc(text);
  text = expandUblock(text);
  text = expandQblock(text);
  text = carryUnderlineAcrossParagraphs(text);
  text = carryUnderlineAcrossListItems(text);
  const writer = new DocxWriter();
  const body = bodyXml(text, writer);
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418"/>' +
    "</w:sectPr></w:body></w:document>";

  const rels = [
    `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>`,
  ];
  writer.links.forEach((url, i) => {
    rels.push(
      `<Relationship Id="rIdL${i + 1}" Type="${R}/hyperlink" Target="${esc(url)}" TargetMode="External"/>`,
    );
  });
  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${PKG_REL}">${rels.join("")}</Relationships>`;

  const enc = new TextEncoder();
  const zipData = {};
  zipData["[Content_Types].xml"] = [enc.encode(CONTENT_TYPES), { level: 6 }];
  zipData["_rels/.rels"] = [enc.encode(ROOT_RELS), { level: 6 }];
  zipData["word/document.xml"] = [enc.encode(document), { level: 6 }];
  zipData["word/_rels/document.xml.rels"] = [enc.encode(documentRels), { level: 6 }];
  zipData["word/styles.xml"] = [enc.encode(stylesXml()), { level: 6 }];
  zipData["word/numbering.xml"] = [enc.encode(numberingXml()), { level: 6 }];
  return zipSync(zipData);
}

// =====================================================================
// 入口
// =====================================================================
export function isImportOnly(ext) {
  ext = ext.toLowerCase();
  return DOCX_EXT.includes(ext) || HTML_EXT.includes(ext);
}
export function readMarkdown(ext, bytes) {
  ext = ext.toLowerCase();
  if (DOCX_EXT.includes(ext)) return docxToMarkdown(bytes);
  if (ext === ".zip") return htmlToMarkdown(htmlFromZip(bytes));
  return htmlToMarkdown(decodeBytes(bytes));
}
export function toBytes(ext, text, crlf = false) {
  ext = ext.toLowerCase();
  const enc = new TextEncoder();
  if (DOCX_EXT.includes(ext)) return markdownToDocx(text);
  if (ext === ".html" || ext === ".htm") {
    const body = markdownToHtml(text, "");
    return enc.encode(crlf ? body.replace(/\n/g, "\r\n") : body);
  }
  return enc.encode(crlf ? text.replace(/\n/g, "\r\n") : text);
}
