const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { sealRuntimeManifest } = require("../electron/runtime-integrity.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const output = path.join(launcherRoot, "build", "runtime");
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;

function hashBuildPath(hash, root, target) {
  const stat = fs.statSync(target);
  const relative = path.relative(root, target).replaceAll(path.sep, "/");
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target).sort()) hashBuildPath(hash, root, path.join(target, name));
    return;
  }
  if (!stat.isFile()) return;
  hash.update(relative);
  hash.update("\0");
  hash.update(fs.readFileSync(target));
  hash.update("\0");
}

function writeBuildIdentity() {
  const hash = createHash("sha256");
  for (const target of [
    path.join(launcherRoot, "electron"),
    path.join(launcherRoot, "dist"),
    path.join(launcherRoot, "assets"),
    path.join(launcherRoot, "package.json"),
  ]) hashBuildPath(hash, launcherRoot, target);
  const destination = path.join(launcherRoot, "build", "build-id.json");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify({ schemaVersion: 1, buildId: hash.digest("hex") })}\n`, "utf8");
}


const result = spawnSync(bun, ["run", "scripts/build-runtime-bundle.ts", output], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const notices = spawnSync(bun, [
  "run",
  "scripts/generate-third-party-notices.ts",
  path.join(output, "THIRD_PARTY_NOTICES.txt"),
  "--include-launcher",
], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});
if (notices.error) throw notices.error;
if (notices.status !== 0) process.exit(notices.status ?? 1);
fs.copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(output, "LICENSE"));
fs.cpSync(path.join(repositoryRoot, "LICENSES"), path.join(output, "LICENSES"), { recursive: true });
const identity = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
const { manifestHash } = sealRuntimeManifest(output, identity);
fs.writeFileSync(path.join(launcherRoot, "electron", "runtime-trust.json"), `${JSON.stringify({ manifestHash })}\n`);

writeBuildIdentity();

const hygienePaths = [
  path.join(launcherRoot, "electron"),
  output,
  path.join(launcherRoot, "package.json"),
];
const rendererOutput = path.join(launcherRoot, "dist");
if (fs.existsSync(rendererOutput)) hygienePaths.push(rendererOutput);
const hygiene = spawnSync(bun, ["run", "scripts/check-public-hygiene.ts", ...hygienePaths], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});
if (hygiene.error) throw hygiene.error;
if (hygiene.status !== 0) process.exit(hygiene.status ?? 1);
