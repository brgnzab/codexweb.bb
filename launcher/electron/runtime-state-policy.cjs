const path = require("node:path");

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathWithin(candidate, root) {
  const candidatePath = comparablePath(candidate);
  const rootPath = comparablePath(root);
  const relative = path.relative(rootPath, candidatePath);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertPrivateRuntimeDataPath(candidate, { label = "Runtime data path", forbiddenRoots = [] } = {}) {
  if (typeof candidate !== "string" || !candidate.trim() || !path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = path.resolve(candidate);
  for (const root of forbiddenRoots) {
    if (typeof root !== "string" || !root.trim()) continue;
    if (isPathWithin(resolved, root)) {
      throw new Error(`${label} must stay outside the application and repository tree`);
    }
  }
  return resolved;
}

module.exports = {
  assertPrivateRuntimeDataPath,
  isPathWithin,
};
