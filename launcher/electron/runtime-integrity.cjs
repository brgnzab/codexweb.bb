const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { assertNoReparsePath } = require("./private-path.cjs");

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function inventory(root) {
  assertNoReparsePath(root);
  const files = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(directory, entry.name);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Runtime resource reparse point rejected");
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const relative = path.relative(root, file).split(path.sep).join("/");
        if (relative !== "manifest.json") files[relative] = sha256(fs.readFileSync(file));
      } else throw new Error("Non-regular runtime resource rejected");
    }
  }
  visit(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function sealRuntimeManifest(root, identity) {
  const files = inventory(root);
  const manifest = { ...identity, schemaVersion: 2, files, bundleId: sha256(JSON.stringify(files)) };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "manifest.json"), bytes);
  return { manifest, manifestHash: sha256(bytes) };
}

function verifyRuntimeContent(root, trustedManifestHash) {
  assertNoReparsePath(path.join(root, "manifest.json"));
  if (!/^[a-f0-9]{64}$/.test(trustedManifestHash || "")) throw new Error("Trusted runtime manifest hash is missing");
  const bytes = fs.readFileSync(path.join(root, "manifest.json"));
  if (sha256(bytes) !== trustedManifestHash) throw new Error("Runtime manifest integrity mismatch");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schemaVersion !== 2 || !manifest.files || Array.isArray(manifest.files)) throw new Error("Runtime manifest inventory is invalid");
  const actual = inventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files) || sha256(JSON.stringify(actual)) !== manifest.bundleId) {
    throw new Error("Runtime resource content integrity mismatch");
  }
  return manifest;
}

module.exports = { sha256, inventory, sealRuntimeManifest, verifyRuntimeContent };
