// 新版の入口（webview 側）。タブ ＋ ツールバー ＋ 編集 ＋ プレビュー ＋
// ステータスバー。メニューバーは C# 殻（WinForms）側。ファイルの読み書きも殻。
// 殻の外（素のブラウザ）でも編集・プレビュー・字数は動く（保存だけ効かない）。
import { createEditor } from "./editor.js";
import { renderMarkdown } from "./preview.js";
import { analyze } from "./count.js";
import { attachMiddleDragPan } from "./pan.js";
import { readMarkdown, toBytes } from "./docformats.js";
import * as bridge from "./bridge.js";

const PRESETS = [400, 600, 800, 1000, 1200, 1600, 2000]; // editor_app.py PRESETS

const SAMPLE = `# croco-editor（ブラウザ表示のサンプル）

殻の外で開いたときのサンプル。**強調**、*弱め*、~~打ち消し~~、\`コード\`。

AIを<u>使った箇所</u>に下線。<uu>二重下線</uu>も別扱い。

> 引用文。

- 箇条書き
  - 入れ子

| 項目 | 値 |
|---|---|
| あ | 123 |

<esc>これはプレビューに出ないメモ。字数にも入らない。</esc>

---

上限を設定すると、超えた分の背景に色が付きます。
`;

const $ = (id) => document.getElementById(id);
const tabsEl = $("tabs");
const previewEl = $("preview");
const memoEl = $("memo");
const splitEl = $("split");
const countEl = $("count");
const posEl = $("pos");
const ptEl = $("pt");
const pathEl = $("path");
const limitEl = $("limit");
const stripEl = $("strip");
const wsEl = $("ws");
const presetsEl = $("presets");

for (const n of PRESETS) {
  const b = document.createElement("button");
  b.textContent = String(n);
  b.addEventListener("click", () => {
    limitEl.value = String(n);
    active().settings.limit = n;
    applySettings();
  });
  presetsEl.appendChild(b);
}

// --- タブ -----------------------------------------------------------------
// tab: { id, path, crlf, state, settings:{limit,stripMarkdown,includeWhitespace}, dirty }
let tabs = [];
let activeId = null;
let seq = 1;
let previewOn = true;
let lastRendered = null;
let memoVisible = false;
let memoEditable = false;
let memoStatus = "none";
let memoLast = null; // 直近に描いたメモ本文（無駄な再描画を避ける）
const pendingSaves = new Map(); // reqId -> tabId
const closeAfterSave = new Map(); // reqId -> tabId（保存が済んだら閉じる）
let reqSeq = 1;

const ed = createEditor($("editor"), {
  onChange,
  onCursor: ({ line, col, selLen }) => {
    posEl.textContent = `${line} 行 ${col} 列` + (selLen ? `（選択 ${selLen} 字）` : "");
  },
  onZoom: (pt) => {
    ptEl.textContent = `${pt} pt`;
  },
  onWrap: (on) => bridge.setWrap(on),
});

function active() {
  return tabs.find((t) => t.id === activeId);
}

function newSettings() {
  return { limit: 0, stripMarkdown: false, includeWhitespace: true };
}

