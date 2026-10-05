// Called by an owner-authorized controller inside Codex. Credentials and relay identifiers never leave this helper.
const fs = require("node:fs");
const path = require("node:path");
const { ownerRequest } = require("../launcher/electron/council-owner-client.cjs");
const { assertReady, completedAnswer } = require("../launcher/electron/project-relay-desktop.cjs");

const CODEX_THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function controllerId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!CODEX_THREAD_ID.test(id)) throw new Error("Run the desktop bridge inside the owner-authorized Codex controller chat; CODEX_THREAD_ID is missing");
  return id;
}

function jobFor(session, turn) {
  return {
    target: session.peers[turn.peer],
    prompt: turn.prompt,
    worker: turn.worker,
    baselineTurnId: turn.nativeBaselineTurnId,
  };
}

function internalIds(session, turn) {
  return { relay_id: session.id, delivery_id: turn.id, lease: turn.lease };
}

function nativeTurn(session, turn) {
  const peer = session?.peers?.[turn?.peer];
  return peer && peer.kind !== "gw" ? { session, turn, peer } : null;
}

function activeAssignments(snapshot, worker) {
  const matches = [];
  for (const session of snapshot?.relays || []) {
    if (session.state !== "running") continue;
    const turn = session.turns?.at?.(-1);
    const candidate = nativeTurn(session, turn);
    if (!candidate || turn.worker !== worker || !["claimed", "submitted"].includes(turn.state)) continue;
    matches.push(candidate);
  }
  return matches;
}

function exactlyOne(values, message) {
  if (values.length !== 1) throw new Error(values.length ? `${message}: multiple current assignments exist` : `${message}: no current assignment exists`);
  return values[0];
}

async function currentAssignment(send, worker) {
  const snapshot = await send("project-relay/list");
  return exactlyOne(activeAssignments(snapshot, worker), "CWC bridge assignment is unavailable");
}

function visibleAssignment(candidate) {
  return { threadId: candidate.peer.conversation, prompt: candidate.turn.prompt };
}

async function exactSubmittedAssignment(send, worker, nativeSnapshot) {
  const snapshot = await send("project-relay/list");
  const matches = [];
  for (const session of snapshot?.relays || []) {
    const turn = session.turns?.at?.(-1);
    const candidate = nativeTurn(session, turn);
    if (!candidate || turn.worker !== worker || turn.state !== "submitted") continue;
    const job = jobFor(session, turn);
    try {
      const result = completedAnswer(job, nativeSnapshot);
      matches.push({ ...candidate, result });
    } catch {}
  }
  return exactlyOne(matches, "Native snapshot does not exactly match one submitted CWC delivery");
}

async function run(request, send = ownerRequest, rawControllerId = process.env.CODEX_THREAD_ID) {
  const fields = {
    claim: ["operation"],
    prepare: ["operation", "snapshot"],
    complete: ["operation", "snapshot"],
    fail: ["operation", "reason"],
  };
  if (!request || typeof request !== "object" || Array.isArray(request) || !fields[request.operation] || Object.keys(request).some(key => !fields[request.operation].includes(key))) {
    throw new Error("Invalid desktop bridge request");
  }
  const worker = controllerId(rawControllerId);

  if (request.operation === "claim") {
    const existing = activeAssignments(await send("project-relay/list"), worker);
    if (existing.length > 1) throw new Error("CWC bridge has multiple active assignments; stop and inspect relay state");
    if (existing.length === 1) return visibleAssignment(existing[0]);
    const claimed = await send("project-relay/claim", { worker });
    if (!claimed) return null;
    return { threadId: claimed.target.conversation, prompt: claimed.prompt };
  }

  if (request.operation === "prepare") {
    const candidate = await currentAssignment(send, worker);
    if (candidate.turn.state !== "claimed") throw new Error("Current CWC assignment already crossed the submission boundary; never replay it");
    const job = jobFor(candidate.session, candidate.turn);
    const { baselineTurnId } = assertReady(job, request.snapshot);
    await send("project-relay/submitting", {
      ...internalIds(candidate.session, candidate.turn),
      ...(baselineTurnId ? { baseline_turn_id: baselineTurnId } : {}),
    });
    return visibleAssignment(candidate);
  }

  if (request.operation === "complete") {
    const candidate = await exactSubmittedAssignment(send, worker, request.snapshot);
    await send("project-relay/complete", {
      ...internalIds(candidate.session, candidate.turn),
      ...candidate.result,
    });
    return undefined;
  }

  const candidate = await currentAssignment(send, worker);
  await send("project-relay/fail", {
    ...internalIds(candidate.session, candidate.turn),
    reason: request.reason,
  });
  return undefined;
}

if (require.main === module) {
  const filename = process.argv[2];
  if (!filename || !path.isAbsolute(filename)) { console.error("Usage: node scripts/cwc-desktop-bridge.cjs <absolute-request-json-path>"); process.exitCode = 1; }
  else {
    Promise.resolve().then(() => {
      if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new Error("Bridge request exceeds 2 MiB");
      return run(JSON.parse(fs.readFileSync(filename, "utf8")));
    }).then(value => { if (value !== undefined) console.log(JSON.stringify(value)); }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = { run };
