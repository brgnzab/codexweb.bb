const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const repositoryManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

test("the public launcher command uses the hardened Electron Council bootstrap", () => {
  assert.equal(repositoryManifest.scripts.launcher, "bun run scripts/start-launcher.ts");
  assert.equal(repositoryManifest.scripts.launcher, repositoryManifest.scripts.app);
  assert.equal(manifest.main, "electron/main-dispatch.cjs");
  const dispatch = read(launcherRoot, "electron", "main-dispatch.cjs");
  assert.match(dispatch, /process\.argv\.includes\("--launcher-smoke-test"\)/);
  assert.match(dispatch, /require\("\.\/main-hardened\.cjs"\)/);
  assert.equal(fs.existsSync(path.join(launcherRoot, "electron", "main-hardened.cjs")), true);
  assert.equal(fs.existsSync(path.join(launcherRoot, "electron", "main-council.cjs")), true);
  assert.equal(fs.existsSync(path.join(launcherRoot, "electron", "smoke-main.cjs")), true);
});

test("launcher packages Windows x64 only with constrained NSIS settings", () => {
  assert.equal(manifest.build.appId, "dev.codexwebgpt.launcher");
  assert.equal(manifest.build.artifactName, "codex-web-gpt-${version}-${os}-${arch}.${ext}");
  assert.equal(manifest.build.mac, undefined);
  assert.equal(manifest.build.linux, undefined);
  assert.deepEqual(manifest.build.win.target, ["nsis"]);
  assert.equal(manifest.build.win.icon, "assets/icon.ico");
  assert.ok(fs.existsSync(path.join(launcherRoot, "assets", "icon.ico")));
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.allowElevation, false);
  assert.equal(manifest.build.nsis.runAfterFinish, false);
  assert.ok(manifest.build.files.includes("electron/**"), "hardened Electron entrypoint must be packaged");
});

test("packager accepts only Windows x64 and never publishes automatically", () => {
  const packager = read(launcherRoot, "scripts", "package.cjs");
  assert.match(packager, /process\.platform !== "win32"/);
  assert.match(packager, /process\.arch !== "x64"/);
  assert.match(packager, /requested && requested !== "--win"/);
  assert.match(packager, /electron-builder\/out\/cli\/cli\.js/);
  assert.match(packager, /"--publish",\s*\n\s*"never"/);
  assert.doesNotMatch(packager, /--mac|--linux|AppImage|\.dmg/);
});

test("packaged smoke gives the cold runtime copy its own bounded timeout", () => {
  const smoke = read(launcherRoot, "scripts", "smoke-package.cjs");
  assert.match(smoke, /const DEFAULT_COMMAND_TIMEOUT_MS = 45_000;/);
  assert.match(smoke, /const COLD_RUNTIME_SMOKE_TIMEOUT_MS = 360_000;/);
  assert.match(smoke, /timeout: options\.timeout \?\? DEFAULT_COMMAND_TIMEOUT_MS/);
  assert.match(
    smoke,
    /run\(executable, \["--launcher-smoke-test"\], \{ env, timeout: COLD_RUNTIME_SMOKE_TIMEOUT_MS \}\);/,
  );
});

test("retired installer and self-update source stay absent", () => {
  for (const relative of [
    "scripts/install-launcher.sh",
    "scripts/install-launcher.ps1",
    "scripts/install.sh",
    "launcher/electron/update.cjs",
    "launcher/electron/update-worker.cjs",
    "launcher/electron/council-update.cjs",
    "launcher/src/CouncilUpdatePrompt.tsx",
  ]) {
    assert.equal(fs.existsSync(path.join(repositoryRoot, relative)), false, `${relative} must remain removed`);
  }
});

test("CI and release build the Windows product only", () => {
  const ci = read(repositoryRoot, ".github", "workflows", "ci.yml");
  const release = read(repositoryRoot, ".github", "workflows", "release.yml");
  assert.match(ci, /verify:\s*\n\s*runs-on: windows-latest/);
  assert.match(ci, /bun run app:package/);
  assert.match(ci, /bun run app:smoke/);
  assert.doesNotMatch(ci, /macos-15|AppImage|\.dmg/);
  assert.match(release, /build:\s*[\s\S]*?runs-on: windows-latest/);
  assert.match(release, /codex-chatgpt-web-windows-amd64\.zip/);
  assert.match(release, /bun run app:smoke/);
  assert.doesNotMatch(release, /macos-15|darwin-arm64|darwin-amd64|linux-amd64|AppImage|\.dmg/);
});

test("release assets remain checksummed and Windows runtime uses the pinned baseline Bun", () => {
  const release = read(repositoryRoot, ".github", "workflows", "release.yml");
  const baseline = read(repositoryRoot, "scripts", "prepare-windows-baseline-bun.ps1");
  assert.match(release, /checksums\.txt/);
  assert.match(release, /sha256sum/);
  assert.match(baseline, /bun-windows-x64-baseline\.zip/);
  assert.match(baseline, /SHASUMS256\.txt/);
  assert.match(baseline, /Get-FileHash[^\n]+SHA256/);
  assert.match(baseline, /CODEX_CHATGPT_WEB_EMBEDDED_BUN=/);
});
