// Editor pane (CodeMirror 6).
//  - Highlights text past the character limit (from analyze().splitIndex on)
//
// Tabs share one EditorView and swap its state. Each tab keeps its own
// EditorState, so undo history, scroll position and selection are per tab.
// Per-tab settings such as the character limit are switched with setActiveSettings.
import { EditorState, Annotation, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  Decoration,
  ViewPlugin,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
  undo,
  redo,
  selectAll,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import {
  search,
  searchKeymap,
  openSearchPanel,
  gotoLine,
  findNext,
  findPrevious,
} from "@codemirror/search";
import { analyze } from "./count.js";
import {
  toggleUnderline,
  toggleUnderlineDouble,
  toggleEsc,
  bulkUnderline,
  underlineSpans,
  underlineDoubleSpans,
  ublockSpans,
  qblockSpans,
  escSpans,
} from "./tags.js";
import { attachMiddleDragPan } from "./pan.js";

// Font choices offered in the View > Font menu
export const FONT_FAMILIES = [
  "Yu Gothic UI",
  "Meiryo UI",
  "Meiryo",
  "ＭＳ ゴシック",
  "Yu Mincho",
  "ＭＳ 明朝",
  "BIZ UDPGothic",
  "BIZ UDPMincho",
];
const DEFAULT_FONT_PT = 11; // editor_app.py DEFAULT_FONT_SIZE

// .html / .htm are edited as HTML rather than Markdown (and previewed as rendered HTML).
// main.js uses the same check.
export function isHtmlPath(path) {
  return !!path && /\.html?$/i.test(path);
}
function languageFor(path) {
  // Auto-closing tags are off (tags you didn't type would get in the way while drafting).
  // Markdown stays uncolored as before, so syntax colors are added only for HTML.
  return isHtmlPath(path)
    ? [html({ autoCloseTags: false }), syntaxHighlighting(defaultHighlightStyle, { fallback: true })]
    : markdown();
}

const refreshAnn = Annotation.define(); // Rebuild decorations only (settings changed)
const loadAnn = Annotation.define(); // Tells a whole-text replacement from the shell (a load) apart from an edit
const OVER = Decoration.mark({ class: "cm-over" });
// Tag decorations shown directly on the text.
const UNDERLINE = Decoration.mark({ class: "cm-underline" });
const UNDERLINE2 = Decoration.mark({ class: "cm-underline2" });
const QBLOCK = Decoration.mark({ class: "cm-qblock" });
const ESC = Decoration.mark({ class: "cm-esc" });

// --- Appearance (font size, font family, wrapping), remembered in localStorage ---
function lsGet(k, d) {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : v;
  } catch {
    return d;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, String(v));
  } catch {}
}

