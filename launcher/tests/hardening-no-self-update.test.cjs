const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

test("Council ships no launcher self-updater or deferred replacement worker", () => {
  for (const relative of [
    "electron/council-update.cjs",
    "electron/update.cjs",
    "electron/update-worker.cjs",
    "src/CouncilUpdatePrompt.tsx",
  ]) {
    assert.equal(fs.existsSync(path.join(launcherRoot, relative)), false, `${relative} must stay removed`);
  }

  const main = read(launcherRoot, "electron", "main-council.cjs");
  assert.doesNotMatch(main, /createUpdateController|updateController\.checkOnce|launcher:update-install|releases\/latest/);
  assert.match(main, /update:\s*\{ status: "disabled" \}/);
});

test("Tunnel provisioning is local-only and keeps remote executable acquisition removed", () => {
  const tunnel = read(repoRoot, "src", "tunnel.ts");
  const setup = read(repoRoot, "src", "council", "setup.ts");
  const runtime = read(launcherRoot, "electron", "runtime.cjs");
  const main = read(launcherRoot, "electron", "main-council.cjs");

  assert.doesNotMatch(tunnel, /\bfetch\s*\(|github\.com\/openai\/tunnel-client|fflate|unzipSync|RELEASE_BASE/);
  assert.match(tunnel, /Automatic tunnel-client download is disabled/);
  assert.match(tunnel, /source: "local"/);
  assert.match(setup, /--tunnel-client-path/);
  assert.match(runtime, /Fresh Council Tunnel setup requires an absolute local tunnel-client path/);
  assert.match(main, /showOpenDialog/);
  assert.match(main, /Select reviewed OpenAI tunnel-client v0\.0\.10/);
});
