// Called by an owner-authorized controller inside Codex. Credentials and relay identifiers never leave this helper.
const fs = require("node:fs");
const path = require("node:path");
const { ownerRequest } = require("../launcher/electron/council-owner-client.cjs");
const { assertReady, completedAnswer, observeAnswer } = require("../launcher/electron/project-relay-desktop.cjs");
const { verifyPrivatePath } = require("../launcher/electron/private-path.cjs");
const { recordCourierFailure, acknowledgeCourierRecovery } = require("../launcher/electron/courier-diagnostic.cjs");

const CODEX_THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function runtimeHome() {
  const root = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  if (!root || !path.isAbsolute(root)) throw new Error("The Personal bridge requires its configured absolute runtime home");
  return path.resolve(root);
}

function personalOwnerRequest(operation, body) {
  runtimeHome();
  return ownerRequest(operation, body, { personal: true });
}

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
  if (candidate.turn.state === "submitted") return { threadId: candidate.peer.conversation };
  return { threadId: candidate.peer.conversation, prompt: candidate.turn.prompt };
}

async function exactCompletionAssignment(send, worker, nativeSnapshot) {
  const snapshot = await send("project-relay/list");
  const matches = [];
  for (const session of snapshot?.relays || []) {
    for (const turn of session.turns || []) {
      const candidate = nativeTurn(session, turn);
      if (!candidate || turn.worker !== worker || !["submitted", "completed"].includes(turn.state)) continue;
      const job = jobFor(session, turn);
      try {
        const result = completedAnswer(job, nativeSnapshot);
        if (turn.state === "completed" && turn.receipt !== result.receipt) continue;
        matches.push({ ...candidate, result, alreadyCompleted: turn.state === "completed" });
      } catch {}
    }
  }
  return exactlyOne(matches, "Native snapshot does not exactly match one CWC submitted delivery");
}

async function run(request, send = personalOwnerRequest, rawControllerId = process.env.CODEX_THREAD_ID) {
  const fields = {
    claim: ["operation"],
    prepare: ["operation", "snapshot"],
    complete: ["operation", "snapshot"],
    observe: ["operation", "snapshot"],
    sent: ["operation", "result"],
    fail: ["operation", "result"],
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
    return claimed.state === "submitted" ? { threadId: claimed.target.conversation }
      : { threadId: claimed.target.conversation, prompt: claimed.prompt };
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
    const candidate = await exactCompletionAssignment(send, worker, request.snapshot);
    if (!candidate.alreadyCompleted) {
      await send("project-relay/complete", {
        ...internalIds(candidate.session, candidate.turn),
        ...candidate.result,
      });
    }
    return undefined;
  }

  if (request.operation === "observe") {
    const candidate = await currentAssignment(send, worker);
    if (candidate.turn.state !== "submitted") throw new Error("Desktop delivery has not been submitted");
    if (Date.now() - candidate.turn.claimedAt > 20 * 60_000) throw new Error("Native receipt deadline exceeded");
    const result = observeAnswer(jobFor(candidate.session, candidate.turn), request.snapshot);
    if (!result) return { threadId: candidate.peer.conversation };
    await send("project-relay/complete", { ...internalIds(candidate.session, candidate.turn), ...result });
    return undefined;
  }

  if (request.operation === "sent" && request.result && typeof request.result === "object"
    && request.result.isError !== true && !request.result.error) return undefined;

  const candidate = await currentAssignment(send, worker);
  await send("project-relay/fail", {
    ...internalIds(candidate.session, candidate.turn),
    reason: "Native courier tool failed; inspect the local courier request.",
  });
  return undefined;
}

async function runCli(filename) {
  let request;
  try {
    const root = runtimeHome();
    if (!filename || !path.isAbsolute(filename)) throw new Error("Bridge request path must be absolute");
    verifyPrivatePath(filename, { personalRoot: root });
    if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new Error("Bridge request exceeds 2 MiB");
    request = JSON.parse(fs.readFileSync(filename, "utf8"));
    const value = await run(request);
    if (request.operation === "claim" || (["complete", "observe"].includes(request.operation) && value === undefined)) {
      acknowledgeCourierRecovery(root, controllerId(process.env.CODEX_THREAD_ID));
    }
    if (value !== undefined) console.log(JSON.stringify(value));
    return 0;
  } catch {
    // The courier never diagnoses or reports project status. Store only a bounded generic
    // diagnostic locally, then settle the matching delivery in CWC when the API is reachable.
    try {
      const root = runtimeHome();
      const worker = controllerId(process.env.CODEX_THREAD_ID);
      verifyPrivatePath(filename, { personalRoot: root });
      recordCourierFailure(root, worker, String(request?.operation ?? "request").slice(0, 32), filename);
      const candidate = await currentAssignment(personalOwnerRequest, worker);
      if (request?.operation === "claim" || request?.operation === "prepare" || candidate.turn.state === "submitted") await personalOwnerRequest("project-relay/fail", {
        ...internalIds(candidate.session, candidate.turn), reason: "Desktop courier failed; inspect the local courier request.",
      });
    } catch {} // A disconnected runtime can still display the retained local diagnostic later.
    return 1;
  }
}
if (require.main === module) runCli(process.argv[2]).then(code => { process.exitCode = code; });
module.exports = { run, runCli };
