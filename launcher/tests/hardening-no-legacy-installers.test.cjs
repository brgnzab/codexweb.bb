const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

test("CWC Personal ships no standalone legacy installer scripts", () => {
  for (const relative of [
    "scripts/install-launcher.ps1",
    "scripts/install-launcher.sh",
    "scripts/install.sh",
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, relative)), false, `${relative} must stay removed`);
  }
});

test("CI and release workflows do not resurrect retired installers", () => {
  const ci = read(repoRoot, ".github", "workflows", "ci.yml");
  const release = read(repoRoot, ".github", "workflows", "release.yml");
  for (const source of [ci, release]) {
    assert.doesNotMatch(source, /install-launcher\.ps1|install-launcher\.sh|scripts\/install\.sh/);
  }
});

test("current build and package verification remain until portable replacement", () => {
  for (const relative of [
    "scripts/build-runtime-bundle.ts",
    "launcher/scripts/prepare-runtime.cjs",
    "launcher/scripts/package.cjs",
    "launcher/scripts/smoke-package.cjs",
    "scripts/smoke-release.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, relative)), true, `${relative} remains current build/verification support`);
  }
});
