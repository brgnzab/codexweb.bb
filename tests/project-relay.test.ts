import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRelayService, parseRelayAnswer, relayPeer, type RelayInput, type RelayPeer } from "../src/council/project-relay";
import { startCouncilHttpServer } from "../src/council/http-server";
import { CouncilStore } from "../src/council/store";
const { assertReady, completedAnswer, observeAnswer } = require("../launcher/electron/project-relay-desktop.cjs");
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
      const relayInput = input(a, b);
      const service = new ProjectRelayService(join(root(), "relay.json"), { run: async (target, prompt) => {
        calls.push(target.conversation);
        expect(prompt).toBe(target.name === "Worker" ? relayInput.task : parseRelayAnswer(answer(0)).body);
        return answer(target.name === "Worker" ? 0 : 1);
      } });
      const started = service.start(relayInput);
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
  test("preserves message whitespace and raw receipt while keeping recognized status in the app", () => {
    expect(parseRelayAnswer("  first\r\nsecond  \r\nCWC_STATE: CONTINUE\r\n")).toEqual({ body: "  first\r\nsecond  ", signal: "CONTINUE" });
    const exactTask = "  HI  ";
    const exactReply = "  participant reply exactly as sent  \nCWC_STATE: CONTINUE";
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    service.start({ ...input(), task: exactTask });
    const first: any = service.claim("controller");
    expect(first.prompt).toBe(exactTask);
    service.submitting(...ids(first));
    service.finish(...ids(first), exactReply, "receipt-1");
    expect(service.list()[0]!.turns[0]!.answer).toBe(exactReply);
    const second: any = service.claim("controller");
    expect(second.prompt).toBe("  participant reply exactly as sent  ");
    expect(service.list()[0]!.turns[0]!.signal).toBe("CONTINUE");
  });
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
    const rawAnswer = 'Useful result\n{"type":"SLEEP","room_id":"project"}';
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => { count++; return rawAnswer; } });
    service.start(input("gw", "codex")); await service.idle();
    expect(count).toBe(1);
    const job: any = service.claim("controller");
    expect(job.target.kind).toBe("codex");
    expect(job.prompt).toBe(rawAnswer);
    expect(service.list()[0]!.turns[0]!.signal).toBe("CONTINUE");
    expect(parseRelayAnswer("quoted\nCWC_STATE: UAT_READY\nmore\nCWC_STATE: UAT_READY").signal).toBe("CONTINUE");
  });
  test("explicit blocker stops forwarding while exact handoff budget completes successfully", () => {
    const blocked = new ProjectRelayService(join(root(), "relay-blocked.json"), { run: async () => "unused" });
    blocked.start({ ...input(), maxTurns: 2 });
    const blockedJob: any = blocked.claim("controller");
    blocked.submitting(...ids(blockedJob));
    blocked.finish(...ids(blockedJob), "Need owner credentials\nCWC_STATE: BLOCKED", blockedJob.deliveryId);
    expect(blocked.list()[0]!.state).toBe("blocked");
    expect(blocked.list()[0]!.result).toBe("Participant reported a blocker.");
    expect(blocked.list()[0]!.turns[0]!.answer).toBe("Need owner credentials\nCWC_STATE: BLOCKED");
    expect(blocked.list()[0]!.turns).toHaveLength(1);
    expect(blocked.claim("controller")).toBeNull();

    const completed = new ProjectRelayService(join(root(), "relay-completed.json"), { run: async () => "unused" });
    completed.start({ ...input(), requestId: "budget", maxTurns: 4 });
    for (const body of [
      "first success\nCWC_STATE: CONTINUE",
      "second success\nCWC_STATE: CONTINUE",
      "third success\nCWC_STATE: CONTINUE",
      "fourth success\nCWC_STATE: CONTINUE",
    ]) {
      const job: any = completed.claim("controller");
      completed.submitting(...ids(job));
      completed.finish(...ids(job), body, job.deliveryId);
    }
    expect(completed.list()[0]!.state).toBe("completed");
    expect(completed.list()[0]!.turns).toHaveLength(4);
    expect(completed.list()[0]!.turns.every(turn => turn.state === "completed")).toBe(true);
    expect(completed.claim("controller")).toBeNull();
    const next = completed.start({ ...input(), requestId: "after-budget", maxTurns: 4 });
    expect(next.state).toBe("running");
    completed.cancel(next.id);
  });
  test("UAT_READY on the final budgeted handoff takes precedence over COMPLETED", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    service.start({ ...input(), maxTurns: 2 });
    const first: any = service.claim("controller");
    service.submitting(...ids(first));
    service.finish(...ids(first), "implementation\nCWC_STATE: CONTINUE", first.deliveryId);
    const second: any = service.claim("controller");
    service.submitting(...ids(second));
    service.finish(...ids(second), "review accepted\nCWC_STATE: UAT_READY", second.deliveryId);
    expect(service.list()[0]!.state).toBe("uat-ready");
    expect(service.list()[0]!.turns).toHaveLength(2);
    expect(service.claim("controller")).toBeNull();
  });
  test("Resume on COMPLETED starts a fresh bounded segment instead of handoff N+1", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    const started = service.start({ ...input(), maxTurns: 4 });
    for (const body of [
      "segment one A\nCWC_STATE: CONTINUE",
      "segment one B\nCWC_STATE: CONTINUE",
      "segment one C\nCWC_STATE: CONTINUE",
      "segment one D\nCWC_STATE: CONTINUE",
    ]) {
      const job: any = service.claim("controller");
      service.submitting(...ids(job));
      service.finish(...ids(job), body, job.deliveryId);
    }
    expect(service.list()[0]!.state).toBe("completed");
    service.resume(started.id);
    let relay = service.list()[0]!;
    expect(relay.state).toBe("running");
    expect(relay.peers).toEqual(started.peers);
    expect(relay.maxTurns).toBe(4);
    expect(relay.segmentStartTurn).toBe(4);
    expect(relay.turns).toHaveLength(5);
    for (const body of [
      "segment two A\nCWC_STATE: CONTINUE",
      "segment two B\nCWC_STATE: CONTINUE",
      "segment two C\nCWC_STATE: CONTINUE",
      "segment two D\nCWC_STATE: CONTINUE",
    ]) {
      const job: any = service.claim("controller");
      service.submitting(...ids(job));
      service.finish(...ids(job), body, job.deliveryId);
    }
    relay = service.list()[0]!;
    expect(relay.state).toBe("completed");
    expect(relay.turns).toHaveLength(8);
    expect(service.claim("controller")).toBeNull();
  });
  test("third identical handoff is allowed; a repeated two-turn exchange is blocked", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    service.start({ ...input(), maxTurns: 10 });
    for (const body of ["SAME", "SAME", "SAME"]) {
      const job: any = service.claim("controller");
      service.submitting(...ids(job));
      service.finish(...ids(job), body, job.deliveryId);
    }
    let relay = service.list()[0]!;
    expect(relay.state).toBe("running");
    expect(relay.turns).toHaveLength(4);
    expect(relay.turns[3]!.prompt).toBe("SAME");

    const fourth: any = service.claim("controller");
    service.submitting(...ids(fourth));
    service.finish(...ids(fourth), "SAME", fourth.deliveryId);
    relay = service.list()[0]!;
    expect(relay.state).toBe("blocked");
    expect(relay.event).toBe("Repeated response blocked relay");
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
  test("restart-submitted native delivery is terminal and never auto-claimed", () => {
    const path = join(root(), "relay.json"); let time = 1000;
    const first = new ProjectRelayService(path, { run: async () => "unused" }, () => time);
    first.start(input()); const job: any = first.claim("controller"); first.submitting(...ids(job));
    time += 999999;
    const restored = new ProjectRelayService(path, { run: async () => "unused" }, () => time);
    expect(restored.list()[0]!.state).toBe("terminated");
    expect(restored.claim("other-controller")).toBeNull();
    expect(restored.claim("controller")).toBeNull();
    expect(() => restored.submitting(...ids(job))).toThrow();
    expect(() => restored.resume(restored.list()[0]!.id)).toThrow("exact-response reconciliation");

    // Exact evidence may still reconcile the tombstone manually, but no controller work is floated.
    restored.finish(...ids(job), answer(0), "receipt"); restored.finish(...ids(job), answer(0), "receipt");
    expect(restored.list()[0]!.state).toBe("terminated");
    expect(restored.list()[0]!.turns).toHaveLength(1);
    restored.resume(restored.list()[0]!.id);
    expect(restored.list()[0]!.state).toBe("running");
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
  test("restart at browser send boundary terminates and never replays", async () => {
    const path = join(root(), "relay.json");
    const service = new ProjectRelayService(path, { run: async () => "unused" }); service.start(input());
    const persisted = JSON.parse(readFileSync(path, "utf8")); persisted.sessions[0].peers[0] = peer("gw", 0); persisted.sessions[0].turns[0].state = "submitted"; writeFileSync(path, JSON.stringify(persisted));
    let calls = 0;
    const restored = new ProjectRelayService(path, { run: async () => { calls++; return answer(0); } }); restored.kick(); await restored.idle();
    expect(calls).toBe(0); expect(restored.list()[0]!.state).toBe("terminated");
    expect(() => restored.resume(restored.list()[0]!.id)).toThrow("exact-response reconciliation");
  });
  test("terminal submitted tombstone releases controller/global work but quarantines only its destination", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    const session = service.start(input());
    const job: any = service.claim("controller");
    service.submitting(...ids(job));
    service.cancel(session.id);

    expect(service.claim("controller")).toBeNull();
    expect(() => service.resume(session.id)).toThrow("submitted delivery");
    expect(() => service.start({
      ...input(),
      requestId: "quarantined",
      peers: [peer("codex", 0), { ...peer("codex", 1), conversation: "00000000-0000-0000-0000-000000000009" }],
    })).toThrow("submission quarantine");

    const unrelated = service.start({
      ...input(),
      requestId: "unrelated",
      peers: [
        { ...peer("codex", 0), conversation: "00000000-0000-0000-0000-000000000007" },
        { ...peer("work", 1), conversation: "00000000-0000-0000-0000-000000000008" },
      ],
    });
    expect(unrelated.state).toBe("running");

    service.finish(...ids(job), answer(0), "receipt");
    expect(service.list().find(relay => relay.id === session.id)!.state).toBe("stopped");
    expect(service.list().find(relay => relay.id === session.id)!.turns).toHaveLength(1);
  });
  test("native UNCERTAIN is terminal, unclaimable and releases unrelated relays without replay", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    service.start(input());
    const job: any = service.claim("controller");
    service.submitting(...ids(job));
    service.fail(...ids(job), "native completion could not be proven");
    expect(service.list()[0]!.state).toBe("uncertain");
    expect(service.list()[0]!.turns[0]!.state).toBe("submitted");
    expect(service.claim("controller")).toBeNull();

    const unrelated = service.start({
      ...input(),
      requestId: "fresh-relay",
      peers: [
        { ...peer("codex", 0), conversation: "00000000-0000-0000-0000-000000000005" },
        { ...peer("work", 1), conversation: "00000000-0000-0000-0000-000000000006" },
      ],
    });
    expect(unrelated.state).toBe("running");
    expect(() => service.start({
      ...input(),
      requestId: "reuse-uncertain-target",
      peers: [peer("codex", 0), { ...peer("work", 1), conversation: "00000000-0000-0000-0000-000000000004" }],
    })).toThrow("submission quarantine");
  });
  test("driver error after actual submission becomes uncertain without a second attempt", async () => {
    let calls = 0;
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async (_target, _prompt, _deliveryId, onPhase) => { calls++; onPhase?.("submit-started"); throw new Error("connection lost"); } });
    service.start(input("gw", "work")); await service.idle(); service.kick(); await service.idle();
    expect(calls).toBe(1); expect(service.list()[0]!.state).toBe("uncertain");
    expect(service.list()[0]!.turns.at(-1)!.state).toBe("submitted");
    expect(service.claim("controller")).toBeNull();
    expect(() => service.assertBrowserAccess(input("gw", "work").peers[0].conversation, "other-agent")).toThrow("submission tombstone");
    expect(() => service.assertBrowserAccess("https://chatgpt.com/c/unrelated-after-uncertain", "other-agent")).not.toThrow();
  });
  test("pre-submit GW failure remains safely resumable and does not masquerade as uncertainty", async () => {
    let calls = 0;
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async (_target, _prompt, _deliveryId, onPhase) => {
      calls++;
      if (calls === 1) throw new Error("ChatGPT Council composer did not preserve the complete prompt (expectedChars=20101, actualChars=20101, commonPrefixChars=11986)");
      onPhase?.("submit-started");
      return answer(0);
    } });
    const started = service.start(input("gw", "work")); await service.idle();
    let relay = service.list()[0]!;
    expect(relay.state).toBe("failed");
    expect(relay.turns[0]!.state).toBe("failed");
    expect(relay.event).toBe("Composer integrity failure");
    service.resume(started.id); await service.idle();
    relay = service.list()[0]!;
    expect(calls).toBe(2);
    expect(relay.state).toBe("running");
    expect(relay.turns[0]!.state).toBe("completed");
    expect(relay.turns[1]!.state).toBe("queued");
  });
});

