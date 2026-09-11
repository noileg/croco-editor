// Markdown プレビュー。markdown-it ＋ 独自記法（<u> / <uu> / <ublock> / <qblock> /
// <esc>）。現行 editor_app.py の _render_markdown 系に対応するが、表の等幅桁揃えは
// 踏襲しない（本人判断：現行の表は妥協）。普通の <table> で出す。
import MarkdownIt from "markdown-it";

// docformats.py の expand_ublock：<ublock>/</ublock> のタグ文字を <u>/</u> へ
// 置き換えるだけ。**行数は変えない**（行番号のずれを作らない）。
function expandUblock(text) {
  return text.replace(/<ublock\s*>/gi, "<u>").replace(/<\/ublock\s*>/gi, "</u>");
}

// docformats.py の expand_qblock：<qblock>…</qblock> の中身の各行頭に "> " を
// 足す（空行は ">"）。**行数は変えない**。
function expandQblock(text) {
  return text.replace(/<qblock\s*>([\s\S]*?)<\/qblock\s*>/gi, (_, inner) =>
    inner
      .split("\n")
      .map((line) => (line ? "> " + line : ">"))
      .join("\n"),
  );
}

// プレビュー用の <esc> 除去。**行数を保つ**ために中身は消すが改行は残す
// （editor_app の strip_esc_for_preview の line_map を作る代わりに、行番号が
// そのまま一致するようにしておく＝スクロール同期がずれない）。
function blankEsc(text) {
  let out = text.replace(/<esc\s*>[\s\S]*?<\/esc\s*>/gi, (m) => m.replace(/[^\n]/g, ""));
  // 閉じ忘れは末尾まで（editor_app の esc_spans と同じ）
  out = out.replace(/<esc\s*>[\s\S]*$/i, (m) => m.replace(/[^\n]/g, ""));
  return out;
}

// インラインの <u> </u> <uu> </uu> を html トークンとして通す markdown-it プラグイン。
// インラインルールなのでコードスパン（`…`）の中では発火しない＝現行と同じ扱い。
function underlineTags(md) {
  const MAP = {
    "<u>": "<u>",
    "</u>": "</u>",
    "<uu>": '<u class="uu">',
    "</uu>": "</u>",
  };
  md.inline.ruler.before("html_inline", "underline_tags", (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) return false;
    const m = /^<\/?uu?\s*>/i.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) {
      const key = m[0].replace(/\s+/g, "").toLowerCase();
      const token = state.push("html_inline", "", 0);
      token.content = MAP[key] || "";
    }
    state.pos += m[0].length;
    return true;
  });
}

// ブロック要素に元の行番号（0 始まり）を data 属性で付ける。
// エディタ↔プレビューのスクロール同期に使う（現行の line_map 相当）。
function sourceLine(md) {
  md.core.ruler.push("source_line", (state) => {
    for (const token of state.tokens) {
      if (token.level === 0 && token.map && token.type.endsWith("_open")) {
        token.attrSet("data-src-line", String(token.map[0]));
      }
    }
  });
}

const md = new MarkdownIt({
  html: false, // 生 HTML は通さない。必要なタグだけ上のプラグインで通す
  linkify: false,
  breaks: false,
  typographer: false,
});
md.use(underlineTags);
md.use(sourceLine);

// 画像は読み込まず [画像: alt] のプレースホルダにする（現行 parse_inline と同じ）。
md.renderer.rules.image = (tokens, idx) => {
  const alt = tokens[idx].content || "";
  return `<span class="img-ph">[画像: ${md.utils.escapeHtml(alt)}]</span>`;
};

export function renderMarkdown(text) {
  let src = blankEsc(text); // <esc>…</esc> は出さない（行数は保つ）
  src = expandUblock(src);
  src = expandQblock(src);
  return md.render(src);
}
