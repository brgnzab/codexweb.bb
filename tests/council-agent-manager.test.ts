import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CouncilAgentManager } from "../src/council/agent-manager";
import { classifyCouncilFailure } from "../src/council/autonomy-errors";
import { parseCouncilActionFooter } from "../src/council/browser-action-parser";
import { ManagedAgentStateStore } from "../src/council/managed-agent-state";

class FakeCouncil {
  state: any = { version: 1, agents: [], credentials: [], rooms: [{ id: "core", name: "Core", mission: "Build", createdAt: "", updatedAt: "" }], messages: [], tasks: [], decisions: [], wakes: [], checkpoints: [] };
  wakeTransitions: string[] = [];
  presenceTouches: string[] = [];
  failWakeStatus?: string;
  snapshot() { return structuredClone(this.state); }
  transaction<T>(work: (store: FakeCouncil) => T): T { const before = structuredClone(this.state); try { return work(this); } catch (error) { this.state = before; throw error; } }
  joinAgent(input: any) { if (!this.state.agents.some((agent: any) => agent.id === input.id)) this.state.agents.push({ ...input, joinedAt: "", updatedAt: "" }); return { agent: input, agentToken: "x", credentialIssued: true }; }
  touchAgentPresence(agentId: string) { this.presenceTouches.push(agentId); return { agentId, freshness: "fresh" as const, lastSeenAt: "", leaseExpiresAt: "" }; }
  say(input: any) { const id = `m${this.state.messages.length + 1}`; const message = { id, threadId: input.replyTo || id, createdAt: "", ...input }; this.state.messages.push(message); return message; }
  readRoom(id: string, limit = 40) { return this.state.messages.filter((message: any) => message.roomId === id).slice(-limit); }
  createTask(input: any) { const task = { id: `t${this.state.tasks.length + 1}`, status: "todo", createdAt: "", updatedAt: "", ...input }; this.state.tasks.push(task); return task; }
  updateTask(input: any) { const task = this.state.tasks.find((candidate: any) => candidate.id === input.taskId); if (!task) throw new Error("task does not exist"); Object.assign(task, { status: input.status, assigneeAgentId: input.assigneeAgentId ?? task.assigneeAgentId }); return task; }
  decide(input: any) { const decision = { id: `d${this.state.decisions.length + 1}`, createdAt: "", ...input }; this.state.decisions.push(decision); return decision; }
  wake(input: any) {
    const createdAt = new Date().toISOString();
    const wake = {
      id: `w${this.state.wakes.length + 1}`,
      status: "queued",
      attempts: 0,
      expiresAt: new Date(Date.parse(createdAt) + 300_000).toISOString(),
      transitions: [{ status: "queued", at: createdAt }],
      createdAt,
      updatedAt: createdAt,
      ...input,
    };
    this.state.wakes.push(wake);
    return wake;
  }
  updateWake(id: string, status: string, lastError?: string) {
    if (status === this.failWakeStatus) throw new Error(`forced wake transition failure: ${status}`);
    const wake = this.state.wakes.find((candidate: any) => candidate.id === id);
    wake.status = status;
    this.wakeTransitions.push(status);
    if (lastError) wake.lastError = lastError;
    return wake;
  }
  checkpoint(input: any) { const checkpoint = { updatedAt: "", ...input }; this.state.checkpoints.push(checkpoint); return checkpoint; }
  buildContextPacket(input: any) { return { identity: this.state.agents.find((agent: any) => agent.id === input.agentId), room: this.state.rooms.find((room: any) => room.id === input.roomId), recentMessages: this.readRoom(input.roomId, 12), decisions: this.state.decisions, tasks: this.state.tasks, generatedAt: "", instruction: "" }; }
}

