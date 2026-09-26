const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

test("root and launcher use committed Bun lockfiles and no workspace lifecycle hooks", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "bun.lock")), true);
  assert.equal(fs.existsSync(path.join(launcherRoot, "bun.lock")), true);
  for (const manifestPath of [path.join(repoRoot, "package.json"), path.join(launcherRoot, "package.json")]) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const hook of ["preinstall", "install", "postinstall"]) {
      assert.equal(manifest.scripts?.[hook], undefined, `${manifestPath} must not define ${hook}`);
    }
  }
});

test("CI and release use frozen installs and the exact Node pin", () => {
  for (const workflow of ["ci.yml", "release.yml"]) {
    const source = read(repoRoot, ".github", "workflows", workflow);
    const matches = source.match(/bun install --frozen-lockfile/g) || [];
    assert.ok(matches.length >= 2, `${workflow} must freeze both root and launcher installs`);
    assert.match(source, /actions\/setup-node@v6/);
    assert.match(source, /node-version: "22\.23\.2"/);
  }
});

test("recorded Windows build toolchain matches committed launcher lock", () => {
  const lock = read(launcherRoot, "bun.lock");
  assert.match(lock, /electron@41\.10\.7/);
  assert.match(lock, /electron-builder@26\.15\.3/);
  assert.match(lock, /vite@6\.4\.3/);
  assert.match(lock, /esbuild@0\.25\.12/);
  assert.match(lock, /typescript@5\.9\.3/);
  const rootLock = read(repoRoot, "bun.lock");
  assert.match(rootLock, /playwright-core@1\.62\.0/);
  assert.match(rootLock, /@modelcontextprotocol\/sdk@1\.30\.0/);
  const rootManifest = JSON.parse(read(repoRoot, "package.json"));
  assert.equal(rootManifest.packageManager, "bun@1.3.14");
  assert.equal(rootManifest.engines.bun, "1.3.14");
  assert.equal(rootManifest.engines.node, "22.23.2");
});

test("launcher security floors remain version-scoped to vulnerable ranges", () => {
  const manifest = JSON.parse(read(launcherRoot, "package.json"));
  assert.equal(manifest.devDependencies.electron, "41.10.7");
  assert.deepEqual(manifest.overrides, {
    "@xmldom/xmldom@<=0.8.14": "0.8.15",
    "brace-expansion@<1.1.18": "1.1.18",
    "fast-uri@<3.1.8": "3.1.8",
    "js-yaml@>=4.0.0 <4.3.2": "4.3.2",
    "nanoid@<3.3.18": "3.3.18",
  });
});

test("supply-chain lifecycle inventory is committed and callable", () => {
  const manifest = JSON.parse(read(repoRoot, "package.json"));
  assert.equal(manifest.scripts["supply-chain:hooks"], "bun run scripts/audit-install-hooks.ts");
  assert.equal(fs.existsSync(path.join(repoRoot, "scripts", "audit-install-hooks.ts")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "docs", "CWC_SUPPLY_CHAIN_AUDIT.md")), true);
});
