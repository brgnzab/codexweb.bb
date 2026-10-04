const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`CWC Personal packaged smoke supports Windows x64 only; received ${process.platform}/${process.arch}`);
}

const launcherRoot = path.resolve(__dirname, "..");
const artifactsDirectory = path.join(launcherRoot, "artifacts");
const launcherManifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const expectedVersion = launcherManifest.version;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-portable-smoke-"));
const extractionRoot = path.join(scratch, "extracted");
const markerPath = path.join(scratch, "ready.json");
const DEFAULT_COMMAND_TIMEOUT_MS = 45_000;
const COLD_RUNTIME_SMOKE_TIMEOUT_MS = 360_000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || scratch,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `status ${result.status}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return result;
}

function artifact(pattern, label) {
  const matches = fs.readdirSync(artifactsDirectory).filter(name => pattern.test(name)).sort();
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label} in ${artifactsDirectory}; found ${matches.join(", ") || "none"}`);
  return path.join(artifactsDirectory, matches[0]);
}

try {
  const portableZip = artifact(/-portable\.zip$/i, "portable Windows ZIP");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  fs.mkdirSync(extractionRoot, { recursive: true });
  const expandScript = path.join(scratch, "expand.ps1");
  fs.writeFileSync(expandScript, [
    "param([string]$Source, [string]$Destination)",
    "$ErrorActionPreference = 'Stop'",
    "Expand-Archive -LiteralPath $Source -DestinationPath $Destination -Force",
    "",
  ].join("\r\n"), "utf8");
  run(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", expandScript, portableZip, extractionRoot,
  ], { timeout: 240_000 });

  const roots = fs.readdirSync(extractionRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
  if (roots.length !== 1) throw new Error(`Portable archive must contain exactly one root folder; found ${roots.map(entry => entry.name).join(", ") || "none"}`);
  const portableRoot = path.join(extractionRoot, roots[0].name);
  const portableMarkerPath = path.join(portableRoot, "cwc-portable.json");
  const portableMarker = JSON.parse(fs.readFileSync(portableMarkerPath, "utf8"));
  if (portableMarker.schemaVersion !== 1 || portableMarker.mode !== "portable" || portableMarker.appVersion !== expectedVersion || portableMarker.dataDirectory !== "data") {
    throw new Error(`Unexpected portable marker: ${JSON.stringify(portableMarker)}`);
  }
  const dataRoot = path.join(portableRoot, "data");
  if (fs.existsSync(dataRoot)) throw new Error("Portable artifact must not ship prior user/session state");

  const appExe = path.join(portableRoot, `${launcherManifest.build.productName}.exe`);
  if (!fs.existsSync(appExe)) throw new Error(`Portable launcher executable is missing: ${appExe}`);

  const env = { ...process.env, CODEX_WEB_GPT_SMOKE_FILE: markerPath };
  delete env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR;
  delete env.CODEX_CHATGPT_WEB_HOME;
  delete env.CODEX_HOME;
  run(appExe, ["--launcher-smoke-test"], { cwd: portableRoot, env, timeout: COLD_RUNTIME_SMOKE_TIMEOUT_MS });

  if (!fs.existsSync(markerPath)) throw new Error("Portable launcher did not write its readiness marker");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (marker.ok !== true || marker.packaged !== true || marker.runtimeVerified !== true || marker.version !== expectedVersion || marker.platform !== "win32") {
    throw new Error(`Unexpected portable launcher marker: ${JSON.stringify(marker)}`);
  }

  const launcherData = path.join(dataRoot, "launcher");
  const coreHome = path.join(dataRoot, "core");
  if (!fs.existsSync(launcherData) || !fs.statSync(launcherData).isDirectory()) {
    throw new Error(`Portable launcher data directory was not created beside the app: ${launcherData}`);
  }
  const installedRuntime = path.join(coreHome, "versions", `${expectedVersion}-win32-x64`);
  const installedManifest = JSON.parse(fs.readFileSync(path.join(installedRuntime, "manifest.json"), "utf8"));
  if (installedManifest.appVersion !== expectedVersion || installedManifest.platform !== "win32" || installedManifest.arch !== "x64" || !/^[a-f0-9]{64}$/.test(installedManifest.bundleId)) {
    throw new Error(`Portable launcher installed the wrong local runtime: ${JSON.stringify(installedManifest)}`);
  }

  process.stdout.write("PORTABLE_LAUNCHER_SMOKE_OK win32/x64\n");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
