import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRelayService, parseRelayAnswer, relayPeer, type RelayInput, type RelayPeer } from "../src/council/project-relay";
import { startCouncilHttpServer } from "../src/council/http-server";
import { CouncilStore } from "../src/council/store";
const { assertReady, completedAnswer } = require("../launcher/electron/project-relay-desktop.cjs");
const { run: bridgeRun } = require("../scripts/cwc-desktop-bridge.cjs");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const value = mkdtempSync(join(tmpdir(), "cwc-project-relay-")); roots.push(value); return value; };
const peer = (kind: RelayPeer["kind"], index: number): RelayPeer => ({ name: index ? "Reviewer" : "Worker", kind, conversation: kind === "gw" ? `https://chatgpt.com/c/fixture-${index}` : `00000000-0000-0000-0000-00000000000${index}` });
const input = (a: RelayPeer["kind"] = "codex", b: RelayPeer["kind"] = "work"): RelayInput => ({ requestId: "request-1", name: "A real project", task: "Write and review an implementation plan", peers: [peer(a, 0), peer(b, 1)] });
const answer = (index: number) => index === 0 ? "Implementation and test evidence.\nCWC_STATE: CONTINUE" : "Reviewed; ready for owner UAT.\nCWC_STATE: UAT_READY";
const ids = (job: any): [string, string, string] => [job.relayId, job.deliveryId, job.lease];
const controllerId = "10000000-0000-0000-0000-000000000001";
function native(job: any, body: string, status = "completed") {
  return { schemaVersion: 1, thread: { id: job.target.conversation, kind: job.target.kind === "work" ? "chatgpt" : "codex", status: { type: "idle" } }, turns: [{ id: "turn-1", status, error: null, items: [{ type: "userMessage", id: "user-1", content: [{ type: "text", text: job.prompt }] }, { type: "agentMessage", id: "answer-1", text: body, ...(job.target.kind === "work" ? {} : { phase: "final_answer" }) }] }] };
}
function delegated(job: any, body: string) {
  const snapshot: any = native({ ...job, target: { ...job.target, kind: "codex" } }, body);
  snapshot.turns[0].items[0] = {
    type: "functionCallOutput", id: "incoming-1", namespace: "codex_app", name: "send_message_to_thread",
    output: { text: `<codex_delegation>\n  <source_thread_id>${job.worker}</source_thread_id>\n  <input>${job.prompt}</input>\n</codex_delegation>`, truncated: false },
  };
  return snapshot;
}

