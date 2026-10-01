process.env.CODEXWEB_COUNCIL_PRODUCT = "1";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
  protocol,
  net: electronNet,
} = require("electron");
const { ensurePrivateDirectory } = require("./private-path.cjs");
const { DebuggerTransport } = require("./debugger-transport.cjs");
const { sha256 } = require("./runtime-integrity.cjs");
const { trustedLauncherSender, installRendererCsp, rendererCsp } = require("./renderer-security.cjs");
protocol.registerSchemesAsPrivileged([{ scheme: "cwc-app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const browserHostModule = require("./browser-host.cjs");
const controlServerModule = require("./control-server.cjs");
const { createCouncilBrowserHostClass } = require("./council-browser-host.cjs");
const { createCouncilBrowserControlServerClass } = require("./council-control-server.cjs");
const { deriveCouncilCapabilities } = require("./council-capabilities.cjs");
const { CouncilConnectionSupervisor } = require("./council-connection-supervisor.cjs");
const {
  autonomyStatus,
  listProjectRelays,
  startProjectRelay,
  cancelProjectRelay,
  bindCurrentConversationAsLead,
  cancelExceptionalWork,
  cancelExecutionRun,
  captureExecutionAgent,
  clearObservations,
  clearProjectMemory,
  deleteObservation,
  focusAgentConversation,
  focusExecutionAgent,
  isRuntimeUnavailable,
  listExceptionalWork,
  listExecutionRuns,
  listObservations,
  memoryRecent,
  memorySearch,
  memoryStats,
  observationStorageStats,
  readExecutionEvents,
  readExecutionReceipts,
  readExecutionRun,
  readObservation,
  readObservationScreenshot,
  retryExecutionRun,
  retryUncertainWork,
  runSupervisorNow,
  setSupervisorManager,
  supervisorStatus,
} = require("./council-owner-client.cjs");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const { createLogger, installProcessDiagnosticGuards, registerLoggedIpc, redactText } = require("./logging.cjs");
const { RuntimeHost, COUNCIL_CONNECTOR_NAME } = require("./runtime.cjs");
const { ensurePackagedRuntime } = require("./runtime-install.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { createStateStore, nextSessionRefreshReminderAt, validateSidebarState } = require("./state.cjs");
const {
  clearCouncilCoreHome,
  prepareFreshBuild,
  readBuildMarker,
  resetRuntimeFlags,
  resolveBuildId,
} = require("./fresh-state.cjs");
const { MIN_WINDOW_BOUNDS, readWindowState, trackWindowState } = require("./window-state.cjs");

const BrowserHost = createCouncilBrowserHostClass(browserHostModule.BrowserHost);
const BrowserControlServer = createCouncilBrowserControlServerClass(controlServerModule.BrowserControlServer);
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const SOURCE_ROOT = path.resolve(__dirname, "../..");
const CORE_HOME = process.env.CODEX_CHATGPT_WEB_HOME?.trim()
  ? path.resolve(process.env.CODEX_CHATGPT_WEB_HOME.trim())
  : path.join(os.homedir(), ".codex-chatgpt-web");
const BROWSER_DESCRIPTOR_PATH = path.join(CORE_HOME, "runtime", "launcher-browser.json");
const BROWSER_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
  : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
const GITHUB_URL = "https://github.com/Nolane-x/codexweb";
const CONNECTORS_URL = "https://chatgpt.com/#settings/Plugins";
const TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";
const KEYS_URL = "https://platform.openai.com/settings/organization/api-keys";
const ALLOWED_EXTERNAL_URLS = new Set([GITHUB_URL, CONNECTORS_URL, TUNNELS_URL, KEYS_URL]);
const PACKAGED_RENDERER_URL = "cwc-app://launcher/index.html";
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");

app.setName("CodexWeb Council");
if (process.platform === "win32") app.setAppUserModelId("dev.codexwebgpt.launcher");
// Keep the Electron browser profile for seamless ChatGPT login continuity. CWC work/runtime state
// is build-scoped separately so a newly downloaded/head build starts clean without logging out.
const configuredUserData = process.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR?.trim();
const launcherUserData = configuredUserData ? path.resolve(configuredUserData) : path.join(app.getPath("appData"), "Codex Web GPT");
ensurePrivateDirectory(launcherUserData, { recursive: true });
ensurePrivateDirectory(CORE_HOME, { recursive: true });
// The trusted build reference lives inside application resources, separate from mutable data.
if (app.isPackaged) ensurePrivateDirectory(path.dirname(app.getAppPath()), { recursive: true });
if (process.platform !== "win32") fs.chmodSync(launcherUserData, 0o700);
app.setPath("userData", launcherUserData);
const BUILD_MARKER_PATH = path.join(launcherUserData, "cwc-build.json");
installProcessDiagnosticGuards({ filePath: path.join(launcherUserData, "logs", "process-stream-errors.log") });

let mainWindow = null;
let browserHost = null;
let browserControl = null;
let runtimeHost = null;
let runtimeSupervisor = null;
let councilConnectionSupervisor = null;
let tray = null;
let lastOperation = null;
let smokePassedThisSession = false;
let quitting = false;
let shutdownInProgress = false;
let exitCommitted = false;
let automationTransport = null;

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, value);
}
function publishOperation(operation) { lastOperation = operation; send("launcher:operation", operation); }
function rendererNavigationAllowed(value) {
  try {
    const target = new URL(value);
    if (isDev) return target.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin;
    target.hash = ""; target.search = "";
    return target.href === PACKAGED_RENDERER_URL;
  } catch { return false; }
}
async function openWebUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Only HTTPS external URLs are allowed");
  await shell.openExternal(url.toString());
}
function windowStateSnapshot(window) { return { fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()), maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()) }; }
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

