const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");
const { verifyRuntimeContent } = require("./runtime-integrity.cjs");
const { ensurePrivateDirectory, protectPrivatePath } = require("./private-path.cjs");

function validateRuntimeBundle(runtimeRoot, { version, platform, arch, bundleId, manifestHash }) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
  const manifest = verifyRuntimeContent(runtimeRoot, manifestHash);
  if (manifest.schemaVersion !== 2
    || manifest.appVersion !== version
    || manifest.platform !== platform
    || manifest.arch !== arch
    || !/^[a-f0-9]{64}$/.test(manifest.bundleId)
    || (bundleId && manifest.bundleId !== bundleId)) {
    throw new Error(
      `Runtime bundle identity mismatch: expected ${version} ${platform}/${arch}, received ${JSON.stringify(manifest)}`,
    );
  }
  const paths = runtimeBundlePaths(runtimeRoot, platform);
  for (const required of requiredRuntimeFiles(runtimeRoot, platform)) {
    if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
      throw new Error(`Runtime bundle file is missing: ${required}`);
    }
  }
  if (platform !== "win32" && (fs.statSync(paths.executable).mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${paths.executable}`);
  }
  return paths.runtimeRoot;
}

function requiredRuntimeFiles(runtimeRoot, platform) {
  const paths = runtimeBundlePaths(runtimeRoot, platform);
  return [paths.executable, paths.entrypoint, path.join(runtimeRoot, "app", "browser-helper.cjs")];
}

function existingRuntimeMatchesPackage(destination, sourceManifestBytes, identity) {
  try {
    const installedManifestPath = path.join(destination, "manifest.json");
    if (!fs.existsSync(installedManifestPath)) return false;
    const installedManifestBytes = fs.readFileSync(installedManifestPath);
    if (!installedManifestBytes.equals(sourceManifestBytes)) return false;
    const manifest = JSON.parse(installedManifestBytes.toString("utf8"));
    if (manifest.schemaVersion !== 2
      || manifest.appVersion !== identity.version
      || manifest.platform !== identity.platform
      || manifest.arch !== identity.arch
      || !/^[a-f0-9]{64}$/.test(manifest.bundleId)) return false;
    return requiredRuntimeFiles(destination, identity.platform)
      .every(file => fs.existsSync(file) && fs.statSync(file).isFile());
  } catch {
    return false;
  }
}

function ensurePackagedRuntime({ app, coreHome, resourcesPath, trustedManifestHash }) {
  if (!app.isPackaged) return null;
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    // This build reference is inside application code/ASAR, not beside the writable runtime.
    manifestHash: trustedManifestHash || require("./runtime-trust.json").manifestHash,
  };
  const source = path.join(resourcesPath, "runtime");
  const sourceManifestPath = path.join(source, "manifest.json");
  const sourceManifestBytes = fs.readFileSync(sourceManifestPath);
  const { sha256 } = require("./runtime-integrity.cjs");
  if (sha256(sourceManifestBytes) !== identity.manifestHash) throw new Error("Runtime manifest integrity mismatch");
  const sourceManifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  const expectedIdentity = { ...identity, bundleId: sourceManifest.bundleId };
  const versionsRoot = path.join(coreHome, "versions");
  const destination = path.join(
    versionsRoot,
    `${identity.version}-${identity.platform}-${identity.arch}`,
  );

  // Ordinary launches use the already-installed version after a cheap manifest/required-file check.
  // Full recursive hashing is reserved for install/repair/update, keeping Electron's main thread responsive.
  if (fs.existsSync(destination) && existingRuntimeMatchesPackage(destination, sourceManifestBytes, identity)) {
    return destination;
  }

  validateRuntimeBundle(source, identity);

  ensurePrivateDirectory(versionsRoot, { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  let previousMoved = false;
  try {
    fs.cpSync(source, temporary, { recursive: true, errorOnExist: true, force: false });
    protectPrivatePath(temporary, { recursive: true });
    validateRuntimeBundle(temporary, expectedIdentity);
    if (fs.existsSync(destination)) {
      renameAtomicFile(destination, previous);
      previousMoved = true;
    }
    try {
      renameAtomicFile(temporary, destination);
      validateRuntimeBundle(destination, expectedIdentity);
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      if (previousMoved) {
        try {
          renameAtomicFile(previous, destination);
          previousMoved = false;
        } catch (restoreError) {
          throw new Error(
            `Runtime replacement failed: ${error instanceof Error ? error.message : String(error)}`
            + `; previous runtime restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
      }
      throw error;
    }
    if (previousMoved) {
      fs.rmSync(previous, { recursive: true, force: true });
      previousMoved = false;
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (previousMoved && fs.existsSync(previous) && !fs.existsSync(destination)) {
      renameAtomicFile(previous, destination);
      previousMoved = false;
    }
  }
  try { fs.chmodSync(destination, 0o700); } catch {}
  return validateRuntimeBundle(destination, expectedIdentity);
}

module.exports = {
  ensurePackagedRuntime,
  validateRuntimeBundle,
};
