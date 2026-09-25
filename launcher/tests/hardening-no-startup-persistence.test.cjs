const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

test("Council has no OS startup registration implementation", () => {
  const persistence = read(launcherRoot, "electron", "autostart.cjs");
  assert.doesNotMatch(persistence, /setLoginItemSettings|getLoginItemSettings|XDG_CONFIG_HOME|X-GNOME-Autostart|openAtLogin|openAsHidden|writePrivateFileAtomic/);
  const { getAutostart, setAutostart } = require("../electron/autostart.cjs");
  assert.deepEqual(getAutostart({}), { supported: false, enabled: false });
  assert.throws(() => setAutostart({}, true), /Launch CodexWeb Council manually/);
  assert.deepEqual(setAutostart({}, false), { supported: false, enabled: false });
});

test("launcher state cannot re-enable startup persistence", () => {
  const { createStateStore } = require("../electron/state.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-no-autostart-"));
  const statePath = path.join(root, "state.json");
  try {
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, autoStart: true }));
    const store = createStateStore(statePath);
    assert.equal(store.read().autoStart, false);
    assert.equal(store.update({ autoStart: true }).autoStart, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("current Council main has no direct OS startup persistence calls", () => {
  const main = read(launcherRoot, "electron", "main-council.cjs");
  assert.doesNotMatch(main, /setLoginItemSettings|getLoginItemSettings|XDG_CONFIG_HOME|X-GNOME-Autostart/);
});
