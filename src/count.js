// Character counting: which characters count toward the total, and where the
// text starts to exceed the limit.
//
// Known gaps:
//  - string.length counts UTF-16 units, so characters outside the BMP (emoji etc.)
//    count as 2. Drafts rarely contain them; counting code points (Array.from)
//    would fix it. TODO.
//  - JS's \s is close to, but not exactly, "whitespace" in every sense (e.g.
//    \x1c-\x1f are not matched). Such characters practically never appear.

// --- Markup detection ---------------------------------------------------------
const RE_HR = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const RE_FENCE = /^\s*(```|~~~)/;
const RE_HEAD_PREFIX = /^(\s*#{1,6}\s+)/;
const RE_QUOTE_PREFIX = /^(\s*>\s?)/;
const RE_LIST_PREFIX = /^(\s*(?:[-*+]|\d+[.)])\s+)/;
const RE_TABLE_ROW = /^\s*\|.*\|\s*$/;
const RE_TABLE_SEP = /^\s*\|[\s|:-]+\|\s*$/;
// (!?)[text]( URL )
const RE_LINK = /(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/g;

// Underline and escape tags. <ublock> is distinct from <u> (the character before
// \s*> must be "u", so "block>" doesn't match).
const RE_U_TAG = /<\/?u\s*>/gi;
const RE_UU_TAG = /<\/?uu\s*>/gi;
const RE_UBLOCK_TAG = /<\/?ublock\s*>/gi;
const RE_QBLOCK_TAG = /<\/?qblock\s*>/gi;
const RE_ESC_TAG = /<\/?esc\s*>/gi;

// Inline markers that don't span lines. JS's \w is ASCII-only, i.e. [A-Za-z0-9_].
const RE_INLINE = [
  /\*\*|__/g,
  /~~/g,
  /(?<![A-Za-z0-9_*])\*(?!\*)|(?<![A-Za-z0-9_])_(?!_)/g,
  /`/g,
];

// Inline decorations as rendered, with named groups. Used to drop the markers and
// count what is visible.
const RE_INLINE_RENDER = new RegExp(
  "<uu\\s*>(?<under2>[\\s\\S]*?)<\\/uu\\s*>" +
  "|<u\\s*>(?<under>[\\s\\S]*?)<\\/u\\s*>" +
  "|\\*\\*(?<strong>[\\s\\S]+?)\\*\\*|__(?<strong2>[\\s\\S]+?)__" +
  "|~~(?<strike>[\\s\\S]+?)~~|`(?<code>[^`]+)`" +
  "|(?<![A-Za-z0-9_*])\\*(?<em>[^*\\n]+)\\*" +
  "|!?\\[(?<label>[^\\]\\n]*)\\]\\(([^)\\n]*)\\)",
  "gi",
);
const DISPLAY_GROUPS = ["under", "under2", "strong", "strong2", "strike", "code", "em", "label"];

// --- Outer spans of <esc>...</esc> --------------------------------------------
export function escSpans(text) {
  const spans = [];
  let start = null;
  RE_ESC_TAG.lastIndex = 0;
  let m;
  while ((m = RE_ESC_TAG.exec(text)) !== null) {
    const closing = m[0][1] === "/";
    if (closing) {
      if (start !== null) {
        spans.push([start, m.index + m[0].length]);
        start = null;
      }
    } else if (start === null) {
      start = m.index;
    }
  }
  // An unclosed tag runs to the end of the text (always the case while typing).
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

// --- Drop decoration markers, leaving only the visible characters ---------------
export function stripDecoration(text) {
  text = stripEsc(text);
  for (let i = 0; i < 4; i++) {
    const reduced = text.replace(RE_INLINE_RENDER, (...args) => {
      const groups = args[args.length - 1];
      for (const name of DISPLAY_GROUPS) {
        if (groups[name] != null) return groups[name];
      }
      return "";
    });
    if (reduced === text) break;
    text = reduced;
  }
  return text;
}

// --- Mark characters used as markup as "not counted" ---------------------------
function markMarkdownSyntax(text, mask) {
  const clear = (start, end) => {
    for (let i = Math.max(0, start); i < Math.min(end, mask.length); i++) mask[i] = 0;
  };

  let pos = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    const start = pos;
    pos += line.length + 1;

    if (RE_FENCE.test(line)) {
      inFence = !inFence;
      clear(start, start + line.length);
      continue;
    }
    if (inFence) continue;
    if (RE_HR.test(line)) {
      clear(start, start + line.length);
      continue;
    }

    for (const pattern of [RE_HEAD_PREFIX, RE_QUOTE_PREFIX, RE_LIST_PREFIX]) {
      const found = line.match(pattern);
      if (found) clear(start, start + found[1].length);
    }

    if (RE_TABLE_ROW.test(line)) {
      if (RE_TABLE_SEP.test(line)) {
        clear(start, start + line.length);
      } else {
        for (let i = 0; i < line.length; i++) {
          if (line[i] === "|") mask[start + i] = 0;
        }
      }
    }
  }

  for (const pattern of RE_INLINE) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      clear(m.index, m.index + m[0].length);
      if (m[0].length === 0) pattern.lastIndex++;
    }
  }

  // Links [text](URL) count only the text. Images ![..](..) are dropped entirely.
  RE_LINK.lastIndex = 0;
  let m;
  while ((m = RE_LINK.exec(text)) !== null) {
    const whole = m[0];
    if (m[1]) {
      clear(m.index, m.index + whole.length);
      continue;
    }
    clear(m.index, m.index + 1); // the leading [
    const close = m.index + 1 + m[2].length; // position of ]
    clear(close, m.index + whole.length); // the ](URL) part
  }
}

// --- build_mask ---------------------------------------------------------
export function buildMask(text, stripMarkdown, includeWhitespace) {
  const mask = new Uint8Array(text.length).fill(1);

  const clearTag = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = 0;
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  // <u> / <uu> / <ublock> / <qblock> tags never count, whatever the settings (they
  // show up as underlines or quotes in the final document, not as text).
  clearTag(RE_U_TAG);
  clearTag(RE_UU_TAG);
  clearTag(RE_UBLOCK_TAG);
  clearTag(RE_QBLOCK_TAG);
  // <esc>...</esc> never counts, tags and contents alike.
  for (const [s, e] of escSpans(text)) {
    for (let i = s; i < Math.min(e, mask.length); i++) mask[i] = 0;
  }
  if (stripMarkdown) markMarkdownSyntax(text, mask);
  if (!includeWhitespace) {
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) mask[i] = 0;
    }
  }
  return mask;
}

// --- analyze: (characters counted, position where the limit is exceeded) ------
export function analyze(text, limit, stripMarkdown, includeWhitespace) {
  const mask = buildMask(text, stripMarkdown, includeWhitespace);
  let total = 0;
  let splitIndex = text.length;
  for (let i = 0; i < text.length; i++) {
    if (!mask[i]) continue;
    total += 1;
    if (total === limit) splitIndex = i + 1;
  }
  if (limit <= 0) splitIndex = 0;
  else if (total <= limit) splitIndex = text.length;
  return { total, splitIndex };
}
