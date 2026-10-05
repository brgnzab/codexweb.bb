const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveBuildId } = require("../electron/fresh-state.cjs");

test("packaged build identity uses the small precomputed sidecar instead of hashing app.asar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-build-id-"));
  try {
    const buildId = "b".repeat(64);
    fs.writeFileSync(path.join(root, "build-id.json"), `${JSON.stringify({ schemaVersion: 1, buildId })}\n`);
    fs.writeFileSync(path.join(root, "app.asar"), "first large-app placeholder");
    const app = { isPackaged: true, getVersion: () => "4.1.0" };
    const first = resolveBuildId({ app, resourcesPath: root, env: {} });
    fs.writeFileSync(path.join(root, "app.asar"), "different contents that must not be read for startup identity");
    const second = resolveBuildId({ app, resourcesPath: root, env: {} });
    assert.equal(first, `package:4.1.0:${buildId}`);
    assert.equal(second, first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
