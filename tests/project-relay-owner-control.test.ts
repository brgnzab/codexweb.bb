import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRelayService, type RelayInput, type RelayPeer } from "../src/council/project-relay";

const {
  relayBlocksCacheClear,
  restoreUncertainSubmissionTombstones,
  uncertainSubmissionTombstones,
} = require("../launcher/electron/project-relay-cache.cjs");

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
  test("blocked relays release bindings immediately and remain terminal across restart", () => {
    const path = join(root(), "relay.json");
    const service = new ProjectRelayService(path, { run: async () => "unused" });
    const started = service.start(input("request-1"));
    const job: any = service.claim("controller");
    service.submitting(...ids(job));
    service.finish(...ids(job), "Need owner decision.\nCWC_STATE: BLOCKED", "receipt-1");
    expect(service.list()[0]!.state).toBe("blocked");
    expect(service.claim("controller")).toBeNull();

    const second = service.start(input("request-2"));
    expect(second.state).toBe("running");
    service.cancel(second.id);

    const restored = new ProjectRelayService(path, { run: async () => "unused" });
    expect(restored.list().find(relay => relay.id === started.id)!.state).toBe("blocked");
    expect(restored.start(input("request-3")).state).toBe("running");
  });

  test("terminal uncertain native delivery is unclaimable and quarantines only its destination", () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => "unused" });
    const started = service.start(input("request-1"));
    const job: any = service.claim("controller");
    service.submitting(...ids(job));
    service.fail(...ids(job), "response transport lost after submit");
    expect(service.list()[0]!.state).toBe("uncertain");
    expect(service.list()[0]!.turns.at(-1)!.state).toBe("submitted");
    expect(service.claim("controller")).toBeNull();
    expect(() => service.start(input("request-2"))).toThrow("submission quarantine");

    const unrelated = service.start({
      ...input("request-3"),
      peers: [
        { ...peer("codex", 0), conversation: "00000000-0000-0000-0000-000000000007" },
        { ...peer("work", 1), conversation: "00000000-0000-0000-0000-000000000008" },
      ],
    });
    expect(unrelated.state).toBe("running");
    service.cancel(unrelated.id);

    service.finish(...ids(job), "Recovered exact answer.\nCWC_STATE: CONTINUE", "receipt-2");
    const reconciled = service.list().find(relay => relay.id === started.id)!;
    expect(reconciled.state).toBe("uncertain");
    expect(reconciled.turns).toHaveLength(1);
    expect(reconciled.turns[0]!.state).toBe("completed");
    expect(service.start(input("request-4")).state).toBe("running");
  });

  test("browser uncertainty releases unrelated work while quarantining only the ambiguous destination", async () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async (_target, _prompt, _deliveryId, onPhase) => { onPhase?.("submit-started"); throw new Error("connection lost after submit"); } });
    const started = service.start(input("request-1", "gw", "work"));
    await service.idle();
    const uncertain = service.list().find(relay => relay.id === started.id)!;
    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.turns.at(-1)!.state).toBe("submitted");
    expect(service.claim("controller")).toBeNull();
    expect(() => service.start(input("request-2", "gw", "work"))).toThrow("submission quarantine");

    const unrelated = service.start({
      ...input("request-3", "gw", "work"),
      peers: [
        { ...peer("gw", 0), conversation: "https://chatgpt.com/c/owner-control-unrelated" },
        { ...peer("work", 1), conversation: "00000000-0000-0000-0000-000000000009" },
      ],
    });
    expect(unrelated.state).toBe("running");
    expect(service.list().find(relay => relay.id === started.id)!.state).toBe("uncertain");
  });

  test.each(["codex", "gw"] as const)("Clear Cache preserves terminal %s uncertainty without replay or claim across restart", async kind => {
    const coreHome = root();
    const path = join(coreHome, "council", "project-relays.json");
    let browserCalls = 0;
    const driver = { run: async (_target: RelayPeer, _prompt: string, _deliveryId: string, onPhase?: (phase: "submit-started") => void) => {
      browserCalls++;
      onPhase?.("submit-started");
      throw new Error("connection lost after submit");
    } };
    const service = new ProjectRelayService(path, driver);
    const started = service.start(input("before-clear", kind));
    expect(relayBlocksCacheClear(service.list()[0])).toBe(true);
    if (kind === "codex") {
      const job: any = service.claim("controller");
      expect(relayBlocksCacheClear(service.list()[0])).toBe(true);
      service.submitting(...ids(job));
      expect(relayBlocksCacheClear(service.list()[0])).toBe(true);
      service.fail(...ids(job), "connection lost after submit");
    } else {
      await service.idle();
    }
    const submitted = service.list()[0]!.turns[0]!;
    expect(browserCalls).toBe(kind === "gw" ? 1 : 0);
    expect(relayBlocksCacheClear(service.list()[0])).toBe(false);

    const tombstones = uncertainSubmissionTombstones(service.list());
    rmSync(join(coreHome, "council"), { recursive: true, force: true });
    expect(restoreUncertainSubmissionTombstones(coreHome, tombstones)).toBe(true);

    const restored = new ProjectRelayService(path, driver);
    restored.kick();
    await restored.idle();
    expect(browserCalls).toBe(kind === "gw" ? 1 : 0);
    expect(restored.list()[0]).toMatchObject({ id: started.id, state: "uncertain" });
    expect(restored.list()[0]!.turns).toHaveLength(1);
    expect(restored.list()[0]!.turns[0]).toMatchObject({ id: submitted.id, state: "submitted", prompt: submitted.prompt });
    expect(relayBlocksCacheClear(restored.list()[0])).toBe(false);
    expect(restored.claim("controller")).toBeNull();
    expect(() => restored.resume(started.id)).toThrow("exact-response reconciliation");
    expect(() => restored.start(input("quarantined-after-clear", kind))).toThrow("submission quarantine");

    const unrelated = restored.start({
      ...input("unrelated-after-clear"),
      peers: [
        { ...peer("codex", 0), conversation: "00000000-0000-0000-0000-000000000007" },
        { ...peer("work", 1), conversation: "00000000-0000-0000-0000-000000000008" },
      ],
    });
    const next: any = restored.claim("controller");
    expect(next.relayId).toBe(unrelated.id);
    expect(next.deliveryId).not.toBe(submitted.id);
    expect(restored.list().find(relay => relay.id === started.id)!.turns[0]!.state).toBe("submitted");
    restored.cancel(unrelated.id);
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

  test("restart-terminated submitted delivery is terminal, unclaimable and only quarantines its destination", () => {
    const path = join(root(), "relay.json");
    const service = new ProjectRelayService(path, { run: async () => "unused" });
    const started = service.start(input("terminated-submitted"));
    const submitted: any = service.claim("controller");
    service.submitting(...ids(submitted));

    const restored = new ProjectRelayService(path, { run: async () => "unused" });
    const terminated = restored.list().find(relay => relay.id === started.id)!;
    expect(terminated.state).toBe("terminated");
    expect(terminated.turns.at(-1)!.state).toBe("submitted");
    expect(restored.claim("controller")).toBeNull();
    expect(relayBlocksCacheClear(terminated)).toBe(false);
    expect(uncertainSubmissionTombstones([terminated])).toHaveLength(1);
    expect(() => restored.start(input("same-destination"))).toThrow("submission quarantine");

    const unrelated = restored.start({
      ...input("terminated-unrelated"),
      peers: [
        { ...peer("codex", 0), conversation: "00000000-0000-0000-0000-000000000007" },
        { ...peer("work", 1), conversation: "00000000-0000-0000-0000-000000000008" },
      ],
    });
    expect(unrelated.state).toBe("running");
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

describe("Codex Bridge Thread configuration", () => {
  const controllerA = "10000000-0000-0000-0000-000000000001";
  const controllerB = "20000000-0000-0000-0000-000000000002";

  test("set, change, clear and restart persistence stay outside relay state", () => {
    const dir = root();
    const relayPath = join(dir, "relay.json");
    const controllerPath = join(dir, "codex-bridge-controller.json");
    let service = new ProjectRelayService(relayPath, { run: async () => "unused" }, () => 1_000, controllerPath);
    expect(service.status()).toMatchObject({ configuredThread: null, connected: false });
    expect(() => service.setController("not-a-thread")).toThrow("exact existing Codex thread ID");

    expect(service.setController(controllerA)).toMatchObject({ configuredThread: controllerA, connected: false });
    expect(JSON.parse(readFileSync(controllerPath, "utf8"))).toEqual({ version: 1, controllerThreadId: controllerA });
    expect(JSON.parse(readFileSync(relayPath, "utf8")).controllerThreadId).toBeUndefined();

    service = new ProjectRelayService(relayPath, { run: async () => "unused" }, () => 1_000, controllerPath);
    expect(service.status().configuredThread).toBe(controllerA);
    expect(service.setController(controllerB).configuredThread).toBe(controllerB);
    expect(service.clearController()).toMatchObject({ configuredThread: null, connected: false });
    expect(JSON.parse(readFileSync(controllerPath, "utf8"))).toEqual({ version: 1, controllerThreadId: null });
  });

  test("only the configured controller can claim and only its recent heartbeat is Connected", () => {
    const dir = root();
    let now = 1_000;
    const service = new ProjectRelayService(join(dir, "relay.json"), { run: async () => "unused" }, () => now, join(dir, "controller.json"));
    service.setController(controllerA);

    const conflict = input("controller-conflict");
    conflict.peers[0] = { ...conflict.peers[0], conversation: controllerA };
    expect(() => service.start(conflict)).toThrow("cannot also be a project participant");

    service.start(input("request-1"));
    expect(() => service.claim(controllerB)).toThrow("not the configured CWC controller");
    expect(service.status()).toMatchObject({ configuredThread: controllerA, connected: false });

    const job: any = service.claim(controllerA);
    expect(job).toBeTruthy();
    expect(service.status()).toMatchObject({ configuredThread: controllerA, connected: true, worker: controllerA });
    now += 120_001;
    expect(service.status().connected).toBe(false);
  });

  test("controller changes fail closed across active and submitted native delivery boundaries", () => {
    const dir = root();
    const service = new ProjectRelayService(join(dir, "relay.json"), { run: async () => "unused" }, () => 1_000, join(dir, "controller.json"));
    service.setController(controllerA);
    service.start(input("request-1"));
    const job: any = service.claim(controllerA);

    expect(() => service.setController(controllerB)).toThrow("native delivery is active");
    service.submitting(...ids(job));
    expect(() => service.clearController()).toThrow("awaiting exact-response reconciliation");
    expect(() => service.setController(controllerB)).toThrow("awaiting exact-response reconciliation");

    service.finish(...ids(job), "Exact response received.\nCWC_STATE: CONTINUE", "receipt-1");
    expect(service.setController(controllerB).configuredThread).toBe(controllerB);
    expect(service.clearController().configuredThread).toBeNull();
  });

  test("configured bridge does not affect GPT Web-only relay execution", async () => {
    const dir = root();
    let calls = 0;
    const service = new ProjectRelayService(join(dir, "relay.json"), { run: async () => {
      calls++;
      return calls === 1 ? "Draft complete.\nCWC_STATE: CONTINUE" : "Review complete.\nCWC_STATE: UAT_READY";
    } }, () => 1_000, join(dir, "controller.json"));
    service.setController(controllerA);
    service.start(input("web-only", "gw", "gw"));
    await service.idle();

    expect(calls).toBe(2);
    expect(service.list()[0]!.state).toBe("uat-ready");
    expect(service.claim(controllerA)).toBeNull();
  });

  test("the same configured controller is reusable across unrelated completed relay setups", () => {
    const dir = root();
    const service = new ProjectRelayService(join(dir, "relay.json"), { run: async () => "unused" }, () => 1_000, join(dir, "controller.json"));
    service.setController(controllerA);

    service.start({ ...input("run-1"), maxTurns: 2 });
    let job: any = service.claim(controllerA);
    expect(job.target.conversation).toBe(peer("codex", 0).conversation);
    service.submitting(...ids(job));
    service.finish(...ids(job), "Run 1 first handoff.\nCWC_STATE: CONTINUE", "run-1-a");
    job = service.claim(controllerA);
    expect(job.target.conversation).toBe(peer("work", 1).conversation);
    service.submitting(...ids(job));
    service.finish(...ids(job), "Run 1 second handoff.\nCWC_STATE: CONTINUE", "run-1-b");
    expect(service.list().find(relay => relay.requestId === "run-1")!.state).toBe("completed");

    const nextPeers: [RelayPeer, RelayPeer] = [
      { ...peer("codex", 0), conversation: "00000000-0000-0000-0000-000000000007" },
      { ...peer("work", 1), conversation: "00000000-0000-0000-0000-000000000008" },
    ];
    service.start({ ...input("run-2"), peers: nextPeers, maxTurns: 2 });
    job = service.claim(controllerA);
    expect(job.target.conversation).toBe(nextPeers[0].conversation);
    expect(job.prompt).toBe("Exercise relay lifecycle");
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

  test("Connections exposes Codex Bridge Thread controls through trusted IPC without model/effort controls", () => {
    const app = readFileSync(join(import.meta.dir, "..", "launcher", "src", "CouncilApp.tsx"), "utf8");
    const preload = readFileSync(join(import.meta.dir, "..", "launcher", "electron", "preload.cjs"), "utf8");
    const main = readFileSync(join(import.meta.dir, "..", "launcher", "electron", "main-council.cjs"), "utf8");
    expect(app).toContain("<h3>Codex Bridge Thread</h3>");
    expect(app).toContain("api.codexBridgeStatus()");
    expect(app).toContain("api.setCodexBridgeController");
    expect(app).toContain("api.clearCodexBridgeController");
    expect(app).toContain("api.reconnectCodexBridge");
    expect(app).toContain(">Reconnect controller</button>");
    expect(preload).toContain('ipcRenderer.invoke("launcher:codex-bridge-set", threadId)');
    expect(preload).toContain('ipcRenderer.invoke("launcher:codex-bridge-reconnect")');
    expect(main).toContain('handle("launcher:codex-bridge-set"');
    expect(main).toContain('handle("launcher:codex-bridge-reconnect"');
    expect(main).toContain("needsNativeRelay(relay?.peers)");
    expect(main).toContain("codexControllerWake.activate(status.configuredThread)");
    const bridgeSection = app.slice(app.indexOf("<h3>Codex Bridge Thread</h3>"), app.indexOf("<h3>Connect secure tunnel</h3>"));
    expect(bridgeSection).not.toMatch(/model|reasoning effort/i);
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
