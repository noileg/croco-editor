// Bundles the webview front end into one file with esbuild.
//   node build.mjs
// Output goes to dist/ (bundle.js + index.html + style.css), which the C# shell loads
// into WebView2. dist/ is committed so the app can be built even if the JS toolchain
// becomes unavailable later.
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
  minify: true, // Faster parsing at startup
  target: ["chrome110"], // WebView2 (Edge/Chromium)
  logLevel: "info",
});

cpSync(join(here, "src/index.html"), join(dist, "index.html"));
cpSync(join(here, "src/style.css"), join(dist, "style.css"));
console.log("wrote dist/");
