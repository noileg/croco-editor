// Messaging with the C# shell (the WebView2 host). A plain string protocol (no JSON).
// Fields are separated by "\n". The text body is always the last field and is the
// only one that may contain newlines.
//
//   shell -> JS:
//     load\n<path>\n<crlf>\n<text>        First tab at startup (empty path = new)
//     opened\n<path>\n<crlf>\n<text>      A file opened with Open -> new tab
//     saved\n<reqId>\n<path>              Save finished (path = final location)
//     conflict\n<reqId>\n<path>           "Leave it for now" was chosen (changed
//                                          externally too). Stop autosaving this tab;
//                                          the next save asks again
//     reloaded\n<reqId>\n<crlf>\n<text>   "Load the external version" was chosen.
//                                          Replace this tab's text without writing
//     externalUpdate\n<path>\n<crlf>\n<text>
//       The shell's 1-second poll (watching the memo-watch draft path) saw the
//       active, unedited tab's file change on disk. A one-way notice unrelated to
//       saving: replace the tab's text if it is still unedited. (Separate from the
//       conflict check that runs before saving.)
//     flushSave                            Send back a save with the text before closing
//     menu\n<cmd>                          A menu item was chosen
//     lang\n<en|ja>                        The UI language was switched
//   JS -> shell:
//     open                                Show the Open dialog and read the file
//     save\n<reqId>\n<crlf>\n<path>\n<text>
//       Save (empty path -> dialog). If the file changed externally, whether this
//       is an autosave or an explicit save, a MessageBox asks: overwrite / load the
//       external version / leave it for now
//     saveas\n<reqId>\n<crlf>\n<path>\n<text>
//       Save as (always shows the dialog)
//     title\n<name>\n<0|1>                Window title (name, unsaved?)
//     wrap\n<0|1> / preview\n<0|1> / editor\n<0|1>  Sync the menu check marks
//     host\n<cmd>                          Run a shell command (new-window etc.)
//     docbase\n<folder>                    Where the HTML preview resolves relative paths (doc.local)
//     dirty\n<0|1> / diag\n<text>          Compatibility / debugging

const wv = typeof window !== "undefined" && window.chrome && window.chrome.webview;
export const inShell = !!wv;

const handlers = {
  load: [],
  opened: [],
  saved: [],
  conflict: [],
  reloaded: [],
  externalUpdate: [],
  flushSave: [],
  menu: [],
  restore: [],
  memo: [],
  import: [],
  exportRequest: [],
  lang: [],
};