function createWindow({ logger, stateStore, startHidden }) {
  const isMac = process.platform === "darwin";
  const saved = readWindowState(path.join(app.getPath("userData"), "window-state.json"), screen.getAllDisplays());
  const window = new BrowserWindow({
    width: saved.bounds.width,
    height: saved.bounds.height,
    ...(Number.isFinite(saved.bounds.x) && Number.isFinite(saved.bounds.y) ? { x: saved.bounds.x, y: saved.bounds.y } : {}),
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    title: "CodexWeb Council",
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: isMac ? "#00000000" : "#181818",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    transparent: isMac,
    ...(isMac ? { trafficLightPosition: { x: 16, y: 17 }, vibrancy: "under-window", visualEffectState: "active" } : { titleBarOverlay: { color: "#181818", symbolColor: "#a8a8a8", height: 46 } }),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, v8CacheOptions: "bypassHeatCheckAndEagerCompile" },
  });
  window.setMenuBarVisibility(false);
  const guard = (event, url) => { if (!rendererNavigationAllowed(url)) { event.preventDefault(); logger.warn("launcher.renderer_navigation_blocked", {}); } };
  window.webContents.on("will-navigate", guard);
  window.webContents.on("will-redirect", guard);
  window.webContents.setWindowOpenHandler(({ url }) => { void openWebUrl(url).catch(() => {}); return { action: "deny" }; });
  window.on("close", event => {
    if (quitting) return;
    event.preventDefault();
    if (stateStore.read().keepRunningOnClose && tray) window.hide(); else void requestQuit();
  });
  window.once("ready-to-show", () => {
    if (saved.maximized) window.maximize();
    if (saved.fullscreen) window.setFullScreen(true);
    if (!startHidden) window.show();
  });
  trackWindowState(window, path.join(app.getPath("userData"), "window-state.json"), error => logger.warn("launcher.window_state_write_failed", { message: error instanceof Error ? error.message : String(error) }));
  return window;
}