// editor_app.py open_path: strip_markdown=path.suffix.lower() in (".md", ".markdown")。
// 新規に開く（復元ではない）ファイルの既定値を拡張子から決める。
// 2026-09-11、レビューで発覚：addTab の呼び出し側がどこも settings を渡して
// おらず、.md を開いても「記法を数えない」が既定でONにならなかった
// （文字数管理が主目的のアプリなので実害が小さくない）。
function stripMarkdownForPath(path) {
  if (!path) return false;
  const ext = (path.match(/\.[^.\\/]*$/) || [""])[0].toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

function addTab({ path = null, crlf = false, text = "", settings = null, dirty = false, memoOverride = null, title = null } = {}) {
  const t = {
    id: seq++,
    path,
    crlf,
    title, // path が無いとき（取り込み等）にタブへ出す名前
    state: ed.makeState(text),
    settings: settings ? { ...newSettings(), ...settings } : newSettings(),
    dirty,
    conflict: false, // 外部でも変更あり・自動保存を停止中（editor_app.py doc.conflict）
    memoOverride,
  };
  tabs.push(t);
  switchTab(t.id);
  pushSession();
  return t;
}

function switchTab(id) {
  if (id === activeId) return;
  const cur = active();
  if (cur) cur.state = ed.getState(); // 離れるタブの生の状態を保存
  activeId = id;
  const t = active();
  ed.setState(t.state);
  ed.setActiveSettings(t.settings);
  syncToolbar();
  updatePath();
  lastRendered = null;
  refresh(ed.getText());
  sendTitle();
  renderTabs();
  updateMemoWatch(); // メモの手動指定はタブごと
  pushSession();
  ed.focus();
}

// --- メモ広場 --------------------------------------------------------
function toggleMemo(force) {
  memoVisible = force === undefined ? !memoVisible : force;
  memoEl.classList.toggle("hidden", !memoVisible);
  bridge.setMemoMenu(memoVisible, memoEditable);
  updateMemoWatch();
}
function toggleMemoEdit() {
  if (memoEditable) flushMemo(); // 編集モードを抜けるとき保存
  memoEditable = !memoEditable;
  bridge.setMemoMenu(memoVisible, memoEditable);
  memoLast = null;
  updateMemoWatch();
}
function updateMemoWatch() {
  const t = active();
  bridge.memoWatch(t ? t.path : null, t ? t.memoOverride : null, memoVisible, memoEditable, t ? t.dirty : false);
  pushSession();
}

let memoTimer = null;
function flushMemo() {
  const ta = memoEl.querySelector("textarea");
  if (ta) bridge.memoSave(ta.value);
}
function renderMemo(status, content) {
  memoStatus = status;
  memoEl.classList.toggle("none", status === "none");
  if (memoEditable && status !== "none") {
    let ta = memoEl.querySelector("textarea");
    if (!ta) {
      memoEl.textContent = "";
      ta = document.createElement("textarea");
      ta.spellcheck = false;
      ta.addEventListener("input", () => {
        clearTimeout(memoTimer);
        memoTimer = setTimeout(() => bridge.memoSave(ta.value), 400);
      });
      ta.addEventListener("blur", flushMemo);
      memoEl.appendChild(ta);
    }
    if (document.activeElement !== ta) ta.value = content;
    return;
  }
  if (status === "none") {
    memoEl.textContent = content; // 「保存された下書きにのみ…」
    memoLast = null;
    return;
  }
  const body = status === "empty" ? "（まだメモはありません）" : content;
  if (body === memoLast) return;
  const keep = memoEl.scrollTop;
  memoEl.innerHTML = renderMarkdown(body);
  memoEl.scrollTop = keep;
  memoLast = body;
}

// --- セッション（開いているタブの一覧）を殻に預ける ---------------------
let sessionTimer = null;
function pushSession() {
  if (!bridge.inShell) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const out = {
      active: tabs.findIndex((t) => t.id === activeId),
      memoVisible,
      memoEditable,
      splitRatio,
      tabs: tabs.map((t) => ({
        path: t.path || null,
        crlf: t.crlf,
        // 本文は常に持たせる（殻は JSON を解釈しないため、復元は session の
        // 本文だけが頼り。自動保存でファイル＝バッファなので陳腐化はまず無い）。
        text: t.id === activeId ? ed.getText() : t.state.doc.toString(),
        dirty: t.dirty,
        limit: t.settings.limit,
        ws: t.settings.includeWhitespace,
        strip: t.settings.stripMarkdown,
        memoOverride: t.memoOverride || null,
      })),
    };
    bridge.setSession(out);
  }, 500);
}

function cycleTab(dir) {
  const i = tabs.findIndex((t) => t.id === activeId);
  if (i < 0 || tabs.length < 2) return;
  const j = (i + dir + tabs.length) % tabs.length;
  switchTab(tabs[j].id);
}

function closeTab(id, force) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (!force && t.dirty && bridge.inShell) {
    // 現行 editor_app と同じ はい/いいえ/キャンセル を殻の MessageBox で出す。
    bridge.askCloseTab(id, tabName(t));
    return;
  }
  const i = tabs.findIndex((x) => x.id === id);
  tabs.splice(i, 1);
  bridge.setAnyDirty(tabs.some((x) => x.dirty));
  if (tabs.length === 0) {
    addTab();
    return;
  }
  if (activeId === id) {
    activeId = null;
    switchTab(tabs[Math.min(i, tabs.length - 1)].id);
  } else {
    renderTabs();
  }
  pushSession();
}