// Bytes <-> base64 (for passing binary data to and from the shell).
export function b64encode(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
export function b64decode(str) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Split on "\n" into n-1 fields plus the rest (newlines included) as the last.
function splitN(s, n) {
  const parts = [];
  let rest = s;
  for (let i = 0; i < n - 1; i++) {
    const k = rest.indexOf("\n");
    if (k < 0) {
      parts.push(rest);
      rest = "";
    } else {
      parts.push(rest.slice(0, k));
      rest = rest.slice(k + 1);
    }
  }
  parts.push(rest);
  return parts;
}

if (wv) {
  wv.addEventListener("message", (e) => {
    const raw = typeof e.data === "string" ? e.data : "";
    const nl = raw.indexOf("\n");
    const head = nl < 0 ? raw : raw.slice(0, nl);
    const body = nl < 0 ? "" : raw.slice(nl + 1);
    if (head === "load" || head === "opened") {
      const [path, crlf, text] = splitN(body, 3);
      const payload = { path: path || null, crlf: crlf === "1", text };
      handlers[head].forEach((cb) => cb(payload));
    } else if (head === "saved") {
      const [reqId, path] = splitN(body, 2);
      handlers.saved.forEach((cb) => cb({ reqId: Number(reqId), path: path || null }));
    } else if (head === "conflict") {
      const [reqId, path] = splitN(body, 2);
      handlers.conflict.forEach((cb) => cb({ reqId: Number(reqId), path: path || null }));
    } else if (head === "reloaded") {
      const [reqId, crlf, text] = splitN(body, 3);
      handlers.reloaded.forEach((cb) => cb({ reqId: Number(reqId), crlf: crlf === "1", text }));
    } else if (head === "externalUpdate") {
      const [path, crlf, text] = splitN(body, 3);
      handlers.externalUpdate.forEach((cb) => cb({ path, crlf: crlf === "1", text }));
    } else if (head === "flushSave") {
      handlers.flushSave.forEach((cb) => cb());
    } else if (head === "menu") {
      handlers.menu.forEach((cb) => cb(body.trim()));
    } else if (head === "restore") {
      let obj = null;
      try {
        obj = JSON.parse(body);
      } catch (e) {
        obj = null;
      }
      if (obj) handlers.restore.forEach((cb) => cb(obj));
    } else if (head === "memo") {
      const [status, content] = splitN(body, 2);
      handlers.memo.forEach((cb) => cb({ status, content }));
    } else if (head === "import") {
      const [path, ext, b64] = splitN(body, 3);
      handlers.import.forEach((cb) => cb({ path, ext, b64 }));
    } else if (head === "export-request") {
      const [path, ext] = splitN(body, 2);
      handlers.exportRequest.forEach((cb) => cb({ path, ext }));
    } else if (head === "lang") {
      handlers.lang.forEach((cb) => cb(body.trim()));
    }
  });
}

export const onLoad = (cb) => handlers.load.push(cb);
export const onOpened = (cb) => handlers.opened.push(cb);
export const onSaved = (cb) => handlers.saved.push(cb);
export const onConflict = (cb) => handlers.conflict.push(cb);
export const onReloaded = (cb) => handlers.reloaded.push(cb);
export const onExternalUpdate = (cb) => handlers.externalUpdate.push(cb);
export const onFlushSave = (cb) => handlers.flushSave.push(cb);
export const onMenu = (cb) => handlers.menu.push(cb);
export const onRestore = (cb) => handlers.restore.push(cb);
export const onMemo = (cb) => handlers.memo.push(cb);
export const onImport = (cb) => handlers.import.push(cb);
export const onExportRequest = (cb) => handlers.exportRequest.push(cb);
export const onLang = (cb) => handlers.lang.push(cb);
export function sendExportBytes(path, u8) {
  if (wv) wv.postMessage("export-bytes\n" + path + "\n" + b64encode(u8));
}

// Notes panel: tell the shell what to watch and whether it is shown; write edits back.
// The dirty flag goes along too: when the active tab's draft changes on disk and the
// tab is unedited, the shell reloads it silently and replies with externalUpdate.
export function memoWatch(draftPath, overridePath, visible, editable, dirty) {
  if (wv) {
    wv.postMessage(
      "memo-watch\n" + (draftPath || "") + "\n" + (overridePath || "") +
        "\n" + (visible ? "1" : "0") + "\n" + (editable ? "1" : "0") +
        "\n" + (dirty ? "1" : "0"),
    );
  }
}
export function memoSave(content) {
  if (wv) wv.postMessage("memo-save\n" + content);
}
export function setMemoMenu(visible, editable) {
  if (wv) {
    wv.postMessage("memowrap\n" + (visible ? "1" : "0"));
    wv.postMessage("memoedit\n" + (editable ? "1" : "0"));
  }
}

// Hand the session state (open tabs etc.) to the shell. It writes it to
// session.dat and returns it with restore at the next launch.
export function setSession(obj) {
  if (wv) wv.postMessage("session\n" + JSON.stringify(obj));
}

export function requestOpen() {
  if (wv) wv.postMessage("open");
}
export function save(reqId, crlf, path, text, asNew = false) {
  if (wv) {
    wv.postMessage(
      (asNew ? "saveas\n" : "save\n") + reqId + "\n" + (crlf ? "1" : "0") + "\n" + path + "\n" + text,
    );
  }
}
export function setTitle(name, dirty) {
  if (wv) wv.postMessage("title\n" + name + "\n" + (dirty ? "1" : "0"));
}
export function setWrap(on) {
  if (wv) wv.postMessage("wrap\n" + (on ? "1" : "0"));
}
export function setAnyDirty(on) {
  if (wv) wv.postMessage("anydirty\n" + (on ? "1" : "0"));
}
export function setEditor(on) {
  if (wv) wv.postMessage("editor\n" + (on ? "1" : "0"));
}
export function setPreview(on) {
  if (wv) wv.postMessage("preview\n" + (on ? "1" : "0"));
}
// Ask the shell to point its virtual host doc.local at the HTML file's folder, so
// the HTML preview can load relative images and CSS (empty removes the mapping).
export function setDocBase(folder) {
  if (wv) wv.postMessage("docbase\n" + (folder || ""));
}
export function menuToHost(cmd) {
  if (wv) wv.postMessage("host\n" + cmd);
}
// Confirm closing an unsaved tab (a Yes/No/Cancel MessageBox in the shell).
export function askCloseTab(id, name) {
  if (wv) wv.postMessage("host\nask-close\n" + id + "\n" + name);
}
export function diag(s) {
  if (wv) wv.postMessage("diag\n" + s);
}