export function createEditor(parent, { onChange, onCursor, onZoom, onWrap }) {
  // Per-tab counting settings, switched with setActiveSettings.
  let current = { limit: 0, stripMarkdown: false, includeWhitespace: true };

  const wrapComp = new Compartment();
  const langComp = new Compartment(); // Per-tab language mode (Markdown / HTML)
  let wrapOn = lsGet("croco.wrap", "1") === "1";

  let fontPt = parseInt(lsGet("croco.fontPt", DEFAULT_FONT_PT), 10) || DEFAULT_FONT_PT;
  let family = lsGet("croco.family", FONT_FAMILIES[0]);
  function applyFont() {
    document.documentElement.style.setProperty("--edit-font", fontPt + "pt");
    document.documentElement.style.setProperty("--edit-family", `"${family}"`);
    lsSet("croco.fontPt", fontPt);
    lsSet("croco.family", family);
    if (onZoom) onZoom(fontPt);
  }
  function zoom(kind) {
    if (kind === "reset") fontPt = DEFAULT_FONT_PT;
    else if (kind === "in") fontPt = Math.min(40, fontPt + 1);
    else if (kind === "out") fontPt = Math.max(8, fontPt - 1);
    applyFont();
  }

  // Add each decorated range. Empty tags (from === to) are skipped because
  // Decoration.mark throws on them; an unclosed tag simply runs to the end.
  function pushSpans(ranges, spans, deco) {
    for (const [from, to] of spans) {
      if (to > from) ranges.push(deco.range(from, to));
    }
  }

  function buildDecorations(view) {
    const text = view.state.doc.toString();
    const ranges = [];
    pushSpans(ranges, underlineSpans(text), UNDERLINE);
    pushSpans(ranges, underlineDoubleSpans(text), UNDERLINE2);
    pushSpans(ranges, ublockSpans(text), UNDERLINE); // <ublock> looks the same as an underline
    pushSpans(ranges, qblockSpans(text), QBLOCK);
    pushSpans(ranges, escSpans(text), ESC);
    const { splitIndex } = analyze(
      text,
      current.limit,
      current.stripMarkdown,
      current.includeWhitespace,
    );
    if (current.limit > 0 && splitIndex < text.length) {
      ranges.push(OVER.range(splitIndex, text.length));
    }
    return Decoration.set(ranges, true);
  }

  const decoPlugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view);
      }
      update(u) {
        if (u.docChanged || u.transactions.some((t) => t.annotation(refreshAnn))) {
          this.decorations = buildDecorations(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  // App shortcuts (Ctrl+N/O/S/P/M/F/H/G/U/E, zoom, ...) are not handled here but at
  // window level in main.js, so they work wherever focus is (editor, preview or
  // notes panel). Only CodeMirror's defaults (undo, select all, copy/paste,
  // movement) stay here.

  const listeners = EditorView.updateListener.of((u) => {
    if (u.docChanged && onChange) {
      const isLoad = u.transactions.some((t) => t.annotation(loadAnn));
      onChange(u.state.doc.toString(), isLoad);
    }
    if ((u.selectionSet || u.docChanged) && onCursor) {
      const sel = u.state.selection.main;
      const line = u.state.doc.lineAt(sel.head);
      onCursor({
        line: line.number,
        col: sel.head - line.from + 1,
        selLen: sel.empty ? 0 : Math.abs(sel.to - sel.from),
      });
    }
  });

  function extensions(path) {
    return [
      history(),
      drawSelection(),
      highlightActiveLine(),
      wrapComp.of(wrapOn ? EditorView.lineWrapping : []),
      langComp.of(languageFor(path)),
      search(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      decoPlugin,
      listeners,
    ];
  }
  function makeState(text = "", path = null) {
    return EditorState.create({ doc: text, extensions: extensions(path) });
  }

  const view = new EditorView({ parent, state: makeState("") });
  applyFont();
  if (onWrap) onWrap(wrapOn);

  // Middle-button drag scrolling (inverted, proportional to movement, 7x by default).
  // It neither moves the caret nor triggers Chromium's built-in autoscroll.
  attachMiddleDragPan(view.scrollDOM);

  // Tag commands replace the whole text and then restore the selection.
  function tagCmd(fn) {
    return () => {
      const { from, to } = view.state.selection.main;
      const res = fn(view.state.doc.toString(), from, to);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: res.text },
        selection: { anchor: res.start, head: res.end },
        scrollIntoView: true,
      });
      view.focus();
    };
  }

  const menu = {
    undo: () => undo(view),
    redo: () => redo(view),
    selectAll: () => selectAll(view),
    cut: () => document.execCommand("cut"),
    copy: () => document.execCommand("copy"),
    paste: () => document.execCommand("paste"),
    underline: tagCmd(toggleUnderline),
    underlineDouble: tagCmd(toggleUnderlineDouble),
    esc: tagCmd(toggleEsc),
    bulkUnderline: tagCmd(bulkUnderline),
    find: () => openSearchPanel(view),
    findNext: () => findNext(view),
    findPrev: () => findPrevious(view),
    replace: () => openSearchPanel(view),
    gotoLine: () => gotoLine(view),
    insertDateTime: () => {
      // Format "%Y-%m-%d %H:%M"
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      view.dispatch(view.state.replaceSelection(s));
      view.focus();
    },
    zoomIn: () => zoom("in"),
    zoomOut: () => zoom("out"),
    zoomReset: () => zoom("reset"),
    toggleWrap: () => {
      wrapOn = !wrapOn;
      lsSet("croco.wrap", wrapOn ? "1" : "0");
      view.dispatch({ effects: wrapComp.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
      if (onWrap) onWrap(wrapOn);
    },
    setFamily: (f) => {
      family = f;
      applyFont();
    },
  };

  return {
    view,
    menu,
    focus: () => view.focus(),
    wrapOn: () => wrapOn,
    getText: () => view.state.doc.toString(),
    // For tab management: create a new tab's state / get the current state / swap it in.
    makeState,
    getState: () => view.state,
    setState: (state) => {
      view.setState(state);
      view.focus();
    },
    // Replace only the text within the tab (e.g. on load). silent=true suppresses onChange.
    setText(text, silent = false) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: silent ? [loadAnn.of(true)] : [],
      });
    },
    // Switch the current tab's language mode, e.g. when Save as changes the extension.
    setLanguage(path) {
      view.dispatch({ effects: langComp.reconfigure(languageFor(path)) });
    },
    // Apply the active tab's counting settings (redraws the over-limit highlight).
    setActiveSettings(s) {
      current = { ...current, ...s };
      view.dispatch({ annotations: [refreshAnn.of(true)] });
    },
  };
}