describe("Existing-chat project routing", () => {
  for (const a of ["gw", "codex", "work"] as const) for (const b of ["gw", "codex", "work"] as const) {
    test(`${a} to ${b}: complete task and review, exactly one delivery per peer`, async () => {
      const calls: string[] = [];
      const service = new ProjectRelayService(join(root(), "relay.json"), { run: async (target, prompt) => { calls.push(target.conversation); expect(prompt).toContain("Write and review"); return answer(target.name === "Worker" ? 0 : 1); } });
      const started = service.start(input(a, b));
      for (let i = 0; i < 2; i++) {
        await service.idle();
        const job: any = service.claim("controller");
        if (job) { calls.push(job.target.conversation); service.submitting(...ids(job)); service.finish(...ids(job), answer(job.target.name === "Worker" ? 0 : 1), `receipt-${i}`); }
      }
      await service.idle();
      const result = service.list()[0]!;
      expect(result.state).toBe("uat-ready");
      expect(result.turns).toHaveLength(2);
      expect(calls).toEqual(started.peers.map(peer => peer.conversation));
      expect(service.claim("controller")).toBeNull();
    });
  }
  test("worker readiness still goes to review and review repairs return to worker", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    service.start(input());
    for (const body of ["First draft\nCWC_STATE: UAT_READY", "Fix missing scenario\nCWC_STATE: CONTINUE", "Fixed and tested\nCWC_STATE: CONTINUE", "All reviewed\nCWC_STATE: UAT_READY"]) {
      const job: any = service.claim("controller"); service.submitting(...ids(job)); service.finish(...ids(job), body, job.deliveryId);
    }
    expect(service.list()[0]!.turns.map(turn => turn.peer)).toEqual([0, 1, 0, 1]);
    expect(service.list()[0]!.state).toBe("uat-ready");
  });
  test("missing/malformed status forwards actual answer without a formatting repair submission", async () => {
    let count = 0;
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => { count++; return 'Useful result\n{"type":"SLEEP","room_id":"project"}'; } });
    service.start(input("gw", "codex")); await service.idle();
    expect(count).toBe(1);
    const job: any = service.claim("controller");
    expect(job.target.kind).toBe("codex");
    expect(job.prompt).toContain("Useful result");
    expect(service.list()[0]!.turns[0]!.signal).toBe("CONTINUE");
    expect(parseRelayAnswer("quoted\nCWC_STATE: UAT_READY\nmore\nCWC_STATE: UAT_READY").signal).toBe("CONTINUE");
  });
  test("real blocker and turn budget stop forwarding", () => {
    for (const reason of ["Need owner credentials\nCWC_STATE: BLOCKED", "progress\nCWC_STATE: CONTINUE"]) {
      const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" }); service.start({ ...input(), maxTurns: 2 });
      for (let i = 0; i < 2; i++) { const job: any = service.claim("controller"); if (!job) break; service.submitting(...ids(job)); service.finish(...ids(job), reason, job.deliveryId); }
      expect(service.list()[0]!.state).toBe("blocked"); expect(service.claim("controller")).toBeNull();
    }
  });
  test("rejects destination injection, duplicate bindings and concurrent project reuse", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    expect(() => relayPeer({ ...peer("codex", 0), command: "arbitrary" })).toThrow();
    expect(() => relayPeer({ ...peer("gw", 0), conversation: "https://example.invalid/c/fixture" })).toThrow();
    expect(() => relayPeer({ ...peer("codex", 0), conversation: "new-session" })).toThrow();
    expect(() => service.start({ ...input(), peers: [peer("codex", 0), peer("codex", 0)] })).toThrow();
    expect(() => service.start({ ...input(), peers: [{ ...peer("gw", 0), conversation: `https://chatgpt.com/c/${peer("work", 0).conversation}` }, peer("work", 0)] })).toThrow();
    const started = service.start(input());
    expect(service.start(input()).id).toBe(started.id);
    expect(() => service.start({ ...input(), requestId: "other" })).toThrow();
    expect(() => service.start({ ...input(), requestId: "third", extra: "field" } as any)).toThrow();
  });
  test("project bindings reserve the same conversation across Council and native Work", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    service.start(input());
    const conversation = `https://chatgpt.com/c/${input().peers[1].conversation}`;
    expect(() => service.assertBrowserAccess(conversation, "old-council-agent")).toThrow();
    expect(() => service.assertBrowserAccess("https://chatgpt.com/c/unrelated", "old-council-agent")).not.toThrow();
  });
});

