const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveCwcPaths } = require("../electron/portable-paths.cjs");

test("packaged portable marker keeps launcher and core state beside the app", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-portable-paths-"));
  try {
    const exe = path.join(scratch, "Codex Web GPT.exe");
    fs.writeFileSync(exe, "");
    fs.writeFileSync(path.join(scratch, "cwc-portable.json"), JSON.stringify({
      schemaVersion: 1,
      mode: "portable",
      dataDirectory: "data",
    }));
    const resolved = resolveCwcPaths({
      isPackaged: true,
      execPath: exe,
      defaultLauncherData: "C:\\default-launcher",
      defaultCoreHome: "C:\\default-core",
    });
    assert.equal(resolved.portableRoot, scratch);
    assert.equal(resolved.launcherData, path.join(scratch, "data", "launcher"));
    assert.equal(resolved.coreHome, path.join(scratch, "data", "core"));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("explicit data locations override portable defaults", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-portable-overrides-"));
  try {
    const exe = path.join(scratch, "Codex Web GPT.exe");
    fs.writeFileSync(exe, "");
    fs.writeFileSync(path.join(scratch, "cwc-portable.json"), JSON.stringify({
      schemaVersion: 1,
      mode: "portable",
      dataDirectory: "data",
    }));
    const resolved = resolveCwcPaths({
      isPackaged: true,
      execPath: exe,
      launcherDataOverride: path.join(scratch, "selected-launcher"),
      coreHomeOverride: path.join(scratch, "selected-core"),
      defaultLauncherData: "C:\\default-launcher",
      defaultCoreHome: "C:\\default-core",
    });
    assert.equal(resolved.launcherData, path.join(scratch, "selected-launcher"));
    assert.equal(resolved.coreHome, path.join(scratch, "selected-core"));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("source and ordinary packaged launches retain existing default locations", () => {
  const resolved = resolveCwcPaths({
    isPackaged: false,
    execPath: process.execPath,
    defaultLauncherData: "C:\\default-launcher",
    defaultCoreHome: "C:\\default-core",
  });
  assert.equal(resolved.portableRoot, null);
  assert.equal(resolved.launcherData, path.resolve("C:\\default-launcher"));
  assert.equal(resolved.coreHome, path.resolve("C:\\default-core"));
});
