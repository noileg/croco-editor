// 編集ペイン。CodeMirror 6。現行 editor_app.py の tk.Text 相当。
//  - 字数オーバーの背景ハイライト（analyze().splitIndex 以降）＝現行の "over" タグ
//  - キー操作・メニュー項目は現行 editor_app.py の割り当てに合わせる。
//  ※ 現行に無いものは足さない。F5 の日時挿入は現行が意図的に外している
//    （IME 変換中に F5 が誤発火する既知バグ、editor_app.py の _bind_keys 参照）。
//
// タブは1つの EditorView の state を差し替えて実現する。タブごとに EditorState
// を丸ごと持たせるので、Undo 履歴・スクロール位置・選択もタブ別になる。
// 字数上限などタブ別の設定は setActiveSettings で切り替える。
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

// 現行 editor_app.py の FONT_FAMILIES
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

const refreshAnn = Annotation.define(); // 設定変更でデコレーションだけ作り直す
const loadAnn = Annotation.define(); // 殻からの全文差し替え（読み込み）を編集と区別する
const OVER = Decoration.mark({ class: "cm-over" });
// editor_app.py _update_status のタグ表示（utag=タグのグレー表示は本人指摘で
// 不要と判断済みなので入れない。それ以外の装飾はここで本文上に直接見せる）。
const UNDERLINE = Decoration.mark({ class: "cm-underline" });
const UNDERLINE2 = Decoration.mark({ class: "cm-underline2" });
const QBLOCK = Decoration.mark({ class: "cm-qblock" });
const ESC = Decoration.mark({ class: "cm-esc" });

// --- 見た目の状態（フォント・書体・折り返し）。localStorage に覚える -------
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
  // タブ別の字数設定。setActiveSettings で切り替える。
  let current = { limit: 0, stripMarkdown: false, includeWhitespace: true };

  const wrapComp = new Compartment();
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

  // 装飾範囲を1個ずつ ranges へ（from===to の空タグは Decoration.mark が
  // 例外を出すので除く。書いている途中は普通に通る＝閉じ忘れは末尾までなので
  // 実質困らない）。
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
    pushSpans(ranges, ublockSpans(text), UNDERLINE); // <ublock> も下線と同じ見た目
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

  // アプリのショートカット（Ctrl+N/O/S/P/M/F/H/G/U/E/ズーム 等）は
  // editor.js では拾わない。webview の window レベル（main.js）で拾う。
  // 編集欄・プレビュー欄・メモ欄のどこにフォーカスがあっても効かせるため。
  // ここに残すのは CodeMirror 既定（Undo・全選択・コピペ・移動）だけ。

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

  function extensions() {
    return [
      history(),
      drawSelection(),
      highlightActiveLine(),
      wrapComp.of(wrapOn ? EditorView.lineWrapping : []),
      markdown(),
      search(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      decoPlugin,
      listeners,
    ];
  }
  function makeState(text = "") {
    return EditorState.create({ doc: text, extensions: extensions() });
  }

  const view = new EditorView({ parent, state: makeState("") });
  applyFont();
  if (onWrap) onWrap(wrapOn);

  // 中ボタンドラッグでスクロール（方向反転・移動量比例・既定7倍）。
  // キャレット移動も Chromium 標準オートスクロールも起こさない。
  attachMiddleDragPan(view.scrollDOM);

  // タグ系：本文を丸ごと差し替えて選択を貼り直す（現行と同じやり方）。
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
      // 現行 editor_app.insert_datetime と同じ書式 "%Y-%m-%d %H:%M"
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
    getText: () => view.state.doc.toString(),
    // タブ管理用：新しいタブの state を作る／今の state を取り出す／差し替える。
    makeState,
    getState: () => view.state,
    setState: (state) => {
      view.setState(state);
      view.focus();
    },
    // タブ内で本文だけ差し替える（読み込み時など）。silent=true で onChange 抑止。
    setText(text, silent = false) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: silent ? [loadAnn.of(true)] : [],
      });
    },
    // アクティブなタブの字数設定を反映（上限ハイライトを描き直す）。
    setActiveSettings(s) {
      current = { ...current, ...s };
      view.dispatch({ annotations: [refreshAnn.of(true)] });
    },
  };
}