function tabName(t) {
  if (t.path) return t.path.split(/[\\/]/).pop();
  return t.title || "無題";
}

function renderTabs() {
  tabsEl.textContent = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === activeId ? " active" : "");
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = (t.dirty ? "*" : "") + tabName(t);
    el.appendChild(name);
    const x = document.createElement("span");
    x.className = "tab-close";
    x.textContent = "×";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    el.appendChild(x);
    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(t.id); // 現行 editor_app._on_middle_click（タブ中クリックで閉じる）
      } else if (e.button === 0) {
        switchTab(t.id);
      }
    });
    tabsEl.appendChild(el);
  }
}

// --- 保存 ---------------------------------------------------------------
let saveTimer = null;
function scheduleAutosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const t = active();
    // 自動保存はパスのあるタブだけ。無題タブで走らせると毎回保存ダイアログが
    // 開く（中身はセッションに残るので閉じても消えない）。外部でも変更されて
    // conflict になっているタブは、本人が明示的に保存し直すまで自動保存を止める
    // （editor_app.py _autosave_files。「無条件の上書きはしない」）。
    if (t && t.dirty && t.path && !t.conflict) saveTab(t, false);
  }, 600);
}

function saveTab(t, asNew) {
  if (!t) return;
  if (!bridge.inShell) return;
  const reqId = reqSeq++;
  pendingSaves.set(reqId, t.id);
  const text = t.id === activeId ? ed.getText() : t.state.doc.toString();
  bridge.save(reqId, t.crlf, t.path || "", text, asNew);
}

function setDirty(t, d) {
  if (t.dirty === d) return;
  t.dirty = d;
  renderTabs();
  if (t.id === activeId) {
    sendTitle();
    updateMemoWatch(); // 殻へ dirty を伝え直す（外部変更の追従可否に使う）
  }
  bridge.setAnyDirty(tabs.some((x) => x.dirty));
  pushSession();
}

// --- 変更・描画 -------------------------------------------------------
function onChange(text, isLoad) {
  refresh(text);
  if (isLoad) return;
  const t = active();
  if (!t || !bridge.inShell) return;
  setDirty(t, true);
  scheduleAutosave();
}

function refresh(text) {
  const s = active() ? active().settings : newSettings();
  const { total } = analyze(text, s.limit, s.stripMarkdown, s.includeWhitespace);
  countEl.textContent = `${total} 字`;
  countEl.classList.toggle("over", s.limit > 0 && total > s.limit);
  if (previewOn && text !== lastRendered) {
    previewEl.innerHTML = renderMarkdown(text);
    lastRendered = text;
    syncPreviewToEditor(); // 描き直したらエディタの位置へ合わせ直す
  }
}

function applySettings() {
  ed.setActiveSettings(active().settings);
  refresh(ed.getText());
  pushSession();
}

function togglePreview(force) {
  previewOn = force === undefined ? !previewOn : force;
  previewEl.classList.toggle("hidden", !previewOn);
  splitEl.classList.toggle("no-preview", !previewOn);
  if (previewOn) {
    lastRendered = null;
    refresh(ed.getText());
  }
  bridge.setPreview(previewOn);
}

function updatePath() {
  const t = active();
  const conflict = !!(t && t.conflict);
  pathEl.classList.toggle("conflict", conflict);
  if (conflict) {
    pathEl.textContent = t.path + "（外部でも変更あり・自動保存を停止中。Ctrl+S でどちらを残すか選べます）";
    return;
  }
  pathEl.textContent = t && t.path ? t.path : "";
}

function sendTitle() {
  const t = active();
  bridge.setTitle(t ? tabName(t) : "無題", t ? t.dirty : false);
}

function syncToolbar() {
  const s = active().settings;
  limitEl.value = String(s.limit);
  stripEl.checked = s.stripMarkdown;
  wsEl.checked = s.includeWhitespace;
}

