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
    expect(restored.list()[0]!.state).toBe("cancelled");
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
    expect(service.list()[0]!.state).toBe("cancelled");
    expect(() => service.start(input("request-2"))).toThrow("active or unresolved relay");

    const reconcile: any = service.claim("controller");
    expect(reconcile).toMatchObject({ deliveryId: job.deliveryId, state: "submitted" });
    service.finish(...ids(reconcile), "Recovered exact answer.\nCWC_STATE: CONTINUE", "receipt-2");
    expect(service.list()[0]!.state).toBe("cancelled");
    expect(service.list()[0]!.turns).toHaveLength(1);
    expect(() => service.start(input("request-3"))).not.toThrow();
  });

  test("browser uncertainty remains submitted so Stop cannot silently release an ambiguous send", async () => {
    const service = new ProjectRelayService(join(root(), "relay.json"), { run: async () => { throw new Error("connection lost after submit"); } });
    const started = service.start(input("request-1", "gw", "work"));
    await service.idle();
    expect(service.list()[0]!.state).toBe("uncertain");
    expect(service.list()[0]!.turns.at(-1)!.state).toBe("submitted");
    service.cancel(started.id);
    expect(() => service.start(input("request-2", "gw", "work"))).toThrow("active or unresolved relay");
  });
});

describe("Owner UI regression contracts", () => {
  test("Project Relay owns its viewport scroll and exposes Stop/CLEAR controls for unresolved relays", () => {
    const css = readFileSync(join(import.meta.dir, "..", "launcher", "src", "project-relay.css"), "utf8");
    const panel = readFileSync(join(import.meta.dir, "..", "launcher", "src", "ProjectRelayPanel.tsx"), "utf8");
    expect(css).toContain("height: 100%");
    expect(css).toContain("overflow-y: auto");
    expect(panel).toContain('relay.state === "blocked"');
    expect(panel).toContain('relay.state === "uncertain"');
    expect(panel).toContain(">Stop relay</button>");
    expect(panel).toContain(">CLEAR</button>");
    expect(panel).toContain("let savedDraft = blankDraft()");
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
