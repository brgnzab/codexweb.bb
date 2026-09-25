const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("Electron starts through the hardened Council entrypoint", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.main, "electron/main-hardened.cjs");
  const hardened = fs.readFileSync(path.join(root, "electron", "main-hardened.cjs"), "utf8");
  assert.match(hardened, /require\("\.\/browser-host\.cjs"\)/);
  assert.match(hardened, /BrowserHost\.prototype\.bindWebContents/);
  assert.match(hardened, /BrowserHost\.prototype\.createAuthView/);
  assert.match(hardened, /require\("\.\/main-council\.cjs"\)/);
  assert.ok(
    hardened.indexOf("BrowserHost.prototype.bindWebContents") < hardened.indexOf('require("./main-council.cjs")'),
    "browser hardening must be installed before the Council main starts",
  );

  const entry = fs.readFileSync(path.join(root, "electron", "main-council.cjs"), "utf8");
  assert.match(entry, /CODEXWEB_COUNCIL_PRODUCT = "1"/);
  assert.match(entry, /createCouncilBrowserHostClass/);
  assert.match(entry, /createCouncilBrowserControlServerClass/);
  assert.match(entry, /setupCouncilMcp/);
  assert.match(entry, /launcher:council-bind-current-lead/);
  assert.match(entry, /COUNCIL_CONNECTOR_NAME/);
  assert.doesNotMatch(entry, /require\("\.\/main\.cjs"\)/);
  assert.doesNotMatch(entry, /setupCore/);
  assert.doesNotMatch(entry, /setBridgeEnabled/);
  assert.doesNotMatch(entry, /codexCatalogVerified/);
});

test("current Council shutdown remains gated by active runtime or browser work", () => {
  const entry = fs.readFileSync(path.join(root, "electron", "main-council.cjs"), "utf8");
  assert.match(entry, /runtimeHost\?\.currentOperation\(\) \|\| browserHost\?\.currentOperation\(\)/);
  assert.match(entry, /Wait for \$\{active\} to finish before quitting CodexWeb Council/);
  assert.match(entry, /await browserHost\?\.persistSession\(\)/);
});
