const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveCouncilCapabilities } = require("../electron/council-capabilities.cjs");

test("persisted setup flags never imply live execution capability", () => {
  const capabilities = deriveCouncilCapabilities({ configured: true, mode: "full", runtimeLive: false });
  assert.equal(capabilities.secureTunnel.available, false);
  assert.notEqual(capabilities.secureTunnel.state, "ready");
  assert.equal(capabilities.fullMcp.available, false);
  assert.equal(capabilities.wakeEngine.available, false);
});

test("browser-only live runtime keeps optional Tunnel and full MCP off", () => {
  const capabilities = deriveCouncilCapabilities({ configured: true, mode: "browser-only", runtimeLive: true });
  assert.equal(capabilities.wakeEngine.available, true);
  assert.equal(capabilities.wakeEngine.state, "ready");
  assert.equal(capabilities.secureTunnel.available, false);
  assert.equal(capabilities.secureTunnel.state, "idle");
  assert.equal(capabilities.fullMcp.available, false);
  assert.equal(capabilities.fullMcp.state, "idle");
});

test("full-mode execution capability becomes ready only from explicit live evidence", () => {
  const capabilities = deriveCouncilCapabilities({ configured: true, mode: "full", runtimeLive: true });
  assert.equal(capabilities.secureTunnel.available, true);
  assert.equal(capabilities.secureTunnel.state, "ready");
  assert.equal(capabilities.fullMcp.available, true);
  assert.equal(capabilities.wakeEngine.available, true);
  assert.equal(capabilities.localRepo.available, false);
  assert.equal(capabilities.githubConnector.available, false);
});
