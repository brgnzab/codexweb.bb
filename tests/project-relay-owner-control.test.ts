import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRelayService, type RelayInput, type RelayPeer } from "../src/council/project-relay";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const value = mkdtempSync(join(tmpdir(), "cwc-owner-control-")); roots.push(value); return value; };
const peer = (kind: RelayPeer["kind"], index: number): RelayPeer => ({
  name: index ? "Reviewer" : "Worker",
  kind,
  conversation: kind === "gw" ? `https://chatgpt.com/c/owner-control-${index}` : `00000000-0000-0000-0000-00000000000${index}`,
});
const input = (requestId: string, a: RelayPeer["kind"] = "codex", b: RelayPeer["kind"] = "work"): RelayInput => ({
  requestId,
  name: "Owner control test",
  task: "Exercise relay lifecycle",
  peers: [peer(a, 0), peer(b, 1)],
});
const ids = (job: any): [string, string, string] => [job.relayId, job.deliveryId, job.lease];

describe("Owner lifecycle control", () => {
  test("blocked relays keep bindings across restart until the owner stops them", () => {
    const path = join(root(), "relay.json");
    const service = new ProjectRelayService(path, { run: async () => "unused" });
    const started = service.start(input("request-1"));
    const job: any = service.claim("controller");
    service.submitting(...ids(job));
    service.finish(...ids(job), "Need owner decision.\nCWC_STATE: BLOCKED", "receipt-1");
    expect(service.list()[0]!.state).toBe("blocked");
    expect(() => service.start(input("request-2"))).toThrow("active or unresolved relay");

    const restored = new ProjectRelayService(path, { run: async () => "unused" });
    expect(restored.list()[0]!.state).toBe("blocked");
    expect(() => restored.start(input("request-3"))).toThrow("active or unresolved relay");

    restored.cancel(started.id);
    expect(restored.list()[0]!.state).toBe("stopped");
    expect(() => restored.start(input("request-4"))).not.toThrow();
  });

  test("a submitted uncertain native delivery remains reserved after Stop until exact reconciliation", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    const started = service.start(input("request-1"));
    const job: any = service.claim("controller");
    service.submitting(...ids(job));
    service.fail(...ids(job), "response transport lost after submit");
    expect(service.list()[0]!.state).toBe("uncertain");
    expect(service.list()[0]!.turns.at(-1)!.state).toBe("submitted");

    service.cancel(started.id);
    expect(service.list()[0]!.state).toBe("stopped");
    expect(() => service.start(input("request-2"))).toThrow("active or unresolved relay");

    const reconcile: any = service.claim("controller");
    expect(reconcile).toMatchObject({ deliveryId: job.deliveryId, state: "submitted" });
    service.finish(...ids(reconcile), "Recovered exact answer.\nCWC_STATE: CONTINUE", "receipt-2");
    expect(service.list()[0]!.state).toBe("stopped");
    expect(service.list()[0]!.turns).toHaveLength(1);
    expect(() => service.start(input("request-3"))).not.toThrow();
  });

  test("browser uncertainty remains submitted so Stop cannot silently release an ambiguous send", async () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async (_target, _prompt, _deliveryId, onPhase) => { onPhase?.("submit-started"); throw new Error("connection lost after submit"); } });
    const started = service.start(input("request-1", "gw", "work"));
    await service.idle();
    expect(service.list()[0]!.state).toBe("uncertain");
    expect(service.list()[0]!.turns.at(-1)!.state).toBe("submitted");
    service.cancel(started.id);
    expect(service.list()[0]!.state).toBe("stopped");
    expect(() => service.start(input("request-2", "gw", "work"))).toThrow("active or unresolved relay");
  });

  test("restart marks an active relay terminated and only explicit Resume makes its queued delivery claimable", () => {
    const path = join(root(), "relay.json");
    const service = new ProjectRelayService(path, { run: async () => "unused" });
    const started = service.start(input("request-1"));
    const originalTurn = started.turns[0]!.id;

    const restored = new ProjectRelayService(path, { run: async () => "unused" });
    expect(restored.list()[0]!.state).toBe("terminated");
    expect(restored.list()[0]!.turns[0]!.id).toBe(originalTurn);
    expect(restored.claim("controller")).toBeNull();

    const resumed = restored.start({ ...input("resume-request"), resumeId: started.id });
    expect(resumed.state).toBe("running");
    expect(resumed.turns).toHaveLength(1);
    const job: any = restored.claim("controller");
    expect(job.deliveryId).toBe(originalTurn);
  });

  test("Stop during a claimed pre-submit delivery requeues the same delivery for explicit Resume", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    const started = service.start(input("request-1"));
    const first: any = service.claim("controller");
    expect(first.state).toBe("claimed");

    const stopped = service.cancel(started.id);
    expect(stopped.state).toBe("stopped");
    expect(stopped.turns[0]!.state).toBe("queued");
    expect(service.claim("controller")).toBeNull();

    service.resume(started.id);
    const resumed: any = service.claim("controller");
    expect(resumed.deliveryId).toBe(first.deliveryId);
    expect(resumed.lease).not.toBe(first.lease);
  });

  test("Resume after stopped exact reconciliation schedules one next handoff without replay", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    const started = service.start(input("request-1"));
    const job: any = service.claim("controller");
    service.submitting(...ids(job));
    service.cancel(started.id);
    service.finish(...ids(job), "Recovered exact answer.\nCWC_STATE: CONTINUE", "receipt-1");
    expect(service.list()[0]!.turns).toHaveLength(1);
    expect(service.list()[0]!.turns[0]!.state).toBe("completed");

    const resumed = service.resume(started.id);
    expect(resumed.state).toBe("running");
    expect(resumed.turns).toHaveLength(2);
    expect(resumed.turns[0]!.id).toBe(job.deliveryId);
    expect(resumed.turns[1]!.peer).toBe(1);
    expect(resumed.turns[1]!.state).toBe("queued");
  });

  test("Resume never replays an ambiguous submitted delivery", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    const started = service.start(input("request-1"));
    const job: any = service.claim("controller");
    service.submitting(...ids(job));
    service.fail(...ids(job), "transport lost after submit");
    service.cancel(started.id);

    expect(() => service.resume(started.id)).toThrow("exact-response reconciliation");
    expect(service.list()[0]!.state).toBe("stopped");
    expect(service.list()[0]!.turns).toHaveLength(1);
    expect(service.list()[0]!.turns[0]!.state).toBe("submitted");
  });

  test("pre-submit browser failure is failed, visible and directly resumable", async () => {
    let calls = 0;
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async (_target, _prompt, _deliveryId, onPhase) => {
      calls++;
      if (calls === 1) throw new Error("ChatGPT Council composer did not preserve the complete prompt (expectedChars=20101, actualChars=20101, commonPrefixChars=11986)");
      onPhase?.("submit-started");
      return "Recovered response.\nCWC_STATE: CONTINUE";
    } });
    const started = service.start(input("request-pre-submit", "gw", "work"));
    await service.idle();
    expect(service.list()[0]!).toMatchObject({ state: "failed", event: "Composer integrity failure" });
    expect(service.list()[0]!.turns[0]!.state).toBe("failed");

    service.resume(started.id);
    await service.idle();
    expect(calls).toBe(2);
    expect(service.list()[0]!.state).toBe("running");
    expect(service.list()[0]!.turns[0]!.state).toBe("completed");
    expect(service.list()[0]!.turns[1]!.state).toBe("queued");
  });
});

