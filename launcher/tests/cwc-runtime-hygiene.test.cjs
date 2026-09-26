const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertPrivateRuntimeDataPath, isPathWithin } = require("../electron/runtime-state-policy.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("configured mutable runtime roots cannot live inside repository or application roots", () => {
  const applicationRoot = path.join(repoRoot, "launcher");
  assert.equal(isPathWithin(path.join(repoRoot, ".cwc-data"), repoRoot), true);
  assert.equal(isPathWithin(path.join(repoRoot, "sibling-private-state"), applicationRoot), false);
  assert.throws(
    () => assertPrivateRuntimeDataPath(repoRoot, { label: "test", forbiddenRoots: [repoRoot] }),
    /outside the application and repository tree/,
  );
  assert.throws(
    () => assertPrivateRuntimeDataPath(path.join(repoRoot, ".cwc-data"), { label: "test", forbiddenRoots: [repoRoot] }),
    /outside the application and repository tree/,
  );
  assert.throws(
    () => assertPrivateRuntimeDataPath(path.join(applicationRoot, "private-state"), { label: "test", forbiddenRoots: [applicationRoot] }),
    /outside the application and repository tree/,
  );
  const external = path.join(os.tmpdir(), "cwc-private-runtime-state");
  assert.equal(assertPrivateRuntimeDataPath(external, { label: "test", forbiddenRoots: [repoRoot] }), path.resolve(external));
});

test("hardened launcher validates both configurable state roots before loading Council main", () => {
  const source = read("launcher/electron/main-hardened.cjs");
  assert.match(source, /CODEX_CHATGPT_WEB_HOME/);
  assert.match(source, /CODEX_WEB_GPT_LAUNCHER_DATA_DIR/);
  assert.match(source, /assertPrivateRuntimeDataPath/);
  const validationIndex = source.indexOf("validateConfiguredRuntimeRoots();");
  const mainIndex = source.lastIndexOf('require("./main-council.cjs")');
  assert.ok(validationIndex >= 0 && mainIndex > validationIndex, "runtime roots must be validated before Council main loads");
});

test("Windows package inputs are static allowlists and never include mutable user state", () => {
  const manifest = JSON.parse(read("launcher/package.json"));
  assert.deepEqual(manifest.build.files, ["dist/**", "electron/**", "assets/icon.png", "package.json"]);
  assert.deepEqual(manifest.build.extraResources, [{ from: "build/runtime", to: "runtime" }]);
  const serialized = JSON.stringify({ files: manifest.build.files, extraResources: manifest.build.extraResources }).toLowerCase();
  for (const forbidden of [".cwc-data", ".codex-chatgpt-web", "storage-state", "cookies", "local storage", "session storage", "launcher-state", "owner-control"]) {
    assert.equal(serialized.includes(forbidden), false, `package input must not include ${forbidden}`);
  }
});

test("runtime bundle starts clean and package preparation scans every distributable source tree", () => {
  const bundle = read("scripts/build-runtime-bundle.ts");
  const purgeIndex = bundle.indexOf("rmSync(output, { recursive: true, force: true });");
  const createIndex = bundle.indexOf("mkdirSync(appDir, { recursive: true });");
  assert.ok(purgeIndex >= 0 && createIndex > purgeIndex, "previous runtime output must be removed before rebuilding");

  const prepare = read("launcher/scripts/prepare-runtime.cjs");
  for (const required of [
    'path.join(launcherRoot, "electron")',
    "output,",
    'path.join(launcherRoot, "package.json")',
    "rendererOutput",
    'scripts/check-public-hygiene.ts',
  ]) assert.ok(prepare.includes(required), `package hygiene scan is missing ${required}`);
});

test("repository ignores all private Council and browser state roots", () => {
  const ignore = read(".gitignore");
  for (const required of [
    ".cwc-data/",
    ".codex-chatgpt-web/",
    ".launcher-runtime/",
    "storage-state.json",
    "/launcher-state.json",
    "/owner-control.json",
    "/Cookies",
    "/Local Storage/",
    "/Session Storage/",
    "/WebStorage/",
    "/Network/",
    "/Cache/",
    "/Code Cache/",
    "/GPUCache/",
  ]) assert.ok(ignore.includes(required), `.gitignore is missing ${required}`);
});
