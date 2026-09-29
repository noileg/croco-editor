// A small CLI that maps a draft (.md etc.) to its notes-panel note.
//
//   node claude_notes.mjs path  <draft path>     Print the path of the matching note
//   node claude_notes.mjs read  <draft path>     Print the note (empty if none)
//   node claude_notes.mjs write <draft path>     Write stdin to the note
//
// The editor (croco-editor.exe) and whatever helps with the draft (Claude Code etc.,
// which calls this file directly) are separate processes with no shared database.
// They still land on the same note for the same draft because the note path is
// computed from the draft's full path in a fixed way. The hash matches NotePathFor
// in host.cs.
//
// Notes live in %APPDATA%\croco-editor\claude_notes (override with the CROCO_NOTE_DIR
// environment variable). The file name is the first 16 hex digits of the draft path's SHA-1.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function noteDir() {
  return (
    process.env.CROCO_NOTE_DIR ||
    join(process.env.APPDATA || process.env.HOME || ".", "croco-editor", "claude_notes")
  );
}

// Same as NotePathFor in host.cs: full path -> forward slashes -> lowercase -> first 16 hex digits of SHA-1 + .md
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
    "usage: node claude_notes.mjs path|read|write <draft path>\n",
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
    /* not written yet: empty */
  }
} else {
  mkdirSync(dirname(note), { recursive: true });
  writeFileSync(note, readStdin(), "utf8");
  process.stdout.write(note + "\n");
}
