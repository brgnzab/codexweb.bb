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
      sessionId: "session-secret",
      session_key: "session-key-secret",
      csrfToken: "csrf-secret",
      xsrf_token: "xsrf-secret",
      xApiKey: "header-api-secret",
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
      sessionId: "[redacted]",
      session_key: "[redacted]",
      csrfToken: "[redacted]",
      xsrf_token: "[redacted]",
      xApiKey: "[redacted]",
    },
  });
});

test("launcher log text redacts auth headers, cookies, URL credentials, session and csrf material", () => {
  const accessParam = "access_" + "token";
  const sessionParam = "session_" + "id";
  const csrfParam = "csrf_" + "token";
  const credentialUrl = "https://owner:" + "password@example.invalid/path?"
    + `${accessParam}=very-secret-access-token&${sessionParam}=private-session&${csrfParam}=private-csrf`;
  const value = redactText(
    "Cookie: session=super-secret-cookie\n"
    + "Authorization: Basic owner-secret-auth\n"
    + "X-Api-Key: header-super-secret\n"
    + `${credentialUrl}\n`
    + "sessionId: colon-session xsrf_token=private-xsrf",
  );
  for (const secret of [
    "super-secret-cookie",
    "owner-secret-auth",
    "header-super-secret",
    "owner:password",
    "very-secret-access-token",
    "private-session",
    "private-csrf",
    "colon-session",
    "private-xsrf",
  ]) assert.doesNotMatch(value, new RegExp(secret));
  assert.match(value, /access_token=\[redacted\]/);
  assert.match(value, /session_id=\[redacted\]/);
  assert.match(value, /csrf_token=\[redacted\]/);
  assert.match(value, /Cookie: \[redacted\]/);
  assert.match(value, /Authorization: \[redacted\]/);
  assert.match(value, /X-Api-Key: \[redacted\]/);
});

test("persisted launcher records never write session or csrf secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-secret-log-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    const logger = createLogger({ filePath });
    const bearer = "Bearer " + "persisted-bearer-secret-0123456789";
    logger.error("secret-test", {
      sessionToken: "persisted-session-secret",
      message: `csrf_token=persisted-csrf-secret Authorization: ${bearer}`,
    });
    const written = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(written, /persisted-session-secret/);
    assert.doesNotMatch(written, /persisted-csrf-secret/);
    assert.doesNotMatch(written, /persisted-bearer-secret/);
    assert.match(written, /\[redacted\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
