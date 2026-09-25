const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const hardened = fs.readFileSync(path.join(launcherRoot, "electron", "main-hardened.cjs"), "utf8");
const main = fs.readFileSync(path.join(launcherRoot, "electron", "main-council.cjs"), "utf8");
const browser = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");

test("production Electron main installs popup hardening before Council startup", () => {
  assert.equal(manifest.main, "electron/main-hardened.cjs");
  assert.match(hardened, /require\("\.\/browser-host\.cjs"\)/);
  assert.match(hardened, /BrowserHost\.prototype\.bindWebContents/);
  assert.match(hardened, /BrowserHost\.prototype\.createAuthView/);
  assert.match(hardened, /require\("\.\/main-council\.cjs"\)/);
  assert.ok(
    hardened.indexOf("BrowserHost.prototype.bindWebContents") < hardened.indexOf('require("./main-council.cjs")'),
    "popup hardening must be installed before Council starts",
  );
});

test("managed home popup requests are denied even when authentication is allowed", () => {
  const override = hardened.slice(hardened.indexOf("BrowserHost.prototype.bindWebContents"), hardened.indexOf("BrowserHost.prototype.createAuthView"));
  assert.match(override, /if \(allowedAuthUrl\(url\)\)/);
  assert.match(override, /this\.createAuthView\(\{\}, url\)/);
  assert.match(override, /return \{ action: "deny" \}/);
  assert.doesNotMatch(override, /action:\s*"allow"|createWindow/);
});

test("authentication uses a fresh sandboxed owned surface, never popup-owned WebContents", () => {
  const auth = hardened.slice(hardened.indexOf("BrowserHost.prototype.createAuthView"));
  assert.match(auth, /new WebContentsView\(\{[\s\S]*?webPreferences:/);
  assert.match(auth, /partition:\s*CHATGPT_PARTITION/);
  assert.match(auth, /contextIsolation:\s*true/);
  assert.match(auth, /nodeIntegration:\s*false/);
  assert.match(auth, /sandbox:\s*true/);
  assert.doesNotMatch(auth, /options\.webContents|webContents:\s*_options/);
  assert.match(auth, /contents\.setWindowOpenHandler\([\s\S]*?return \{ action: "deny" \}/);
  assert.match(auth, /will-navigate/);
  assert.match(auth, /will-redirect/);
  assert.match(auth, /allowedAuthUrl\(url\)/);
});

test("turn surfaces and local renderer remain sandboxed with child windows denied", () => {
  assert.match(browser, /bindTurnContents\(tab\)[\s\S]*?setWindowOpenHandler[\s\S]*?return \{ action: "deny" \};/);
  assert.match(browser, /contextIsolation:\s*true/);
  assert.match(browser, /nodeIntegration:\s*false/);
  assert.match(browser, /sandbox:\s*true/);

  assert.match(main, /webPreferences:\s*\{[\s\S]*?contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /webContents\.setWindowOpenHandler\([\s\S]*?return \{ action: "deny" \}/);
});