// --- 殻からのメッセージ -------------------------------------------------
bridge.onLoad(({ path, crlf, text }) => {
  // 起動時の最初のタブ（前回セッションが無いとき）
  addTab({ path, crlf, text, settings: { stripMarkdown: stripMarkdownForPath(path) } });
});
bridge.onRestore(({ tabs: saved, active: activeIdx, memoVisible: mv, memoEditable: me, splitRatio: sr }) => {
  if (typeof sr === "number" && sr > 0) {
    splitRatio = sr;
    applySplit();
  }
  // 前回開いていたタブを復元
  for (const s of saved || []) {
    addTab({
      path: s.path || null,
      crlf: !!s.crlf,
      text: s.text || "",
      settings: { limit: s.limit || 0, includeWhitespace: s.ws !== false, stripMarkdown: !!s.strip },
      dirty: !!s.dirty,
      memoOverride: s.memoOverride || null,
    });
  }
  if (tabs.length === 0) {
    addTab();
  } else if (typeof activeIdx === "number" && tabs[activeIdx]) {
    switchTab(tabs[activeIdx].id);
  }
  memoEditable = !!me;
  if (mv) toggleMemo(true);
});
bridge.onOpened(({ path, crlf, text }) => {
  // 既に同じファイルを開いていればそのタブへ切り替える。殻は毎回ファイルを
  // 読み直してから渡してくる（OpenAsTab）ので、未編集（dirtyでない）なら
  // その最新の中身に差し替える。でないと同じファイルを何度開き直しても
  // 最初に開いたときの内容のまま固まる（2026-09-11、本人指摘で発覚：
  // 「開く際は完全に開くファイルに依存しとけよ」）。dirtyなタブは未保存の
  // 編集を黙って消さないよう据え置く（今出ているタブに*が付いたまま）。
  const exist = path && tabs.find((t) => t.path === path);
  if (exist) {
    switchTab(exist.id);
    if (!exist.dirty) {
      exist.crlf = crlf;
      exist.conflict = false;
      ed.setText(text, true); // silent＝dirty化しない
      exist.state = ed.getState();
      refresh(text);
    }
    return;
  }
  // 今出ているタブが空の無題タブ（パス無し・未編集・本文なし）ならそこへ読み込む。
  // 新規タブを増やさない（editor_app.py open_path「空の無題タブは使い回す」）。
  // 旧版はこのとき Doc を丸ごと新規に作り直す（＝settings も memoOverride も
  // 既定へ戻る）ので、ここも同じく作り直す（前の空タブに残っていた値を
  // 持ち越さない。2026-09-11、レビューで発覚）。
  const cur = active();
  if (cur && !cur.path && !cur.dirty && ed.getText() === "") {
    cur.path = path;
    cur.crlf = crlf;
    cur.settings = { ...newSettings(), stripMarkdown: stripMarkdownForPath(path) };
    cur.memoOverride = null;
    ed.setText(text, true);
    ed.setActiveSettings(cur.settings);
    cur.state = ed.getState();
    syncToolbar();
    updatePath();
    sendTitle();
    renderTabs();
    updateMemoWatch();
    pushSession();
    return;
  }
  addTab({ path, crlf, text, settings: { stripMarkdown: stripMarkdownForPath(path) } });
});
bridge.onSaved(({ reqId, path }) => {
  const tabId = pendingSaves.get(reqId);
  pendingSaves.delete(reqId);
  const t = tabs.find((x) => x.id === tabId);
  if (!t) {
    closeAfterSave.delete(reqId);
    return;
  }
  if (path) t.path = path;
  t.conflict = false; // 書けた＝解消（明示保存で「はい」＝上書きを選んだ場合を含む）
  setDirty(t, false);
  if (t.id === activeId) {
    updatePath();
    renderTabs();
  }
  if (closeAfterSave.has(reqId)) {
    closeAfterSave.delete(reqId);
    closeTab(t.id, true);
  }
});
bridge.onConflict(({ reqId, path }) => {
  // 自動保存（idle timer）が外部変更を検知して書かずに諦めた。打っている
  // 最中にダイアログで割り込まないので、タブを止めて本人に知らせるだけ
  // （明示保存すれば殻側が選択肢を出す＝ onReloaded／通常の saved）。
  const tabId = pendingSaves.get(reqId);
  pendingSaves.delete(reqId);
  const t = tabs.find((x) => x.id === tabId);
  if (!t) return;
  t.conflict = true;
  if (t.id === activeId) updatePath();
  bridge.diag("conflict: " + (path || t.path));
});
bridge.onReloaded(({ reqId, crlf, text }) => {
  // 明示保存の競合で「いいえ」＝外部の内容を読み込む、を選んだ。書かずに
  // このタブの中身を外部の内容へ差し替える（このタブの未保存の変更は消える。
  // 本人が選択肢として選んだ結果なので警告はここでは出さない）。
  const tabId = pendingSaves.get(reqId);
  pendingSaves.delete(reqId);
  const t = tabs.find((x) => x.id === tabId);
  if (!t) return;
  t.crlf = crlf;
  t.conflict = false;
  if (t.id === activeId) {
    ed.setText(text, true); // silent＝dirty化しない
    t.state = ed.getState();
  } else {
    t.state = ed.makeState(text);
  }
  setDirty(t, false);
  if (t.id === activeId) {
    refresh(text);
    updatePath();
  }
  renderTabs();
  if (closeAfterSave.has(reqId)) {
    closeAfterSave.delete(reqId);
    closeTab(t.id, true); // 外部の内容に差し替えた上で、元々の「閉じる」を続行
  }
});
bridge.onExternalUpdate(({ path, crlf, text }) => {
  // アクティブなタブが未編集のまま外部で変わった。殻からの一方的な通知
  // （保存は絡まない）。念のためここでも「今もそのパスのまま・未編集か」を
  // 確認してから差し替える（殻が検知した瞬間と届いた瞬間の間にタブを
  // 切り替えたり編集し始めたりした場合に備える）。
  const t = tabs.find((x) => x.path === path);
  if (!t || t.dirty) return;
  t.crlf = crlf;
  if (t.id === activeId) {
    ed.setText(text, true); // silent＝dirty化しない
    t.state = ed.getState();
    refresh(text);
  } else {
    t.state = ed.makeState(text);
  }
  renderTabs();
});
bridge.onFlushSave(() => {
  const t = active();
  if (t) saveTab(t, false);
});
bridge.onMemo(({ status, content }) => renderMemo(status, content));

