const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const {
  prepareFreshBuild,
  readBuildMarker,
  resolveBuildId,
} = require("../electron/fresh-state.cjs");
const { deriveCouncilCapabilities } = require("../electron/council-capabilities.cjs");

function stateStore(initial = {}) {
  let state = {
    onboardingComplete: true,
    keepRunningOnClose: true,
    showBrowserDuringTurns: true,
    mcpRuntimeInstalled: true,
    mcpSetupComplete: true,
    browserSmokePassed: true,
    browserSmokeVersion: "old",
    mcpGuideStep: 2,
    ...initial,
  };
  return {
    read: () => structuredClone(state),
    update: (patch) => {
      state = { ...state, ...patch };
      return structuredClone(state);
    },
  };
}

test("a changed build starts with clean CWC work/runtime state while preserving packaged runtime versions and launcher preferences", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-clean-build-"));
  try {
    const coreHome = path.join(base, "core");
    const markerPath = path.join(base, "launcher", "cwc-build.json");
    fs.mkdirSync(path.join(coreHome, "council"), { recursive: true });
    fs.mkdirSync(path.join(coreHome, "runtime"), { recursive: true });
    fs.mkdirSync(path.join(coreHome, "versions", "4.1.0-win32-x64"), { recursive: true });
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(path.join(coreHome, "config.json"), "stale");
    fs.writeFileSync(path.join(coreHome, "council", "project-relays.json"), "old relay history");
    fs.writeFileSync(path.join(coreHome, "runtime", "launcher-supervisor.json"), "old runtime");
    fs.writeFileSync(path.join(coreHome, "versions", "4.1.0-win32-x64", "keep.txt"), "runtime bundle");
    const store = stateStore();

    const first = prepareFreshBuild({ markerPath, buildId: "source:1111111111111111111111111111111111111111", coreHome, stateStore: store });
    assert.equal(first.reset, true);
    assert.equal(fs.existsSync(path.join(coreHome, "config.json")), false);
    assert.equal(fs.existsSync(path.join(coreHome, "council", "project-relays.json")), false);
    assert.equal(fs.existsSync(path.join(coreHome, "runtime", "launcher-supervisor.json")), false);
    assert.equal(fs.readFileSync(path.join(coreHome, "versions", "4.1.0-win32-x64", "keep.txt"), "utf8"), "runtime bundle");
    assert.equal(store.read().onboardingComplete, true);
    assert.equal(store.read().keepRunningOnClose, true);
    assert.equal(store.read().mcpRuntimeInstalled, false);
    assert.equal(store.read().mcpSetupComplete, false);
    assert.equal(store.read().browserSmokePassed, false);
    assert.equal(readBuildMarker(markerPath).buildId, "source:1111111111111111111111111111111111111111");

    fs.mkdirSync(path.join(coreHome, "council"), { recursive: true });
    fs.writeFileSync(path.join(coreHome, "council", "project-relays.json"), "current build history");
    const second = prepareFreshBuild({ markerPath, buildId: "source:1111111111111111111111111111111111111111", coreHome, stateStore: store });
    assert.equal(second.reset, false);
    assert.equal(fs.existsSync(path.join(coreHome, "council", "project-relays.json")), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("source build identity follows the checked-out HEAD supplied by the dev launcher", () => {
  const app = { isPackaged: false, getVersion: () => "4.1.0" };
  assert.equal(
    resolveBuildId({ app, resourcesPath: "", env: { CWC_BUILD_ID: "4934276e04735b42941949808d625891f77565a1" } }),
    "source:4934276e04735b42941949808d625891f77565a1",
  );
  const dev = fs.readFileSync(path.join(root, "scripts", "dev.cjs"), "utf8");
  assert.match(dev, /git", \["rev-parse", "HEAD"\]/);
  assert.match(dev, /CWC_BUILD_ID: sourceBuildId/);
});

test("browser-only startup keeps Tunnel and full MCP optional while the Council runtime is live", () => {
  const capabilities = deriveCouncilCapabilities({ configured: true, mode: "browser-only", runtimeLive: true });
  assert.equal(capabilities.wakeEngine.available, true);
  assert.equal(capabilities.wakeEngine.state, "ready");
  assert.equal(capabilities.secureTunnel.available, false);
  assert.equal(capabilities.secureTunnel.state, "idle");
  assert.equal(capabilities.fullMcp.available, false);
  assert.equal(capabilities.fullMcp.state, "idle");
});

test("normal startup probes ChatGPT and starts the local Council runtime before showing the renderer", () => {
  const entry = fs.readFileSync(path.join(root, "electron", "main-council.cjs"), "utf8");
  const startIndex = entry.indexOf("async function start()");
  const endIndex = entry.indexOf("\nvoid start().catch", startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex);
  const startSource = entry.slice(startIndex, endIndex);
  const ready = startSource.indexOf("await browserHost.ready()");
  const cache = startSource.indexOf("if (freshBuild) await browserHost.clearCachePreservingSession()");
  const authProbe = startSource.indexOf("await browserHost.refreshAuthentication()");
  const bootstrap = startSource.indexOf("await bootstrapCouncilRuntime({ stateStore, logger })");
  const supervisor = startSource.indexOf("councilConnectionSupervisor.start()");
  const renderer = startSource.lastIndexOf("await loadRenderer(mainWindow)");
  assert.ok(ready >= 0 && cache > ready && authProbe > cache && bootstrap > authProbe && supervisor > bootstrap && renderer > supervisor);
  assert.match(entry, /prepareFreshBuild/);
  assert.match(entry, /launcher:council-runtime-start/);
  assert.match(entry, /launcher:clear-cache/);
  assert.match(entry, /Stop active relay work and reconcile any submitted delivery before clearing CWC cache/);
});

test("Clear cache preserves the ChatGPT login store and exposes all usability controls in-app", () => {
  const browser = fs.readFileSync(path.join(root, "electron", "council-browser-host.cjs"), "utf8");
  assert.match(browser, /clearCachePreservingSession/);
  assert.match(browser, /session\.clearCache\(\)/);
  const method = browser.slice(browser.indexOf("async clearCachePreservingSession"), browser.indexOf("async dispose", browser.indexOf("async clearCachePreservingSession")));
  assert.doesNotMatch(method, /clearStorageData|cookies\.remove|logout/);

  const app = fs.readFileSync(path.join(root, "src", "CouncilApp.tsx"), "utf8");
  assert.match(app, />Clear cache<\/button>/);
  assert.match(app, /keeps your ChatGPT sign-in/);
  assert.match(app, /api\.clearCache\(\)/);
  assert.match(app, /Start \/ repair local runtime/);
  assert.match(app, /api\.startCouncilRuntime\(\)/);
  assert.match(app, /Council runtime, Playwright and the ChatGPT session start with CWC/);

  const connectionModel = fs.readFileSync(path.join(root, "src", "councilConnectionModel.ts"), "utf8");
  assert.match(connectionModel, /capability\.state === "idle"[\s\S]*?detail: "Off"/);
  assert.match(connectionModel, /connectorObservation === "verified"[\s\S]*?detail: "Off"/);
});

test("the sidebar remains reachable without maximizing the desktop window", () => {
  const main = fs.readFileSync(path.join(root, "src", "main.tsx"), "utf8");
  const usability = fs.readFileSync(path.join(root, "src", "cwc-usability.css"), "utf8");
  assert.match(main, /import "\.\/cwc-usability\.css"/);
  assert.match(usability, /\.council-sidebar[\s\S]*overflow-y:\s*auto/);
});
