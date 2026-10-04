const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`CWC Personal packaging supports Windows x64 only; received ${process.platform}/${process.arch}`);
}
const requested = process.argv[2];
if (requested && requested !== "--win") throw new Error(`Unsupported packaging target: ${requested}`);

const launcherManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = launcherManifest.version;
const artifactBase = `cwc-personal-${version}-windows-x64-portable`;
const executable = process.execPath;
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js", { paths: [root] });
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-portable-package-"));
const builderOutput = path.join(staging, "builder");
const portableRoot = path.join(staging, artifactBase);
const artifactsDirectory = path.join(root, "artifacts");
const zipPath = path.join(artifactsDirectory, `${artifactBase}.zip`);
const hashPath = `${zipPath}.sha256`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  run(executable, [
    electronBuilderCli,
    "--win",
    "--x64",
    "--dir",
    "--publish",
    "never",
    `--config.directories.output=${builderOutput}`,
  ]);

  const unpacked = path.join(builderOutput, "win-unpacked");
  if (!fs.existsSync(unpacked) || !fs.statSync(unpacked).isDirectory()) {
    throw new Error(`electron-builder produced no win-unpacked directory in ${builderOutput}`);
  }
  fs.cpSync(unpacked, portableRoot, { recursive: true, force: false, errorOnExist: false });
  fs.rmSync(path.join(portableRoot, "data"), { recursive: true, force: true });

  const productExe = path.join(portableRoot, `${launcherManifest.build.productName}.exe`);
  if (!fs.existsSync(productExe) || !fs.statSync(productExe).isFile()) {
    throw new Error(`Portable launcher executable is missing: ${productExe}`);
  }

  fs.writeFileSync(path.join(portableRoot, "cwc-portable.json"), `${JSON.stringify({
    schemaVersion: 1,
    mode: "portable",
    appVersion: version,
    platform: "win32",
    arch: "x64",
    dataDirectory: "data",
  }, null, 2)}\n`, "utf8");

  fs.mkdirSync(artifactsDirectory, { recursive: true });
  for (const entry of fs.readdirSync(artifactsDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/\.(?:exe|blockmap)$/i.test(entry.name) || /-portable\.zip(?:\.sha256)?$/i.test(entry.name)) {
      fs.rmSync(path.join(artifactsDirectory, entry.name), { force: true });
    }
  }

  const archiveScript = path.join(staging, "archive.ps1");
  fs.writeFileSync(archiveScript, [
    "param([string]$Source, [string]$Destination)",
    "$ErrorActionPreference = 'Stop'",
    "Compress-Archive -LiteralPath $Source -DestinationPath $Destination -CompressionLevel Optimal -Force",
    "",
  ].join("\r\n"), "utf8");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", archiveScript, portableRoot, zipPath]);

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) throw new Error(`Portable ZIP was not created: ${zipPath}`);
  const digest = createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex").toUpperCase();
  fs.writeFileSync(hashPath, `${digest}  ${path.basename(zipPath)}\n`, "utf8");
  process.stdout.write(`PORTABLE_ARTIFACT ${zipPath}\nPORTABLE_SHA256 ${digest}\n`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