// docx / html / zip の取り込み。殻がバイトを base64 で渡す → Markdown にして
// 新しいタブへ（取り込みなのでパス無し・未保存＝Ctrl+S で保存先を訊く）。
bridge.onImport(({ path, ext, b64 }) => {
  try {
    const md = readMarkdown(ext, bridge.b64decode(b64));
    const stem = (path || "").split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    // editor_app.py: 取り込みは常に strip_markdown=True
    // （変換で入る <u> 等のタグ記法を文字数に含めないため）。
    addTab({
      text: md,
      dirty: true,
      title: stem ? stem + ".md" : "取り込み",
      settings: { stripMarkdown: true },
    });
  } catch (e) {
    bridge.menuToHost("import-failed\n" + (e && e.message ? e.message : e));
  }
});

// 「形式を変換して保存」。殻が保存先と拡張子を渡す → その形式のバイトを返す。
bridge.onExportRequest(({ path, ext }) => {
  try {
    bridge.sendExportBytes(path, toBytes(ext, ed.getText(), active() ? active().crlf : false));
  } catch (e) {
    bridge.menuToHost("import-failed\n" + (e && e.message ? e.message : e));
  }
});

// メニュー（殻から）と window キー入力（下）の両方から呼ぶコマンド実行。
// cmd は現行の「ファイル」「編集」「表示」メニュー項目に対応。
function doCommand(cmd) {
  const m = ed.menu;
  if (cmd.startsWith("family:")) {
    m.setFamily(cmd.slice("family:".length));
    ed.focus();
    return;
  }
  if (cmd.startsWith("memo-file\n")) {
    const p = cmd.slice("memo-file\n".length);
    if (active()) active().memoOverride = p;
    memoVisible = true;
    memoEl.classList.remove("hidden");
    bridge.setMemoMenu(memoVisible, memoEditable);
    memoLast = null;
    updateMemoWatch();
    return;
  }
  if (cmd.startsWith("open-relative\n")) {
    // プレビュー内の相対リンク。アクティブタブのフォルダから解決して殻へ。
    const rel = cmd.slice("open-relative\n".length).split("#")[0];
    const base = active() && active().path ? active().path.replace(/[\\/][^\\/]*$/, "") : "";
    if (!base) return;
    const abs = (base + "\\" + rel).replace(/\//g, "\\").replace(/\\\.\\/g, "\\");
    bridge.menuToHost("open-path\n" + abs);
    return;
  }
  if (cmd.startsWith("close-decision\n")) {
    const [, idStr, choice] = cmd.split("\n");
    const id = Number(idStr);
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    if (choice === "discard") {
      closeTab(id, true);
    } else if (choice === "save") {
      // 保存してから閉じる。saved を待って閉じる。
      const reqId = reqSeq++;
      pendingSaves.set(reqId, t.id);
      closeAfterSave.set(reqId, t.id);
      const text = t.id === activeId ? ed.getText() : t.state.doc.toString();
      bridge.save(reqId, t.crlf, t.path || "", text, !t.path);
    }
    return;
  }
  const map = {
    "new": () => addTab(),
    save: () => saveTab(active(), false),
    "save-as": () => saveTab(active(), true),
    "close-tab": () => closeTab(activeId),
    print: () => window.print(),
    undo: m.undo,
    redo: m.redo,
    "select-all": m.selectAll,
    cut: m.cut,
    copy: m.copy,
    paste: m.paste,
    underline: m.underline,
    "underline-double": m.underlineDouble,
    "bulk-underline": m.bulkUnderline,
    esc: m.esc,
    find: m.find,
    "find-next": m.findNext,
    "find-prev": m.findPrev,
    replace: m.replace,
    "goto-line": m.gotoLine,
    "date-time": m.insertDateTime,
    "zoom-in": m.zoomIn,
    "zoom-out": m.zoomOut,
    "zoom-reset": m.zoomReset,
    "toggle-wrap": m.toggleWrap,
    "toggle-preview": () => togglePreview(),
    "toggle-memo": () => toggleMemo(),
    "toggle-memo-edit": () => toggleMemoEdit(),
    "new-window": () => bridge.menuToHost("new-window"),
    "open": () => bridge.requestOpen(),
    "next-tab": () => cycleTab(1),
    "prev-tab": () => cycleTab(-1),
    "memo-reset": () => {
      if (active()) active().memoOverride = null;
      memoLast = null;
      updateMemoWatch();
    },
  };
  if (map[cmd]) map[cmd]();
  if (cmd !== "toggle-memo-edit") ed.focus();
}

bridge.onMenu(doCommand);

// アプリのショートカットは window レベルで拾う（capture）。編集欄・プレビュー
// 欄・メモ欄のどこにフォーカスがあっても効かせる（本人指摘）。CodeMirror 既定
// （Undo・全選択・コピペ・カーソル移動）はここでは触らない＝素通しさせる。
// 物理キー（e.code）で判定する。Ctrl+M は環境によって e.key が "Enter"（CR）に
// なるため e.key では取りこぼす。
const KEYMAP = [
  ["c", false, "KeyN", "new"],
  ["c", true, "KeyN", "new-window"],
  ["c", false, "KeyO", "open"],
  ["c", false, "KeyS", "save"],
  ["c", true, "KeyS", "save-as"],
  ["c", true, "KeyP", "print"],
  ["c", false, "KeyW", "close-tab"],
  ["c", false, "Tab", "next-tab"],
  ["c", true, "Tab", "prev-tab"],
  ["c", false, "PageUp", "prev-tab"], // 現行 editor_app の割り当て
  ["c", false, "PageDown", "next-tab"],
  ["c", false, "KeyP", "toggle-preview"],
  ["c", false, "KeyM", "toggle-memo"],
  ["c", false, "KeyF", "find"],
  ["c", false, "KeyH", "replace"],
  ["c", false, "KeyG", "goto-line"],
  ["c", false, "KeyU", "underline"],
  ["c", true, "KeyU", "underline-double"],
  ["c", false, "KeyE", "esc"],
  ["c", false, "Equal", "zoom-in"],
  ["c", false, "Semicolon", "zoom-in"], // JIS 配列で Ctrl+; の位置が ＋
  ["c", false, "Minus", "zoom-out"],
  ["c", false, "Digit0", "zoom-reset"],
  ["n", false, "F3", "find-next"],
  ["n", true, "F3", "find-prev"],
];
window.addEventListener(
  "keydown",
  (e) => {
    if (e.altKey || e.metaKey) return;
    // IME変換中のキー（Enter/Space/矢印等での確定・候補選択）を横取りしない。
    // KEYMAP は全項目 Ctrl 併用（F3系を除く）で変換中に押される組合せとは
    // 重ならないため実害は無いはずだが、念のため素通しさせる。
    if (e.isComposing || e.keyCode === 229) return;
    for (const [ctrl, shift, code, cmd] of KEYMAP) {
      if (ctrl === "c" && !e.ctrlKey) continue;
      if (ctrl === "n" && e.ctrlKey) continue;
      if (!!shift !== e.shiftKey) continue;
      if (e.code !== code) continue;
      e.preventDefault();
      e.stopPropagation();
      doCommand(cmd);
      return;
    }
  },
  true,
);

// Ctrl+ホイールでズーム（現行 _on_ctrl_wheel）。
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    doCommand(e.deltaY < 0 ? "zoom-in" : "zoom-out");
  },
  { capture: true, passive: false },
);

