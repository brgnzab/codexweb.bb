const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { resolveCwcPaths } = require("../electron/portable-paths.cjs");

async function executeSmoke(scratch, overrides = {}) {
  const portable = path.join(scratch, "portable");
  fs.mkdirSync(portable);
  fs.writeFileSync(path.join(portable, "cwc-portable.json"), JSON.stringify({
    schemaVersion: 1, mode: "portable", dataDirectory: "data",
  }));
  const legacyProfile = path.join(scratch, "legacy-profile");
  const legacyHome = path.join(scratch, "legacy-home");
  const marker = path.join(scratch, "ready.json");
  let userData = legacyProfile;
  let installedCore;
  let logs;
  const smokeEnv = { CODEX_WEB_GPT_SMOKE_FILE: marker, ...overrides };
  const exited = Promise.withResolvers();
  const app = {
    isPackaged: true,
    getPath: () => userData,
    setPath: (name, value) => { assert.equal(name, "userData"); userData = value; },
    setAppLogsPath: value => { logs = value; },
    whenReady: () => Promise.resolve(),
    getVersion: () => "4.1.0",
    exit: code => exited.resolve(code),
  };
  const modules = {
    "node:fs": fs,
    "node:path": path,
    "node:os": { homedir: () => legacyHome },
    "node:child_process": { spawnSync: () => ({ status: 0, stdout: "4.1.0\n" }) },
    electron: { app },
    "./portable-paths.cjs": { resolveCwcPaths },
    "./runtime-install.cjs": { ensurePackagedRuntime: ({ coreHome }) => {
      assert.equal(smokeEnv.CODEXWEB_COUNCIL_PRODUCT, "1");
      installedCore = coreHome;
      fs.mkdirSync(coreHome, { recursive: true });
      return path.join(coreHome, "versions", "4.1.0-win32-x64");
    } },
    "./runtime-command.cjs": { runtimeInvocation: () => ({ executable: "fixture", args: [], cwd: scratch }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/smoke-main.cjs"), "utf8"), {
    __dirname: path.join(__dirname, "../electron"),
    require: name => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
    process: { execPath: path.join(portable, "Codex Web GPT.exe"), platform: "win32",
      resourcesPath: path.join(portable, "resources"),
      env: smokeEnv, stderr: { write() {} } },
  });
  assert.equal(await exited.promise, 0);
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).runtimeVerified, true);
  assert.equal(fs.existsSync(legacyProfile), false);
  assert.equal(fs.existsSync(legacyHome), false);
  return { portable, userData, installedCore, logs };
}

test("packaged smoke executes with runtime and Electron data beside the portable app", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-smoke-paths-"));
  try {
    const result = await executeSmoke(scratch);
    assert.equal(result.userData, path.join(result.portable, "data", "launcher"));
    assert.equal(result.installedCore, path.join(result.portable, "data", "core"));
    assert.equal(result.logs, path.join(result.userData, "logs"));
    assert.equal(fs.statSync(result.userData).isDirectory(), true);
    assert.equal(fs.statSync(result.installedCore).isDirectory(), true);
  } finally {
    assert.ok(path.resolve(scratch).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("packaged smoke honors explicit D: test profiles without touching legacy locations", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-smoke-overrides-"));
  try {
    const launcherData = path.join(scratch, "chosen-launcher");
    const coreHome = path.join(scratch, "chosen-core");
    const result = await executeSmoke(scratch, {
      CODEX_WEB_GPT_LAUNCHER_DATA_DIR: launcherData, CODEX_CHATGPT_WEB_HOME: coreHome,
    });
    assert.equal(result.userData, launcherData);
    assert.equal(result.installedCore, coreHome);
  } finally {
    assert.ok(path.resolve(scratch).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
