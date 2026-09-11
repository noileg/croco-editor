// C# 殻（WebView2 ホスト）とのやりとり。素の文字列プロトコル（JSON 依存なし）。
// フィールド区切りは "\n"。本文は必ず最後の1フィールドに置き、そこだけ改行を含む。
//
//   殻 → JS :
//     load\n<パス>\n<crlf>\n<本文>        起動時の最初のタブ（パス空 = 新規）
//     opened\n<パス>\n<crlf>\n<本文>      「開く」で読み込んだファイル → 新しいタブ
//     saved\n<reqId>\n<パス>              保存完了（パスは最終的な保存先）
//     conflict\n<reqId>\n<パス>           保留を選んだ（外部でも変更あり。この
//                                          タブの自動保存を止める。以後の保存で再度選択肢）
//     reloaded\n<reqId>\n<crlf>\n<本文>   外部の内容を読み込む」を選んだ。
//                                          このタブを書かずに差し替える
//     flushSave                            閉じる前に本文つき save を返せ
//     menu\n<cmd>                          メニュー項目が押された
//   JS → 殻 :
//     open                                「開く」ダイアログを出して読んで
//     save\n<reqId>\n<crlf>\n<パス>\n<本文>
//       上書き保存（パス空 → ダイアログ）。外部変更を検知したら、自動保存
//       （idle timer）・明示保存（Ctrl+S 等）を問わずその場で MessageBox を出し
//       上書き／外部を読み込む／保留 を選ばせる（VS Code の比較/上書き相当）
//     saveas\n<reqId>\n<crlf>\n<パス>\n<本文>
//       名前を付けて保存（必ずダイアログ）
//     title\n<名前>\n<0|1>                ウィンドウタイトル（名前, 未保存か）
//     wrap\n<0|1> / preview\n<0|1>        メニューのチェックを合わせる
//     host\n<cmd>                          殻の機能を呼ぶ（new-window 等）
//     dirty\n<0|1> / diag\n<文字列>       互換・デバッグ用

const wv = typeof window !== "undefined" && window.chrome && window.chrome.webview;
export const inShell = !!wv;

const handlers = {
  load: [],
  opened: [],
  saved: [],
  conflict: [],
  reloaded: [],
  flushSave: [],
  menu: [],
  restore: [],
  memo: [],
  import: [],
  exportRequest: [],
};

// バイト列 ⇄ base64（殻とのバイナリ受け渡し用）。
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

// 先頭 n-1 個を "\n" で割り、残り全部（改行込み）を最後の要素にする。
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
    }
  });
}

export const onLoad = (cb) => handlers.load.push(cb);
export const onOpened = (cb) => handlers.opened.push(cb);
export const onSaved = (cb) => handlers.saved.push(cb);
export const onConflict = (cb) => handlers.conflict.push(cb);
export const onReloaded = (cb) => handlers.reloaded.push(cb);
export const onFlushSave = (cb) => handlers.flushSave.push(cb);
export const onMenu = (cb) => handlers.menu.push(cb);
export const onRestore = (cb) => handlers.restore.push(cb);
export const onMemo = (cb) => handlers.memo.push(cb);
export const onImport = (cb) => handlers.import.push(cb);
export const onExportRequest = (cb) => handlers.exportRequest.push(cb);
export function sendExportBytes(path, u8) {
  if (wv) wv.postMessage("export-bytes\n" + path + "\n" + b64encode(u8));
}

// メモ広場：見張る対象と表示状態を殻に伝える／編集内容を書き戻す。
export function memoWatch(draftPath, overridePath, visible, editable) {
  if (wv) {
    wv.postMessage(
      "memo-watch\n" + (draftPath || "") + "\n" + (overridePath || "") +
        "\n" + (visible ? "1" : "0") + "\n" + (editable ? "1" : "0"),
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

// セッション状態（開いているタブの一覧など）を殻に預ける。殻はこれを
// session.dat に書き、次回起動時に restore で返す。
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
export function setPreview(on) {
  if (wv) wv.postMessage("preview\n" + (on ? "1" : "0"));
}
export function menuToHost(cmd) {
  if (wv) wv.postMessage("host\n" + cmd);
}
// 未保存タブを閉じる確認（殻の MessageBox。現行の はい/いいえ/キャンセル）。
export function askCloseTab(id, name) {
  if (wv) wv.postMessage("host\nask-close\n" + id + "\n" + name);
}
export function diag(s) {
  if (wv) wv.postMessage("diag\n" + s);
}
