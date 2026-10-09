// Markdown preview: markdown-it plus the custom tags (<u> / <uu> / <ublock> /
// <qblock> / <esc>). Tables render as ordinary <table>s.
import MarkdownIt from "markdown-it";
import { tr } from "./i18n.js";

// Replace the <ublock>/</ublock> tags with <u>/</u>. The line count stays the same
// (so line numbers don't shift).
function expandUblock(text) {
  return text.replace(/<ublock\s*>/gi, "<u>").replace(/<\/ublock\s*>/gi, "</u>");
}

// Prefix every line inside <qblock>...</qblock> with "> " (">" for empty lines).
// The line count stays the same.
function expandQblock(text) {
  return text.replace(/<qblock\s*>([\s\S]*?)<\/qblock\s*>/gi, (_, inner) =>
    inner
      .split("\n")
      .map((line) => (line ? "> " + line : ">"))
      .join("\n"),
  );
}

// Remove <esc> for the preview. The contents are cleared but newlines are kept,
// so line numbers still match the editor and scroll sync stays aligned.
function blankEsc(text) {
  let out = text.replace(/<esc\s*>[\s\S]*?<\/esc\s*>/gi, (m) => m.replace(/[^\n]/g, ""));
  // An unclosed tag runs to the end
  out = out.replace(/<esc\s*>[\s\S]*$/i, (m) => m.replace(/[^\n]/g, ""));
  return out;
}

// markdown-it plugin that passes inline <u> </u> <uu> </uu> through as HTML tokens.
// Being an inline rule, it doesn't fire inside code spans (`...`).
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

// Tag top-level block elements with their source line (0-based) as a data attribute,
// used for editor <-> preview scroll sync.
function sourceLine(md) {
  md.core.ruler.push("source_line", (state) => {
    for (const token of state.tokens) {
      if (token.level === 0 && token.map && token.type.endsWith("_open")) {
        token.attrSet("data-src-line", String(token.map[0]));
      }
    }
  });
}

// A list item ends at its own line: an unindented line right after it starts a new
// paragraph instead of continuing the item (CommonMark's "lazy continuation" is off).
// Registered only as a paragraph terminator, so it fires only when a paragraph asks
// whether to stop. sCount < blkIndent holds only for lazy lines inside a list item.
function noLazyListContinuation(md) {
  md.block.ruler.before(
    "paragraph",
    "no_lazy_list_continuation",
    (state, line, _endLine, silent) => silent && state.sCount[line] < state.blkIndent,
    { alt: ["paragraph"] },
  );
}

// Line breaks and list items are read the same way as the .docx/.html export
// (docformats.js), so the preview shows what the export will look like.
const md = new MarkdownIt({
  html: false, // No raw HTML; only the tags above get through, via the plugin
  linkify: false,
  breaks: true, // A single newline is a line break
  typographer: false,
});
md.use(underlineTags);
md.use(sourceLine);
md.use(noLazyListContinuation);

// Images are not loaded; they show as an [image: alt] placeholder.
md.renderer.rules.image = (tokens, idx) => {
  const alt = tokens[idx].content || "";
  return `<span class="img-ph">${tr("[image: ", "[画像: ")}${md.utils.escapeHtml(alt)}]</span>`;
};

export function renderMarkdown(text) {
  let src = blankEsc(text); // Hide <esc>...</esc> (line count kept)
  src = expandUblock(src);
  src = expandQblock(src);
  return md.render(src);
}
