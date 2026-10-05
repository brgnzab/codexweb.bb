const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runStartupPrewarm } = require("../electron/startup-prewarm.cjs");
const { sealRuntimeManifest } = require("../electron/runtime-integrity.cjs");

function runtimeFixture(root, version = "0.2.0") {
  const resourcesPath = path.join(root, "resources");
  const runtimeRoot = path.join(resourcesPath, "runtime");
  const executable = path.join(runtimeRoot, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "app"), { recursive: true });
  fs.writeFileSync(executable, "bun");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(runtimeRoot, "app", "cli.js"), "cli");
  fs.writeFileSync(path.join(runtimeRoot, "app", "browser-helper.cjs"), "helper");
  fs.writeFileSync(path.join(runtimeRoot, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    appVersion: version,
    bundleId: "a".repeat(64),
    platform: process.platform,
    arch: process.arch,
  })}\n`);
  const { manifestHash } = sealRuntimeManifest(runtimeRoot, {
    appVersion: version,
    platform: process.platform,
    arch: process.arch,
  });
  return { resourcesPath, manifestHash };
}

test("startup runtime verification/install executes in a child process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-startup-prewarm-"));
  try {
    const { resourcesPath, manifestHash } = runtimeFixture(root);
    const coreHome = path.join(root, "core");
    const result = await runStartupPrewarm({
      workerPath: path.resolve(__dirname, "../electron/startup-prewarm-worker.cjs"),
      input: {
        coreHome,
        resourcesPath,
        version: "0.2.0",
        packaged: true,
        freshBuild: false,
        trustedManifestHash: manifestHash,
      },
    });
    assert.notEqual(result.pid, process.pid);
    assert.equal(result.installedRuntimeRoot, path.join(coreHome, "versions", `0.2.0-${process.platform}-${process.arch}`));
    assert.equal(fs.readFileSync(path.join(result.installedRuntimeRoot, "app", "cli.js"), "utf8"), "cli");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh-build cleanup and full runtime repair stay inside the prewarm worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-startup-prewarm-repair-"));
  try {
    const { resourcesPath, manifestHash } = runtimeFixture(root);
    const coreHome = path.join(root, "core");
    const workerPath = path.resolve(__dirname, "../electron/startup-prewarm-worker.cjs");
    const base = {
      coreHome,
      resourcesPath,
      version: "0.2.0",
      packaged: true,
      trustedManifestHash: manifestHash,
    };
    const first = await runStartupPrewarm({ workerPath, input: { ...base, freshBuild: false } });
    fs.mkdirSync(path.join(coreHome, "council"), { recursive: true });
    fs.writeFileSync(path.join(coreHome, "council", "old-state.json"), "old");
    fs.writeFileSync(path.join(first.installedRuntimeRoot, "app", "cli.js"), "corrupt");

    const repaired = await runStartupPrewarm({ workerPath, input: { ...base, freshBuild: true } });
    assert.notEqual(repaired.pid, process.pid);
    assert.equal(fs.existsSync(path.join(coreHome, "council", "old-state.json")), false);
    assert.equal(fs.readFileSync(path.join(repaired.installedRuntimeRoot, "app", "cli.js"), "utf8"), "cli");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
