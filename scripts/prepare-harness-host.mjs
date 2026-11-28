// Build the Harness Host (packages/host, ADR 0001) and Windows Child Session
// helpers (src-tauri/win-child-desktop) into src-tauri/resources/harness/.
// `--bundle-only` stops after bundling the JS host, which
// `node <bundle> --data-dir <dir> --port 47100 --page-origin http://localhost:1420`
// runs for browser-only development.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { syncBundledPluginAssets } from "./generate-plugin-types.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostDir = join(repoRoot, "packages", "host");
const bundleDir = join(repoRoot, "node_modules", ".cache", "qianji-harness-host");
const bundleFile = join(bundleDir, "host.mjs");
const outputDir = join(repoRoot, "src-tauri", "resources", "harness");
const executable = join(outputDir, "qianji-harness.exe");
const winDesktopExe = join(outputDir, "qianji-win-desktop.exe");
const enableChildSessionsExe = join(outputDir, "qianji-enable-child-sessions.exe");
const manifestFile = join(outputDir, "build-manifest.json");
const bunExecutable = join(repoRoot, "node_modules", "bun", "bin", "bun.exe");
const winChildDir = join(repoRoot, "src-tauri", "win-child-desktop");
const appIcon = join(repoRoot, "src-tauri", "icons", "icon.ico");
const bundleOnly = process.argv.includes("--bundle-only");
const appVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

function toFourPartVersion(rawVersion) {
  const core = String(rawVersion).split("-")[0] ?? "0.0.0";
  const parts = core.split(".").map((n) => {
    const parsed = Number.parseInt(n, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  });
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join(".");
}

function locateCscCompiler() {
  const winDir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    join(winDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(winDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Could not find .NET Framework 4.x C# compiler (csc.exe) under ${winDir}\\Microsoft.NET`);
  }
  return found;
}

function compileCSharpWinExe(csc, { outExe, manifestPath, references, sources, title, fourPartVersion }) {
  const stagingExe = `${outExe}.staging.exe`;
  const tempAsmInfo = join(tmpdir(), `qianji-asm-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.cs`);
  const asmSource = [
    "using System.Reflection;",
    `[assembly: AssemblyTitle(${JSON.stringify(title)})]`,
    `[assembly: AssemblyProduct("Qianji")]`,
    `[assembly: AssemblyVersion(${JSON.stringify(fourPartVersion)})]`,
    `[assembly: AssemblyFileVersion(${JSON.stringify(fourPartVersion)})]`,
    "",
  ].join("\r\n");
  writeFileSync(tempAsmInfo, asmSource, "utf8");
  rmSync(stagingExe, { force: true });
  try {
    const args = [
      "/nologo",
      "/target:winexe",
      "/optimize+",
      "/platform:anycpu",
      "/debug-",
      `/out:${stagingExe}`,
      `/win32manifest:${manifestPath}`,
      ...(existsSync(appIcon) ? [`/win32icon:${appIcon}`] : []),
      ...references.map((ref) => `/r:${ref}`),
      ...sources,
      tempAsmInfo,
    ];
    const res = spawnSync(csc, args, {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`csc.exe failed for ${title} with exit code ${res.status}`);
    }
    rmSync(outExe, { force: true });
    renameSync(stagingExe, outExe);
  } finally {
    rmSync(tempAsmInfo, { force: true });
    rmSync(stagingExe, { force: true });
  }
}

await build({
  entryPoints: [join(hostDir, "src", "bin.ts")],
  outfile: bundleFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  tsconfig: join(hostDir, "tsconfig.build.json"),
  define: { QIANJI_HOST_VERSION: JSON.stringify(appVersion) },
  // ws loads these optional accelerators inside try/catch.
  external: ["bufferutil", "utf-8-validate"],
  // CommonJS dependencies bundled into ESM still call require() for Node built-ins.
  banner: { js: "import { createRequire as __qianjiCreateRequire } from 'node:module'; const require = __qianjiCreateRequire(import.meta.url);" },
  legalComments: "eof",
  logLevel: "warning",
});
console.log(`Bundled Harness Host: ${bundleFile}`);
syncBundledPluginAssets(repoRoot);
if (bundleOnly) process.exit(0);

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Qianji currently builds a Windows x64 Harness Host, not ${process.platform}/${process.arch}`);
}
if (!existsSync(bunExecutable)) throw new Error(`Bun compiler is missing: ${bunExecutable}`);

const bunVersion = JSON.parse(readFileSync(join(repoRoot, "node_modules", "bun", "package.json"), "utf8")).version;
const harnessKey = createHash("sha256").update(readFileSync(bundleFile)).update(bunVersion).digest("hex");

const winChildFiles = readdirSync(winChildDir)
  .filter((name) => name.endsWith(".cs") || name.endsWith(".manifest"))
  .sort();
const winChildHasher = createHash("sha256").update(appVersion);
for (const fileName of winChildFiles) {
  winChildHasher.update(fileName).update(readFileSync(join(winChildDir, fileName)));
}
if (existsSync(appIcon)) winChildHasher.update(readFileSync(appIcon));
const winChildKey = winChildHasher.digest("hex");
const buildKey = createHash("sha256").update(`${harnessKey}:${winChildKey}`).digest("hex");

let cachedManifest = null;
if (existsSync(manifestFile)) {
  try {
    cachedManifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    cachedManifest = null;
  }
}

const harnessCached = existsSync(executable) && cachedManifest?.harnessKey === harnessKey;
const winChildCached =
  existsSync(winDesktopExe) &&
  existsSync(enableChildSessionsExe) &&
  cachedManifest?.winChildKey === winChildKey;

if (harnessCached && winChildCached && cachedManifest?.buildKey === buildKey) {
  console.log("Harness Host and Windows Child Session helpers are ready (cached).");
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });

if (!harnessCached) {
  // Bun appends `.exe` to an outfile without it, so the staging name keeps the extension.
  const staging = join(outputDir, "qianji-harness.staging.exe");
  rmSync(staging, { force: true });
  const result = spawnSync(bunExecutable, ["build", "--compile", bundleFile, "--outfile", staging], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bun build --compile exited with ${result.status}`);
  rmSync(executable, { force: true });
  rmSync(join(outputDir, "pid-harness.exe"), { force: true });
  renameSync(staging, executable);
  console.log(`Prepared Harness Host: ${executable}`);
}

