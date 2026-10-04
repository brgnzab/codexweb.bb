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
  desktopCodexCandidates,
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
  assert.equal(calls[0].args.at(-1), `CODEX_CHATGPT_WEB_HOME=${coreHome}. ${WAKE_PROMPT}`);
  assert.equal(calls[0].args.some(value => /model|reasoning|effort/i.test(value)), false);
});

test("wake prompt scopes the controller to only the launcher runtime", () => {
  const coreHome = path.resolve("D:/CWC/isolated-candidate-runtime");
  const prompt = buildWakePrompt(coreHome);
  assert.equal(prompt, `CODEX_CHATGPT_WEB_HOME=${coreHome}. ${WAKE_PROMPT}`);
  assert.match(prompt, /never replay submitted\/uncertain/);
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

test("explicit CODEX_CLI_PATH must be an existing compatible absolute executable", () => {
  const expected = path.resolve("D:/Codex/codex.exe");
  assert.equal(resolveCodexExecutable({
    env: { CODEX_CLI_PATH: expected },
    exists: value => value === expected,
    find: (executable, args) => executable === expected && args[0] === "queue"
      ? { status: 0, stdout: "--thread <THREAD> --message <TEXT>", stderr: "" }
      : { status: 1, stdout: "", stderr: "" },
  }), expected);
  assert.throws(() => resolveCodexExecutable({
    env: { CODEX_CLI_PATH: "codex.exe" },
    exists: () => true,
    find: () => ({ status: 1, stdout: "", stderr: "" }),
  }), /must point to an existing Codex executable/);
  assert.throws(() => resolveCodexExecutable({
    env: { CODEX_CLI_PATH: expected },
    exists: value => value === expected,
    find: () => ({ status: 0, stdout: "Usage: codex queue <MESSAGE>", stderr: "" }),
  }), /does not support controller queue delivery/);
});

test("Windows prefers the newest compatible Codex Desktop runtime over stale standalone CLI", () => {
  const local = path.resolve("C:/Users/test/AppData/Local");
  const root = path.join(local, "OpenAI", "Codex", "bin");
  const newest = path.join(root, "bbbb2222", "codex.exe");
  const older = path.join(root, "aaaa1111", "codex.exe");
  const standalone = path.join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  const existing = new Set([root, newest, older, standalone]);
  const entries = [
    { name: "aaaa1111", isDirectory: () => true },
    { name: "bbbb2222", isDirectory: () => true },
  ];
  const run = executable => {
    if (executable === newest) return { status: 0, stdout: "--thread <THREAD> --message <TEXT>", stderr: "" };
    if (executable === older || executable === standalone) return { status: 0, stdout: "Usage: codex queue <MESSAGE>", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  assert.deepEqual(desktopCodexCandidates({
    env: { LOCALAPPDATA: local },
    exists: value => existing.has(value),
    readDir: () => entries,
    stat: value => ({ mtimeMs: value === newest ? 200 : 100 }),
  }), [newest, older]);
  assert.equal(resolveCodexExecutable({
    env: { LOCALAPPDATA: local, SystemRoot: "C:/Windows" },
    platform: "win32",
    exists: value => existing.has(value),
    readDir: () => entries,
    stat: value => ({ mtimeMs: value === newest ? 200 : 100 }),
    find: run,
  }), newest);
});
