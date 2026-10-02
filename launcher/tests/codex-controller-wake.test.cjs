const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const {
  CodexControllerWake,
  WAKE_PROMPT,
  buildWakePrompt,
  needsNativeRelay,
  resolveCodexExecutable,
} = require("../electron/codex-controller-wake.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("native relay detection is limited to Codex and Work peers", () => {
  assert.equal(needsNativeRelay([{ kind: "gw" }, { kind: "gw" }]), false);
  assert.equal(needsNativeRelay([{ kind: "gw" }, { kind: "codex" }]), true);
  assert.equal(needsNativeRelay([{ kind: "work" }, { kind: "gw" }]), true);
});

test("controller activation queues one message to the exact configured native thread", async () => {
  const calls = [];
  const child = fakeChild();
  const coreHome = path.resolve("D:/CWC/runtime");
  const wake = new CodexControllerWake({
    coreHome,
    resolveExecutable: () => "codex.exe",
    spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options });
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });
  const threadId = "10000000-0000-0000-0000-000000000001";
  assert.deepEqual(await wake.activate(threadId), { requested: true, threadId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "codex.exe");
  assert.deepEqual(calls[0].args, ["queue", "--thread", threadId, "--message", buildWakePrompt(coreHome)]);
  assert.equal(calls[0].options.cwd, coreHome);
  assert.match(calls[0].args.at(-1), new RegExp(coreHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(calls[0].args.at(-1), /Do not read, claim, reconcile, or modify relay state from any other CWC runtime\/home/);
  assert.equal(calls[0].args.some(value => /model|reasoning|effort/i.test(value)), false);
});

test("wake prompt scopes the controller to only the launcher runtime", () => {
  const coreHome = path.resolve("D:/CWC/isolated-candidate-runtime");
  const prompt = buildWakePrompt(coreHome);
  assert.match(prompt, new RegExp(coreHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /CODEX_CHATGPT_WEB_HOME exactly to this path/);
  assert.match(prompt, /Do not read, claim, reconcile, or modify relay state from any other CWC runtime\/home/);
  assert.match(prompt, new RegExp(WAKE_PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("concurrent reconnect requests share one Codex queue operation", async () => {
  const calls = [];
  const child = fakeChild();
  const wake = new CodexControllerWake({
    coreHome: path.resolve("D:/CWC/runtime"),
    resolveExecutable: () => "codex.exe",
    spawnImpl: (executable, args, options) => { calls.push({ executable, args, options }); return child; },
  });
  const threadId = "10000000-0000-0000-0000-000000000001";
  const first = wake.activate(threadId);
  const second = wake.activate(threadId);
  assert.equal(calls.length, 1);
  child.emit("exit", 0, null);
  assert.deepEqual(await first, { requested: true, threadId });
  assert.deepEqual(await second, { requested: true, threadId });
});

test("controller activation surfaces queue failure instead of pretending reconnect succeeded", async () => {
  const child = fakeChild();
  const wake = new CodexControllerWake({
    coreHome: path.resolve("D:/CWC/runtime"),
    resolveExecutable: () => "codex.exe",
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("shared app-server unavailable\n"));
        child.emit("exit", 1, null);
      });
      return child;
    },
  });
  await assert.rejects(
    () => wake.activate("10000000-0000-0000-0000-000000000001"),
    /shared app-server unavailable/,
  );
});

test("controller activation rejects malformed ids before starting Codex", async () => {
  let spawned = false;
  const wake = new CodexControllerWake({
    coreHome: path.resolve("D:/CWC/runtime"),
    resolveExecutable: () => "codex.exe",
    spawnImpl: () => { spawned = true; return fakeChild(); },
  });
  await assert.rejects(() => wake.activate("not-a-thread"), /invalid/);
  assert.equal(spawned, false);
});

test("explicit CODEX_CLI_PATH must be an existing absolute executable", () => {
  const expected = path.resolve("D:/Codex/codex.exe");
  assert.equal(resolveCodexExecutable({
    env: { CODEX_CLI_PATH: expected },
    exists: value => value === expected,
    find: () => ({ status: 1, stdout: "" }),
  }), expected);
  assert.throws(() => resolveCodexExecutable({
    env: { CODEX_CLI_PATH: "codex.exe" },
    exists: () => true,
    find: () => ({ status: 1, stdout: "" }),
  }), /must point to an existing Codex executable/);
});
