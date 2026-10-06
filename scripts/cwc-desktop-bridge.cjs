// Mechanical CWC desktop courier helper. Project state and internal relay identifiers stay inside CWC.
const fs = require("node:fs");
const path = require("node:path");
const { ownerRequest } = require("../launcher/electron/council-owner-client.cjs");
const { assertReady, completedAnswer } = require("../launcher/electron/project-relay-desktop.cjs");
const { verifyPrivatePath } = require("../launcher/electron/private-path.cjs");

const CODEX_THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CLAIM_WAIT_MS = 20 * 60_000;
const CLAIM_POLL_MS = 500;

function controllerId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!CODEX_THREAD_ID.test(id)) throw new Error("Run the desktop bridge inside the owner-authorized Codex controller chat; CODEX_THREAD_ID is missing");
  return id;
}
function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function runtimeHome() {
  const root = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  if (!root || !path.isAbsolute(root)) throw new Error("CWC runtime home is unavailable");
  return path.resolve(root);
}
function runtimeHomeFromRequestFile(filename) {
  if (!filename || !path.isAbsolute(filename)) throw new Error("Bridge request path must be absolute");
  const requestsDir = path.dirname(path.resolve(filename));
  const councilDir = path.dirname(requestsDir);
  if (path.basename(requestsDir) !== "bridge-requests" || path.basename(councilDir) !== "council") {
    throw new Error("Bridge requests must be inside CWC_HOME/council/bridge-requests");
  }
  return path.dirname(councilDir);
}
function configureRuntimeHome(filename) {
  const inferred = runtimeHomeFromRequestFile(filename);
  const configured = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  if (configured && !samePath(configured, inferred)) throw new Error("Bridge request does not belong to the configured CWC runtime");
  process.env.CODEX_CHATGPT_WEB_HOME = inferred;
  return inferred;
}
function personalOwnerRequest(operation, body) {
  runtimeHome();
  return ownerRequest(operation, body, { personal: true });
}
function jobFor(session, turn) {
  return { target: session.peers[turn.peer], prompt: turn.prompt, worker: turn.worker, baselineTurnId: turn.nativeBaselineTurnId };
}
function internalIds(session, turn) { return { relay_id: session.id, delivery_id: turn.id, lease: turn.lease }; }
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
function pendingNativeRelay(snapshot, worker) {
  return (snapshot?.relays || []).some(session =>
    session?.state === "running"
    && Array.isArray(session.peers)
    && session.peers.some(peer =>
      peer?.kind !== "gw"
      && typeof peer?.conversation === "string"
      && peer.conversation.toLowerCase() !== worker
    )
  );
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
  return candidate.turn.state === "submitted"
    ? { threadId: candidate.peer.conversation }
    : { threadId: candidate.peer.conversation, prompt: candidate.turn.prompt };
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
    fail: ["operation", "reason"],
  };
  if (!request || typeof request !== "object" || Array.isArray(request) || !fields[request.operation]
    || Object.keys(request).some(key => !fields[request.operation].includes(key))) throw new Error("Invalid desktop bridge request");
  const worker = controllerId(rawControllerId);

  if (request.operation === "claim") {
    const existing = activeAssignments(await send("project-relay/list"), worker);
    if (existing.length > 1) throw new Error("CWC bridge has multiple active assignments; stop and inspect relay state");
    if (existing.length === 1) return visibleAssignment(existing[0]);
    const claimed = await send("project-relay/claim", { worker });
    if (!claimed) return null;
    return claimed.state === "submitted"
      ? { threadId: claimed.target.conversation }
      : { threadId: claimed.target.conversation, prompt: claimed.prompt };
  }
  if (request.operation === "prepare") {
    const candidate = await currentAssignment(send, worker);
    if (candidate.turn.state !== "claimed") throw new Error("Current CWC assignment already crossed the submission boundary; never replay it");
    const { baselineTurnId } = assertReady(jobFor(candidate.session, candidate.turn), request.snapshot);
    await send("project-relay/submitting", {
      ...internalIds(candidate.session, candidate.turn),
      ...(baselineTurnId ? { baseline_turn_id: baselineTurnId } : {}),
    });
    return visibleAssignment(candidate);
  }
  if (request.operation === "complete") {
    const candidate = await exactCompletionAssignment(send, worker, request.snapshot);
    if (!candidate.alreadyCompleted) await send("project-relay/complete", {
      ...internalIds(candidate.session, candidate.turn),
      ...candidate.result,
    });
    return undefined;
  }
  const candidate = await currentAssignment(send, worker);
  await send("project-relay/fail", { ...internalIds(candidate.session, candidate.turn), reason: request.reason });
  return undefined;
}
async function claimUntilReady(
  send = personalOwnerRequest,
  rawControllerId = process.env.CODEX_THREAD_ID,
  { waitMs = CLAIM_WAIT_MS, pollMs = CLAIM_POLL_MS, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {},
) {
  const worker = controllerId(rawControllerId);
  const deadline = now() + Math.max(0, waitMs);
  for (;;) {
    const assignment = await run({ operation: "claim" }, send, worker);
    if (assignment) return assignment;
    const snapshot = await send("project-relay/list");
    if (!pendingNativeRelay(snapshot, worker)) return null;
    if (now() >= deadline) throw new Error("CWC courier timed out waiting for the next native assignment");
    await sleep(Math.max(0, pollMs));
  }
}
async function runCli(filename) {
  try {
    const root = configureRuntimeHome(filename);
    verifyPrivatePath(filename, { personalRoot: root });
    if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new Error("Bridge request exceeds 2 MiB");
    const request = JSON.parse(fs.readFileSync(filename, "utf8"));
    const value = request?.operation === "claim" ? await claimUntilReady() : await run(request);
    if (value !== undefined) console.log(JSON.stringify(value));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
if (require.main === module) runCli(process.argv[2]).then(code => { process.exitCode = code; });
module.exports = { CLAIM_POLL_MS, CLAIM_WAIT_MS, claimUntilReady, pendingNativeRelay, run, runCli, runtimeHomeFromRequestFile };
