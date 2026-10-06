const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  relayBlocksCacheClear,
  restoreUncertainSubmissionTombstones,
  uncertainSubmissionTombstones,
} = require("../electron/project-relay-cache.cjs");

function relay(state, turnState = "completed") {
  return {
    id: "relay-1",
    requestId: "request-1",
    name: "Relay",
    task: "Do work",
    peers: [
      { name: "A", kind: "codex", conversation: "00000000-0000-0000-0000-000000000000" },
      { name: "B", kind: "work", conversation: "00000000-0000-0000-0000-000000000001" },
    ],
    maxTurns: 4,
    segmentStartTurn: 0,
    state,
    turns: [{
      id: "delivery-1",
      peer: 1,
      prompt: "exact payload",
      state: turnState,
      lease: "lease-1",
      worker: "10000000-0000-0000-0000-000000000001",
      nativeBaselineTurnId: "native-before-send",
    }],
    result: "connection lost",
    event: "Submission outcome uncertain",
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:01.000Z",
  };
}

test("clear-cache gate treats terminal uncertain submitted evidence as a tombstone, not active work", () => {
  assert.equal(relayBlocksCacheClear(relay("running", "submitted")), true);
  assert.equal(relayBlocksCacheClear(relay("uncertain", "submitted")), false);
  assert.equal(relayBlocksCacheClear(relay("terminated", "submitted")), false);
  assert.equal(relayBlocksCacheClear(relay("stopped", "submitted")), false);
  assert.equal(relayBlocksCacheClear(relay("completed", "completed")), false);
});

test("uncertain submitted tombstone retains only durable exact-correlation evidence", () => {
  const value = relay("uncertain", "submitted");
  value.turns.unshift({ id: "old", peer: 0, prompt: "old", state: "completed", answer: "old answer" });
  const [tombstone] = uncertainSubmissionTombstones([value]);
  assert.equal(tombstone.state, "uncertain");
  assert.equal(tombstone.segmentStartTurn, 0);
  assert.equal(tombstone.turns.length, 1);
  assert.deepEqual(tombstone.turns[0], value.turns.at(-1));
  const [stoppedTombstone] = uncertainSubmissionTombstones([relay("stopped", "submitted")]);
  assert.equal(stoppedTombstone.state, "uncertain");
  assert.equal(stoppedTombstone.turns[0].state, "submitted");
  const [terminatedTombstone] = uncertainSubmissionTombstones([relay("terminated", "submitted")]);
  assert.equal(terminatedTombstone.state, "uncertain");
  assert.equal(terminatedTombstone.turns[0].state, "submitted");
  assert.equal(uncertainSubmissionTombstones([relay("uncertain", "completed")]).length, 0);
});

test("clear cache restores uncertain tombstone in the existing project-relays store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-relay-tombstone-"));
  try {
    const tombstones = uncertainSubmissionTombstones([relay("uncertain", "submitted")]);
    assert.equal(restoreUncertainSubmissionTombstones(root, tombstones), true);
    const stored = JSON.parse(fs.readFileSync(path.join(root, "council", "project-relays.json"), "utf8"));
    assert.equal(stored.version, 1);
    assert.equal(stored.sessions.length, 1);
    assert.equal(stored.sessions[0].turns[0].state, "submitted");
    assert.equal(stored.sessions[0].turns[0].prompt, "exact payload");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
