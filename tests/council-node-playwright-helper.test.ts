import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePlaywrightCouncilChatDriver } from "../src/council/node-playwright-council-driver";
import { CouncilConversationUnavailableError } from "../src/council/browser-transport";
import { LAUNCHER_BROWSER_HOST_KIND } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode: "success" | "conversation-missing" = "success") {
  const root = mkdtempSync(join(tmpdir(), "cwc-node-council-helper-"));
  roots.push(root);
  const capturePath = join(root, "request.json");
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, `
    const fs = require("node:fs");
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "council") return;
      fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
        message,
        electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
        helperProcess: process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS,
      }));
      if (${JSON.stringify(mode)} === "conversation-missing") {
        send({ type: "council-error", id: message.id, name: "CouncilConversationUnavailableError", message: "missing conversation" });
        return;
      }
      send({ type: "council-event", id: message.id, observation: { type: "phase", phase: "conversation-ready" } });
      send({ type: "council-event", id: message.id, observation: { type: "deep-state", state: "THINKING", confidence: 0.75, reason: "helper telemetry" } });
      send({ type: "council-result", id: message.id, value: { answer: "relay-ok", conversationUrl: "https://chatgpt.com/c/helper-test" } });
    });
  `, { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return { descriptorPath, capturePath };
}

test("Bun Council runtime delegates persistent conversation work through launcher helper protocol", async () => {
  const { descriptorPath, capturePath } = fixture();
  const driver = new NodePlaywrightCouncilChatDriver(descriptorPath);
  const phases: string[] = [];
  const observations: unknown[] = [];
  const result = await driver.create({
    surfaceId: "launcher_surface_id_0123456789AB",
    prompt: "CWC-017 relay probe",
    onPhase: phase => phases.push(phase),
    onExecution: observation => observations.push(observation),
  });

  expect(result).toEqual({ answer: "relay-ok", conversationUrl: "https://chatgpt.com/c/helper-test" });
  expect(phases).toEqual(["conversation-ready"]);
  expect(observations).toEqual([
    { type: "phase", phase: "conversation-ready" },
    { type: "deep-state", state: "THINKING", confidence: 0.75, reason: "helper telemetry" },
  ]);

  const captured = JSON.parse(readFileSync(capturePath, "utf8"));
  expect(captured.electronRunAsNode).toBe("1");
  expect(captured.helperProcess).toBe("1");
  expect(captured.message.type).toBe("council");
  expect(captured.message.operation).toBe("create");
  expect(captured.message.input).toMatchObject({
    surfaceId: "launcher_surface_id_0123456789AB",
    prompt: "CWC-017 relay probe",
  });
});

test("Council helper preserves conversation-unavailable semantics for safe resurrection logic", async () => {
  const { descriptorPath } = fixture("conversation-missing");
  const driver = new NodePlaywrightCouncilChatDriver(descriptorPath);
  await expect(driver.resume({
    surfaceId: "launcher_surface_id_0123456789AB",
    conversationUrl: "https://chatgpt.com/c/original-thread",
    prompt: "resume",
  })).rejects.toBeInstanceOf(CouncilConversationUnavailableError);
});
