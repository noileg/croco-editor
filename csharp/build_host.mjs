// C# 殻を Windows 同梱の csc.exe でビルドする（.NET SDK 不要）。
//   node csharp/build_host.mjs
// 出力は csharp/out/（croco-editor.exe ＋ WebView2 の DLL 3個 ＋ dist/）。
//
// フロント（dist/bundle.js）はリポジトリにコミットしてあるので、clone 直後に
// npm install 無しでもこのスクリプトは通る（システムの csc だけあればよい）。
// node_modules があるときはフロントもバンドルし直してから複製する。
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const vendor = join(here, "vendor");
const repo = join(here, "..");
const dist = join(repo, "dist");

// node_modules があればフロントを最新化。無ければコミット済みの dist/ を使う。
if (existsSync(join(repo, "node_modules"))) {
  execFileSync(process.execPath, [join(repo, "build.mjs")], { stdio: "inherit" });
} else {
  console.log("node_modules 無し → コミット済みの dist/ をそのまま使う");
}

const csc = [
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
].find(existsSync);
if (!csc) {
  console.error("csc.exe が見つからない（C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\）");
  process.exit(1);
}
if (!existsSync(join(dist, "index.html")) || !existsSync(join(dist, "bundle.js"))) {
  console.error("dist/ が無い。npm install 後に `node build.mjs` を実行すること");
  process.exit(1);
}

// out/ は消さずに上書き（croco-editor.exe 実行中でも csc の /out 以外は通る）。
mkdirSync(out, { recursive: true });

const icon = join(here, "editor.ico");
const args = [
  "/nologo",
  "/target:winexe",
  "/langversion:5",
  ...(existsSync(icon) ? [`/win32icon:${icon}`] : []),
  `/out:${join(out, "croco-editor.exe")}`,
  `/reference:${join(vendor, "Microsoft.Web.WebView2.Core.dll")}`,
  `/reference:${join(vendor, "Microsoft.Web.WebView2.WinForms.dll")}`,
  "/reference:System.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Windows.Forms.dll",
  join(here, "host.cs"),
];

try {
  const o = execFileSync(csc, args, { encoding: "utf-8" });
  process.stdout.write(o);
} catch (e) {
  process.stdout.write(e.stdout || "");
  process.stderr.write(e.stderr || String(e));
  process.exit(1);
}

for (const dll of [
  "Microsoft.Web.WebView2.Core.dll",
  "Microsoft.Web.WebView2.WinForms.dll",
  "WebView2Loader.dll",
]) {
  cpSync(join(vendor, dll), join(out, dll));
}
if (existsSync(icon)) cpSync(icon, join(out, "editor.ico"));
cpSync(dist, join(out, "dist"), { recursive: true });

console.log("csharp/out/croco-editor.exe をビルドしました");
