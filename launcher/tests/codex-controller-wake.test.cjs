const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const {
  CodexControllerWake,
  WAKE_PROMPT,
  needsNativeRelay,
  resolveCodexExecutable,
} = require("../electron/codex-controller-wake.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {};
  return child;
}

test("native relay detection is limited to Codex and Work peers", () => {
  assert.equal(needsNativeRelay([{ kind: "gw" }, { kind: "gw" }]), false);
  assert.equal(needsNativeRelay([{ kind: "gw" }, { kind: "codex" }]), true);
  assert.equal(needsNativeRelay([{ kind: "work" }, { kind: "gw" }]), true);
});

test("controller activation resumes the exact configured thread without model or effort overrides", () => {
  const calls = [];
  const child = fakeChild();
  const coreHome = path.resolve("D:/CWC/runtime");
  const wake = new CodexControllerWake({
    coreHome,
    resolveExecutable: () => "codex.exe",
    spawnImpl: (executable, args, options) => { calls.push({ executable, args, options }); return child; },
  });
  const threadId = "10000000-0000-0000-0000-000000000001";
  assert.deepEqual(wake.activate(threadId), { requested: true, alreadyRunning: false, threadId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "codex.exe");
  assert.deepEqual(calls[0].args, ["exec", "resume", threadId, "--json", "--skip-git-repo-check", WAKE_PROMPT]);
  assert.equal(calls[0].options.cwd, coreHome);
  assert.equal(calls[0].options.env.CODEX_CHATGPT_WEB_HOME, coreHome);
  assert.equal(calls[0].args.some(value => /model|reasoning|effort/i.test(value)), false);

  assert.deepEqual(wake.activate(threadId), { requested: false, alreadyRunning: true, threadId });
  assert.equal(calls.length, 1);

  child.exitCode = 0;
  child.emit("exit", 0, null);
  const second = fakeChild();
  wake.spawnImpl = (executable, args, options) => { calls.push({ executable, args, options }); return second; };
  assert.equal(wake.activate(threadId).requested, true);
  assert.equal(calls.length, 2);
});

test("controller activation rejects malformed ids before starting Codex", () => {
  let spawned = false;
  const wake = new CodexControllerWake({
    coreHome: path.resolve("D:/CWC/runtime"),
    resolveExecutable: () => "codex.exe",
    spawnImpl: () => { spawned = true; return fakeChild(); },
  });
  assert.throws(() => wake.activate("not-a-thread"), /invalid/);
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
