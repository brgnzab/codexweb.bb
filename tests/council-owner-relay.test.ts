import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CouncilAgentRegistry } from "../src/council/agent-registry";
import { ManagedAgentStateStore } from "../src/council/managed-agent-state";
import { CouncilManagedRuntime } from "../src/council/managed-runtime";
import { ManagedProjectStateStore } from "../src/council/managed-project-state";
import { startCouncilOwnerRelay } from "../src/council/owner-relay";
import { CouncilStore } from "../src/council/store";

describe("Council owner relay setup", () => {
  test("binds one exact peer and schedules one controller wake through the managed runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "council-owner-relay-"));
    try {
      const store = new CouncilStore(join(root, "state.json"));
      store.joinAgent({ id: "lead", name: "Lead", role: "Lead Coordinator" });
      const managed = new ManagedAgentStateStore(join(root, "agents.json"));
      const runtime = new CouncilManagedRuntime({
        council: store,
        managed,
        project: new ManagedProjectStateStore(join(root, "project.json")),
        registry: new CouncilAgentRegistry(),
        transport: {} as any,
        parseAnswer: (() => { throw new Error("unused"); }) as any,
      });
      runtime.startProject("lead", { roomId: "project", name: "Relay", mission: "Exact-thread relay", mandate: "Coordinate" });
      managed.bindConversation("lead", "https://chatgpt.com/c/exact-A");
      const scheduled: string[] = [];
      runtime.attachAutonomy({ enqueueWake: async wake => { scheduled.push(wake.id); }, enqueuePreparedSpawn: async () => {} });
      const input = {
        leadConversationUrl: "https://chatgpt.com/c/exact-A",
        peerConversationUrl: "https://chatgpt.com/c/exact-B",
        peerAgentId: "relay-b",
        nonce: "CWC017-G9-UNIQUE-1234",
        task: "Send A1 to relay-b, then continue the six-token relay through Council WAKE actions.",
      };
      const result = await startCouncilOwnerRelay(store, runtime, input, "s".repeat(64));
      expect(result).toMatchObject({ leadAgentId: "lead", peerAgentId: "relay-b", leadConversationUrl: input.leadConversationUrl, peerConversationUrl: input.peerConversationUrl, nonce: input.nonce });
      expect(managed.get("relay-b")?.conversationUrl).toBe(input.peerConversationUrl);
      expect(managed.get("relay-b")?.permissions).toEqual(["wake"]);
      expect(scheduled).toEqual([result.wakeId]);
      expect(store.snapshot().wakes).toHaveLength(1);
      expect(store.snapshot().wakes[0]).toMatchObject({ id: result.wakeId, targetAgentId: "lead", roomId: "project" });
      expect(store.snapshot().wakes[0]!.reason).toContain(input.nonce);
      expect(store.snapshot().wakes[0]!.reason).toContain(input.task);
      await expect(startCouncilOwnerRelay(store, runtime, input)).rejects.toThrow(/nonce already has a wake/);
      expect(scheduled).toHaveLength(1);
      expect(store.snapshot().wakes).toHaveLength(1);
      await expect(startCouncilOwnerRelay(store, runtime, { ...input, nonce: "CWC017-G9-UNIQUE-5678", peerConversationUrl: input.leadConversationUrl }))
        .rejects.toThrow(/distinct/);
      await expect(startCouncilOwnerRelay(store, runtime, { ...input, nonce: "CWC017-G9-UNIQUE-5678", leadConversationUrl: "https://chatgpt.com/c/other-A" }))
        .rejects.toThrow(/requested exact conversation/);
      await expect(startCouncilOwnerRelay(store, runtime, { ...input, nonce: "CWC017-G9-UNIQUE-5678", peerConversationUrl: "https://chatgpt.com/c/other-B" }))
        .rejects.toThrow(/binding does not match/);
      await expect(startCouncilOwnerRelay(store, runtime, { ...input, nonce: "CWC017-G9-UNIQUE-5678", task: "s".repeat(64) }, "s".repeat(64)))
        .rejects.toThrow(/owner-control material/);
      expect(scheduled).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
