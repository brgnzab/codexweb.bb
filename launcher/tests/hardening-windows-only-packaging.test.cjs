const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

test("launcher manifest exposes Windows packaging only", () => {
  const manifest = JSON.parse(read(launcherRoot, "package.json"));
  assert.equal(manifest.main, "electron/main-dispatch.cjs");
  const dispatch = read(launcherRoot, "electron", "main-dispatch.cjs");
  assert.match(dispatch, /require\("\.\/main-hardened\.cjs"\)/);
  assert.equal(manifest.scripts.package, "bun run package:win");
  assert.equal(typeof manifest.scripts["package:win"], "string");
  assert.equal(manifest.scripts["package:mac"], undefined);
  assert.equal(manifest.scripts["package:linux"], undefined);
  assert.ok(manifest.build.win);
  assert.equal(manifest.build.mac, undefined);
  assert.equal(manifest.build.linux, undefined);
});

test("package and packaged smoke reject non-Windows x64 hosts", () => {
  const packageScript = read(launcherRoot, "scripts", "package.cjs");
  const smoke = read(launcherRoot, "scripts", "smoke-package.cjs");
  for (const source of [packageScript, smoke]) {
    assert.match(source, /process\.platform !== "win32"/);
    assert.match(source, /process\.arch !== "x64"/);
  }
  assert.doesNotMatch(packageScript, /--mac|--linux|AppImage|\.dmg/);
  assert.doesNotMatch(smoke, /darwin|linux|AppImage|ditto|xvfb-run/);
});

test("product CI and release build only Windows x64 artifacts", () => {
  const ci = read(repoRoot, ".github", "workflows", "ci.yml");
  const release = read(repoRoot, ".github", "workflows", "release.yml");
  assert.match(ci, /verify:\s*\n\s*runs-on: windows-latest/);
  assert.doesNotMatch(ci, /macos-15|ubuntu-latest, windows-latest|AppImage|\.dmg/);
  assert.match(release, /build:\s*[\s\S]*?runs-on: windows-latest/);
  assert.match(release, /codex-chatgpt-web-windows-amd64\.zip/);
  assert.doesNotMatch(release, /macos-15|AppImage|darwin-arm64|darwin-amd64|linux-amd64|\.dmg/);
});

test("shared current runtime files are intentionally preserved", () => {
  for (const relative of [
    "src/tunnel.ts",
    "launcher/electron/main-dispatch.cjs",
    "launcher/electron/main-hardened.cjs",
    "launcher/electron/main-council.cjs",
    "launcher/electron/runtime.cjs",
    "launcher/electron/runtime-supervisor.cjs",
    "scripts/build-runtime-bundle.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, relative)), true, `${relative} is shared current-release code`);
  }
});
