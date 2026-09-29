import { useEffect, useRef, useState } from "react";
import "./project-relay.css";

type Peer = { name: string; kind: "gw" | "codex" | "work"; conversation: string };
export type ProjectRelayInput = { requestId: string; name: string; task: string; peers: [Peer, Peer]; maxTurns: number; resumeId?: string };
type ProjectRelayDraft = Omit<ProjectRelayInput, "requestId" | "resumeId">;
export type ProjectRelayView = ProjectRelayInput & {
  id: string;
  state: string;
  result?: string;
  event?: string;
  createdAt?: string;
  updatedAt?: string;
  turns: { id: string; peer: number; state: string; answer?: string; receipt?: string }[];
};
export type ProjectRelaySnapshot = { relays: ProjectRelayView[]; bridge: { connected: boolean; lastSeen?: string; error?: string } };
const api = window.codexWebLauncher!;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const blankDraft = (): ProjectRelayDraft => ({ name: "", task: "", peers: [{ name: "First participant", kind: "gw", conversation: "" }, { name: "Second participant", kind: "codex", conversation: "" }], maxTurns: 20 });
const copyDraft = (draft: ProjectRelayDraft): ProjectRelayDraft => ({ ...draft, peers: draft.peers.map(peer => ({ ...peer })) as [Peer, Peer] });
let savedDraft = blankDraft();
const participantLabel = (peer: number) => peer === 0 ? "First" : "Second";
const recoverableRelay = (relay: ProjectRelayView) => relay.state !== "running" && relay.state !== "uat-ready";
const stoppableRelay = (relay: ProjectRelayView) => relay.state === "running" || relay.state === "blocked";
const eventLabel = (relay: ProjectRelayView): string => {
  if (relay.event) return relay.event;
  if (/composer did not preserve the complete prompt|prompt integrity/i.test(relay.result ?? "")) return "Composer integrity failure";
  if (relay.state === "terminated") return "Relay terminated unexpectedly";
  if (relay.state === "failed") return "Delivery failed";
  if (relay.state === "uncertain") return "Submission outcome uncertain";
  if (relay.state === "stopped" || relay.state === "cancelled") return "Relay stopped";
  if (relay.state === "uat-ready") return "UAT ready";
  return "Relay active";
};
const displayTimestamp = (relay: ProjectRelayView): string => {
  const value = relay.updatedAt ?? relay.createdAt;
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

export function ProjectRelayPanel() {
  const [snapshot, setSnapshot] = useState<ProjectRelaySnapshot>({ relays: [], bridge: { connected: false } });
  const [draft, setDraftState] = useState<ProjectRelayDraft>(() => copyDraft(savedDraft));
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  // Keep an uncertain start request id stable until its receipt can be reconciled.
  const pending = useRef<ProjectRelayInput | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const value = await api.projectRelayList(); if (!stopped) { setSnapshot(value); setLoadError(""); } }
      catch (failure) { if (!stopped) setLoadError(errorText(failure)); }
      if (!stopped) timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  const updateDraft = (change: (current: ProjectRelayDraft) => ProjectRelayDraft) => setDraftState(current => {
    const next = change(current);
    savedDraft = copyDraft(next);
    return next;
  });
  const updatePeer = (index: number, value: Partial<Peer>) => updateDraft(current => ({ ...current, peers: current.peers.map((peer, i) => i === index ? { ...peer, ...value } : peer) as [Peer, Peer] }));
  const clearInputs = () => {
    if (busy || pending.current) return;
    const next = blankDraft();
    savedDraft = copyDraft(next);
    setDraftState(next);
    setError("");
  };
  const start = async () => {
    setBusy(true); setError("");
    pending.current ??= { requestId: crypto.randomUUID(), ...copyDraft(draft) };
    try {
      await api.projectRelayStart(pending.current);
      pending.current = null;
      setSnapshot(await api.projectRelayList());
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  const cancel = async (id: string) => {
    setBusy(true); setError("");
    try { await api.projectRelayCancel(id); setSnapshot(await api.projectRelayList()); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  const resume = async (relay: ProjectRelayView) => {
    setBusy(true); setError("");
    try {
      await api.projectRelayStart({
        requestId: crypto.randomUUID(),
        resumeId: relay.id,
        name: relay.name,
        task: relay.task,
        peers: relay.peers,
        maxTurns: relay.maxTurns,
      });
      setSnapshot(await api.projectRelayList());
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  return <section className="project-relay">
    <header><h2>Work between your existing chats</h2><p>Choose two participants, give them the task, and let CWC carry their answers back and forth until a blocker or UAT-ready result.</p></header>
    <p role="status">Desktop bridge: <strong>{snapshot.bridge.connected ? "Connected" : "Not connected"}</strong>{!snapshot.bridge.connected && " — GPT Web pairs can run now. Codex/Work deliveries wait for the CWC controller."}</p>
    {(error || loadError || snapshot.bridge.error) && <p role="alert" className="relay-error">{error || loadError || snapshot.bridge.error}</p>}
    <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <fieldset disabled={busy || Boolean(pending.current)}><legend>New project</legend>
        <label>Project name<input required maxLength={160} value={draft.name} onChange={event => updateDraft(current => ({ ...current, name: event.target.value }))} /></label>
        <div className="relay-peers">{draft.peers.map((peer, index) => <fieldset key={index}><legend>{index === 0 ? "1. First participant" : "2. Second participant"}</legend>
          <label>Chat name<input required maxLength={100} value={peer.name} onChange={event => updatePeer(index, { name: event.target.value })} /></label>
          <label>Chat type<select value={peer.kind} onChange={event => updatePeer(index, { kind: event.target.value as Peer["kind"], conversation: "" })}><option value="gw">GPT Web</option><option value="codex">Codex</option><option value="work">Work</option></select></label>
          <label>{peer.kind === "gw" ? "Existing conversation URL" : "Existing desktop chat ID or codex://threads/ link"}<input required value={peer.conversation} onChange={event => updatePeer(index, { conversation: event.target.value })} placeholder={peer.kind === "gw" ? "https://chatgpt.com/c/…" : "Chat ID"} /></label>
        </fieldset>)}</div>
        <label>Task and boundaries<textarea required rows={5} maxLength={12000} value={draft.task} onChange={event => updateDraft(current => ({ ...current, task: event.target.value }))} placeholder="Describe the outcome, permitted work, and what needs your approval." /></label>
        <label>Maximum handoffs<input type="number" min={2} max={100} value={draft.maxTurns} onChange={event => updateDraft(current => ({ ...current, maxTurns: Number(event.target.value) }))} /></label>
      </fieldset>
      <button type="submit" disabled={busy}>{pending.current ? "Recover start receipt" : "Start project relay"}</button>
      <button type="button" disabled={busy || Boolean(pending.current)} onClick={clearInputs}>CLEAR</button>
      {pending.current && <button type="button" disabled={busy} onClick={() => { pending.current = null; setError("Before starting again, check the project list for the previous request."); }}>Edit request</button>}
    </form>
    <h3>Projects</h3>
    {!snapshot.relays.length && <p>No project relays yet.</p>}
    {snapshot.relays.slice().reverse().map(relay => {
      const lastTurn = relay.turns.at(-1);
      const awaitingReconciliation = lastTurn?.state === "submitted";
      const settledFailure = lastTurn?.state === "failed" && Boolean(lastTurn.receipt);
      const resumeBlocked = awaitingReconciliation || settledFailure;
      return <article key={relay.id}>
        <h3>{relay.name}</h3>
        <p><strong>Participant:</strong> {lastTurn ? participantLabel(lastTurn.peer) : "Unavailable"}</p>
        <p><strong>Status:</strong> {relay.state}</p>
        <p><strong>Timestamp:</strong> {displayTimestamp(relay)}</p>
        <p><strong>Event:</strong> {eventLabel(relay)}</p>
        <details><summary>Conversation bindings and handoff history</summary>
          {relay.peers.map((peer, index) => <p key={peer.conversation}>{participantLabel(index)} participant ({peer.name}): <code>{peer.conversation}</code></p>)}
          {relay.turns.map((turn, i) => <p key={turn.id}>{i + 1}. Participant: {participantLabel(turn.peer)} · Status: {turn.state} · Handoff ID: <code>{turn.id}</code></p>)}
        </details>
        {stoppableRelay(relay) && <button disabled={busy} onClick={() => void cancel(relay.id)}>Stop relay</button>}
        {recoverableRelay(relay) && <button disabled={busy || resumeBlocked} onClick={() => void resume(relay)}>Resume relay</button>}
        {recoverableRelay(relay) && awaitingReconciliation && <p className="relay-safety-note">Resume is waiting for exact-response reconciliation because the last delivery crossed the submission boundary. It will not be replayed.</p>}
        {recoverableRelay(relay) && settledFailure && <p className="relay-safety-note">The exact response was received but could not be accepted. Replaying that delivery is unsafe; inspect the failed handoff before continuing.</p>}
      </article>;
    })}
  </section>;
}