function createTray(logger) {
  try {
    const image = nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 18, height: 18 });
    tray = new Tray(image);
    tray.setToolTip("CodexWeb Council");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Open CodexWeb Council", click: showMainWindow }, { type: "separator" }, { label: "Quit", click: () => void requestQuit() }]));
    tray.on("click", showMainWindow);
    return true;
  } catch (error) {
    logger.warn("launcher.tray_unavailable", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function loadRenderer(window) {
  if (isDev) await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await window.loadURL(PACKAGED_RENDERER_URL);
}
function validateBounds(value) {
  if (!value || typeof value !== "object") throw new Error("Browser bounds are required");
  for (const key of ["x", "y", "width", "height"]) if (!Number.isFinite(value[key])) throw new Error(`Browser bounds ${key} must be finite`);
  return value;
}
function smokePassedForCurrentVersion(state) { return state.browserSmokePassed === true && state.browserSmokeVersion === app.getVersion(); }
function councilCapabilities(stateStore) {
  const state = stateStore.read();
  const current = runtimeHost?.runtimeConfigSnapshot?.();
  const configured = current?.configured === true || state.mcpRuntimeInstalled === true || state.mcpSetupComplete === true;
  return deriveCouncilCapabilities({ configured, mode: current?.mode, runtimeLive: false });
}
function councilRuntimeSnapshot() {
  return councilConnectionSupervisor?.snapshot() ?? {
    controlPlane: { state: "connecting" },
    projection: { syncState: "idle" },
    managedProject: { state: "unattached", reason: { code: "PROJECT_UNATTACHED", retryable: false } },
    capabilities: deriveCouncilCapabilities({ configured: false, runtimeLive: false }),
  };
}
function safeCouncilId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function applyRuntimeState(stateStore, runtime) {
  let state;
  if (runtime.status === "ready") state = stateStore.update({ mcpRuntimeInstalled: true });
  else if (runtime.status === "not-configured") state = stateStore.update({ mcpRuntimeInstalled: false, mcpSetupComplete: false });
  else return runtime;
  send("launcher:state-changed", state);
  return runtime;
}

async function bootstrapCouncilRuntime({ stateStore, logger, forceLocal = false } = {}) {
  const setup = forceLocal
    ? await runtimeHost.setupCouncilLocal()
    : await runtimeHost.upgradeManagedRuntime();
  if (setup?.updated) logger.info("council.runtime_upgraded", { fromVersion: setup.fromVersion, toVersion: setup.toVersion });
  const runtime = await runtimeSupervisor.startIfConfigured();
  applyRuntimeState(stateStore, runtime);
  if (runtime.status !== "ready" && runtime.status !== "needs-setup") {
    publishOperation({ name: "runtime-start", status: "failed", message: runtime.detail || `Council runtime is ${runtime.status}` });
  }
  return { runtime, stdout: setup?.stdout };
}

async function clearApplicationCache({ stateStore, logger }) {
  const active = runtimeHost?.currentOperation() || browserHost?.currentOperation() || (browserHost?.activeTraceId ? "active ChatGPT turn" : null);
  if (active) throw new Error(`Wait for ${active} to finish before clearing CWC cache`);
  let relaySnapshot = { relays: [] };
  try {
    relaySnapshot = await listProjectRelays();
  } catch (error) {
    if (!isRuntimeUnavailable(error)) throw error;
  }
  const relays = Array.isArray(relaySnapshot?.relays) ? relaySnapshot.relays : [];
  const unsafe = relays.find(relay => relay.state === "running" || relay.turns?.some(turn => turn.state === "claimed" || turn.state === "submitted"));
  if (unsafe) throw new Error("Stop active relay work and reconcile any submitted delivery before clearing CWC cache");

  publishOperation({ name: "clear-cache", status: "running", message: "Clearing local CWC work state and browser cache" });
  await councilConnectionSupervisor?.stop();
  await runtimeSupervisor?.shutdown();
  clearCouncilCoreHome(CORE_HOME);
  const state = resetRuntimeFlags(stateStore);
  send("launcher:state-changed", state);
  await browserHost.clearCachePreservingSession();
  try {
    await bootstrapCouncilRuntime({ stateStore, logger });
  } finally {
    councilConnectionSupervisor?.start();
  }
  await browserHost.refreshAuthentication();
  publishOperation({ name: "clear-cache", status: "completed", message: "CWC cache cleared; ChatGPT sign-in was preserved" });
  return { ok: true };
}

function registerIpc({ logger, stateStore }) {
  const validateSender = event => trustedLauncherSender(event, mainWindow, rendererNavigationAllowed);
  const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, handler, validateSender);
  handle("launcher:snapshot", async () => ({
    state: stateStore.read(), browser: browserHost?.snapshot() ?? null, councilRuntime: councilRuntimeSnapshot(), connectorName: COUNCIL_CONNECTOR_NAME,
    mcpCredentialsConfigured: runtimeHost?.mcpCredentialsConfigured() ?? false, logs: logger.recent(),
    urls: { github: GITHUB_URL, x: GITHUB_URL, connectors: CONNECTORS_URL, tunnels: TUNNELS_URL, keys: KEYS_URL },
    platform: process.platform, packaged: app.isPackaged, version: app.getVersion(),
    smokePassed: smokePassedThisSession || smokePassedForCurrentVersion(stateStore.read()), operation: lastOperation,
    update: { status: "disabled" },
  }));
  handle("launcher:council-runtime-snapshot", () => councilRuntimeSnapshot());
  handle("launcher:set-language", (_event, language) => stateStore.update({ language: language === "zh-CN" ? "zh-CN" : "en" }));
  handle("launcher:open-social", async (_event, target) => { if (target !== "github" && target !== "x") throw new Error("Unknown social target"); await openWebUrl(GITHUB_URL); return stateStore.update(target === "github" ? { githubOpened: true } : { xOpened: true }); });
  handle("launcher:complete-onboarding", (_event, language) => stateStore.update({ language: language === "zh-CN" ? "zh-CN" : "en", onboardingComplete: true, githubOpened: true, xOpened: true }));
  handle("launcher:open-external", async (_event, url) => { if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error("External URL is not allowlisted"); await openWebUrl(url); return true; });
  handle("launcher:browser-bounds", (_event, bounds) => { browserHost.setBounds(validateBounds(bounds)); return true; });
  handle("launcher:browser-surface-active", (_event, active) => browserHost.setSurfaceActive(active === true));
  handle("launcher:browser-show", () => browserHost.reveal());
  handle("launcher:browser-hide", () => { browserHost.hide(); return browserHost.snapshot(); });
  handle("launcher:browser-navigate", (_event, action) => browserHost.navigate(action));
  handle("launcher:browser-zoom", (_event, action) => browserHost.zoom(action));
  handle("launcher:browser-tab-select", (_event, tabId) => browserHost.selectTab(tabId));
  handle("launcher:browser-tab-close", (_event, tabId) => browserHost.closeTab(tabId));
  handle("launcher:browser-login", async () => { const browser = await browserHost.openLogin(); if (browser.authenticated) send("launcher:state-changed", stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() })); return browser; });
  handle("launcher:browser-logout", async () => { const browser = await browserHost.logout(); const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() }); send("launcher:state-changed", state); return { browser, state }; });
  handle("launcher:session-reminder-dismiss", () => { const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() }); send("launcher:state-changed", state); return state; });
  handle("launcher:browser-smoke", async () => { const result = await browserHost.smokeTest(); smokePassedThisSession = true; stateStore.update({ browserSmokePassed: true, browserSmokeVersion: app.getVersion() }); return result; });
  handle("launcher:council-runtime-start", async () => {
    const result = await bootstrapCouncilRuntime({ stateStore, logger, forceLocal: true });
    return { ok: result.runtime.status === "ready", stdout: result.stdout };
  });
  handle("launcher:clear-cache", () => clearApplicationCache({ stateStore, logger }));
  handle("launcher:setup-mcp", async (_event, input = {}) => {
    const replace = input.replace === true;
    let tunnelClientPath = "";
    if (replace) {
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: "Select reviewed OpenAI tunnel-client v0.0.10",
        properties: ["openFile"],
        ...(process.platform === "win32" ? { filters: [{ name: "Tunnel client", extensions: ["exe"] }] } : {}),
      });
      if (selected.canceled || selected.filePaths.length !== 1) throw new Error("Council Tunnel setup requires a reviewed local tunnel-client binary");
      tunnelClientPath = selected.filePaths[0];
    }
    const result = await runtimeHost.setupCouncilMcp({
      tunnelId: typeof input.tunnelId === "string" ? input.tunnelId.trim() : "",
      runtimeKey: typeof input.runtimeKey === "string" ? input.runtimeKey : "",
      tunnelClientPath,
      replace,
    });
    const state = stateStore.update({ mcpRuntimeInstalled: true, mcpSetupComplete: false, mcpGuideStep: 2 }); send("launcher:state-changed", state);
    return { ok: true, stdout: result.stdout };
  });
  handle("launcher:mcp-verify", async () => {
    const report = await runtimeHost.doctor();
    if (!report.ok) { const state = stateStore.update({ mcpSetupComplete: false }); send("launcher:state-changed", state); return report; }
    await browserHost.verifyConnector(COUNCIL_CONNECTOR_NAME);
    const state = stateStore.update({ mcpSetupComplete: true }); send("launcher:state-changed", state); return report;
  });
  handle("launcher:doctor", () => runtimeHost.doctor());
  handle("launcher:cancel-turns", async () => ({ stdout: "Council browser turns are managed by the Agent Manager" }));
  handle("launcher:council-bind-current-lead", async (_event, input = {}) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Council lead binding input is invalid");
    const unexpected = Object.keys(input).filter(key => key !== "projectName");
    if (unexpected.length) throw new Error(`Council lead binding rejects renderer-controlled fields: ${unexpected.join(", ")}`);
    if (browserHost.snapshot().authenticated !== true) throw new Error("Sign in to ChatGPT before binding a Council Lead");
    const conversationUrl = browserHost.currentHomeConversationUrl();
    const projectName = typeof input.projectName === "string" ? input.projectName.trim().slice(0, 160) : "ChatGPT Project";
    return await bindCurrentConversationAsLead({ conversationUrl, projectName: projectName || "ChatGPT Project" });
  });
  handle("launcher:council-agent-focus", (_event, agentId) => focusAgentConversation(safeCouncilId(agentId, "agentId")));
  handle("launcher:council-execution-runs", () => listExecutionRuns());
  handle("launcher:project-relay-list", () => listProjectRelays());
  handle("launcher:project-relay-start", (_event, input) => startProjectRelay(input));
  handle("launcher:project-relay-cancel", (_event, id) => cancelProjectRelay(safeCouncilId(id, "relayId")));
  handle("launcher:council-execution-read", (_event, runId) => readExecutionRun(safeCouncilId(runId, "runId")));
  handle("launcher:council-execution-events", (_event, runId) => readExecutionEvents(safeCouncilId(runId, "runId")));
  handle("launcher:council-execution-receipts", () => readExecutionReceipts());
  handle("launcher:council-execution-cancel", (_event, runId) => cancelExecutionRun(safeCouncilId(runId, "runId")));
  handle("launcher:council-execution-focus", (_event, agentId) => focusExecutionAgent(safeCouncilId(agentId, "agentId")));
  handle("launcher:council-execution-capture", (_event, agentId) => captureExecutionAgent(safeCouncilId(agentId, "agentId")));
  handle("launcher:council-execution-retry", (_event, runId) => retryExecutionRun(safeCouncilId(runId, "runId")));
  handle("launcher:council-supervisor-status", () => supervisorStatus());
  handle("launcher:council-supervisor-manager", (_event, agentId) => {
    if (agentId !== null && agentId !== undefined && (typeof agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agentId))) throw new Error("Council manager agent id is invalid");
    return setSupervisorManager(typeof agentId === "string" ? agentId : null);
  });
  handle("launcher:council-supervisor-run", () => runSupervisorNow());
  handle("launcher:council-observations-list", () => listObservations());
  handle("launcher:council-observation-storage", () => observationStorageStats());
  handle("launcher:council-observation-read", (_event, runId) => readObservation(safeCouncilId(runId, "runId")));
  handle("launcher:council-observation-screenshot", (_event, runId, screenshotId) => readObservationScreenshot(safeCouncilId(runId, "runId"), screenshotId));
  handle("launcher:council-observation-delete", (_event, runId) => deleteObservation(safeCouncilId(runId, "runId")));
  handle("launcher:council-observations-clear", () => clearObservations());
  handle("launcher:council-autonomy-status", () => autonomyStatus());
  handle("launcher:council-autonomy-exceptional", () => listExceptionalWork());
  handle("launcher:council-autonomy-cancel", (_event, workItemId) => cancelExceptionalWork(safeCouncilId(workItemId, "workItemId")));
  handle("launcher:council-autonomy-retry-uncertain", (_event, workItemId) => retryUncertainWork(safeCouncilId(workItemId, "workItemId")));
  handle("launcher:council-memory-stats", (_event, roomId) => memoryStats(roomId === null || roomId === undefined ? null : safeCouncilId(roomId, "roomId")));
  handle("launcher:council-memory-search", (_event, roomId, query, limit) => memorySearch(safeCouncilId(roomId, "roomId"), query, limit));
  handle("launcher:council-memory-recent", (_event, roomId, limit) => memoryRecent(safeCouncilId(roomId, "roomId"), limit));
  handle("launcher:council-memory-clear-project", (_event, roomId) => clearProjectMemory(safeCouncilId(roomId, "roomId")));
  handle("launcher:set-mcp-step", (_event, step) => { if (!Number.isInteger(step) || step < 0 || step > 2) throw new Error("Invalid MCP guide step"); return stateStore.update({ mcpGuideStep: step }); });
  handle("launcher:autostart", (_event, enabled) => { const desired = enabled === true; const autostart = setAutostart(app, desired); return { state: stateStore.update({ autoStart: desired }), ...autostart }; });
  handle("launcher:set-preference", (_event, key, value) => { if (key !== "keepRunningOnClose" && key !== "showBrowserDuringTurns") throw new Error("Unknown preference"); return stateStore.update({ [key]: value === true }); });
  handle("launcher:sidebar-state", (_event, value) => stateStore.update(validateSidebarState(value)));
  handle("launcher:logs", (_event, limit) => logger.recent(limit));
  handle("launcher:open-logs", async () => { const error = await shell.openPath(path.dirname(logger.filePath)); if (error) throw new Error(error); return logger.filePath; });
  handle("launcher:window-state", event => windowStateSnapshot(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.on("launcher:window-control", (event, action) => { if (!validateSender(event)) return; const window = BrowserWindow.fromWebContents(event.sender); if (!window || window.isDestroyed()) return; if (action === "close") window.close(); else if (action === "minimize") window.minimize(); else if (action === "zoom") window.isMaximized() ? window.unmaximize() : window.maximize(); });
}

async function requestQuit() {
  if (shutdownInProgress || exitCommitted) return { ok: false, message: "Council shutdown is already in progress" };
  shutdownInProgress = true;
  try {
    const active = runtimeHost?.currentOperation() || browserHost?.currentOperation();
    if (active) throw new Error(`Wait for ${active} to finish before quitting CodexWeb Council`);
    await councilConnectionSupervisor?.stop();
    await runtimeSupervisor?.shutdown();
    quitting = true;
    await browserHost?.persistSession();
    browserHost?.destroy();
    await automationTransport?.close();
    await browserControl?.close();
    exitCommitted = true;
    app.quit();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); quitting = false; showMainWindow(); publishOperation({ name: "launcher-quit", status: "failed", message }); return { ok: false, message };
  } finally { shutdownInProgress = false; }
}