// --- ツールバー（アクティブなタブの設定を書き換える） -------------------
limitEl.addEventListener("input", () => {
  active().settings.limit = parseInt(limitEl.value, 10) || 0;
  applySettings();
});
stripEl.addEventListener("change", () => {
  active().settings.stripMarkdown = stripEl.checked;
  applySettings();
});
wsEl.addEventListener("change", () => {
  active().settings.includeWhitespace = wsEl.checked;
  applySettings();
});

attachMiddleDragPan(previewEl); // プレビュー欄でも中ボタンドラッグでスクロール
attachMiddleDragPan(memoEl);

// --- 編集欄の右クリック文脈メニュー（現行 _popup_context） --------------
const ctxMenu = document.createElement("div");
ctxMenu.id = "ctxmenu";
ctxMenu.hidden = true;
document.body.appendChild(ctxMenu);
const CTX_ITEMS = [
  ["元に戻す", "undo"],
  ["やり直し", "redo"],
  ["-"],
  ["切り取り", "cut"],
  ["コピー", "copy"],
  ["貼り付け", "paste"],
  ["-"],
  ["下線", "underline"],
  ["下線（二重）", "underline-double"],
  ["選択範囲に一括で下線", "bulk-underline"],
  ["エスケープ（文字数から除外）", "esc"],
  ["すべて選択", "select-all"],
];
function hideCtx() {
  ctxMenu.hidden = true;
}
ed.view.dom.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  ctxMenu.textContent = "";
  for (const [label, cmd] of CTX_ITEMS) {
    if (label === "-") {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      ctxMenu.appendChild(sep);
      continue;
    }
    const it = document.createElement("div");
    it.className = "ctx-item";
    it.textContent = label;
    it.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      hideCtx();
      doCommand(cmd);
    });
    ctxMenu.appendChild(it);
  }
  ctxMenu.hidden = false;
  const mw = ctxMenu.offsetWidth;
  const mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(e.clientX, innerWidth - mw - 4) + "px";
  ctxMenu.style.top = Math.min(e.clientY, innerHeight - mh - 4) + "px";
});
window.addEventListener("mousedown", (e) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideCtx();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideCtx();
});
window.addEventListener("blur", hideCtx);

