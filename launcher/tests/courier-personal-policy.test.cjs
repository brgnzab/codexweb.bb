const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { claimUntilReady, run, runtimeHomeFromRequestFile } = require("../../scripts/cwc-desktop-bridge.cjs");

const worker = "10000000-0000-0000-0000-000000000001";
const destination = "20000000-0000-0000-0000-000000000002";

function runningRelay(turn) {
  return {
    relays: [{
      id: "relay",
      state: "running",
      peers: [
        { kind: "gw", conversation: "https://chatgpt.com/c/source" },
        { kind: "codex", conversation: destination },
      ],
      turns: turn ? [turn] : [{ id: "gw-turn", peer: 0, state: "submitted", prompt: "web work" }],
    }],
  };
}

test("mechanical claim wait does not treat a temporary null as relay completion", async () => {
  let claims = 0;
  const claimed = {
    target: { kind: "codex", conversation: destination },
    prompt: "exact payload",
    relayId: "hidden-relay",
    deliveryId: "hidden-delivery",
    lease: "hidden-lease",
    state: "claimed",
  };
  const send = async operation => {
    if (operation === "project-relay/list") return runningRelay();
    if (operation === "project-relay/claim") return ++claims < 3 ? null : claimed;
    throw new Error(`Unexpected operation ${operation}`);
  };
  const result = await claimUntilReady(send, worker, {
    waitMs: 100,
    pollMs: 0,
    sleep: async () => {},
  });
  assert.deepEqual(result, { threadId: destination, prompt: "exact payload" });
  assert.equal(claims, 3);
});

test("mechanical claim wait ends only after the relay is actually terminal", async () => {
  let listCalls = 0;
  const send = async operation => {
    if (operation === "project-relay/claim") return null;
    if (operation === "project-relay/list") {
      listCalls++;
      return { relays: [{ ...runningRelay().relays[0], state: "completed" }] };
    }
    throw new Error(`Unexpected operation ${operation}`);
  };
  assert.equal(await claimUntilReady(send, worker, { waitMs: 50, pollMs: 0, sleep: async () => {} }), null);
  assert.ok(listCalls >= 2);
});

test("controller failure passes the concrete reason into CWC without exposing ids to the controller", async () => {
  let failure;
  const turn = { id: "delivery", peer: 1, prompt: "exact payload", state: "claimed", lease: "hidden-lease", worker, claimedAt: Date.now() };
  const send = async (operation, body) => {
    if (operation === "project-relay/list") return runningRelay(turn);
    if (operation === "project-relay/fail") { failure = body; return { accepted: true }; }
    throw new Error(`Unexpected operation ${operation}`);
  };
  await run({ operation: "fail", reason: "approval review rejected the message" }, send, worker);
  assert.equal(failure.reason, "approval review rejected the message");
  assert.deepEqual(Object.keys(failure).sort(), ["delivery_id", "lease", "reason", "relay_id"]);
});

test("request-file path mechanically selects the correct portable runtime home", () => {
  const root = path.join(os.tmpdir(), "cwc-portable", "data", "core");
  const request = path.join(root, "council", "bridge-requests", "claim.json");
  assert.equal(runtimeHomeFromRequestFile(request), path.resolve(root));
  assert.throws(() => runtimeHomeFromRequestFile(path.join(root, "council", "claim.json")), /bridge-requests/);
});
