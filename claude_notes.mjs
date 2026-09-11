// 下書き（.md 等）と「メモ広場」ノートを対応づける小さな CLI。
//
//   node claude_notes.mjs path  <下書きのパス>     対応するノートのパスを出す
//   node claude_notes.mjs read  <下書きのパス>     ノートを読む（無ければ空）
//   node claude_notes.mjs write <下書きのパス>     標準入力の内容をノートに書く
//
// エディタ（croco-editor.exe）と、下書きを手伝う側（Claude Code など、この
// ファイルを直接呼ぶ）は別プロセスで共有 DB を持たない。それでも同じ下書きに
// 同じノートを指せるよう、「下書きの絶対パスから決まったやり方でノートのパスを
// 計算する」だけで対応づける。ハッシュ計算は host.cs の NotePathFor と一致。
//
// ノートの置き場所は %APPDATA%\croco-editor\claude_notes（環境変数
// CROCO_NOTE_DIR で上書き可）。ファイル名は下書きパスの sha1 先頭16桁。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function noteDir() {
  return (
    process.env.CROCO_NOTE_DIR ||
    join(process.env.APPDATA || process.env.HOME || ".", "croco-editor", "claude_notes")
  );
}

// host.cs NotePathFor と同じ：絶対パス → posix 表記 → 小文字 → sha1 先頭16桁 + .md
export function notePathFor(draftPath) {
  const key = resolve(draftPath).replace(/\\/g, "/").toLowerCase();
  const digest = createHash("sha1").update(key, "utf8").digest("hex").slice(0, 16);
  return join(noteDir(), digest + ".md");
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const [action, draft] = process.argv.slice(2);
if (!draft || !["path", "read", "write"].includes(action)) {
  process.stderr.write(
    "usage: node claude_notes.mjs path|read|write <下書きのパス>\n",
  );
  process.exit(2);
}
const note = notePathFor(draft);
if (action === "path") {
  process.stdout.write(note + "\n");
} else if (action === "read") {
  try {
    process.stdout.write(readFileSync(note, "utf8"));
  } catch {
    /* まだ書かれていなければ空 */
  }
} else {
  mkdirSync(dirname(note), { recursive: true });
  writeFileSync(note, readStdin(), "utf8");
  process.stdout.write(note + "\n");
}
