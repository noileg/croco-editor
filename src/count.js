// 字数カウント。editor_app.py の build_mask / mark_markdown_syntax / analyze と
// docformats.py の esc 処理からの逐語移植。ここが変わると道具の意味が変わるので、
// 書き直しではなく移植であることを守る（Python 版 docstring より）。
//
// 移植上の注意（Python との差）:
//  - Python の len / インデックスはコードポイント単位。JS の string.length は
//    UTF-16 単位なので、BMP 外（絵文字など）で 1 文字が 2 に数えられてずれる。
//    下書き書類に絵文字はまず入らないが、完全一致にするなら Array.from で
//    コードポイント配列に直して数える必要がある。TODO として残す。
//  - JS の \s と Python の str.isspace() は概ね一致するが完全同一ではない
//    （Python は \x1c-\x1f 等も空白扱い）。実害の出る文字はまず現れない。

// --- 記法の判定（editor_app.py 72-88 行からの移植） -----------------------
const RE_HR = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const RE_FENCE = /^\s*(```|~~~)/;
const RE_HEAD_PREFIX = /^(\s*#{1,6}\s+)/;
const RE_QUOTE_PREFIX = /^(\s*>\s?)/;
const RE_LIST_PREFIX = /^(\s*(?:[-*+]|\d+[.)])\s+)/;
const RE_TABLE_ROW = /^\s*\|.*\|\s*$/;
const RE_TABLE_SEP = /^\s*\|[\s|:-]+\|\s*$/;
// (!?)[表示]( URL )
const RE_LINK = /(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/g;

// 下線・エスケープのタグ。<ublock> と <u> は別物として扱う（\s*> の直前が
// "u" なので "block>" には一致しない）。
const RE_U_TAG = /<\/?u\s*>/gi;
const RE_UU_TAG = /<\/?uu\s*>/gi;
const RE_UBLOCK_TAG = /<\/?ublock\s*>/gi;
const RE_QBLOCK_TAG = /<\/?qblock\s*>/gi;
const RE_ESC_TAG = /<\/?esc\s*>/gi;

// 行をまたがない装飾記号（editor_app.py RE_INLINE）。JS の \w は元々 ASCII のみ
// なので Python 側が明示していた [A-Za-z0-9_] とそのまま対応する。
const RE_INLINE = [
  /\*\*|__/g,
  /~~/g,
  /(?<![A-Za-z0-9_*])\*(?!\*)|(?<![A-Za-z0-9_])_(?!_)/g,
  /`/g,
];

// プレビューで拾う装飾（editor_app.py RE_INLINE_RENDER）。装飾記号を落として
// 桁を数えるのに使う。名前付きグループ。
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

// --- docformats.py: <esc>…</esc> の外側スパン ----------------------------
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
  // 閉じ忘れは本文末尾までとみなす（書いている途中は必ずこの状態を通る）。
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

// --- 装飾記号を落として実際に見える文字だけにする（strip_decoration） -----
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

// --- mark_markdown_syntax（記法として使われている文字に「数えない」印） ----
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

  // [表示](URL) は表示文字だけ数える。画像 ![..](..) は丸ごと落とす。
  RE_LINK.lastIndex = 0;
  let m;
  while ((m = RE_LINK.exec(text)) !== null) {
    const whole = m[0];
    if (m[1]) {
      clear(m.index, m.index + whole.length);
      continue;
    }
    clear(m.index, m.index + 1); // 先頭の [
    const close = m.index + 1 + m[2].length; // ] の位置
    clear(close, m.index + whole.length); // ](URL) の部分
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
  // <u> / <uu> / <ublock> / <qblock> のタグ自体は設定に関わらず常に数えない。
  // （提出物には下線や引用として現れる印であって本文ではない）
  clearTag(RE_U_TAG);
  clearTag(RE_UU_TAG);
  clearTag(RE_UBLOCK_TAG);
  clearTag(RE_QBLOCK_TAG);
  // <esc>…</esc> はタグも中身も常に数えない。
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

// --- analyze: (数えた文字数, 上限を超え始める位置) ----------------------
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
