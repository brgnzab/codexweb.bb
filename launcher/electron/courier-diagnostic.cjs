const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { verifyPrivatePath } = require("./private-path.cjs");

const MESSAGE = "Desktop courier failed; inspect the local courier request in CWC's runtime folder.";
const filename = root => path.join(root, "council", "courier-error.json");

function recordCourierFailure(root, worker, operation, requestFile, now = Date.now()) {
  // Never persist native error strings: they may contain credentials or participant content.
  writePrivateFileAtomic(filename(root), JSON.stringify({ version: 1, worker, operation, at: now,
    requestFile: path.relative(root, requestFile), message: MESSAGE }), { personalRoot: root });
}

function readCourierFailure(root, worker, since = 0) {
  if (!worker) return undefined;
  try {
    const file = verifyPrivatePath(filename(root), { personalRoot: root });
    if (fs.statSync(file).size > 4096) return MESSAGE;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number.isFinite(value.resolvedAt) && value.resolvedAt >= value.at) return undefined;
    return value.version === 1 && value.worker === worker && Number.isFinite(value.at) && value.at >= since
      ? MESSAGE : undefined;
  } catch (error) {
    return error?.code === "ENOENT" ? undefined : MESSAGE;
  }
}
function acknowledgeCourierRecovery(root, worker, now = Date.now()) {
  try {
    const file = verifyPrivatePath(filename(root), { personalRoot: root });
    if (fs.statSync(file).size > 4096) return;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.version !== 1 || value.worker !== worker || !Number.isFinite(value.at)) return;
    writePrivateFileAtomic(file, JSON.stringify({ ...value, resolvedAt: now }), { personalRoot: root });
  } catch {} // Never make recovery depend on optional local diagnostic storage.
}

module.exports = { recordCourierFailure, readCourierFailure, acknowledgeCourierRecovery, MESSAGE };
