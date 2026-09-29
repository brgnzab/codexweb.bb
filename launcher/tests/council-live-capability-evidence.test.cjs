const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { deriveCouncilCapabilities } = require("../electron/council-capabilities.cjs");
const { isCouncilRuntimeLive, setCouncilRuntimeLive } = require("../electron/council-runtime-evidence.cjs");

const supervisorSource = readFileSync(join(__dirname, "..", "electron", "runtime-supervisor.cjs"), "utf8");

test("Council capability readiness follows live runtime evidence and active mode", () => {
  setCouncilRuntimeLive(false);
  assert.equal(isCouncilRuntimeLive(), false);
  assert.equal(deriveCouncilCapabilities({ configured: true, mode: "full", runtimeLive: false }).wakeEngine.available, false);

  setCouncilRuntimeLive(true);
  assert.equal(isCouncilRuntimeLive(), true);
  const browserOnly = deriveCouncilCapabilities({ configured: true, mode: "browser-only", runtimeLive: false });
  assert.equal(browserOnly.wakeEngine.available, true);
  assert.equal(browserOnly.secureTunnel.available, false);
  assert.equal(browserOnly.fullMcp.available, false);
  const full = deriveCouncilCapabilities({ configured: true, mode: "full", runtimeLive: false });
  assert.equal(full.secureTunnel.available, true);
  assert.equal(full.fullMcp.available, true);
  assert.equal(full.wakeEngine.available, true);

  setCouncilRuntimeLive(false);
});

test("Council RuntimeSupervisor owns runtime evidence across start, recovery and shutdown", () => {
  assert.match(supervisorSource, /setCouncilRuntimeLive\(false\)[\s\S]{0,260}runtime-start/);
  assert.match(supervisorSource, /writeState\(["']ready["']\)[\s\S]{0,180}setCouncilRuntimeLive\(true\)/);
  assert.match(supervisorSource, /runtime-recovery[\s\S]{0,220}setCouncilRuntimeLive\(false\)/);
  assert.match(supervisorSource, /Council tunnel recovered[\s\S]{0,180}setCouncilRuntimeLive\(true\)/);
  assert.match(supervisorSource, /async shutdown\(\)[\s\S]{0,220}setCouncilRuntimeLive\(false\)/);
});