describe("Durability and no duplicate submissions", () => {
  test("reconnect reconciles submitted native delivery, duplicate prepare fails and completion is idempotent", () => {
    const path = join(root(), "relay.json"); let time = 1000;
    const first = new ProjectRelayService(path, { run: async () => "unused" }, () => time);
    first.start(input()); const job: any = first.claim("controller"); first.submitting(...ids(job));
    time += 999999;
    const restored = new ProjectRelayService(path, { run: async () => "unused" }, () => time);
    expect(restored.claim("other-controller")).toBeNull();
    expect(restored.claim("controller")).toMatchObject({ deliveryId: job.deliveryId, state: "submitted" });
    expect(() => restored.submitting(...ids(job))).toThrow();
    restored.finish(...ids(job), answer(0), "receipt"); restored.finish(...ids(job), answer(0), "receipt");
    expect(restored.list()[0]!.turns).toHaveLength(2);
  });
  test("expired unsubmitted claim can move safely; stale lease cannot send", () => {
    let time = 1;
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" }, () => time);
    service.start(input()); const old: any = service.claim("controller"); time += 120001;
    expect(() => service.submitting(...ids(old))).toThrow();
    const next: any = service.claim("replacement"); expect(next.deliveryId).toBe(old.deliveryId); expect(next.lease).not.toBe(old.lease);
    expect(() => service.submitting(...ids(old))).toThrow(); service.submitting(...ids(next));
  });
  test("restart at browser send boundary never replays", async () => {
    const path = join(root(), "relay.json");
    const service = new ProjectRelayService(path, { run: async () => "unused" }); service.start(input());
    const persisted = JSON.parse(readFileSync(path, "utf8")); persisted.sessions[0].peers[0] = peer("gw", 0); persisted.sessions[0].turns[0].state = "submitted"; writeFileSync(path, JSON.stringify(persisted));
    let calls = 0;
    const restored = new ProjectRelayService(path, { run: async () => { calls++; return answer(0); } }); restored.kick(); await restored.idle();
    expect(calls).toBe(0); expect(restored.list()[0]!.state).toBe("uncertain");
  });
  test("cancel during a submitted turn accepts its receipt without scheduling the peer", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    const session = service.start(input()); const job: any = service.claim("controller"); service.submitting(...ids(job)); service.cancel(session.id);
    expect(service.claim("controller")).toMatchObject({ deliveryId: job.deliveryId, state: "submitted" });
    expect(() => service.start({ ...input(), requestId: "another" })).toThrow();
    service.finish(...ids(job), answer(0), "receipt");
    expect(service.list()[0]!.state).toBe("cancelled"); expect(service.list()[0]!.turns).toHaveLength(1); expect(service.claim("controller")).toBeNull();
  });
  test("driver error after submission becomes uncertain without a second attempt", async () => {
    let calls = 0;
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => { calls++; throw new Error("connection lost"); } });
    service.start(input("gw", "work")); await service.idle(); service.kick(); await service.idle();
    expect(calls).toBe(1); expect(service.list()[0]!.state).toBe("uncertain");
  });
});