async function start() {
  if (process.platform === "linux") app.commandLine.appendSwitch("class", "codexweb-council");
  if (app.commandLine.hasSwitch("remote-debugging-port") || app.commandLine.hasSwitch("remote-debugging-pipe")) {
    throw new Error("Unrestricted Chromium debugging must not be enabled");
  }
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", showMainWindow);
  await app.whenReady();
  if (!isDev) {
    const rendererRoot = path.resolve(__dirname, "..", "dist");
    protocol.handle("cwc-app", async request => {
      const url = new URL(request.url);
      const file = path.resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);
      if (url.host !== "launcher" || !file.startsWith(rendererRoot + path.sep)) return new Response(null, { status: 403 });
      const response = await electronNet.fetch(pathToFileURL(file).href);
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", rendererCsp());
      headers.set("X-Frame-Options", "DENY");
      return new Response(response.body, { status: response.status, headers });
    });
  }

  let installedRuntimeRoot = null;
  let runtimeRootResolved = false;
  const runtimeRootProvider = () => {
    if (app.isPackaged || !runtimeRootResolved) {
      installedRuntimeRoot = ensurePackagedRuntime({ app, coreHome: CORE_HOME, resourcesPath: process.resourcesPath });
      runtimeRootResolved = true;
    }
    return installedRuntimeRoot;
  };
  const stateStore = createStateStore(path.join(app.getPath("userData"), "launcher-state.json"));
  if (stateStore.read().sessionRefreshReminderAt === null) stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
  const autostart = getAutostart(app); if (autostart.supported && stateStore.read().autoStart !== autostart.enabled) setAutostart(app, stateStore.read().autoStart);
  const logger = createLogger({ filePath: path.join(app.getPath("logs"), "launcher.jsonl"), publish: record => send("launcher:log", record) });
  const startHidden = process.argv.includes("--hidden") && stateStore.read().onboardingComplete;
  nativeTheme.themeSource = "system";
  mainWindow = createWindow({ logger, stateStore, startHidden });
  if (isDev) installRendererCsp(mainWindow.webContents.session, process.env.VITE_DEV_SERVER_URL, process.env.VITE_DEV_SERVER_URL);
  automationTransport = await new DebuggerTransport({ getBrowserHost: () => browserHost }).start();
  browserControl = await new BrowserControlServer({ logger, getBrowserHost: () => browserHost, getPreferences: () => stateStore.read() }).start();
  runtimeSupervisor = new RuntimeSupervisor({ app, logger, sourceRoot: SOURCE_ROOT, installedRuntimeRoot, runtimeRootProvider, coreHome: CORE_HOME, browserDescriptorPath: BROWSER_DESCRIPTOR_PATH, publishOperation });
  runtimeHost = new RuntimeHost({ app, logger, sourceRoot: SOURCE_ROOT, installedRuntimeRoot, runtimeRootProvider, browserDescriptorPath: BROWSER_DESCRIPTOR_PATH, publishOperation, supervisor: runtimeSupervisor });

  const buildId = resolveBuildId({ app, resourcesPath: process.resourcesPath });
  const previousBuild = readBuildMarker(BUILD_MARKER_PATH);
  const freshBuild = previousBuild?.buildId !== buildId;
  if (freshBuild) {
    try { await runtimeSupervisor.shutdown(); } catch (error) { logger.warn("council.fresh_build_shutdown_failed", { message: error instanceof Error ? error.message : String(error) }); }
    const prepared = prepareFreshBuild({ markerPath: BUILD_MARKER_PATH, buildId, coreHome: CORE_HOME, stateStore });
    if (prepared.reset) logger.info("council.fresh_build_state_reset", { previousBuildId: prepared.previousBuildId, buildId });
  }

  councilConnectionSupervisor = new CouncilConnectionSupervisor({ logger, capabilities: () => councilCapabilities(stateStore), publish: state => send("launcher:council-runtime", state) });
  if (app.isPackaged) runtimeRootProvider();
  browserHost = new BrowserHost({ window: mainWindow, descriptorPath: BROWSER_DESCRIPTOR_PATH, automation: automationTransport.descriptor(), control: browserControl.descriptor(), getConnectorName: () => COUNCIL_CONNECTOR_NAME, helper: { executable: process.execPath, script: BROWSER_HELPER_PATH, executableHash: sha256(fs.readFileSync(process.execPath)), scriptHash: sha256(fs.readFileSync(BROWSER_HELPER_PATH)) }, logger, publishState: state => send("launcher:browser-state", state) });
  await browserHost.ready();
  if (freshBuild) await browserHost.clearCachePreservingSession();
  await browserHost.refreshAuthentication().catch(error => logger.warn("browser.session_refresh_failed", { message: error instanceof Error ? error.message : String(error) }));
  registerIpc({ logger, stateStore });

  const smoke = process.argv.includes("--launcher-smoke-test");
  if (smoke) {
    await loadRenderer(mainWindow);
    const smokeRuntimeRoot = runtimeRootProvider();
    if (app.isPackaged && !smokeRuntimeRoot) throw new Error("Packaged Council smoke test could not install its durable runtime");
    const invocation = runtimeSupervisor.runtimeCommand(["--version"]);
    const result = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.stdout.trim() !== app.getVersion()) throw new Error(`Installed Council runtime is not executable (status=${result.status ?? "unknown"})`);
    const markerPath = process.env.CODEX_WEB_GPT_SMOKE_FILE?.trim();
    if (!markerPath || !path.isAbsolute(markerPath)) throw new Error("Packaged Council smoke test requires an absolute CODEX_WEB_GPT_SMOKE_FILE");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({ ok: true, product: "codexweb-council", version: app.getVersion(), platform: process.platform, packaged: app.isPackaged, runtimeVerified: true })}\n`);
    browserHost.destroy(); await browserControl.close(); mainWindow.destroy(); app.quit(); return;
  }

  try {
    await bootstrapCouncilRuntime({ stateStore, logger });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("council.runtime_start_failed", { message });
    publishOperation({ name: "runtime-start", status: "failed", message });
  }
  councilConnectionSupervisor.start();
  const trayAvailable = createTray(logger); if (startHidden && !trayAvailable) mainWindow.once("ready-to-show", showMainWindow);
  await loadRenderer(mainWindow);

  app.on("activate", showMainWindow);
  app.on("before-quit", event => { if (exitCommitted) return; event.preventDefault(); void requestQuit(); });
  process.once("SIGINT", () => void requestQuit());
  process.once("SIGTERM", () => void requestQuit());
}

void start().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  try { fs.appendFileSync(path.join(app.getPath("logs"), "launcher-fatal.log"), `${new Date().toISOString()} ${redactText(String(error?.stack || error))}\n`); } catch {}
  try { dialog.showErrorBox("CodexWeb Council could not start", message); } catch {}
  app.exit(1);
});
