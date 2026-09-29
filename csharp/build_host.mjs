// Builds the C# shell with the csc.exe that ships with Windows (no .NET SDK needed).
//   node csharp/build_host.mjs
// Output goes to csharp/out/ (croco-editor.exe + the 3 WebView2 DLLs + dist/).
//
// The front end (dist/bundle.js) is committed, so right after a clone this script works
// without npm install (only the system csc is needed). If node_modules exists, the
// front end is rebundled first.
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const vendor = join(here, "vendor");
const repo = join(here, "..");
const dist = join(repo, "dist");

// Rebuild the front end if node_modules exists; otherwise use the committed dist/.
if (existsSync(join(repo, "node_modules"))) {
  execFileSync(process.execPath, [join(repo, "build.mjs")], { stdio: "inherit" });
} else {
  console.log("no node_modules: using the committed dist/ as is");
}

const csc = [
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
].find(existsSync);
if (!csc) {
  console.error("csc.exe not found (C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\)");
  process.exit(1);
}
if (!existsSync(join(dist, "index.html")) || !existsSync(join(dist, "bundle.js"))) {
  console.error("dist/ is missing. Run `node build.mjs` after npm install");
  process.exit(1);
}

// Overwrite out/ instead of deleting it (so only csc's /out fails while croco-editor.exe is running).
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

console.log("built csharp/out/croco-editor.exe");
