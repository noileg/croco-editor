// 選択範囲の <u>/<uu>/<esc> トグルと一括下線。docformats.py の _toggle_pair /
// toggle_underline / toggle_underline_double / toggle_esc / bulk_underline /
// underline_spans / underline_double_spans / esc_spans / _code_span_mask を移植。
// いずれも (本文, 選択開始, 選択終了) を受け、(新しい本文, 新しい開始, 新しい終了)
// を返す。呼び出し側は本文を丸ごと差し替えて選択を貼り直す（現行と同じやり方）。

const RE_U_TAG = /<\/?u\s*>/gi;
const RE_UU_TAG = /<\/?uu\s*>/gi;
const RE_ESC_TAG = /<\/?esc\s*>/gi;
const RE_UBLOCK_TAG = /<\/?ublock\s*>/gi;
const RE_QBLOCK_TAG = /<\/?qblock\s*>/gi;
const RE_INLINE_CODE = /`[^`\n]+`/g;

// docformats._code_span_mask: インラインコード `…` が占める位置を 1 に。
function codeSpanMask(text) {
  const mask = new Uint8Array(text.length);
  RE_INLINE_CODE.lastIndex = 0;
  let m;
  while ((m = RE_INLINE_CODE.exec(text)) !== null) {
    for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = 1;
  }
  return mask;
}

// docformats.underline_spans / underline_double_spans（中身の範囲。閉じ忘れは
// 末尾まで。インラインコード内のタグは無視）。
function pairSpans(text, re, ignoreCode) {
  const spans = [];
  const inCode = ignoreCode ? codeSpanMask(text) : null;
  let open = null;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (inCode && inCode[m.index]) continue;
    const closing = m[0][1] === "/";
    if (closing) {
      if (open !== null) {
        spans.push([open, m.index]);
        open = null;
      }
    } else if (open === null) {
      open = m.index + m[0].length;
    }
  }
  if (open !== null) spans.push([open, text.length]);
  return spans;
}

// docformats.underline_spans / underline_double_spans / ublock_spans /
// qblock_spans。エディタ本文中で「ここは装飾範囲」と分かるように、
// 保存・書き出しと同じ規則でライブ表示するのに使う（editor_app.py _update_status）。
export const underlineSpans = (text) => pairSpans(text, RE_U_TAG, true);
export const underlineDoubleSpans = (text) => pairSpans(text, RE_UU_TAG, true);
export const ublockSpans = (text) => pairSpans(text, RE_UBLOCK_TAG, false);
export const qblockSpans = (text) => pairSpans(text, RE_QBLOCK_TAG, false);

// docformats.esc_spans（タグごと外側の範囲。閉じ忘れは末尾まで）。
export function escSpans(text) {
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
    } else if (start === null) {
      start = m.index;
    }
  }
  if (start !== null) spans.push([start, text.length]);
  return spans;
}

// docformats._toggle_pair
export function togglePair(text, start, end, open, close) {
  const before = text.slice(0, start);
  const inner = text.slice(start, end);
  const after = text.slice(end);
  const lo = (s) => s.toLowerCase();
  if (lo(inner).startsWith(open) && lo(inner).endsWith(close)) {
    const core = inner.slice(open.length, inner.length - close.length);
    return { text: before + core + after, start, end: start + core.length };
  }
  if (lo(before).endsWith(open) && lo(after).startsWith(close)) {
    return {
      text: before.slice(0, -open.length) + inner + after.slice(close.length),
      start: start - open.length,
      end: end - open.length,
    };
  }
  return {
    text: before + open + inner + close + after,
    start: start + open.length,
    end: end + open.length,
  };
}

export const toggleUnderline = (t, s, e) => togglePair(t, s, e, "<u>", "</u>");
export const toggleUnderlineDouble = (t, s, e) => togglePair(t, s, e, "<uu>", "</uu>");
export const toggleEsc = (t, s, e) => togglePair(t, s, e, "<esc>", "</esc>");

// docformats.bulk_underline
export function bulkUnderline(text, start, end) {
  if (start === end) {
    start = 0;
    end = text.length;
  }
  if (start > end) [start, end] = [end, start];

  const covered = new Uint8Array(text.length);
  const spans = [
    ...pairSpans(text, RE_U_TAG, true),
    ...pairSpans(text, RE_UU_TAG, true),
    ...escSpans(text),
  ];
  for (const [s, e] of spans) {
    for (let i = s; i < Math.min(e, text.length); i++) covered[i] = 1;
  }
  const isTag = new Uint8Array(text.length);
  for (const re of [RE_U_TAG, RE_UU_TAG, RE_ESC_TAG]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      for (let i = m.index; i < m.index + m[0].length; i++) isTag[i] = 1;
    }
  }

  const gaps = [];
  let i = start;
  while (i < end) {
    if (covered[i] || isTag[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < end && !covered[j] && !isTag[j]) j += 1;
    if (text.slice(i, j).trim()) gaps.push([i, j]);
    i = j;
  }

  if (gaps.length === 0) return { text, start, end };

  let out = text;
  for (let k = gaps.length - 1; k >= 0; k--) {
    const [s, e] = gaps[k];
    out = out.slice(0, s) + "<u>" + out.slice(s, e) + "</u>" + out.slice(e);
  }
  const added = gaps.length * ("<u>".length + "</u>".length);
  return { text: out, start, end: end + added };
}
