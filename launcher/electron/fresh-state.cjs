const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const BUILD_MARKER_VERSION = 1;
const PRESERVED_CORE_ENTRIES = new Set(["versions"]);

function normalizeBuildId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 220 || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
}

function resolveBuildId({ app, resourcesPath, env = process.env }) {
  const sourceId = normalizeBuildId(env.CWC_BUILD_ID);
  if (sourceId) return `source:${sourceId}`;

  if (app?.isPackaged) {
    const buildIdentityPath = path.join(resourcesPath, "build-id.json");
    if (fs.existsSync(buildIdentityPath)) {
      const identity = JSON.parse(fs.readFileSync(buildIdentityPath, "utf8"));
      if (identity?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(identity?.buildId || "")) {
        throw new Error("Packaged Council build identity is invalid");
      }
      return `package:${app.getVersion()}:${identity.buildId}`;
    }
    // Compatibility fallback for packages created before build-id.json existed.
    // This is still a small manifest read and never hashes app.asar at launch.
    const manifestPath = path.join(resourcesPath, "runtime", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!/^[a-f0-9]{64}$/.test(manifest?.bundleId || "")) {
      throw new Error("Packaged Council runtime has no valid build identity");
    }
    return `package:${app.getVersion()}:${manifest.bundleId}`;
  }

  return `source:${app?.getVersion?.() || "unknown"}`;
}

function readBuildMarker(markerPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (parsed?.version !== BUILD_MARKER_VERSION || !normalizeBuildId(parsed.buildId)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeBuildMarker(markerPath, buildId) {
  writePrivateFileAtomic(markerPath, `${JSON.stringify({
    version: BUILD_MARKER_VERSION,
    buildId,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

function clearCouncilCoreHome(coreHome) {
  fs.mkdirSync(coreHome, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(coreHome, { withFileTypes: true })) {
    if (PRESERVED_CORE_ENTRIES.has(entry.name) && entry.isDirectory()) continue;
    fs.rmSync(path.join(coreHome, entry.name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function resetRuntimeFlags(stateStore) {
  return stateStore.update({
    coreSetupComplete: false,
    codexCatalogVerified: false,
    mcpSetupComplete: false,
    mcpRuntimeInstalled: false,
    codexRestartRequired: false,
    browserSmokePassed: false,
    browserSmokeVersion: null,
    mcpGuideStep: 0,
  });
}

function prepareFreshBuild({ markerPath, buildId, coreHome, stateStore }) {
  const normalized = normalizeBuildId(buildId);
  if (!normalized) throw new Error("Council build identity is invalid");
  const previous = readBuildMarker(markerPath);
  if (previous?.buildId === normalized) {
    return { reset: false, previousBuildId: previous.buildId, state: stateStore.read() };
  }
  clearCouncilCoreHome(coreHome);
  const state = resetRuntimeFlags(stateStore);
  writeBuildMarker(markerPath, normalized);
  return { reset: true, previousBuildId: previous?.buildId ?? null, state };
}

module.exports = {
  BUILD_MARKER_VERSION,
  clearCouncilCoreHome,
  prepareFreshBuild,
  readBuildMarker,
  resetRuntimeFlags,
  resolveBuildId,
  writeBuildMarker,
};
