const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCouncilBrowserHostClass } = require("../electron/council-browser-host.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

test("Council browser partition rejects arbitrary downloads", async () => {
  const handlers = new Map();
  const removed = [];
  const warnings = [];
  const session = {
    on(name, handler) { handlers.set(name, handler); },
    removeListener(name, handler) { removed.push([name, handler]); handlers.delete(name); },
  };
  class LegacyBrowserHost {
    constructor() {
      this.view = { webContents: { session } };
      this.logger = { warn(event, detail) { warnings.push({ event, detail }); } };
    }
    async dispose() {}
  }
  const CouncilBrowserHost = createCouncilBrowserHostClass(LegacyBrowserHost);
  const host = new CouncilBrowserHost({});
  const blocker = handlers.get("will-download");
  assert.equal(typeof blocker, "function");
  let prevented = false;
  blocker({ preventDefault() { prevented = true; } }, { getURL() { return "https://example.com/payload.exe?secret=value"; } });
  assert.equal(prevented, true);
  assert.deepEqual(warnings, [{ event: "browser.download_blocked", detail: { origin: "https://example.com" } }]);
  await host.dispose();
  assert.deepEqual(removed, [["will-download", blocker]]);
});

test("legacy native Codex upstream client stays removed", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "src", "native-passthrough.ts")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "src", "server.ts")), false);
});

test("remote executable acquisition remains absent from current Tunnel setup", () => {
  const tunnel = read(repoRoot, "src", "tunnel.ts");
  assert.doesNotMatch(tunnel, /\bfetch\s*\(|github\.com\/openai\/tunnel-client|unzipSync|RELEASE_BASE/);
  assert.match(tunnel, /Automatic tunnel-client download is disabled/);
});
