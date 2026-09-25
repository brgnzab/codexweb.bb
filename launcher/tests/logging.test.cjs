const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  createLogger,
  installProcessDiagnosticGuards,
  redactText,
  registerLoggedIpc,
  sanitize,
} = require("../electron/logging.cjs");

test("launcher logs redact tunnel ids, runtime keys, bearer credentials, and generic secret fields", () => {
  assert.deepEqual(sanitize({
    line: "tunnel_0123456789abcdef0123456789abcdef sk-exampleRuntimeSecret123",
    authorization: "Bearer this-must-never-be-recorded",
    nested: {
      controlToken: "also-secret",
      accessToken: "access-secret",
      refresh_token: "refresh-secret",
      apiKey: "api-secret",
      password: "password-secret",
      clientSecret: "client-secret",
    },
  }), {
    line: "[tunnel-id] [runtime-key]",
    authorization: "[redacted]",
    nested: {
      controlToken: "[redacted]",
      accessToken: "[redacted]",
      refresh_token: "[redacted]",
      apiKey: "[redacted]",
      password: "[redacted]",
      clientSecret: "[redacted]",
    },
  });
});

test("launcher log text redacts cookie headers, URL credentials, and secret query parameters", () => {
  const value = redactText(
    "Cookie: session=super-secret-cookie\n"
    + "https://owner:password@example.invalid/path?access_token=very-secret-access-token",
  );
  assert.doesNotMatch(value, /super-secret-cookie/);
  assert.doesNotMatch(value, /owner:password/);
  assert.doesNotMatch(value, /very-secret-access-token/);
  assert.match(value, /Cookie: \[redacted\]/);
  assert.match(value, /access_token=\[redacted\]/);
});

test("failed launcher IPC calls are written to runtime activity", async () => {
  let registered;
  const errors = [];
  const ipcMain = {
    handle(channel, handler) {
      registered = { channel, handler };
    },
  };
  registerLoggedIpc(
    ipcMain,
    { error: (event, detail) => errors.push({ event, detail }) },
    "launcher:test",
    async () => {
      throw new Error("visible failure");
    },
  );

  await assert.rejects(registered.handler({}, 1), /visible failure/);
  assert.deepEqual(errors, [{
    event: "launcher.ipc_failed",
    detail: { channel: "launcher:test", message: "visible failure" },
  }]);
});

test("launcher activity restores valid records from the previous process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-logging-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    fs.writeFileSync(filePath, [
      JSON.stringify({ at: "2026-07-28T00:00:00.000Z", level: "info", event: "previous", detail: {} }),
      "not-json",
      "",
    ].join("\n"));
    const logger = createLogger({ filePath });
    assert.deepEqual(logger.recent().map((record) => record.event), ["previous"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a closed Windows diagnostic pipe redacts credentials without becoming an uncaught process error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-process-pipe-"));
  const filePath = path.join(root, "process-stream-errors.log");
  const stream = new PassThrough();
  try {
    installProcessDiagnosticGuards({ filePath, streams: [stream] });
    stream.emit("error", Object.assign(new Error("write EOF Bearer this-must-never-be-recorded"), { code: "EOF" }));
    const written = fs.readFileSync(filePath, "utf8");
    assert.match(written, /write EOF/);
    assert.doesNotMatch(written, /this-must-never-be-recorded/);
  } finally {
    stream.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