class FakeRegistry {
  agents = new Map<string, any>();
  register(input: any) { this.agents.set(input.id, { ...input, status: "sleeping" }); return this.get(input.id); }
  get(id: string) { const agent = this.agents.get(id); return agent && { ...agent }; }
  lease(id: string) { const agent = this.agents.get(id); agent.status = "active"; agent.surfaceId = "A".repeat(32); return { agentId: id, status: "active", surfaceId: agent.surfaceId }; }
  release(id: string) { const agent = this.agents.get(id); if (agent) { agent.status = "sleeping"; delete agent.surfaceId; } return this.get(id); }
  bindConversation(id: string, input: any) { const agent = this.agents.get(id); agent.conversationUrl = input.conversationUrl; return this.get(id); }
}

describe("CouncilAgentManager", () => {
  test("routes six parsed relay action footers through the bound peer wake queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "manager-relay-"));
    try {
      const managed = new ManagedAgentStateStore(join(root, "agents.json"));
      const council = new FakeCouncil();
      const registry = new FakeRegistry();
      const marker = "CWC017-G9-UNIQUE-1234";
      const pending: any[] = [];
      const prompts: any[] = [];
      const steps = [
        { agent: "lead", token: "B1", next: "relay-b", nextToken: "A2" },
        { agent: "relay-b", token: "A2", next: "lead", nextToken: "B2" },
        { agent: "lead", token: "B2", next: "relay-b", nextToken: "A3" },
        { agent: "relay-b", token: "A3", next: "lead", nextToken: "B3" },
        { agent: "lead", token: "B3", next: "relay-b", nextToken: "acknowledgement" },
        { agent: "relay-b", token: "acknowledgement" },
      ];
      let index = 0;
      const transport = {
        async run(input: any) {
          prompts.push(input);
          const step = steps[index++];
          expect(step).toBeDefined();
          expect(input.agentId).toBe(step!.agent);
          expect(input.conversationUrl).toBe(`https://chatgpt.com/c/${step!.agent}`);
          const body = step!.token === "acknowledgement" ? "acknowledged" : `${marker}:${step!.token}`;
          const actions: any[] = [{ type: "SAY", room_id: "core", body }];
          if (step!.next) actions.push({ type: "WAKE", room_id: "core", target_agent_id: step!.next, reason: `Continue public marker relay; emit ${marker}:${step!.nextToken}` });
          else actions.push({ type: "SLEEP" });
          return { answer: `${body}\n<COUNCIL_ACTIONS version="1">\n${JSON.stringify({ actions })}\n</COUNCIL_ACTIONS>`, conversationUrl: input.conversationUrl, resumed: true };
        },
        async release() { return true; },
      };
      const manager = new CouncilAgentManager({
        council: council as any, managed, registry: registry as any, transport: transport as any,
        parseAnswer: parseCouncilActionFooter, projectMission: "Relay", defaultRoomId: "core",
        effectSink: { async deliverWake(wake) { pending.push(wake); }, async spawn() { throw new Error("third agent is forbidden"); } },
      });
      manager.registerLead({ id: "lead", name: "Lead", role: "Lead", mandate: "Coordinate", permissions: ["wake"] });
      manager.registerLead({ id: "relay-b", name: "Peer", role: "Peer", mandate: "Relay", permissions: ["wake"] });
      managed.bindConversation("lead", "https://chatgpt.com/c/lead");
      managed.bindConversation("relay-b", "https://chatgpt.com/c/relay-b");
      const ownerWake = council.wake({ targetAgentId: "lead", roomId: "core", reason: `COUNCIL_RELAY:${marker}:\nController task for the bound Lead. Relay peer agent ID: relay-b. Use Council actions to hand off; do not create another peer or use another conversation.\n${["A1", "B1", "A2", "B2", "A3", "B3"].map(step => `${marker}:${step}`).join(" ")}` });
      await manager.executeWakeEvent(ownerWake as any);
      expect(prompts[0].prompt).toContain(`${marker}:B1`);
      expect(prompts[0].prompt).toContain('"target_agent_id":"relay-b"');
      while (pending.length) await manager.executeWakeEvent(pending.shift());
      expect(index).toBe(6);
      expect(council.state.messages.map((message: any) => message.body)).toEqual([
        `${marker}:B1`, `${marker}:A2`, `${marker}:B2`, `${marker}:A3`, `${marker}:B3`, "acknowledged",
      ]);
      expect(council.state.wakes.map((wake: any) => wake.targetAgentId)).toEqual(["lead", "relay-b", "lead", "relay-b", "lead", "relay-b"]);
      expect(council.state.wakes.every((wake: any) => wake.status === "replied")).toBe(true);
      expect(managed.list().map(agent => agent.id).sort()).toEqual(["lead", "relay-b"]);
      expect(prompts[1].prompt).toContain("public test marker");
      // First peer wake uses the full prompt; later A/B wakes use the delta.
      // Both must carry the schema and an example targeting the bound sender.
      for (let turn = 1; turn < prompts.length; turn++) {
        const prompt = prompts[turn].prompt as string;
        expect(prompt).toContain('Never put "body", "message", or any other unknown field on WAKE');
        const example = prompt.split("\n").find(line => line.startsWith('{"actions":') && line.includes('"type":"WAKE"'))!;
        const parsed = parseCouncilActionFooter(`<COUNCIL_ACTIONS version="1">${example}</COUNCIL_ACTIONS>`);
        expect(parsed.batch.actions.map(action => action.type)).toEqual(["SAY", "WAKE"]);
        expect(parsed.batch.actions[1]).toMatchObject({ target_agent_id: steps[turn - 1]!.agent, room_id: "core" });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const invalid of [
    { name: "WAKE body", action: { type: "WAKE", room_id: "core", target_agent_id: "lead", reason: "Continue", body: "A2" } },
    { name: "WAKE message", action: { type: "WAKE", room_id: "core", target_agent_id: "lead", reason: "Continue", message: "A2" } },
    { name: "WAKE missing reason", action: { type: "WAKE", room_id: "core", target_agent_id: "lead" } },
    { name: "capacity wording in invalid field", action: { type: "WAKE", room_id: "core", target_agent_id: "lead", reason: "Continue", "capacity is full": "untrusted" } },
    { name: "unknown target", action: { type: "WAKE", room_id: "core", target_agent_id: "unbound", reason: "Continue" } },
    { name: "invalid JSON", answer: '<COUNCIL_ACTIONS version="1">{bad}</COUNCIL_ACTIONS>' },
    { name: "missing action footer", answer: "A2" },
  ]) {
    test(`fails closed after one submission for ${invalid.name}, with no partial SAY or wake`, async () => {
      const root = mkdtempSync(join(tmpdir(), "manager-invalid-footer-"));
      try {
        const managed = new ManagedAgentStateStore(join(root, "agents.json"));
        const council = new FakeCouncil();
        const registry = new FakeRegistry();
        let submissions = 0;
        let releases = 0;
        const transport = {
          async run(input: any) {
            submissions++;
            // Deliberately omit phase events: even legacy transports returning a
            // response must close the manager's retry boundary.
            return { answer: invalid.answer ?? `A2\n<COUNCIL_ACTIONS version="1">${JSON.stringify({ actions: [
              { type: "SAY", room_id: "core", body: "A2" }, invalid.action,
            ] })}</COUNCIL_ACTIONS>`, conversationUrl: input.conversationUrl, resumed: true };
          },
          async release() { releases++; return true; },
        };
        const manager = new CouncilAgentManager({ council: council as any, managed, registry: registry as any, transport, parseAnswer: parseCouncilActionFooter, projectMission: "Relay", defaultRoomId: "core" });
        manager.registerLead({ id: "lead", name: "Lead", role: "Lead", mandate: "Coordinate", permissions: ["wake"] });
        manager.registerLead({ id: "peer", name: "Peer", role: "Peer", mandate: "Relay", permissions: ["wake"] });
        managed.bindConversation("peer", "https://chatgpt.com/c/peer");
        const error = await manager.wakeAgent("lead", "peer", "core", "Emit A2 then wake lead").then(() => undefined, error => error);
        expect(error).toBeInstanceOf(Error);
        expect(classifyCouncilFailure(error)).toEqual({ code: "SUBMISSION_UNCERTAIN", retryableBeforeSubmit: false });
        expect(submissions).toBe(1);
        expect(releases).toBe(1);
        expect(council.state.messages).toEqual([]);
        expect(council.state.wakes).toHaveLength(1);
        expect(council.state.wakes[0].status).toBe("failed");
        expect(registry.get("peer")?.status).toBe("sleeping");
        expect(managed.get("peer")?.conversationUrl).toBe("https://chatgpt.com/c/peer");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  for (const afterSubmit of [false, true]) {
    test(`capacity error ${afterSubmit ? "after submit never retries" : "before submit can recover"}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "manager-submit-boundary-"));
      try {
        const managed = new ManagedAgentStateStore(join(root, "agents.json"));
        const council = new FakeCouncil();
        const registry = new FakeRegistry();
        let calls = 0;
        let releases = 0;
        const phases: string[] = [];
        const transport = {
          async run(input: any) {
            calls++;
            input.onPhase?.("lease-acquired");
            if (afterSubmit) input.onPhase?.("submit-started");
            if (calls === 1) throw new Error("capacity is full");
            return { answer: '<COUNCIL_ACTIONS version="1">{"actions":[{"type":"SLEEP"}]}</COUNCIL_ACTIONS>', conversationUrl: input.conversationUrl, resumed: true };
          },
          async release() { releases++; return true; },
        };
        const manager = new CouncilAgentManager({ council: council as any, managed, registry: registry as any, transport, parseAnswer: parseCouncilActionFooter, projectMission: "Relay", defaultRoomId: "core" });
        manager.registerLead({ id: "peer", name: "Peer", role: "Peer", mandate: "Relay", permissions: ["wake"] });
        managed.bindConversation("peer", "https://chatgpt.com/c/peer");
        const wake = council.wake({ targetAgentId: "peer", roomId: "core", reason: "Work" });
        const result = manager.executeWakeEvent(wake as any, 0, phase => phases.push(phase));
        if (afterSubmit) {
          await expect(result).rejects.toMatchObject({ code: "SUBMISSION_UNCERTAIN", retryableBeforeSubmit: false });
          expect(calls).toBe(1);
          expect(phases).toEqual(["lease-acquired", "submit-started"]);
          expect(council.state.wakes[0].status).toBe("failed");
        } else {
          await result;
          expect(calls).toBe(2);
          expect(phases).toEqual(["lease-acquired", "lease-acquired"]);
          expect(council.state.wakes[0].status).toBe("replied");
        }
        expect(releases).toBe(calls);
        expect(registry.get("peer")?.status).toBe("sleeping");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("lead spawns a child, records its speech, persists conversation and releases the surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "manager-"));
    try {
      const managed = new ManagedAgentStateStore(join(root, "agents.json"));
      const council = new FakeCouncil();
      const registry = new FakeRegistry();
      const calls: any[] = [];
      const transport = { async run(input: any) { calls.push(input); return { answer: "Bob found a race", conversationUrl: "https://chatgpt.com/c/bob", resumed: false }; }, async release(id: string) { calls.push({ release: id }); return true; } };
      const parse = () => ({ visibleText: "Bob found a race", batch: { version: 1 as const, actions: [{ type: "SAY" as const, room_id: "core", body: "race" }, { type: "SLEEP" as const }] } });
      const manager = new CouncilAgentManager({ council: council as any, managed, registry: registry as any, transport: transport as any, parseAnswer: parse, projectMission: "Build", defaultRoomId: "core" });
      manager.registerLead({ id: "alice", name: "Alice", role: "Lead", mandate: "Lead", permissions: ["spawn", "wake", "finalize", "assign"] });
      const result = await manager.spawnAgent("alice", { name: "Bob", role: "Critic", mandate: "Attack", requestedAgentId: "bob" });
      expect(result.id).toBe("bob");
      expect(managed.get("bob")?.conversationUrl).toBe("https://chatgpt.com/c/bob");
      expect(council.state.messages.at(-1).body).toBe("Bob found a race");
      expect(council.presenceTouches).toContain("bob");
      expect(calls.at(-1).release).toBe("bob");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("managed wake records dispatched, target-running and replied around the persistent response", async () => {
    const root = mkdtempSync(join(tmpdir(), "manager-"));
    try {
      const managed = new ManagedAgentStateStore(join(root, "agents.json"));
      const council = new FakeCouncil();
      const registry = new FakeRegistry();
      const calls: any[] = [];
      const transport = { async run(input: any) { calls.push(input); return { answer: "Bob response", conversationUrl: "https://chatgpt.com/c/bob", resumed: true }; }, async release() { return true; } };
      const parse = () => ({ visibleText: "Bob response", batch: { version: 1 as const, actions: [{ type: "SAY" as const, room_id: "core", body: "response" }, { type: "SLEEP" as const }] } });
      const manager = new CouncilAgentManager({ council: council as any, managed, registry: registry as any, transport: transport as any, parseAnswer: parse, projectMission: "Build", defaultRoomId: "core" });
      manager.registerLead({ id: "alice", name: "Alice", role: "Lead", mandate: "Lead", permissions: ["spawn", "wake", "finalize", "assign"] });
      manager.registerLead({ id: "bob", name: "Bob", role: "Critic", mandate: "Attack", permissions: ["wake", "review"] });
      managed.bindConversation("bob", "https://chatgpt.com/c/bob");
      await manager.wakeAgent("alice", "bob", "core", "Review this");
      expect(calls[0].conversationUrl).toBe("https://chatgpt.com/c/bob");
      expect(calls[0].prompt).toContain("Allowed actions: SAY, PROPOSE, REPLY, WAKE");
      expect(calls[0].prompt).toContain("Review this");
      expect(calls[0].resurrectionPrompt).toContain("Review this");
      expect(council.wakeTransitions).toEqual(["dispatched", "target-running", "replied"]);
      expect(council.state.wakes[0].status).toBe("replied");
      expect(council.presenceTouches).toContain("bob");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("running transition failure still releases the leased browser surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "manager-"));
    try {
      const managed = new ManagedAgentStateStore(join(root, "agents.json"));
      const council = new FakeCouncil();
      council.failWakeStatus = "target-running";
      const registry = new FakeRegistry();
      const calls: any[] = [];
      const transport = { async run() { throw new Error("transport must not run after transition failure"); }, async release(id: string) { calls.push({ release: id }); return true; } };
      const manager = new CouncilAgentManager({ council: council as any, managed, registry: registry as any, transport: transport as any, parseAnswer: (() => null) as any, projectMission: "Build", defaultRoomId: "core" });
      manager.registerLead({ id: "alice", name: "Alice", role: "Lead", mandate: "Lead", permissions: ["wake"] });
      manager.registerLead({ id: "bob", name: "Bob", role: "Critic", mandate: "Attack", permissions: ["wake", "review"] });
      managed.bindConversation("bob", "https://chatgpt.com/c/bob");

      await expect(manager.wakeAgent("alice", "bob", "core", "Review this")).rejects.toThrow(/target-running/);

      expect(calls).toEqual([{ release: "bob" }]);
      expect(registry.get("bob")?.status).toBe("sleeping");
      expect(council.state.wakes[0].status).toBe("failed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("critic without spawn permission cannot mint a child", async () => {
    const root = mkdtempSync(join(tmpdir(), "manager-"));
    try {
      const managed = new ManagedAgentStateStore(join(root, "agents.json"));
      const manager = new CouncilAgentManager({ council: new FakeCouncil() as any, managed, registry: new FakeRegistry() as any, transport: {} as any, parseAnswer: (() => null) as any, projectMission: "Build", defaultRoomId: "core" });
      manager.registerLead({ id: "critic", name: "Critic", role: "Critic", mandate: "Attack", permissions: ["wake", "review"] });
      await expect(manager.spawnAgent("critic", { name: "X", role: "Worker", mandate: "Work" })).rejects.toThrow(/spawn/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
