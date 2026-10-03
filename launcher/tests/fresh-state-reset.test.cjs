const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { clearCouncilCoreHome } = require("../electron/fresh-state.cjs");

test("fresh-build cleanup retries transient Windows-style removal failures and preserves versions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-fresh-reset-"));
  const versions = path.join(root, "versions");
  const council = path.join(root, "council");
  fs.mkdirSync(versions, { recursive: true });
  fs.mkdirSync(council, { recursive: true });
  fs.writeFileSync(path.join(versions, "keep.txt"), "keep");
  fs.writeFileSync(path.join(council, "remove.txt"), "remove");

  const originalRmSync = fs.rmSync;
  const calls = [];
  fs.rmSync = (target, options) => {
    if (path.resolve(target) === path.resolve(council)) calls.push({ target, options: { ...options } });
    return originalRmSync(target, options);
  };

  try {
    clearCouncilCoreHome(root);
    assert.equal(fs.existsSync(council), false);
    assert.equal(fs.readFileSync(path.join(versions, "keep.txt"), "utf8"), "keep");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } finally {
    fs.rmSync = originalRmSync;
    originalRmSync(root, { recursive: true, force: true });
  }
});
