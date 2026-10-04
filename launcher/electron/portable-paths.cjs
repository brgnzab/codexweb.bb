const fs = require("node:fs");
const path = require("node:path");

const PORTABLE_MARKER = "cwc-portable.json";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPortableMarker({ isPackaged, execPath }) {
  if (!isPackaged) return null;
  const root = path.dirname(path.resolve(execPath));
  const markerPath = path.join(root, PORTABLE_MARKER);
  if (!fs.existsSync(markerPath)) return null;
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (marker?.schemaVersion !== 1 || marker?.mode !== "portable" || marker?.dataDirectory !== "data") {
    throw new Error(`Invalid CWC portable marker: ${markerPath}`);
  }
  return { root, markerPath, marker };
}

function resolveCwcPaths({
  isPackaged,
  execPath,
  launcherDataOverride,
  coreHomeOverride,
  defaultLauncherData,
  defaultCoreHome,
}) {
  const portable = readPortableMarker({ isPackaged, execPath });
  const dataRoot = portable ? path.join(portable.root, portable.marker.dataDirectory) : null;
  const launcherOverride = nonEmpty(launcherDataOverride);
  const coreOverride = nonEmpty(coreHomeOverride);
  return {
    portableRoot: portable?.root ?? null,
    launcherData: launcherOverride
      ? path.resolve(launcherOverride)
      : dataRoot
        ? path.join(dataRoot, "launcher")
        : path.resolve(defaultLauncherData),
    coreHome: coreOverride
      ? path.resolve(coreOverride)
      : dataRoot
        ? path.join(dataRoot, "core")
        : path.resolve(defaultCoreHome),
  };
}

module.exports = {
  PORTABLE_MARKER,
  readPortableMarker,
  resolveCwcPaths,
};