describe("Native desktop adapter", () => {
  test("helper derives claim identity from Codex and rejects mistyped or missing controller identity", async () => {
    const calls: unknown[] = [];
    const send = async (operation: string, body: unknown) => { calls.push({ operation, body }); return null; };
    await bridgeRun({ operation: "claim" }, send, controllerId);
    expect(calls).toEqual([{ operation: "project-relay/claim", body: { worker: controllerId } }]);
    await expect(bridgeRun({ operation: "claim", worker: "20000000-0000-0000-0000-000000000002" }, send, controllerId)).rejects.toThrow("must match");
    await expect(bridgeRun({ operation: "claim", worker: controllerId }, send, "")).rejects.toThrow("CODEX_THREAD_ID");
    expect(calls).toHaveLength(1);
  });
  test("oversized desktop input is blocked before submit rather than becoming unreadable", async () => {
    const job = { target: peer("codex", 0), worker: controllerId, prompt: "x".repeat(20000) };
    expect(() => assertReady(job, { ...native(job, ""), turns: [] })).toThrow("full-read limit");
    let submitted = false;
    const request = { operation: "prepare", relay_id: "relay", delivery_id: "delivery", lease: "lease", snapshot: { ...native(job, ""), turns: [] } };
    await expect(bridgeRun(request, async (operation: string) => {
      if (operation === "project-relay/list") return { relays: [{ id: "relay", peers: [job.target], turns: [{ id: "delivery", peer: 0, lease: "lease", worker: controllerId, prompt: job.prompt, state: "claimed" }] }] };
      submitted = true; throw new Error("Must not reach submission");
    }, controllerId)).rejects.toThrow("full-read limit");
    expect(submitted).toBe(false);
  });
  test.each(["codex", "work"] as const)("correlates actual incoming native %s envelope and prevents a second send", kind => {
    const job = { target: peer(kind, 0), worker: controllerId, prompt: "Exact multiline prompt\nwith literal </input> and <input> tags & content." };
    const snapshot = delegated(job, answer(0));
    expect(completedAnswer(job, snapshot)).toEqual({ answer: answer(0), receipt: "turn-1:answer-1" });
    expect(() => assertReady(job, snapshot)).toThrow("already appears");
    expect(() => completedAnswer({ ...job, worker: "20000000-0000-0000-0000-000000000002" }, snapshot)).toThrow("source");
    expect(() => completedAnswer({ ...job, worker: undefined }, snapshot)).toThrow("source");
    expect(() => completedAnswer({ ...job, prompt: job.prompt + " altered" }, snapshot)).toThrow();
    // Even another controller cannot submit the same delivery prompt again.
    expect(() => assertReady({ ...job, worker: "other" }, snapshot)).toThrow("already appears");
  });
  test("native input cannot be spoofed by tool metadata, assistant text, or partial envelopes", () => {
    const job = { target: peer("codex", 0), worker: controllerId, prompt: "exact unique delivery" };
    for (const mutation of [
      (item: any) => { item.namespace = "unrelated"; },
      (item: any) => { item.name = "create_thread"; },
      (item: any) => { item.type = "agentMessage"; item.text = item.output.text; },
      (item: any) => { item.output.text = "quoted " + item.output.text; },
      (item: any) => { item.output.text += " unrelated suffix"; },
      (item: any) => { item.output.text = item.output.text.replace(controllerId, "invalid-source"); },
      (item: any) => { item.output.text = item.output.text.replace(job.prompt, "partial"); },
    ]) {
      const snapshot = delegated(job, answer(0)); mutation(snapshot.turns[0].items[0]);
      expect(() => completedAnswer(job, snapshot)).toThrow();
    }
  });
  test("hidden or truncated native input never authorizes send or completion", () => {
    const job = { target: peer("codex", 0), worker: controllerId, prompt: "exact unique delivery" };
    for (const mutation of [
      (snapshot: any) => { delete snapshot.turns[0].items[0].output; },
      (snapshot: any) => { snapshot.turns[0].items[0].output.truncated = true; },
      (snapshot: any) => { snapshot.turns[0].items[0].truncated = true; },
      (snapshot: any) => { snapshot.turns[0].truncated = true; },
      (snapshot: any) => { snapshot.truncated = true; },
    ]) {
      const snapshot = delegated(job, answer(0)); mutation(snapshot);
      expect(() => completedAnswer(job, snapshot)).toThrow();
      expect(() => assertReady(job, snapshot)).toThrow();
    }
  });
  test("duplicate native inputs in one turn or multiple turns cannot correlate a receipt", () => {
    const job = { target: peer("codex", 0), worker: controllerId, prompt: "exact unique delivery" };
    for (const sameTurn of [true, false]) {
      const snapshot = delegated(job, answer(0));
      if (sameTurn) snapshot.turns[0].items.push(structuredClone(snapshot.turns[0].items[0]));
      else snapshot.turns.push(structuredClone(snapshot.turns[0]));
      expect(() => completedAnswer(job, snapshot)).toThrow("duplicated");
    }
  });
  test("local Work uses Codex final-answer format and ignores commentary", () => {
    const job = { target: peer("work", 0), prompt: "exact delivery prompt" };
    const snapshot = native({ ...job, target: { ...job.target, kind: "codex" } }, answer(0));
    snapshot.turns[0]!.items.push({ type: "agentMessage", id: "comment", text: "Still working", phase: "commentary" } as any);
    expect(completedAnswer(job, snapshot).answer).toBe(answer(0));
  });
  test.each(["codex", "work"] as const)("accepts only the exact completed %s answer", kind => {
    const job = { target: peer(kind, 0), prompt: "exact delivery prompt" };
    const snapshot = native(job, answer(0));
    expect(completedAnswer(job, snapshot)).toEqual({ answer: answer(0), receipt: "turn-1:answer-1" });
    expect(completedAnswer(job, { content: [{ type: "text", text: JSON.stringify(snapshot) }] }).answer).toBe(answer(0));
    expect(() => completedAnswer(job, native(job, answer(0), "inProgress"))).toThrow();
    expect(() => completedAnswer({ ...job, prompt: "other prompt" }, snapshot)).toThrow();
    expect(() => completedAnswer({ ...job, target: peer(kind, 1) }, snapshot)).toThrow();
    expect(() => completedAnswer(job, { ...snapshot, turns: [...snapshot.turns, ...snapshot.turns] })).toThrow();
    expect(() => completedAnswer(job, { ...snapshot, truncated: true })).toThrow();
    expect(() => assertReady(job, snapshot)).toThrow();
    expect(assertReady(job, { ...snapshot, turns: [] })).toBe(true);
    expect(() => assertReady(job, { ...snapshot, turns: [], thread: { ...snapshot.thread, status: { type: "active" } } })).toThrow();
  });
  test("helper records submit before authorizing native send; completion forwards the full final result", async () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" }); service.start(input());
    const send = async (operation: string, body: any) => {
      if (operation === "project-relay/claim") return service.claim(body.worker);
      if (operation === "project-relay/list") return { relays: service.list() };
      if (operation === "project-relay/submitting") { service.submitting(body.relay_id, body.delivery_id, body.lease); return { accepted: true }; }
      if (operation === "project-relay/complete") { service.finish(body.relay_id, body.delivery_id, body.lease, body.answer, body.receipt); return { accepted: true }; }
      throw new Error("Unexpected operation");
    };
    const job = await bridgeRun({ operation: "claim" }, send, controllerId);
    const base = { relay_id: job.relayId, delivery_id: job.deliveryId, lease: job.lease };
    const empty = { ...native(job, ""), turns: [] };
    await expect(bridgeRun({ operation: "prepare", ...base, snapshot: empty }, send, "20000000-0000-0000-0000-000000000002")).rejects.toThrow("different controller");
    expect(service.list()[0]!.turns[0]!.state).toBe("claimed");
    const prepared = await bridgeRun({ operation: "prepare", ...base, snapshot: empty }, send, controllerId);
    expect(prepared).toEqual({ sendOnce: true, threadId: job.target.conversation, prompt: job.prompt });
    expect(service.list()[0]!.turns[0]!.state).toBe("submitted");
    await expect(bridgeRun({ operation: "prepare", ...base, snapshot: empty }, send, controllerId)).rejects.toThrow();
    const completed = delegated({ ...job, worker: controllerId }, answer(0));
    await bridgeRun({ operation: "complete", ...base, snapshot: completed }, send, controllerId);
    await bridgeRun({ operation: "complete", ...base, snapshot: completed }, send, controllerId);
    expect(service.list()[0]!.turns).toHaveLength(2);
    expect(service.list()[0]!.turns[1]!.prompt).toContain("Implementation and test evidence");
  });
});

test("project owner endpoints require bearer, reject browser Origin and unknown routing fields", async () => {
  const dir = root(); const service = new ProjectRelayService(join(dir, "relay.json"), { run: async () => "unused" });
  const token = "a".repeat(64);
  const server = startCouncilHttpServer(new CouncilStore(join(dir, "council.json")), { port: 0, owner: { token: () => token, startLead: async () => null, focusAgent: async () => null, projectRelay: service } })!;
  const request = (operation: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) => fetch(`http://127.0.0.1:${server.port}/api/owner/project-relay/${operation}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    expect((await request("start", input(), {})).status).toBe(401);
    expect((await request("start", input(), { authorization: `Bearer ${token}`, origin: "null" })).status).toBe(403);
    expect((await request("start", { ...input(), target: "override" })).status).toBe(400);
    expect(service.list()).toHaveLength(0);
    expect((await request("start", input())).status).toBe(200);
    const listed = await (await request("list", {})).json() as any;
    expect(listed.result.relays).toHaveLength(1);
    const claimed = await (await request("claim", { worker: "controller" })).json() as any;
    expect(claimed.result.target.conversation).toBe(input().peers[0].conversation);
  } finally { server.stop(true); service.stop(); }
});