describe("Owner UI regression contracts", () => {
  test("Project Relay owns its viewport scroll and exposes compact lifecycle controls", () => {
    const css = readFileSync(join(import.meta.dir, "..", "launcher", "src", "project-relay.css"), "utf8");
    const panel = readFileSync(join(import.meta.dir, "..", "launcher", "src", "ProjectRelayPanel.tsx"), "utf8");
    const http = readFileSync(join(import.meta.dir, "..", "src", "council", "http-server.ts"), "utf8");
    const main = readFileSync(join(import.meta.dir, "..", "src", "council", "mcp-main.ts"), "utf8");
    expect(css).toContain("height: 100%");
    expect(css).toContain("overflow-y: auto");
    expect(panel).toContain('relay.state === "terminated"');
    expect(panel).toContain('relay.state === "failed"');
    expect(panel).toContain("recoverableRelay(relay)");
    expect(panel).toContain(">Stop relay</button>");
    expect(panel).toContain(">Resume relay</button>");
    expect(panel).toContain(">CLEAR</button>");
    expect(panel).toContain("resumeId: relay.id");
    expect(panel).toContain("let savedDraft = blankDraft()");
    expect(panel).toContain("<strong>Participant:</strong>");
    expect(panel).toContain("<strong>Status:</strong>");
    expect(panel).toContain("<strong>Timestamp:</strong>");
    expect(panel).toContain("<strong>Event:</strong>");
    expect(panel).toContain("Handoff ID:");
    expect(panel).not.toContain("<pre>{relay.result}</pre>");
    expect(panel).not.toContain("turn.answer && <pre>");
    expect(http).toContain('["requestId", "name", "task", "peers", "maxTurns", "resumeId"]');
    expect(main).toContain("run: async (peer, prompt, deliveryId, onPhase)");
    expect(main).toContain("transport.run({ agentId, conversationUrl: peer.conversation, prompt, onPhase })");
  });

  test("other manual-entry pages retain drafts in renderer memory and CLEAR only those drafts", () => {
    const app = readFileSync(join(import.meta.dir, "..", "launcher", "src", "CouncilApp.tsx"), "utf8");
    expect(app).toContain('let connectionDraft = { tunnelId: "", runtimeKey: "" }');
    expect(app).toContain('let memoryQueryDraft = ""');
    expect(app).toContain('connectionDraft = { tunnelId: "", runtimeKey: "" }');
    expect(app).toContain('onClick={clearInputs}>CLEAR</button>');
    expect(app).toContain('onClick={() => setQuery("")}>CLEAR</button>');
    expect(app).not.toContain("localStorage");
    expect(app).not.toContain("sessionStorage");
  });
});
