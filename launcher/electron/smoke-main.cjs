const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { app } = require("electron");
const { ensurePackagedRuntime } = require("./runtime-install.cjs");
const { runtimeInvocation } = require("./runtime-command.cjs");

const SOURCE_ROOT = path.resolve(__dirname, "../..");
const configuredUserData = process.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR?.trim();
if (configuredUserData) {
  const launcherData = path.resolve(configuredUserData);
  fs.mkdirSync(launcherData, { recursive: true, mode: 0o700 });
  app.setPath("userData", launcherData);
}

function writeFatal(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  try {
    const logs = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(logs, "launcher-fatal.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {}
  try { process.stderr.write(`${message}\n`); } catch {}
}

async function runSmoke() {
  await app.whenReady();
  if (!app.isPackaged) throw new Error("Council package smoke entry requires a packaged Electron application");

  const coreHome = process.env.CODEX_CHATGPT_WEB_HOME?.trim()
    ? path.resolve(process.env.CODEX_CHATGPT_WEB_HOME.trim())
    : path.join(os.homedir(), ".codex-chatgpt-web");
  const installedRuntimeRoot = ensurePackagedRuntime({
    app,
    coreHome,
    resourcesPath: process.resourcesPath,
  });
  if (!installedRuntimeRoot) throw new Error("Packaged Council smoke test could not install its durable runtime");

  const invocation = runtimeInvocation({
    app,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    args: ["--version"],
  });
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.trim() !== app.getVersion()) {
    throw new Error(`Installed Council runtime is not executable (status=${result.status ?? "unknown"})`);
  }

  const markerPath = process.env.CODEX_WEB_GPT_SMOKE_FILE?.trim();
  if (!markerPath || !path.isAbsolute(markerPath)) {
    throw new Error("Packaged Council smoke test requires an absolute CODEX_WEB_GPT_SMOKE_FILE");
  }
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify({
    ok: true,
    product: "codexweb-council",
    version: app.getVersion(),
    platform: process.platform,
    packaged: true,
    runtimeVerified: true,
  })}\n`);
  app.exit(0);
}

void runSmoke().catch(error => {
  writeFatal(error);
  app.exit(1);
});