// --- 仕切り（エディタ↔プレビュー）のドラッグ。比率は session に覚える -----
let splitRatio = 0.5;
const gutter = $("gutter1");
function applySplit() {
  const r = Math.max(0.15, Math.min(0.85, splitRatio));
  document.getElementById("editor").style.flexBasis = r * 100 + "%";
}
gutter.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const rect = splitEl.getBoundingClientRect();
  const onMove = (ev) => {
    splitRatio = (ev.clientX - rect.left) / rect.width;
    applySplit();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    pushSession();
  };
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
});

// --- エディタ → プレビューのスクロール同期（現行 _sync_preview 相当） -----
// 編集欄の一番上に見えている行に対応するプレビュー要素を、プレビュー欄の
// 上端へ寄せる。<esc>/<ublock>/<qblock> の展開で行数がずれる分だけ誤差が出る
// が、無いよりは合う（現行の line_map も近似）。
let syncRaf = 0;
function syncPreviewToEditor() {
  syncRaf = 0;
  if (!previewOn) return;
  const sv = ed.view.scrollDOM;
  const rect = sv.getBoundingClientRect();
  let topLine = 1;
  try {
    const pos = ed.view.posAtCoords({ x: rect.left + 6, y: rect.top + 4 }, false);
    topLine = ed.view.state.doc.lineAt(pos).number; // 1 始まり
  } catch {
    return;
  }
  const want = topLine - 1; // markdown-it は 0 始まり
  const marks = previewEl.querySelectorAll("[data-src-line]");
  if (!marks.length) return;
  let best = marks[0];
  for (const el of marks) {
    if (Number(el.getAttribute("data-src-line")) <= want) best = el;
    else break;
  }
  const delta = best.getBoundingClientRect().top - previewEl.getBoundingClientRect().top;
  previewEl.scrollTop += delta;
}
ed.view.scrollDOM.addEventListener("scroll", () => {
  if (!syncRaf) syncRaf = requestAnimationFrame(syncPreviewToEditor);
});

