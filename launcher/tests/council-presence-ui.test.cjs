const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const types = readFileSync(join(root, "src", "types.ts"), "utf8");
const presence = readFileSync(join(root, "src", "council-presence.ts"), "utf8");

test("shared projection types keep presence freshness separate from explicit agent status", () => {
  assert.match(types, /CouncilAgentPresenceView/);
  assert.match(types, /freshness:\s*"unknown"/);
  assert.match(types, /freshness:\s*"fresh"\s*\|\s*"stale"/);
  assert.match(types, /leaseExpiresAt:\s*string/);
  assert.match(types, /presence:\s*CouncilAgentPresenceView\[\]/);
});

test("effective presence ages a fresh server lease stale using the renderer clock", () => {
  assert.match(presence, /export function effectivePresenceFreshness/);
  assert.match(presence, /Date\.parse\(presence\.leaseExpiresAt\)/);
  assert.match(presence, /leaseExpiresAt.*nowMs|nowMs.*leaseExpiresAt/s);
  assert.match(presence, /"unknown"/);
  assert.match(presence, /"fresh"/);
  assert.match(presence, /"stale"/);
});
