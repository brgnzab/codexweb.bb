import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { CouncilExecutionPhase } from "./autonomy-errors";
import { assertChatGptConversationUrl } from "./conversation-registry";
import { readCourierFailure } from "../../launcher/electron/courier-diagnostic.cjs";

export type RelayPeer = { name: string; kind: "gw" | "codex" | "work"; conversation: string };
export type RelayState = "running" | "completed" | "blocked" | "uncertain" | "failed" | "terminated" | "uat-ready" | "stopped" | "cancelled";
type TurnState = "queued" | "claimed" | "submitted" | "completed" | "failed";
export type RelayTurn = { id: string; peer: number; prompt: string; state: TurnState; answer?: string; signal?: string; lease?: string; worker?: string; claimedAt?: number; receipt?: string; nativeBaselineTurnId?: string };
export type ProjectRelay = { id: string; requestId: string; name: string; task: string; peers: [RelayPeer, RelayPeer]; maxTurns: number; segmentStartTurn?: number; state: RelayState; turns: RelayTurn[]; result?: string; event?: string; createdAt: string; updatedAt?: string };
export type RelayInput = { requestId: string; name: string; task: string; peers: [RelayPeer, RelayPeer]; maxTurns?: number; resumeId?: string };
export interface RelayGwDriver { run(peer: RelayPeer, prompt: string, deliveryId: string, onPhase?: (phase: CouncilExecutionPhase) => void): Promise<string> }
const terminal = new Set<RelayState>(["completed", "blocked", "uncertain", "failed", "terminated", "uat-ready", "stopped", "cancelled"]);
const globallyReserved = new Set<RelayState>(["running", "terminated"]);
function conversationKey(peer: RelayPeer): string { return peer.kind === "gw" ? new URL(peer.conversation).pathname.slice(3).toLowerCase() : peer.conversation.toLowerCase(); }
function submittedTombstone(session: ProjectRelay): RelayTurn | undefined {
  const turn = session.turns.at(-1);
  return session.state !== "running" && turn?.state === "submitted" && !turn.receipt ? turn : undefined;
}
function reservesBindings(session: ProjectRelay): boolean { return globallyReserved.has(session.state); }
function quarantinesConversation(session: ProjectRelay, key: string): boolean {
  const turn = submittedTombstone(session);
  return Boolean(turn && conversationKey(session.peers[turn.peer]!) === key);
}
function conflictsWithPeers(session: ProjectRelay, peers: RelayPeer[]): boolean {
  if (reservesBindings(session)) return session.peers.some(peer => peers.some(other => conversationKey(other) === conversationKey(peer)));
  return peers.some(peer => quarantinesConversation(session, conversationKey(peer)));
}
function resetClaim(turn: RelayTurn): void { turn.lease = undefined; turn.worker = undefined; turn.claimedAt = undefined; }
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text of at most ${max} characters`);
  return value.trim();
}
function exactText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text of at most ${max} characters`);
  return value;
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid relay object fields");
}
function preSubmitFailureEvent(reason: string): string {
  return /composer did not preserve the complete prompt|prompt integrity/i.test(reason) ? "Composer integrity failure" : "Delivery failed before submit";
}
function repeatedExchange(turns: RelayTurn[]): boolean {
  const completed = turns.filter(turn => turn.state === "completed" && typeof turn.answer === "string");
  if (completed.length < 4) return false;
  const last = completed.slice(-4);
  return last[0]!.answer === last[2]!.answer && last[1]!.answer === last[3]!.answer;
}
const CODEX_THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function codexThreadId(value: unknown): string {
  const id = text(value, "Codex Bridge Thread", 100).toLowerCase();
  if (!CODEX_THREAD_ID.test(id)) throw new Error("Use the exact existing Codex thread ID");
  return id;
}
export type CodexBridgeStatus = { configuredThread: string | null; connected: boolean; worker?: string; lastSeen?: string; error?: string };
export function relayPeer(value: unknown): RelayPeer {
  exact(value, ["name", "kind", "conversation"]);
  const name = text(value.name, "Peer name", 100);
  const kind = value.kind;
  if (kind !== "gw" && kind !== "codex" && kind !== "work") throw new Error("Unknown relay peer kind");
  let conversation = text(value.conversation, "Conversation", 1000);
  if (kind === "gw") conversation = assertChatGptConversationUrl(conversation);
  else {
    conversation = conversation.replace(/^codex:\/\/threads\//, "").toLowerCase();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(conversation)) throw new Error("Use the exact existing desktop chat ID");
  }
  return { name, kind, conversation };
}
export function parseRelayAnswer(answer: string): { body: string; signal: "CONTINUE" | "BLOCKED" | "UAT_READY" } {
  const bounded = exactText(answer, "Relay response", 48000);
  const match = /(?:^|\r?\n)CWC_STATE: (CONTINUE|BLOCKED|UAT_READY)\s*$/.exec(bounded);
  // A missing/malformed hint must not trigger another submission to repair formatting.
  // Keep protocol status in CWC. Preserve every message character outside the recognized footer.
  if (!match || (bounded.match(/^CWC_STATE:/gm) ?? []).length !== 1) return { body: bounded, signal: "CONTINUE" };
  const body = bounded.slice(0, match.index);
  if (!body.trim()) throw new Error("Relay response has no visible result");
  return { body, signal: match[1] as "CONTINUE" | "BLOCKED" | "UAT_READY" };
}

/** Durable two-peer routing. CWC relays owner/participant text exactly and only parses relay state. */
export class ProjectRelayService {
  private sessions: ProjectRelay[];
  private pumping = false;
  private rerun = false;
  private stopped = false;
  private storageError?: Error;
  private controllerError?: Error;
  private controllerThreadId?: string;
  private bridge?: { worker: string; lastSeen: number };
  constructor(private path: string, private gw: RelayGwDriver, private now = () => Date.now(), private controllerPath?: string) {
    const file = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, sessions: [] };
    this.loadController();
    if (file.version !== 1 || !Array.isArray(file.sessions)) throw new Error("Invalid project relay state");
    this.sessions = file.sessions;
    for (const session of this.sessions) {
      if (!session || typeof session.id !== "string" || !Array.isArray(session.peers) || session.peers.length !== 2 || !Array.isArray(session.turns) || !session.turns.length || !["running", ...terminal].includes(session.state)) throw new Error("Invalid stored relay");
      session.peers = session.peers.map(relayPeer) as [RelayPeer, RelayPeer];
      session.updatedAt ??= session.createdAt;
      session.segmentStartTurn ??= 0;
      if (!Number.isInteger(session.maxTurns) || session.maxTurns < 2 || session.maxTurns > 100) throw new Error("Invalid stored relay budget");
      if (!Number.isInteger(session.segmentStartTurn) || session.segmentStartTurn < 0 || session.segmentStartTurn > session.turns.length) throw new Error("Invalid stored relay segment");
      for (const turn of session.turns) {
        if (!turn || ![0, 1].includes(turn.peer) || typeof turn.id !== "string" || typeof turn.prompt !== "string" || !["queued", "claimed", "submitted", "completed", "failed"].includes(turn.state)) throw new Error("Invalid stored relay delivery");
        if (turn.nativeBaselineTurnId !== undefined && (typeof turn.nativeBaselineTurnId !== "string" || !turn.nativeBaselineTurnId || turn.nativeBaselineTurnId.length > 200)) throw new Error("Invalid stored native submission baseline");
      }
    }
    for (const session of this.sessions) {
      if (session.state === "cancelled") session.state = "stopped";
      if (session.state !== "running") continue;
      const turn = session.turns.at(-1)!;
      if (turn.state === "claimed") { turn.state = "queued"; resetClaim(turn); }
      session.state = "terminated";
      session.result = turn.state === "submitted"
        ? "CWC stopped unexpectedly after the submission boundary. Exact-response reconciliation is required before Resume."
        : "CWC stopped unexpectedly before submission. Resume is safe when the owner is ready.";
      this.mark(session, turn.state === "submitted" ? "Terminated after submission; reconciliation required" : "Relay terminated unexpectedly");
    }
    this.persist();
  }
  private mark(session: ProjectRelay, event: string): void {
    session.event = event;
    session.updatedAt = new Date(this.now()).toISOString();
  }
  private persist(): void {
    if (this.storageError) throw this.storageError;
    try {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, sessions: this.sessions }), { mode: 0o600, flag: "wx" });
    renameSync(temp, this.path);
    } catch (error) {
      this.storageError = new Error("Project relay storage failed; delivery is stopped until storage is restored and CWC restarts", { cause: error });
      this.stopped = true;
      throw this.storageError;
    }
  }
  private loadController(): void {
    if (!this.controllerPath || !existsSync(this.controllerPath)) return;
    try {
      const value = JSON.parse(readFileSync(this.controllerPath, "utf8")) as Record<string, unknown>;
      if (!value || value.version !== 1 || !("controllerThreadId" in value) || Object.keys(value).some(key => key !== "version" && key !== "controllerThreadId")) {
        throw new Error("invalid schema");
      }
      if (value.controllerThreadId === null) this.controllerThreadId = undefined;
      else this.controllerThreadId = codexThreadId(value.controllerThreadId);
    } catch (error) {
      this.controllerThreadId = undefined;
      this.controllerError = new Error("Codex Bridge Thread configuration is invalid; set or clear it from Connections", { cause: error });
    }
  }
  private persistController(controllerThreadId?: string): void {
    if (!this.controllerPath) throw new Error("Codex Bridge Thread configuration is unavailable");
    try {
      mkdirSync(dirname(this.controllerPath), { recursive: true, mode: 0o700 });
      const temp = `${this.controllerPath}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, controllerThreadId: controllerThreadId ?? null }), { mode: 0o600, flag: "wx" });
      renameSync(temp, this.controllerPath);
    } catch (error) {
      throw new Error("Codex Bridge Thread configuration could not be saved", { cause: error });
    }
  }
  private assertControllerMutationSafe(next?: string): void {
    for (const session of this.sessions) {
      for (const turn of session.turns) {
        const peer = session.peers[turn.peer]!;
        if (peer.kind === "gw") continue;
        const activeClaim = turn.state === "claimed" && this.now() - (turn.claimedAt ?? 0) <= 120000;
        if ((session.state === "running" || session.state === "terminated") && (turn.state === "submitted" || activeClaim)) {
          throw new Error("Cannot change Codex Bridge Thread while a native delivery is active or awaiting exact-response reconciliation");
        }
      }
    }
    if (next && this.sessions.some(session => reservesBindings(session) && session.peers.some(peer => peer.kind !== "gw" && peer.conversation === next))) {
      throw new Error("The Codex Bridge Thread cannot also be a participant in an active or unresolved project relay");
    }
  }
  private authorizedController(): string | undefined {
    return this.controllerPath ? this.controllerThreadId : this.bridge?.worker;
  }
  stop(): void { this.stopped = true; }
  list(): ProjectRelay[] { return structuredClone(this.sessions); }
  assertBrowserAccess(conversation: string | undefined, agentId: string): void {
    if (!conversation) return;
    const key = conversationKey({ name: "", kind: "gw", conversation });
    const reservation = this.sessions.find(session =>
      (reservesBindings(session) && session.peers.some(peer => conversationKey(peer) === key))
      || quarantinesConversation(session, key));
    if (!reservation) return;
    const turn = reservation.turns.at(-1)!;
    const ownedBrowserTurn = reservation.state === "running"
      && (turn.state === "claimed" || turn.state === "submitted")
      && agentId === `relay-${turn.id}`
      && conversationKey(reservation.peers[turn.peer]!) === key;
    if (!ownedBrowserTurn) throw new Error("This conversation is reserved by active relay work or an unresolved submission tombstone");
  }
  status(): CodexBridgeStatus {
    const heartbeat = this.bridge && (!this.controllerPath || this.bridge.worker === this.controllerThreadId) ? this.bridge : undefined;
    const error = this.controllerError ?? this.storageError;
    const courierError = readCourierFailure(dirname(dirname(this.path)), this.controllerThreadId, heartbeat?.lastSeen ?? 0);
    return {
      configuredThread: this.controllerThreadId ?? null,
      connected: Boolean(heartbeat && this.now() - heartbeat.lastSeen < 120000),
      ...(heartbeat ? { worker: heartbeat.worker, lastSeen: new Date(heartbeat.lastSeen).toISOString() } : {}),
      ...(error ? { error: error.message } : courierError ? { error: courierError } : {}),
    };
  }
  setController(raw: string): CodexBridgeStatus {
    if (!this.controllerPath) throw new Error("Codex Bridge Thread configuration is unavailable");
    const next = codexThreadId(raw);
    if (next === this.controllerThreadId && !this.controllerError) return this.status();
    this.assertControllerMutationSafe(next);
    this.persistController(next);
    this.controllerThreadId = next;
    this.controllerError = undefined;
    if (this.bridge?.worker !== next) this.bridge = undefined;
    return this.status();
  }
  clearController(): CodexBridgeStatus {
    if (!this.controllerPath) throw new Error("Codex Bridge Thread configuration is unavailable");
    if (!this.controllerThreadId && !this.controllerError) return this.status();
    this.assertControllerMutationSafe();
    this.persistController();
    this.controllerThreadId = undefined;
    this.controllerError = undefined;
    this.bridge = undefined;
    return this.status();
  }
  start(raw: RelayInput): ProjectRelay {
    if (this.stopped) throw this.storageError ?? new Error("Project relay is stopped");
    exact(raw, ["requestId", "name", "task", "peers", "maxTurns", "resumeId"]);
    text(raw.requestId, "Request ID", 100);
    if (raw.resumeId !== undefined) return this.resume(text(raw.resumeId, "Relay ID", 128));
    const requestId = text(raw.requestId, "Request ID", 100);
    const prior = this.sessions.find(session => session.requestId === requestId);
    if (prior) return structuredClone(prior);
    if (this.sessions.length >= 100) throw new Error("Relay history is full; preserve/export history before starting more projects");
    if (!Array.isArray(raw.peers) || raw.peers.length !== 2) throw new Error("Choose exactly two existing chats");
    const peers = raw.peers.map(relayPeer) as [RelayPeer, RelayPeer];
    const controller = this.authorizedController();
    if (controller && peers.some(peer => peer.kind !== "gw" && peer.conversation === controller)) throw new Error("The configured Codex Bridge Thread cannot also be a project participant");
    if (conversationKey(peers[0]) === conversationKey(peers[1])) throw new Error("Choose two different chats");
    if (this.sessions.some(session => conflictsWithPeers(session, peers))) throw new Error("A selected chat already belongs to active relay work or a submission quarantine");
    const maxTurns = raw.maxTurns ?? 20;
    if (!Number.isInteger(maxTurns) || maxTurns < 2 || maxTurns > 100) throw new Error("Turn budget must be 2–100");
    const createdAt = new Date(this.now()).toISOString();
    const session: ProjectRelay = { id: randomUUID(), requestId, name: text(raw.name, "Project name", 160), task: exactText(raw.task, "Task", 12000), peers, maxTurns, segmentStartTurn: 0, state: "running", turns: [], createdAt, updatedAt: createdAt, event: "Relay started" };
    this.next(session, 0, session.task);
    this.sessions.push(session);
    this.persist();
    this.kick();
    return structuredClone(session);
  }
  cancel(id: string): ProjectRelay {
    const session = this.require(id);
    if (session.state === "uat-ready") throw new Error("UAT-ready relay is already complete");
    const turn = session.turns.at(-1)!;
    if (turn.state === "claimed") { turn.state = "queued"; resetClaim(turn); }
    session.state = "stopped";
    session.result = turn.state === "submitted"
      ? "Owner stopped the relay after submission. Exact-response reconciliation is required before Resume."
      : "Owner stopped the relay before submission. Resume is safe when the owner is ready.";
    this.mark(session, "Owner stopped relay");
    this.persist();
    return structuredClone(session);
  }
  resume(id: string): ProjectRelay {
    const session = this.require(id);
    if (session.state === "cancelled") session.state = "stopped";
    if (session.state === "running") throw new Error("Relay is already running");
    if (session.state === "uat-ready") throw new Error("UAT-ready relay is already complete");
    const controller = this.authorizedController();
    if (controller && session.peers.some(peer => peer.kind !== "gw" && peer.conversation === controller)) throw new Error("The configured Codex Bridge Thread cannot also be a project participant");
    const conflict = this.sessions.find(other => other.id !== session.id && conflictsWithPeers(other, session.peers));
    if (conflict) throw new Error("A participant chat is now reserved by active relay work or a submission quarantine");
    const turn = session.turns.at(-1)!;
    if (turn.state === "submitted") throw new Error("This relay cannot Resume until the submitted delivery has exact-response reconciliation; it will not be replayed");
    if (turn.state === "claimed") { turn.state = "queued"; resetClaim(turn); }
    if (turn.state === "failed") {
      if (turn.receipt) throw new Error("This settled delivery failed after an exact response and cannot be replayed safely");
      turn.state = "queued"; turn.answer = undefined; turn.signal = undefined; resetClaim(turn);
    }
    if (turn.state === "completed") this.resumeAfterCompleted(session, turn);
    else if (turn.state === "queued") {
      session.state = "running";
      session.result = "Owner resumed the relay.";
      this.mark(session, "Owner resumed relay");
    } else throw new Error("Relay has no safe continuation point");
    this.persist();
    if (session.state === "running") this.kick();
    return structuredClone(session);
  }
  private segmentHandoffs(session: ProjectRelay): number {
    return session.turns.length - (session.segmentStartTurn ?? 0);
  }
  private resumeAfterCompleted(session: ProjectRelay, turn: RelayTurn): void {
    const answer = turn.answer;
    if (!answer?.trim()) throw new Error("Completed relay delivery has no resumable answer");
    if (session.state === "completed") {
      session.segmentStartTurn = session.turns.length;
      session.state = "running";
      session.result = "Owner started another bounded relay segment.";
      this.next(session, 1 - turn.peer, parseRelayAnswer(answer).body);
      this.mark(session, "New relay segment started");
      return;
    }
    if (turn.signal === "UAT_READY" && turn.peer === 1) {
      session.state = "uat-ready"; session.result = "Review complete; ready for owner UAT."; this.mark(session, "UAT ready"); return;
    }
    if (this.segmentHandoffs(session) >= session.maxTurns) {
      session.segmentStartTurn = session.turns.length;
    }
    if (repeatedExchange(session.turns)) {
      session.state = "blocked"; session.result = "Repeated exchange shows no progress."; this.mark(session, "Repeated response blocked relay"); return;
    }
    session.state = "running";
    session.result = "Owner resumed the relay.";
    this.next(session, 1 - turn.peer, parseRelayAnswer(answer).body);
    this.mark(session, "Owner resumed relay");
  }
  private require(id: string): ProjectRelay { const session = this.sessions.find(value => value.id === id); if (!session) throw new Error("Unknown relay"); return session; }
  private next(session: ProjectRelay, peer: number, prompt: string): void {
    const id = randomUUID();
    session.turns.push({ id, peer, state: "queued", prompt });
  }
  private accept(session: ProjectRelay, turn: RelayTurn, answer: string, receipt: string): void {
    const parsed = parseRelayAnswer(answer);
    turn.answer = answer; turn.signal = parsed.signal; turn.receipt = receipt; turn.state = "completed";
    if (terminal.has(session.state)) { this.mark(session, "Response reconciled"); return; }
    if (parsed.signal === "BLOCKED") {
      session.state = "blocked"; session.result = "Participant reported a blocker."; this.mark(session, "Participant reported blocker");
    } else if (parsed.signal === "UAT_READY" && turn.peer === 1) {
      session.state = "uat-ready"; session.result = "Review complete; ready for owner UAT."; this.mark(session, "UAT ready");
    } else if (this.segmentHandoffs(session) >= session.maxTurns) {
      session.state = "completed"; session.result = "Relay completed its owner-set handoff segment."; this.mark(session, "Handoff segment completed");
    } else if (repeatedExchange(session.turns)) {
      session.state = "blocked"; session.result = "Repeated exchange shows no progress."; this.mark(session, "Repeated response blocked relay");
    } else {
      this.next(session, 1 - turn.peer, parsed.body);
      this.mark(session, "Response received; next handoff queued");
    }
  }
  kick(): void { this.rerun = true; if (!this.pumping && !this.stopped) void this.pump().catch(() => { this.stopped = true; }); }
  async idle(): Promise<void> { while (this.pumping) await new Promise(resolve => setTimeout(resolve, 5)); }
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.rerun && !this.stopped) {
        this.rerun = false;
        for (const session of this.sessions) {
          const turn = session.turns.at(-1);
          if (this.stopped || session.state !== "running" || turn?.state !== "queued" || session.peers[turn.peer]!.kind !== "gw") continue;
          // A GPT Web turn is only submitted once the browser driver reaches submit-started.
          // Before that boundary an unexpected stop is safe to Resume without a duplicate send.
          turn.state = "claimed";
          turn.worker = `relay-${turn.id}`;
          turn.claimedAt = this.now();
          this.mark(session, "Preparing handoff");
          this.persist();
          // This local boundary marker is visible to the outer catch; TypeScript
          // cannot infer the turn-state mutation made inside the driver callback.
          let submissionStarted = false;
          try {
            const answer = await this.gw.run(session.peers[turn.peer]!, turn.prompt, turn.id, observedPhase => {
              if (observedPhase !== "submit-started") return;
              if (session.state !== "running" || turn.state !== "claimed") throw new Error("Project relay stopped before submission");
              submissionStarted = true;
              turn.state = "submitted";
              this.mark(session, "Handoff submitted");
              this.persist();
            });
            this.accept(session, turn, answer, turn.id);
          } catch (error) {
            if (session.state === "running") {
              const reason = error instanceof Error ? error.message : "Relay delivery failed";
              if (submissionStarted) {
                session.state = "uncertain";
                session.result = reason;
                this.mark(session, "Submission outcome uncertain");
              } else {
                turn.state = "failed";
                resetClaim(turn);
                session.state = "failed";
                session.result = reason;
                this.mark(session, preSubmitFailureEvent(reason));
              }
            }
          }
          this.persist(); this.rerun = true;
        }
      }
    } finally { this.pumping = false; }
  }
  /** Native Codex/Work host claims only owner-bound targets; no chat discovery here. */
  claim(worker: string): unknown {
    if (this.stopped) throw this.storageError ?? new Error("Project relay is stopped");
    let workerId = text(worker, "Bridge worker", 100);
    if (this.controllerPath) {
      if (this.controllerError) throw this.controllerError;
      workerId = codexThreadId(workerId);
      if (!this.controllerThreadId) throw new Error("Configure a Codex Bridge Thread in Connections before claiming native relay work");
      if (workerId !== this.controllerThreadId) throw new Error("This Codex thread is not the configured CWC controller");
    }
    this.bridge = { worker: workerId, lastSeen: this.now() };
    for (const session of this.sessions) {
      const turn = session.turns.at(-1)!;
      const peer = session.peers[turn.peer]!;
      if (peer.kind === "gw" || peer.conversation === workerId) continue;
      if (session.state === "terminated" && turn.state === "submitted" && turn.worker === workerId) return this.job(session, turn); // restart reconciliation only
      if (session.state !== "running") continue;
      if (turn.state === "submitted" && turn.worker === workerId) return this.job(session, turn); // current live delivery only, never replay
      if (turn.state === "claimed" && this.now() - (turn.claimedAt ?? 0) > 120000) turn.state = "queued";
      if (turn.state !== "queued") continue;
      turn.state = "claimed"; turn.lease = randomUUID(); turn.worker = workerId; turn.claimedAt = this.now();
      this.mark(session, "Preparing handoff");
      this.persist(); return this.job(session, turn);
    }
    return null;
  }
  private job(session: ProjectRelay, turn: RelayTurn): unknown { return structuredClone({ relayId: session.id, deliveryId: turn.id, lease: turn.lease, state: turn.state, target: session.peers[turn.peer], prompt: turn.prompt }); }
  private claimed(relayId: string, deliveryId: string, lease: string): { session: ProjectRelay; turn: RelayTurn } {
    const session = this.require(relayId);
    const turn = session.turns.find(value => value.id === deliveryId);
    if (!turn || !turn.lease || turn.lease !== lease) throw new Error("Stale desktop delivery lease");
    return { session, turn };
  }
  submitting(relayId: string, deliveryId: string, lease: string, nativeBaselineTurnId?: string): void {
    const { session, turn } = this.claimed(relayId, deliveryId, lease);
    if (session.state !== "running" || turn.state !== "claimed") throw new Error("Desktop delivery cannot be submitted twice");
    if (this.now() - (turn.claimedAt ?? 0) > 120000) throw new Error("Desktop delivery lease expired before submission");
    if (nativeBaselineTurnId !== undefined && (!nativeBaselineTurnId || nativeBaselineTurnId.length > 200)) throw new Error("Native submission baseline is invalid");
    turn.nativeBaselineTurnId = nativeBaselineTurnId;
    turn.state = "submitted";
    this.mark(session, "Handoff submitted");
    this.persist();
  }
  finish(relayId: string, deliveryId: string, lease: string, answer: string, receipt: string): void {
    const { session, turn } = this.claimed(relayId, deliveryId, lease);
    if (turn.state === "completed" && turn.receipt === receipt) return;
    if (turn.state !== "submitted") throw new Error("Desktop delivery has not been submitted");
    text(receipt, "Exact response receipt", 200);
    try { this.accept(session, turn, answer, receipt); }
    catch (error) {
      // An exact receipt resolves duplicate-send ambiguity even if the returned answer itself is invalid.
      turn.receipt = receipt; turn.state = "failed";
      const reason = error instanceof Error ? error.message : "Invalid relay result";
      if (session.state === "running") session.state = "failed";
      session.result = reason;
      this.mark(session, "Response validation failed");
    }
    this.persist(); this.kick();
  }
  fail(relayId: string, deliveryId: string, lease: string, reason: string): void {
    const { session, turn } = this.claimed(relayId, deliveryId, lease);
    if (turn.state !== "claimed" && turn.state !== "submitted") throw new Error("Desktop delivery already settled");
    const wasSubmitted = turn.state === "submitted";
    const failure = text(reason, "Blocker", 1000);
    if (session.state === "running") {
      session.state = wasSubmitted ? "uncertain" : "failed";
      session.result = failure;
      this.mark(session, wasSubmitted ? "Submission outcome uncertain" : preSubmitFailureEvent(failure));
    }
    // Once submitted, keep the delivery in the submitted state until exact-response reconciliation.
    // A claimed-only failure is safe to mark failed and can be resumed directly by the owner.
    if (!wasSubmitted) { turn.state = "failed"; resetClaim(turn); }
    this.persist();
  }
}
