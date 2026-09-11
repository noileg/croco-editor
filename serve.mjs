// dist/ を配る使い捨ての静的サーバ（標準ライブラリのみ）。動作確認用。
//   node serve.mjs [ポート]
// file:// でも開けるが、将来 fetch を足したときのために http で見られるようにする。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "dist");
const port = Number(process.argv[2]) || 5173;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split("?")[0]);
  if (path === "/") path = "/index.html";
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port}/  (Ctrl+C で停止)`);
});