if (!winChildCached) {
  const csc = locateCscCompiler();
  const fourPartVersion = toFourPartVersion(appVersion);

  compileCSharpWinExe(csc, {
    outExe: enableChildSessionsExe,
    manifestPath: join(winChildDir, "setup.manifest"),
    references: ["System.dll", "System.Windows.Forms.dll"],
    sources: [join(winChildDir, "QianjiEnableChildSessions.cs")],
    title: "Qianji Isolated Windows Desktop Setup",
    fourPartVersion,
  });
  console.log(`Prepared Child Session Setup Helper: ${enableChildSessionsExe}`);

  const desktopSources = winChildFiles
    .filter((name) => name.endsWith(".cs") && name !== "QianjiEnableChildSessions.cs")
    .map((name) => join(winChildDir, name));

  compileCSharpWinExe(csc, {
    outExe: winDesktopExe,
    manifestPath: join(winChildDir, "desktop.manifest"),
    references: [
      "System.dll",
      "System.Core.dll",
      "Microsoft.CSharp.dll",
      "System.Drawing.dll",
      "System.Windows.Forms.dll",
    ],
    sources: desktopSources,
    title: "Qianji Isolated Desktop",
    fourPartVersion,
  });
  console.log(`Prepared Child Session Desktop Viewer & Agent: ${winDesktopExe}`);
}

writeFileSync(
  manifestFile,
  `${JSON.stringify(
    {
      buildKey,
      harnessKey,
      winChildKey,
      compiler: "bun",
      compilerVersion: bunVersion,
    },
    null,
    2,
  )}\n`,
);
