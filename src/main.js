// Entry point of the webview side: tabs, toolbar, editor, preview and status bar.
// The menu bar and all file I/O live in the C# shell (WinForms).
// Outside the shell (a plain browser) editing, preview and counting still work;
// only saving does not.
import { createEditor, isHtmlPath } from "./editor.js";
import { renderMarkdown } from "./preview.js";
import { analyze } from "./count.js";
import { attachMiddleDragPan } from "./pan.js";
import { readMarkdown, toBytes, htmlToMarkdown } from "./docformats.js";
import * as bridge from "./bridge.js";
import { tr, setLang } from "./i18n.js";

const PRESETS = [400, 600, 800, 1000, 1200, 1600, 2000];

// Sample text shown when the page is opened outside the shell.
const SAMPLE_EN = `# croco-editor (browser sample)

This sample appears when the page is opened outside the app. **Bold**, *italic*, ~~strikethrough~~, \`code\`.

Underline the parts <u>written with AI</u>. <uu>Double underlines</uu> are tracked separately.

> A quote.

- A list
  - Nested

| Item | Value |
|---|---|
| a | 123 |

<esc>A note that stays out of the preview and the character count.</esc>

---

Set a limit and the text past it gets a colored background.
`;

const SAMPLE_JA = `# croco-editor（ブラウザ表示のサンプル）

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

// --- Tabs -------------------------------------------------------------------
// tab: { id, path, crlf, state, settings:{limit,stripMarkdown,includeWhitespace}, dirty }
let tabs = [];
let activeId = null;
let seq = 1;
let previewOn = true;
let lastRendered = null;
let memoVisible = false;
let memoEditable = false;
let memoStatus = "none";
let memoLast = null; // Last rendered note text (skips needless redraws)
const pendingSaves = new Map(); // reqId -> tabId
const closeAfterSave = new Map(); // reqId -> tabId (close once saved)
let reqSeq = 1;

let lastCursor = { line: 1, col: 1, selLen: 0 };
function renderCursor() {
  const { line, col, selLen } = lastCursor;
  posEl.textContent =
    tr(`Ln ${line}, Col ${col}`, `${line} 行 ${col} 列`) +
    (selLen ? tr(` (${selLen} selected)`, `（選択 ${selLen} 字）`) : "");
}

const ed = createEditor($("editor"), {
  onChange,
  onCursor: (c) => {
    lastCursor = c;
    renderCursor();
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

// Default for "Ignore markup" when a file is newly opened (not restored):
// on for .md / .markdown.
function stripMarkdownForPath(path) {
  if (!path) return false;
  const ext = (path.match(/\.[^.\\/]*$/) || [""])[0].toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

function addTab({ path = null, crlf = false, text = "", settings = null, dirty = false, memoOverride = null, title = null, editorOn } = {}) {
  const t = {
    id: seq++,
    path,
    crlf,
    title, // Name shown on the tab when there is no path (e.g. an import)
    state: ed.makeState(text, path),
    settings: settings ? { ...newSettings(), ...settings } : newSettings(),
    dirty,
    conflict: false, // Changed externally too; autosave is paused for this tab
    memoOverride,
    // Whether the editor pane is shown (per tab). Shown for Markdown, hidden for HTML (view the rendering only).
    editorOn: editorOn === undefined ? !isHtmlPath(path) : editorOn,
  };
  tabs.push(t);
  switchTab(t.id);
  pushSession();
  return t;
}

function switchTab(id) {
  if (id === activeId) return;
  const cur = active();
  if (cur) cur.state = ed.getState(); // Keep the live state of the tab we're leaving
  activeId = id;
  const t = active();
  ed.setState(t.state);
  ed.setActiveSettings(t.settings);
  syncToolbar();
  updatePath();
  applyEditorVisibility(); // Apply this tab's editor visibility to the pane layout
  lastRendered = null;
  refresh(ed.getText());
  sendTitle();
  renderTabs();
  updateMemoWatch(); // The manual note choice is per tab
  pushSession();
  ed.focus();
}

// --- Notes panel ------------------------------------------------------------
function toggleMemo(force) {
  memoVisible = force === undefined ? !memoVisible : force;
  layoutPanes();
  bridge.setMemoMenu(memoVisible, memoEditable);
  updateMemoWatch();
}
function toggleMemoEdit() {
  if (memoEditable) flushMemo(); // Save when leaving edit mode
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
    memoEl.textContent = content; // e.g. "available only for saved drafts"
    memoLast = null;
    return;
  }
  const body = status === "empty" ? tr("(No notes yet)", "（まだメモはありません）") : content;
  if (body === memoLast) return;
  const keep = memoEl.scrollTop;
  memoEl.innerHTML = renderMarkdown(body);
  memoEl.scrollTop = keep;
  memoLast = body;
}

// --- Session (the list of open tabs), kept by the shell -----------------------
let sessionTimer = null;
function pushSession() {
  if (!bridge.inShell) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const out = {
      active: tabs.findIndex((t) => t.id === activeId),
      memoVisible,
      memoEditable,
      paneOrder,
      paneRatios,
      tabs: tabs.map((t) => ({
        path: t.path || null,
        crlf: t.crlf,
        // Always include the text: the shell doesn't parse this JSON, so restoring relies on it.
        text: t.id === activeId ? ed.getText() : t.state.doc.toString(),
        dirty: t.dirty,
        limit: t.settings.limit,
        ws: t.settings.includeWhitespace,
        strip: t.settings.stripMarkdown,
        editor: t.editorOn,
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
    // Ask Yes/No/Cancel with a MessageBox in the shell.
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
  return t.title || tr("Untitled", "無題");
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
        closeTab(t.id); // Middle-click a tab to close it
      } else if (e.button === 0) {
        switchTab(t.id);
      }
    });
    tabsEl.appendChild(el);
  }
}

// --- Saving -----------------------------------------------------------------
let saveTimer = null;
function scheduleAutosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const t = active();
    // Autosave only tabs with a path; untitled tabs would open a save dialog every
    // time (their text is kept in the session anyway). Tabs in conflict (changed
    // externally too) are not autosaved until the user saves them explicitly.
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
    updateMemoWatch(); // Tell the shell the new dirty state (it decides whether to follow external changes)
  }
  bridge.setAnyDirty(tabs.some((x) => x.dirty));
  pushSession();
}

// --- Changes and rendering ----------------------------------------------------
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
  countEl.textContent = tr(`${total} chars`, `${total} 字`);
  countEl.classList.toggle("over", s.limit > 0 && total > s.limit);
  // HTML and Markdown tabs render differently, so the kind is part of the comparison.
  const key = (activeIsHtml() ? "H:" : "M:") + text;
  if (previewOn && key !== lastRendered) {
    const first = lastRendered === null;
    lastRendered = key;
    clearTimeout(htmlTimer);
    if (activeIsHtml()) {
      // Rebuilding the iframe on every keystroke flickers, so wait a little (right away after a switch)
      htmlTimer = setTimeout(renderHtmlNow, first ? 0 : 250);
    } else {
      htmlFrame = null;
      previewEl.classList.remove("html-mode");
      previewEl.innerHTML = renderMarkdown(text);
      syncPreviewToEditor(); // After redrawing, line up with the editor again
    }
  }
}

// --- Preview for HTML tabs ----------------------------------------------------
// .html/.htm tabs skip markdown-it and render as-is in an iframe. The sandbox has no
// allow-scripts, so scripts don't run (and the preview has no way to message the
// shell). allow-same-origin lets the parent reach into the iframe for scroll sync
// and forwarding shortcuts, which is safe with scripts off.
let htmlFrame = null;
let htmlTimer = null;
let docBase = null; // Folder the shell's doc.local currently points to

function activeIsHtml() {
  const t = active();
  return !!t && isHtmlPath(t.path);
}

// Add a <base> so relative images and CSS load from doc.local (the HTML file's folder).
// A <base> before the doctype would trigger quirks mode, so look for head, then html,
// then the doctype.
function withBase(text) {
  const tag = '<base href="https://doc.local/">';
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    if (re.test(text)) return text.replace(re, (m) => m + tag);
  }
  return tag + text;
}

function renderHtmlNow() {
  const t = active();
  if (!previewOn || !t || !isHtmlPath(t.path)) return;
  const folder = t.path.replace(/[\\/][^\\/]*$/, "");
  const draw = () => {
    const cur = active();
    if (!previewOn || !cur || !isHtmlPath(cur.path)) return;
    if (!htmlFrame || !previewEl.contains(htmlFrame)) {
      previewEl.textContent = "";
      previewEl.classList.add("html-mode");
      htmlFrame = document.createElement("iframe");
      htmlFrame.setAttribute("sandbox", "allow-same-origin allow-modals");
      htmlFrame.addEventListener("load", onHtmlFrameLoad);
      previewEl.appendChild(htmlFrame);
    }
    htmlFrame.srcdoc = withBase(ed.getText());
  };
  if (folder !== docBase) {
    // The folder mapping is an async message to the shell, so give it a moment before drawing
    docBase = folder;
    bridge.setDocBase(folder);
    setTimeout(draw, 60);
  } else {
    draw();
  }
}

function onHtmlFrameLoad() {
  const w = htmlFrame && htmlFrame.contentWindow;
  if (!w) return;
  // Keep the app's shortcuts working while focus is inside the iframe
  w.addEventListener("keydown", onAppKeydown, true);
  w.addEventListener("wheel", onAppWheel, { capture: true, passive: false });
  // Middle-button drag panning works as in the editor and the Markdown preview. The
  // iframe gets a new window whenever srcdoc is redrawn, so attach it on each load.
  const d = htmlFrame.contentDocument;
  if (d && d.scrollingElement) attachMiddleDragPan(d.scrollingElement, w);
  syncPreviewToEditor();
}

function applySettings() {
  ed.setActiveSettings(active().settings);
  refresh(ed.getText());
  pushSession();
}

// Editor pane visibility (per tab; hidden by default for HTML tabs).
// Pane order and widths are handled by layoutPanes (see "Pane order and widths" below).
function applyEditorVisibility() {
  const t = active();
  layoutPanes();
  bridge.setEditor(!t || t.editorOn);
}

function toggleEditor(force) {
  const t = active();
  if (!t) return;
  t.editorOn = force === undefined ? !t.editorOn : force;
  applyEditorVisibility();
  pushSession();
}

function togglePreview(force) {
  previewOn = force === undefined ? !previewOn : force;
  layoutPanes();
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
    pathEl.textContent = t.path + tr("  (also changed externally; autosave paused. Press Ctrl+S to choose which version to keep)", "（外部でも変更あり・自動保存を停止中。Ctrl+S でどちらを残すか選べます）");
    return;
  }
  pathEl.textContent = t && t.path ? t.path : "";
}

function sendTitle() {
  const t = active();
  bridge.setTitle(t ? tabName(t) : tr("Untitled", "無題"), t ? t.dirty : false);
}

function syncToolbar() {
  const s = active().settings;
  limitEl.value = String(s.limit);
  stripEl.checked = s.stripMarkdown;
  wsEl.checked = s.includeWhitespace;
}

// --- Messages from the shell --------------------------------------------------
bridge.onLoad(({ path, crlf, text }) => {
  // First tab at startup (when there is no previous session)
  addTab({ path, crlf, text, settings: { stripMarkdown: stripMarkdownForPath(path) } });
});
bridge.onRestore(({ tabs: saved, active: activeIdx, memoVisible: mv, memoEditable: me, paneOrder: po, paneRatios: pr }) => {
  if (pr && typeof pr === "object") paneRatios = pr;
  // Restore the tabs that were open last time
  for (const s of saved || []) {
    addTab({
      path: s.path || null,
      crlf: !!s.crlf,
      text: s.text || "",
      settings: { limit: s.limit || 0, includeWhitespace: s.ws !== false, stripMarkdown: !!s.strip },
      dirty: !!s.dirty,
      memoOverride: s.memoOverride || null,
      editorOn: typeof s.editor === "boolean" ? s.editor : undefined,
    });
  }
  if (tabs.length === 0) {
    addTab();
  } else if (typeof activeIdx === "number" && tabs[activeIdx]) {
    switchTab(tabs[activeIdx].id);
  }
  memoEditable = !!me;
  if (mv) toggleMemo(true);
  // Restore the order after all tabs are back, so switching tabs midway can't disturb it
  if (Array.isArray(po)) {
    paneOrder = po.filter((n) => PANE_NAMES.includes(n));
    layoutPanes();
  }
});
bridge.onOpened(({ path, crlf, text }) => {
  // If the file is already open, switch to that tab. The shell re-reads the file on
  // every open, so an unedited tab is refreshed with the latest content. A tab with
  // unsaved edits is left alone so they are never silently discarded.
  const exist = path && tabs.find((t) => t.path === path);
  if (exist) {
    switchTab(exist.id);
    if (!exist.dirty) {
      exist.crlf = crlf;
      exist.conflict = false;
      ed.setText(text, true); // silent: don't mark dirty
      exist.state = ed.getState();
      refresh(text);
    }
    return;
  }
  // If the current tab is an empty untitled tab (no path, unedited, no text), load
  // into it instead of adding a tab, resetting its settings to the defaults.
  const cur = active();
  if (cur && !cur.path && !cur.dirty && ed.getText() === "") {
    cur.path = path;
    cur.crlf = crlf;
    cur.settings = { ...newSettings(), stripMarkdown: stripMarkdownForPath(path) };
    cur.memoOverride = null;
    cur.editorOn = !isHtmlPath(path);
    ed.setLanguage(path);
    lastRendered = null;
    ed.setText(text, true);
    ed.setActiveSettings(cur.settings);
    cur.state = ed.getState();
    syncToolbar();
    updatePath();
    applyEditorVisibility();
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
  const pathChanged = !!path && path !== t.path;
  if (path) t.path = path;
  if (pathChanged && t.id === activeId) {
    // The kind may change (e.g. .md -> .html), so switch the language mode and preview too.
    ed.setLanguage(t.path);
    lastRendered = null;
    refresh(ed.getText());
  }
  t.conflict = false; // Written, so resolved (including "Yes" to overwrite on an explicit save)
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
  // Autosave found an external change and gave up without writing. Rather than
  // interrupt typing with a dialog, pause the tab and show it in the status bar
  // (an explicit save lets the shell offer the choices: onReloaded / saved).
  const tabId = pendingSaves.get(reqId);
  pendingSaves.delete(reqId);
  const t = tabs.find((x) => x.id === tabId);
  if (!t) return;
  t.conflict = true;
  if (t.id === activeId) updatePath();
  bridge.diag("conflict: " + (path || t.path));
});
bridge.onReloaded(({ reqId, crlf, text }) => {
  // On an explicit save conflict the user chose "No" (load the external version).
  // Replace this tab's text without writing; its unsaved changes are discarded, as
  // chosen.
  const tabId = pendingSaves.get(reqId);
  pendingSaves.delete(reqId);
  const t = tabs.find((x) => x.id === tabId);
  if (!t) return;
  t.crlf = crlf;
  t.conflict = false;
  if (t.id === activeId) {
    ed.setText(text, true); // silent: don't mark dirty
    t.state = ed.getState();
  } else {
    t.state = ed.makeState(text, t.path);
  }
  setDirty(t, false);
  if (t.id === activeId) {
    refresh(text);
    updatePath();
  }
  renderTabs();
  if (closeAfterSave.has(reqId)) {
    closeAfterSave.delete(reqId);
    closeTab(t.id, true); // Replaced with the external version; carry on with the original close
  }
});
bridge.onExternalUpdate(({ path, crlf, text }) => {
  // The active tab changed on disk while unedited (a one-way notice from the shell,
  // unrelated to saving). Check again that the tab still has that path and no edits,
  // in case the user switched tabs or started typing in the meantime.
  const t = tabs.find((x) => x.path === path);
  if (!t || t.dirty) return;
  t.crlf = crlf;
  if (t.id === activeId) {
    ed.setText(text, true); // silent: don't mark dirty
    t.state = ed.getState();
    refresh(text);
  } else {
    t.state = ed.makeState(text, t.path);
  }
  renderTabs();
});
bridge.onFlushSave(() => {
  const t = active();
  if (t) saveTab(t, false);
});
bridge.onMemo(({ status, content }) => renderMemo(status, content));

// Text in index.html that depends on the language.
function applyStaticText() {
  $("lbl-limit").textContent = tr("Limit", "上限");
  $("lbl-unit").textContent = tr("chars", "字");
  $("lbl-ws").textContent = tr("Count spaces", "空白も数える");
  $("lbl-strip").textContent = tr("Ignore markup", "記法を数えない");
  $("empty").textContent = tr(
    "No panes shown (Ctrl+Shift+E: editor   Ctrl+P: preview   Ctrl+M: notes)",
    "表示する欄がありません（Ctrl+Shift+E：エディタ　Ctrl+P：プレビュー　Ctrl+M：メモ広場）",
  );
  renderCursor();
}

// The language was switched: redraw every piece of text, and re-send the states
// behind the check marks of the shell's rebuilt menu.
bridge.onLang((lang) => {
  setLang(lang);
  applyStaticText();
  renderTabs();
  sendTitle();
  updatePath();
  lastRendered = null;
  refresh(ed.getText());
  memoLast = null;
  updateMemoWatch(); // The shell replies with the note (or its "unavailable" text)
  bridge.setPreview(previewOn);
  bridge.setEditor(!active() || active().editorOn);
  bridge.setWrap(ed.wrapOn());
  bridge.setMemoMenu(memoVisible, memoEditable);
});

// Importing docx / zip. The shell sends the bytes as base64; convert them to Markdown
// and open a new tab (no path and unsaved, so Ctrl+S asks where to save).
bridge.onImport(({ path, ext, b64 }) => {
  try {
    const md = readMarkdown(ext, bridge.b64decode(b64));
    const stem = (path || "").split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    // Imports always ignore markup when counting, so tags added by the conversion
    // (<u> etc.) don't count.
    addTab({
      text: md,
      dirty: true,
      title: stem ? stem + ".md" : tr("Imported", "取り込み"),
      settings: { stripMarkdown: true },
    });
  } catch (e) {
    bridge.menuToHost("import-failed\n" + (e && e.message ? e.message : e));
  }
});

// Export as. The shell passes the destination and extension; reply with the bytes in that format.
bridge.onExportRequest(({ path, ext }) => {
  try {
    const t = active();
    const crlf = t ? t.crlf : false;
    const text = ed.getText();
    const e = ext.toLowerCase();
    if (t && isHtmlPath(t.path)) {
      // HTML tab: as-is for HTML, via Markdown for other formats
      const bytes =
        e === ".html" || e === ".htm"
          ? new TextEncoder().encode(crlf ? text.replace(/\n/g, "\r\n") : text)
          : toBytes(ext, htmlToMarkdown(text), crlf);
      bridge.sendExportBytes(path, bytes);
    } else {
      bridge.sendExportBytes(path, toBytes(ext, text, crlf));
    }
  } catch (e) {
    bridge.menuToHost("import-failed\n" + (e && e.message ? e.message : e));
  }
});

// Runs a command from the shell's menu or from the key handler below.
function doCommand(cmd) {
  const m = ed.menu;
  if (cmd.startsWith("pane-move:")) {
    const [name, dir] = cmd.slice("pane-move:".length).split(":");
    movePane(name, Number(dir));
    return;
  }
  if (cmd.startsWith("family:")) {
    m.setFamily(cmd.slice("family:".length));
    ed.focus();
    return;
  }
  if (cmd.startsWith("memo-file\n")) {
    const p = cmd.slice("memo-file\n".length);
    if (active()) active().memoOverride = p;
    memoVisible = true;
    layoutPanes();
    bridge.setMemoMenu(memoVisible, memoEditable);
    memoLast = null;
    updateMemoWatch();
    return;
  }
  if (cmd.startsWith("open-relative\n")) {
    // Relative link in the preview: resolve it against the active tab's folder and pass it to the shell.
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
      // Save first, then close once "saved" comes back.
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
    print: () => {
      // For HTML tabs print the iframe's document (printing the parent only shows the iframe's visible part)
      if (activeIsHtml() && previewOn && htmlFrame && htmlFrame.contentWindow) htmlFrame.contentWindow.print();
      else window.print();
    },
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
    "toggle-editor": () => toggleEditor(),
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

// App shortcuts are caught at window level (capture phase) so they work wherever
// focus is: editor, preview or notes panel. CodeMirror's own keys (undo, select all,
// copy/paste, cursor movement) pass through untouched.
// Match on the physical key (e.code): on some setups Ctrl+M reports e.key as "Enter"
// (CR), so e.key would miss it.
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
  ["c", false, "PageUp", "prev-tab"],
  ["c", false, "PageDown", "next-tab"],
  ["c", false, "KeyP", "toggle-preview"],
  ["c", true, "KeyE", "toggle-editor"],
  ["c", false, "KeyM", "toggle-memo"],
  ["c", false, "KeyF", "find"],
  ["c", false, "KeyH", "replace"],
  ["c", false, "KeyG", "goto-line"],
  ["c", false, "KeyU", "underline"],
  ["c", true, "KeyU", "underline-double"],
  ["c", false, "KeyE", "esc"],
  ["c", false, "Equal", "zoom-in"],
  ["c", false, "Semicolon", "zoom-in"], // Ctrl+; is where + sits on a JIS keyboard
  ["c", false, "Minus", "zoom-out"],
  ["c", false, "Digit0", "zoom-reset"],
  ["n", false, "F3", "find-next"],
  ["n", true, "F3", "find-prev"],
];
function onAppKeydown(e) {
  if (e.altKey || e.metaKey) return;
  // Don't intercept keys while an IME is composing (Enter/Space/arrows confirm or pick
  // candidates). KEYMAP always uses Ctrl (except F3), so there should be no overlap,
  // but let them through to be safe.
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
}
window.addEventListener("keydown", onAppKeydown, true);

// Ctrl+wheel zooms.
function onAppWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  doCommand(e.deltaY < 0 ? "zoom-in" : "zoom-out");
}
window.addEventListener("wheel", onAppWheel, { capture: true, passive: false });

// --- Toolbar (edits the active tab's settings) --------------------------------
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

attachMiddleDragPan(previewEl); // Middle-button drag scrolling in the preview too
attachMiddleDragPan(memoEl);

// --- Context menu for the editor ----------------------------------------------
const ctxMenu = document.createElement("div");
ctxMenu.id = "ctxmenu";
ctxMenu.hidden = true;
document.body.appendChild(ctxMenu);
const ctxItems = () => [
  [tr("Undo", "元に戻す"), "undo"],
  [tr("Redo", "やり直し"), "redo"],
  ["-"],
  [tr("Cut", "切り取り"), "cut"],
  [tr("Copy", "コピー"), "copy"],
  [tr("Paste", "貼り付け"), "paste"],
  ["-"],
  [tr("Underline", "下線"), "underline"],
  [tr("Double underline", "下線（二重）"), "underline-double"],
  [tr("Underline selection", "選択範囲に一括で下線"), "bulk-underline"],
  [tr("Escape (exclude from the count)", "エスケープ（文字数から除外）"), "esc"],
  [tr("Select all", "すべて選択"), "select-all"],
];
function hideCtx() {
  ctxMenu.hidden = true;
}
ed.view.dom.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  ctxMenu.textContent = "";
  for (const [label, cmd] of ctxItems()) {
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

// --- Pane order and widths ----------------------------------------------------
// The editor, preview and notes panel are three equal panes, each shown or hidden
// on its own.
//  - Order is the order they were shown (paneOrder[0] is leftmost). A hidden pane
//    leaves the order and rejoins at the right end. View > Pane order reorders them.
//  - Widths are remembered per combination of visible panes (paneRatios). The key is
//    the sorted pane names joined with "+", the value maps pane name -> share. Shares
//    are per pane, so reordering keeps each pane's width. Saved in the session.
//  - With every pane hidden the area is blank apart from a hint. Nothing is brought
//    back automatically.
const PANE_NAMES = ["editor", "preview", "memo"];
const PANES = { editor: $("editor"), preview: previewEl, memo: memoEl };
const gutters = [$("gutter1"), $("gutter2")];
const emptyEl = $("empty");
const MIN_PANE = 140; // editor_app.py MIN_PANE
let paneOrder = ["editor", "preview"];
let paneRatios = {}; // { "editor+preview": { editor: 0.5, preview: 0.5 }, ... }
let paneFr = []; // Shares of the visible panes (same order as paneOrder, summing to 1)

function paneVisible(name) {
  if (name === "editor") {
    const t = active();
    return !t || t.editorOn;
  }
  return name === "preview" ? previewOn : memoVisible;
}

function paneKey() {
  return [...paneOrder].sort().join("+");
}

function layoutPanes() {
  paneOrder = paneOrder.filter(paneVisible);
  for (const name of PANE_NAMES) {
    if (paneVisible(name) && !paneOrder.includes(name)) paneOrder.push(name);
  }
  const n = paneOrder.length;
  const saved = paneRatios[paneKey()] || {};
  const fr = paneOrder.map((p) => (saved[p] > 0 ? saved[p] : 1 / n));
  const sum = fr.reduce((a, b) => a + b, 0);
  paneFr = fr.map((f) => f / sum);
  for (const name of PANE_NAMES) {
    const el = PANES[name];
    const i = paneOrder.indexOf(name);
    el.classList.toggle("hidden", i < 0);
    if (i >= 0) {
      el.style.order = String(2 * i);
      el.style.flex = `${paneFr[i] * 1000} 1 0`; // Zero basis; the grow factor carries the share
    }
  }
  gutters.forEach((g, i) => {
    g.classList.toggle("hidden", n < i + 2);
    g.style.order = String(2 * i + 1);
  });
  emptyEl.classList.toggle("hidden", n > 0);
  pushSession();
}

function movePane(name, dir) {
  const i = paneOrder.indexOf(name);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= paneOrder.length) return;
  [paneOrder[i], paneOrder[j]] = [paneOrder[j], paneOrder[i]];
  layoutPanes();
}

// Dragging the border between two adjacent panes moves the split between them; their combined width stays the same.
gutters.forEach((g, gi) => {
  g.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const a = PANES[paneOrder[gi]];
    const b = PANES[paneOrder[gi + 1]];
    if (!a || !b) return;
    const left = a.getBoundingClientRect().left;
    const span = b.getBoundingClientRect().right - left - g.offsetWidth; // Combined width of the two panes
    const pair = paneFr[gi] + paneFr[gi + 1];
    splitEl.classList.add("dragging");
    const onMove = (ev) => {
      // If the button is already up but we missed the mouseup, end here
      if (ev.buttons === 0) {
        onUp();
        return;
      }
      const min = span >= MIN_PANE * 2 ? MIN_PANE : 0;
      const wa = Math.max(min, Math.min(span - min, ev.clientX - left - g.offsetWidth / 2));
      paneFr[gi] = (pair * wa) / span;
      paneFr[gi + 1] = pair - paneFr[gi];
      a.style.flex = `${paneFr[gi] * 1000} 1 0`;
      b.style.flex = `${paneFr[gi + 1] * 1000} 1 0`;
    };
    const onUp = () => {
      splitEl.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      paneRatios[paneKey()] = Object.fromEntries(paneOrder.map((p, i) => [p, paneFr[i]]));
      pushSession();
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  });
});

// --- Editor -> preview scroll sync --------------------------------------------
// Bring the preview element for the editor's top visible line to the top of the
// preview. Expanding <esc>/<ublock>/<qblock> can shift lines a little, so it is
// approximate.
let syncRaf = 0;
function syncPreviewToEditor() {
  syncRaf = 0;
  if (!previewOn) return;
  if (active() && !active().editorOn) return; // Editor pane is hidden; nothing to follow
  const sv = ed.view.scrollDOM;
  if (activeIsHtml()) {
    // HTML has no line markers, so match by scroll ratio
    try {
      const w = htmlFrame && htmlFrame.contentWindow;
      const d = htmlFrame && htmlFrame.contentDocument;
      if (!w || !d || !d.documentElement) return;
      const ratio = sv.scrollTop / Math.max(1, sv.scrollHeight - sv.clientHeight);
      w.scrollTo(0, Math.max(0, ratio * (d.documentElement.scrollHeight - w.innerHeight)));
    } catch {}
    return;
  }
  const rect = sv.getBoundingClientRect();
  let topLine = 1;
  try {
    const pos = ed.view.posAtCoords({ x: rect.left + 6, y: rect.top + 4 }, false);
    topLine = ed.view.state.doc.lineAt(pos).number; // 1-based
  } catch {
    return;
  }
  const want = topLine - 1; // markdown-it is 0-based
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

// --- Startup ------------------------------------------------------------------
applyStaticText();
if (!bridge.inShell) {
  addTab({ text: tr(SAMPLE_EN, SAMPLE_JA) });
}
// Inside the shell, bridge.onLoad creates the first tab.

// --- Shell self-test (only when CROCO_SELFTEST=1) -------------------------------
if (bridge.inShell && location.search.indexOf("selftest") >= 0) {
  bridge.diag("selftest: script loaded");
  window.addEventListener("error", (e) => bridge.diag("selftest: window error " + e.message));
  // Imports (.docx etc.) arrive via import, not load, so watch that too.
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
        // 1) Append text and save (only for a tab with a path; an untitled one would block on the dialog)
        ed.setText(ed.getText() + "\n\nSELFTEST-OK\n", false);
        if (active().path) saveTab(active(), false);
        bridge.diag("selftest: save requested (tabs=" + tabs.length + " path=" + !!active().path + ")");
        // 2) Open a second tab -> tag command -> switch back and forth -> close
        setTimeout(() => {
          const before = tabs.length;
          addTab({ path: null, crlf: false, text: "SECOND-TAB-TEXT" });
          const id2 = activeId;
          ed.menu.underline(); // No selection -> empty <u></u> at the caret
          const hasU = ed.getText().indexOf("<u>") >= 0;
          cycleTab(-1);
          const backToFirst = !!(active().path && active().path.indexOf("ta.md") >= 0);
          const firstTextKept = ed.getText().indexOf("SELFTEST-OK") >= 0;
          switchTab(id2);
          const secondTextKept = ed.getText().indexOf("SECOND-TAB-TEXT") >= 0;
          tabs.find((t) => t.id === id2).dirty = false; // Skip the confirmation dialog (test)
          closeTab(id2, true);
          bridge.diag(
            "selftest: tabs " + before + "->" + tabs.length +
            " underline=" + hasU + " cycleBack=" + backToFirst +
            " firstKept=" + firstTextKept + " secondKept=" + secondTextKept +
            " afterClose=" + tabs.length,
          );
          // 3) Check that showing and hiding the notes panel actually works
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
