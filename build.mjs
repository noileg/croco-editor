// webview 側のフロントを1ファイルにバンドルする。esbuild。
//   node build.mjs
// 出力は dist/（bundle.js ＋ index.html ＋ style.css）。C# 殻はこの dist/ を
// WebView2 に読ませる。dist/ はコミットする（ツールチェーンが将来使えなくても
// 動かせるように）。
import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [join(here, "src/main.js")],
  bundle: true,
  format: "iife",
  outfile: join(dist, "bundle.js"),
  sourcemap: true,
  minify: true, // 起動時のパース時間短縮（2026-09-11、未minifyで1.4MBあった）
  target: ["chrome110"], // WebView2（Edge/Chromium）向け
  logLevel: "info",
});

cpSync(join(here, "src/index.html"), join(dist, "index.html"));
cpSync(join(here, "src/style.css"), join(dist, "style.css"));
console.log("dist/ に出力しました");
