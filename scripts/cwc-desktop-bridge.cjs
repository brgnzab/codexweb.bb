// Called by an owner-authorized controller inside Codex. Credentials never leave this process.
const fs = require("node:fs");
const path = require("node:path");
const { ownerRequest } = require("../launcher/electron/council-owner-client.cjs");
const { assertReady, completedAnswer } = require("../launcher/electron/project-relay-desktop.cjs");

async function run(request, send = ownerRequest) {
  const fields = {
    list: ["operation"],
    claim: ["operation", "worker"],
    prepare: ["operation", "relay_id", "delivery_id", "lease", "snapshot"],
    complete: ["operation", "relay_id", "delivery_id", "lease", "snapshot"],
    fail: ["operation", "relay_id", "delivery_id", "lease", "reason"],
  };
  if (!request || typeof request !== "object" || Array.isArray(request) || !fields[request.operation] || Object.keys(request).some(key => !fields[request.operation].includes(key))) throw new Error("Invalid desktop bridge request");
  if (request.operation === "list") return send("project-relay/list");
  if (request.operation === "claim") return send("project-relay/claim", { worker: request.worker });
  const ids = { relay_id: request.relay_id, delivery_id: request.delivery_id, lease: request.lease };
  if (request.operation === "fail") return send("project-relay/fail", { ...ids, reason: request.reason });
  const snapshot = await send("project-relay/list");
  const session = snapshot.relays.find(relay => relay.id === ids.relay_id);
  const turn = session?.turns.find(turn => turn.id === ids.delivery_id);
  if (!turn || turn.lease !== ids.lease) throw new Error("Desktop delivery lease does not match");
  const job = { target: session.peers[turn.peer], prompt: turn.prompt, worker: turn.worker };
  if (request.operation === "prepare") {
    if (turn.state !== "claimed") throw new Error("Delivery is no longer eligible to send; reconcile only");
    assertReady(job, request.snapshot);
    await send("project-relay/submitting", ids);
    return { sendOnce: true, threadId: job.target.conversation, prompt: job.prompt };
  }
  const result = completedAnswer(job, request.snapshot);
  return send("project-relay/complete", { ...ids, ...result });
}

if (require.main === module) {
  const filename = process.argv[2];
  if (!filename || !path.isAbsolute(filename)) { console.error("Usage: node scripts/cwc-desktop-bridge.cjs <absolute-request-json-path>"); process.exitCode = 1; }
  else {
    Promise.resolve().then(() => {
      if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new Error("Bridge request exceeds 2 MiB");
      return run(JSON.parse(fs.readFileSync(filename, "utf8")));
    }).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = { run };
