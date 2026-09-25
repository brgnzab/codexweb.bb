const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(launcherRoot, "electron", "main-council.cjs"), "utf8");
const browser = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");

test("local renderer denies child-window creation", () => {
  assert.match(main, /webContents\.setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?return \{ action: "deny" \};[\s\S]*?\}\);/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
});

test("managed ChatGPT surfaces constrain every window-open request", () => {
  const handlers = browser.match(/setWindowOpenHandler/g) || [];
  assert.ok(handlers.length >= 3, "home, turn, and auth surfaces must each install a window-open handler");
  assert.match(browser, /bindTurnContents\(tab\)[\s\S]*?setWindowOpenHandler[\s\S]*?return \{ action: "deny" \};/);
  assert.match(browser, /createAuthView\([\s\S]*?setWindowOpenHandler[\s\S]*?return \{ action: "deny" \};/);
  assert.match(browser, /if \(allowedAuthUrl\(url\)\)[\s\S]*?createWindow: \(options\) => this\.createAuthView\(options, url\)/);
  assert.match(browser, /AUTH_PROVIDER_HOSTS = new Set/);
  assert.match(browser, /contextIsolation:\s*true/);
  assert.match(browser, /nodeIntegration:\s*false/);
  assert.match(browser, /sandbox:\s*true/);
});