describe("Native desktop adapter", () => {
  test("one courier transports two projects with helper-owned assignment and completion", async () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    const send = async (operation: string, body: any) => {
      if (operation === "project-relay/list") return { relays: service.list() };
      if (operation === "project-relay/claim") return service.claim(body.worker);
      if (operation === "project-relay/submitting") { service.submitting(body.relay_id, body.delivery_id, body.lease, body.baseline_turn_id); return {}; }
      if (operation === "project-relay/complete") { service.finish(body.relay_id, body.delivery_id, body.lease, body.answer, body.receipt); return {}; }
      if (operation === "project-relay/fail") { service.fail(body.relay_id, body.delivery_id, body.lease, body.reason); return {}; }
      throw new Error("Unexpected operation");
    };
    for (const project of ["A", "B"]) {
      service.start({ ...input(), requestId: project, name: project, task: `Task ${project}`, maxTurns: 4 });
      for (let i = 0; i < 4; i++) {
        const assignment: any = await bridgeRun({ operation: "claim" }, send, controllerId);
        expect(Object.keys(assignment).sort()).toEqual(["prompt", "threadId"]);
        expect(assignment.prompt.includes("CWC_STATE")).toBe(false);
        const current = service.list().at(-1)!;
        const turn = current.turns.at(-1)!;
        const job = { target: current.peers[turn.peer]!, worker: controllerId, prompt: assignment.prompt };
        await bridgeRun({ operation: "prepare", snapshot: { ...native(job, ""), turns: [] } }, send, controllerId);
        expect(await bridgeRun({ operation: "claim" }, send, controllerId)).toEqual({ threadId: assignment.threadId });
        await bridgeRun({ operation: "complete", snapshot: native(job, `  ${project}-${i}  \nCWC_STATE: CONTINUE`) }, send, controllerId);
      }
      expect(await bridgeRun({ operation: "claim" }, send, controllerId)).toBeNull();
      const finished = service.list().at(-1)!;
      expect(finished.state).toBe("completed");
      expect(finished.turns).toHaveLength(4);
      expect(finished.turns[1]!.prompt).toBe(`  ${project}-0  `);
      expect(finished.turns[0]!.answer).toBe(`  ${project}-0  \nCWC_STATE: CONTINUE`);
    }
    const last = service.list().at(-1)!;
    const resumed = service.resume(last.id);
    expect(resumed.turns.at(-1)!.prompt).toBe("  B-3  ");
  });

  test("concrete native send failure becomes terminal uncertainty and remains owner-visible", async () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    service.start(input());
    const job: any = service.claim(controllerId);
    service.submitting(...ids(job));
    const send = async (operation: string, body: any) => {
      if (operation === "project-relay/list") return { relays: service.list() };
      if (operation === "project-relay/fail") { service.fail(body.relay_id, body.delivery_id, body.lease, body.reason); return {}; }
      throw new Error("Unexpected operation");
    };
    const reason = "approval review rejected the message";
    expect(await bridgeRun({ operation: "fail", reason }, send, controllerId)).toBeUndefined();
    expect(service.list()[0]!.state).toBe("uncertain");
    expect(service.list()[0]!.result).toBe(reason);
    expect(service.claim(controllerId)).toBeNull();
  });

  test("helper hides relay identifiers and derives controller identity from Codex", async () => {
    const calls: unknown[] = [];
    const claimed = { target: peer("codex", 0), prompt: "exact payload", relayId: "hidden-relay", deliveryId: "hidden-delivery", lease: "hidden-lease" };
    const send = async (operation: string, body?: unknown) => {
      calls.push({ operation, body });
      if (operation === "project-relay/list") return { relays: [] };
      if (operation === "project-relay/claim") return claimed;
      throw new Error("Unexpected operation");
    };
    expect(await bridgeRun({ operation: "claim" }, send, controllerId)).toEqual({ threadId: claimed.target.conversation, prompt: claimed.prompt });
    expect(calls).toEqual([
      { operation: "project-relay/list", body: undefined },
      { operation: "project-relay/claim", body: { worker: controllerId } },
    ]);
    await expect(bridgeRun({ operation: "claim", worker: controllerId }, send, controllerId)).rejects.toThrow("Invalid desktop bridge request");
    await expect(bridgeRun({ operation: "claim" }, send, "")).rejects.toThrow("CODEX_THREAD_ID");
  });
  test("oversized desktop input is blocked before submit rather than becoming unreadable", async () => {
    const job = { target: peer("codex", 0), worker: controllerId, prompt: "x".repeat(20000) };
    expect(() => assertReady(job, { ...native(job, ""), turns: [] })).toThrow("full-read limit");
    let submitted = false;
    const request = { operation: "prepare", snapshot: { ...native(job, ""), turns: [] } };
    await expect(bridgeRun(request, async (operation: string) => {
      if (operation === "project-relay/list") return { relays: [{ id: "relay", state: "running", peers: [job.target], turns: [{ id: "delivery", peer: 0, lease: "lease", worker: controllerId, prompt: job.prompt, state: "claimed" }] }] };
      submitted = true; throw new Error("Must not reach submission");
    }, controllerId)).rejects.toThrow("full-read limit");
    expect(submitted).toBe(false);
  });
  test.each(["codex", "work"] as const)("correlates actual incoming native %s envelope and prevents a second send", kind => {
    const job = { target: peer(kind, 0), worker: controllerId, prompt: "Exact multiline prompt\nwith literal </input> and <input> tags & content." };
    const snapshot = delegated(job, answer(0));
    expect(completedAnswer(job, snapshot)).toEqual({ answer: answer(0), receipt: "turn-1:answer-1" });
    expect(assertReady(job, snapshot)).toEqual({ baselineTurnId: "turn-1" });
    expect(() => completedAnswer({ ...job, worker: "20000000-0000-0000-0000-000000000002" }, snapshot)).toThrow("source");
    expect(() => completedAnswer({ ...job, worker: undefined }, snapshot)).toThrow("source");
    expect(() => completedAnswer({ ...job, prompt: job.prompt + " altered" }, snapshot)).toThrow();
    // Text reuse is allowed; same-delivery replay is blocked by durable delivery state, not content equality.
    expect(assertReady({ ...job, worker: "other" }, snapshot)).toEqual({ baselineTurnId: "turn-1" });
  });

  test("identical text can be a later handoff while reconciliation requires a new native turn", () => {
    const job = { target: peer("codex", 0), worker: controllerId, prompt: "Chicken breast." };
    const prior = delegated(job, "Earlier answer");
    expect(assertReady(job, prior)).toEqual({ baselineTurnId: "turn-1" });

    const current = delegated(job, "Current answer");
    current.turns[0].id = "turn-2";
    current.turns[0].items[1].id = "answer-2";
    expect(completedAnswer({ ...job, baselineTurnId: "turn-1" }, current)).toEqual({
      answer: "Current answer",
      receipt: "turn-2:answer-2",
    });

    expect(() => completedAnswer({ ...job, baselineTurnId: "turn-1" }, prior)).toThrow("submission baseline");
  });
  test("newest-first native history excludes every pre-submission turn, including older identical text", () => {
    const job = { target: peer("codex", 0), worker: controllerId, prompt: "Identical transport payload" };
    const old = delegated(job, "Old answer").turns[0];
    old.id = "old";
    const baseline = delegated({ ...job, prompt: "Different latest input" }, "Latest answer").turns[0];
    baseline.id = "baseline";
    const snapshot = { ...delegated(job, "Current answer"), page: { order: "newest_first" }, turns: [baseline, old] };
    expect(assertReady(job, snapshot)).toEqual({ baselineTurnId: "baseline" });
    const prepared = { ...job, baselineTurnId: "baseline" };
    expect(observeAnswer(prepared, snapshot)).toBeNull();
    const current = delegated(job, "Current answer").turns[0];
    current.id = "current";
    current.items[1].id = "current-answer";
    expect(completedAnswer(prepared, { ...snapshot, turns: [current, baseline, old] })).toEqual({
      answer: "Current answer", receipt: "current:current-answer",
    });
    expect(() => completedAnswer(prepared, { ...snapshot, turns: [current] })).toThrow("missing the submission baseline");
    expect(() => completedAnswer(prepared, { ...snapshot, turns: [current, { ...current, id: "duplicate" }, baseline, old] })).toThrow("duplicated");
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
  test("incomplete native baseline cannot cross the submitting boundary", async () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" }); service.start(input());
    const send = async (operation: string, body: any) => {
      if (operation === "project-relay/claim") return service.claim(body.worker);
      if (operation === "project-relay/list") return { relays: service.list() };
      if (operation === "project-relay/submitting") { service.submitting(body.relay_id, body.delivery_id, body.lease, body.baseline_turn_id); return { accepted: true }; }
      throw new Error("Unexpected operation");
    };
    await bridgeRun({ operation: "claim" }, send, controllerId);
    const claimed = service.list()[0]!;
    const claimedTurn = claimed.turns.at(-1)!;
    const job: any = { target: claimed.peers[claimedTurn.peer]!, prompt: claimedTurn.prompt, worker: controllerId };
    for (const mutate of [
      (snapshot: any) => { delete snapshot.turns[0].items[0].output; },
      (snapshot: any) => { snapshot.turns[0].items[0].output.truncated = true; },
      (snapshot: any) => { snapshot.turns[0].items[0].truncated = true; },
      (snapshot: any) => { snapshot.turns[0].truncated = true; },
      (snapshot: any) => { snapshot.truncated = true; },
    ]) {
      const snapshot = delegated({ ...job, worker: controllerId }, answer(0));
      mutate(snapshot);
      await expect(bridgeRun({ operation: "prepare", snapshot }, send, controllerId)).rejects.toThrow();
      expect(service.list()[0]!.turns[0]!.state).toBe("claimed");
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
    expect(assertReady(job, snapshot)).toEqual({ baselineTurnId: "turn-1" });
    expect(assertReady(job, { ...snapshot, turns: [] })).toEqual({ baselineTurnId: undefined });
    expect(() => assertReady(job, { ...snapshot, turns: [], thread: { ...snapshot.thread, status: { type: "active" } } })).toThrow();
  });
  test("helper records submit before authorizing native send; completion forwards the message without status", async () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" }); service.start(input());
    const send = async (operation: string, body: any) => {
      if (operation === "project-relay/claim") return service.claim(body.worker);
      if (operation === "project-relay/list") return { relays: service.list() };
      if (operation === "project-relay/submitting") { service.submitting(body.relay_id, body.delivery_id, body.lease); return { accepted: true }; }
      if (operation === "project-relay/complete") { service.finish(body.relay_id, body.delivery_id, body.lease, body.answer, body.receipt); return { accepted: true }; }
      throw new Error("Unexpected operation");
    };
    await bridgeRun({ operation: "claim" }, send, controllerId);
    const claimed = service.list()[0]!;
    const claimedTurn = claimed.turns.at(-1)!;
    const job = { target: claimed.peers[claimedTurn.peer]!, prompt: claimedTurn.prompt, worker: controllerId };
    const empty = { ...native(job, ""), turns: [] };
    await expect(bridgeRun({ operation: "prepare", snapshot: empty }, send, "20000000-0000-0000-0000-000000000002")).rejects.toThrow();
    expect(service.list()[0]!.turns[0]!.state).toBe("claimed");
    const prepared = await bridgeRun({ operation: "prepare", snapshot: empty }, send, controllerId);
    expect(prepared).toEqual({ threadId: job.target.conversation, prompt: job.prompt });
    expect(service.list()[0]!.turns[0]!.state).toBe("submitted");
    expect(service.list()[0]!.turns[0]!.nativeBaselineTurnId).toBeUndefined();
    await expect(bridgeRun({ operation: "prepare", snapshot: empty }, send, controllerId)).rejects.toThrow("submission boundary");
    const completed = delegated(job, answer(0));
    expect(await bridgeRun({ operation: "complete", snapshot: completed }, send, controllerId)).toBeUndefined();
    expect(await bridgeRun({ operation: "complete", snapshot: completed }, send, controllerId)).toBeUndefined();
    expect(service.list()[0]!.turns).toHaveLength(2);
    expect(service.list()[0]!.turns[1]!.prompt).toBe(parseRelayAnswer(answer(0)).body);
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
