process.env.CODEXWEB_COUNCIL_PRODUCT = "1";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { ensurePackagedRuntime } = require("./runtime-install.cjs");
const { runtimeInvocation } = require("./runtime-command.cjs");
const { resolveCwcPaths } = require("./portable-paths.cjs");
const { parkedTurnBoundsForWindow } = require("./browser-host.cjs");

const SOURCE_ROOT = path.resolve(__dirname, "../..");
const resolvedPaths = resolveCwcPaths({
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  launcherDataOverride: process.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR,
  coreHomeOverride: process.env.CODEX_CHATGPT_WEB_HOME,
  defaultLauncherData: app.getPath("userData"),
  defaultCoreHome: path.join(os.homedir(), ".codex-chatgpt-web"),
});
fs.mkdirSync(resolvedPaths.launcherData, { recursive: true, mode: 0o700 });
app.setPath("userData", resolvedPaths.launcherData);
if (resolvedPaths.portableRoot) {
  const logs = path.join(resolvedPaths.launcherData, "logs");
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  app.setAppLogsPath(logs);
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

async function verifyBackgroundTurnViewport() {
  let smokeWindow;
  let turnView;
  try {
    smokeWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: true,
      frame: false,
      skipTaskbar: true,
      backgroundColor: "#181818",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    await smokeWindow.loadURL("data:text/html,<html><body>cwc-smoke</body></html>");

    const [contentWidth, contentHeight] = smokeWindow.getContentSize();
    const target = {
      x: 0,
      y: 0,
      width: Math.max(1, contentWidth),
      height: Math.max(1, contentHeight),
    };

    turnView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    smokeWindow.contentView.addChildView(turnView);
    const parked = parkedTurnBoundsForWindow(contentWidth, target);
    turnView.setBounds(parked);
    turnView.setVisible(true);
    await turnView.webContents.loadURL("data:text/html,<html><body>cwc-turn-smoke</body></html>");

    const viewport = await turnView.webContents.executeJavaScript(
      "({ width: window.innerWidth, height: window.innerHeight })",
      true,
    );
    const minimumWidth = Math.max(320, Math.floor(target.width * 0.8));
    const minimumHeight = Math.max(200, Math.floor(target.height * 0.8));
    if (!viewport
      || !Number.isFinite(viewport.width)
      || !Number.isFinite(viewport.height)
      || viewport.width < minimumWidth
      || viewport.height < minimumHeight) {
      throw new Error(
        `Background relay viewport collapsed: ${JSON.stringify({ target, parked, viewport })}`,
      );
    }
    return { target, parked, viewport };
  } finally {
    if (turnView) {
      try { smokeWindow?.contentView.removeChildView(turnView); } catch {}
      try {
        if (!turnView.webContents.isDestroyed()) turnView.webContents.close();
      } catch {}
    }
    try {
      if (smokeWindow && !smokeWindow.isDestroyed()) smokeWindow.destroy();
    } catch {}
  }
}

async function runSmoke() {
  await app.whenReady();
  if (!app.isPackaged) throw new Error("Council package smoke entry requires a packaged Electron application");

  const coreHome = resolvedPaths.coreHome;
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

  // Exercise the actual packaged Electron WebContentsView path used by background GPT relay turns.
  // This catches native process exits and renderer viewport collapse before a portable reaches UAT.
  const backgroundViewport = await verifyBackgroundTurnViewport();

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
    backgroundViewportVerified: true,
    backgroundViewport,
  })}\n`);
  app.exit(0);
}

void runSmoke().catch(error => {
  writeFatal(error);
  app.exit(1);
});
