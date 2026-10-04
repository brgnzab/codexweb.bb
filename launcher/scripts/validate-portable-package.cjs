const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`CWC Personal portable validation supports Windows x64 only; received ${process.platform}/${process.arch}`);
}

const root = path.resolve(__dirname, "..");
const artifactsDirectory = path.join(root, "artifacts");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const matches = fs.readdirSync(artifactsDirectory).filter(name => /-portable\.zip$/i.test(name)).sort();
if (matches.length !== 1) throw new Error(`Expected exactly one portable ZIP; found ${matches.join(", ") || "none"}`);
const zipPath = path.join(artifactsDirectory, matches[0]);
const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");

function run(args) {
  const result = spawnSync(tar, args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`tar ${args.join(" ")} failed: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || result.status}`);
  }
  return result.stdout;
}

const entries = run(["-tf", zipPath]).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
if (!entries.length) throw new Error("Portable ZIP is empty");
const roots = new Set(entries.map(entry => entry.replace(/\\/g, "/").split("/")[0]).filter(Boolean));
if (roots.size !== 1) throw new Error(`Portable ZIP must have one root directory; found ${[...roots].join(", ")}`);
const rootName = [...roots][0];
const normalized = new Set(entries.map(entry => entry.replace(/\\/g, "/")));
const required = [
  `${rootName}/cwc-portable.json`,
  `${rootName}/${manifest.build.productName}.exe`,
  `${rootName}/resources/app.asar`,
  `${rootName}/resources/runtime/manifest.json`,
];
for (const entry of required) {
  if (!normalized.has(entry)) throw new Error(`Portable ZIP is missing required entry: ${entry}`);
}
if ([...normalized].some(entry => entry === `${rootName}/data` || entry.startsWith(`${rootName}/data/`))) {
  throw new Error("Portable ZIP contains prior user/session data");
}
if ([...normalized].some(entry => /\.(?:blockmap)$/i.test(entry))) {
  throw new Error("Portable ZIP contains installer/update metadata");
}
const marker = JSON.parse(run(["-xOf", zipPath, `${rootName}/cwc-portable.json`]));
if (marker.schemaVersion !== 1 || marker.mode !== "portable" || marker.appVersion !== manifest.version || marker.platform !== "win32" || marker.arch !== "x64" || marker.dataDirectory !== "data") {
  throw new Error(`Portable marker is invalid: ${JSON.stringify(marker)}`);
}
process.stdout.write(`PORTABLE_STRUCTURE_OK ${path.basename(zipPath)}\n`);
