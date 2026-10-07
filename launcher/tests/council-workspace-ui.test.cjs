const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const types = readFileSync(join(root, "src", "types.ts"), "utf8");
const app = readFileSync(join(root, "src", "CouncilApp.tsx"), "utf8");

test("managed project view carries sanitized GitHub workspace metadata", () => {
  assert.match(types, /workspace\?:\s*RepoWorkspaceBindingView/);
  assert.match(types, /provider:\s*"github"/);
  assert.match(types, /repoId:\s*string/);
  assert.match(types, /owner:\s*string/);
  assert.match(types, /name:\s*string/);
  assert.match(types, /defaultBranch:\s*string/);
  assert.match(types, /baseCommit:\s*string/);
  assert.doesNotMatch(types, /workspace[^}]*token/i);
  assert.doesNotMatch(types, /workspace[^}]*localPath/i);
});

test("current Mission Control does not render workspace credentials or local paths", () => {
  assert.doesNotMatch(app, /workspace\.token/);
  assert.doesNotMatch(app, /workspace\.localPath/);
});