// --- 起動 -----------------------------------------------------------
if (!bridge.inShell) {
  addTab({ text: SAMPLE });
}
// 殻内なら bridge.onLoad が最初のタブを作る。

// --- 殻の自己テスト（CROCO_SELFTEST=1 のときだけ） ----------------------
if (bridge.inShell && location.search.indexOf("selftest") >= 0) {
  bridge.diag("selftest: script loaded");
  window.addEventListener("error", (e) => bridge.diag("selftest: window error " + e.message));
  // 取り込み（.docx 等）は load でなく import で来るので、そちらも観測する。
  bridge.onImport(() => {
    setTimeout(() => {
      const txt = ed.getText();
      bridge.diag(
        "selftest: imported len=" + txt.length +
          " hasHeading=" + (txt.indexOf("# ") >= 0) +
          " hasU=" + (txt.indexOf("<u>") >= 0) +
          " hasTable=" + (txt.indexOf("|---|") >= 0),
      );
    }, 500);
  });
  bridge.onLoad(() => {
    setTimeout(() => {
      try {
        // 1) 本文を足して保存（パスのあるタブのときだけ。無題だとダイアログで固まる）
        ed.setText(ed.getText() + "\n\nSELFTEST-OK\n", false);
        if (active().path) saveTab(active(), false);
        bridge.diag("selftest: save requested (tabs=" + tabs.length + " path=" + !!active().path + ")");
        // 2) 2つ目のタブを開く → タグ操作 → 切替往復 → 閉じる
        setTimeout(() => {
          const before = tabs.length;
          addTab({ path: null, crlf: false, text: "二つ目のタブ本文" });
          const id2 = activeId;
          ed.menu.underline(); // 選択なし → カーソル位置に空 <u></u>
          const hasU = ed.getText().indexOf("<u>") >= 0;
          cycleTab(-1);
          const backToFirst = !!(active().path && active().path.indexOf("ta.md") >= 0);
          const firstTextKept = ed.getText().indexOf("SELFTEST-OK") >= 0;
          switchTab(id2);
          const secondTextKept = ed.getText().indexOf("二つ目のタブ本文") >= 0;
          tabs.find((t) => t.id === id2).dirty = false; // 確認ダイアログを避ける（テスト）
          closeTab(id2, true);
          bridge.diag(
            "selftest: tabs " + before + "->" + tabs.length +
            " underline=" + hasU + " cycleBack=" + backToFirst +
            " firstKept=" + firstTextKept + " secondKept=" + secondTextKept +
            " afterClose=" + tabs.length,
          );
          // 3) メモ広場 表示→非表示 が実際に効くか
          toggleMemo(true);
          const shownVisible = getComputedStyle(memoEl).display !== "none";
          toggleMemo(false);
          const hiddenOk = getComputedStyle(memoEl).display === "none";
          toggleMemo(true);
          setTimeout(() => {
            bridge.diag(
              "selftest: memo status=" + memoStatus +
                " shown=" + shownVisible + " hides=" + hiddenOk,
            );
          }, 700);
        }, 400);
      } catch (err) {
        bridge.diag("selftest: EXC " + err);
      }
    }, 800);
  });
}
