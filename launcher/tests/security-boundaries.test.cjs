const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once, EventEmitter } = require("node:events");
const { WebSocket } = require("ws");
const { DebuggerTransport, automationUrlAllowed } = require("../electron/debugger-transport.cjs");
const { trustedLauncherSender, rendererCsp, installRendererCsp } = require("../electron/renderer-security.cjs");
const { registerLoggedIpc, createLogger } = require("../electron/logging.cjs");
const { assertNoReparsePath, ensurePrivateDirectory, verifyPrivatePath, protectPrivatePath, windowsAclScript } = require("../electron/private-path.cjs");
const { sessionEvidenceAuthenticated } = require("../electron/browser-host.cjs");
const { sealRuntimeManifest, verifyRuntimeContent } = require("../electron/runtime-integrity.cjs");
const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");
const { createCouncilSyncClient } = require("../electron/council-connection-supervisor.cjs");

test("raw debugger metadata and websocket require the private bearer; auth and launcher surfaces are excluded", async () => {
  const debuggerApi = new EventEmitter();
  let attached = false;
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = () => { attached = true; };
  debuggerApi.detach = () => { attached = false; };
  debuggerApi.sendCommand = async () => ({ targetInfo: { targetId: "synthetic-target", browserContextId: "synthetic-context" } });
  const contents = Object.assign(new EventEmitter(), { id: 10, debugger: debuggerApi, isDestroyed: () => false, getURL: () => "https://chatgpt.com/c/dev-fixture" });
  const host = { state: { authenticated: true }, surfaceId: "s".repeat(32), view: { webContents: contents }, turnTabs: new Map() };
  const transport = await new DebuggerTransport({ getBrowserHost: () => host }).start();
  try {
    const { endpoint, token } = transport.descriptor();
    assert.equal((await fetch(`${endpoint}/json/version`)).status, 401);
    assert.equal((await fetch(`${endpoint}/json/list`)).status, 401);
    assert.equal((await fetch(`${endpoint}/json/version`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${endpoint}/json/version`, { headers: { authorization: `Bearer ${token}`, origin: "null" } })).status, 401);
    const metadata = await (await fetch(`${endpoint}/json/version`, { headers: { authorization: `Bearer ${token}` } })).json();
    const rejected = new WebSocket(metadata.webSocketDebuggerUrl);
    rejected.on("error", () => {});
    assert.equal((await once(rejected, "unexpected-response"))[1].statusCode, 403);
    rejected.terminate();
    const connection = new WebSocket(metadata.webSocketDebuggerUrl, { headers: { authorization: `Bearer ${token}`, "x-cwc-surface": host.surfaceId } });
    await once(connection, "open");
    const result = once(connection, "message");
    connection.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
    assert.match(JSON.parse((await result)[0]).error.message, /denied/);
    const closed = once(connection, "close");
    contents.emit("will-navigate", {}, "https://auth.openai.com/authorize");
    await closed;
    assert.equal(attached, false);
    host.state.authenticated = false;
    assert.equal(transport.resolveSurface(host.surfaceId), null);
    host.state.authenticated = true;
    host.authView = {};
    assert.equal(transport.resolveSurface(host.surfaceId), null);
    assert.equal(transport.resolveSurface("launcher"), null);
  } finally { await transport.close(); }
});

test("authentication routes and OAuth callbacks cannot be automation targets", () => {
  for (const url of ["https://auth.openai.com/", "https://accounts.google.com/", "https://chatgpt.com/auth/login", "https://chatgpt.com/?code=CANARY", "file:///launcher/index.html"]) assert.equal(automationUrlAllowed(url), false);
  assert.equal(automationUrlAllowed("https://chatgpt.com/c/dev-fixture"), true);
});

test("retained ChatGPT session evidence stays authenticated on existing conversation pages", () => {
  assert.equal(sessionEvidenceAuthenticated({ sessionAuthenticated: true, temporary: false, composer: true }), true);
  assert.equal(sessionEvidenceAuthenticated({ sessionAuthenticated: true, temporary: true, composer: false }), true);
  assert.equal(sessionEvidenceAuthenticated({ sessionAuthenticated: false, temporary: false, composer: true }), false);
});

test("privileged IPC rejects foreign renderers, subframes and navigation changes before calling handlers", async () => {
  const mainFrame = { url: "cwc-app://launcher/index.html" };
  const contents = { mainFrame };
  const window = { isDestroyed: () => false, webContents: contents };
  const allowed = url => url === mainFrame.url;
  const validator = event => trustedLauncherSender(event, window, allowed);
  let invoke;
  let calls = 0;
  registerLoggedIpc({ handle: (_channel, handler) => { invoke = handler; } }, { error() {} }, "privileged", () => ++calls, validator);
  await assert.rejects(invoke({ sender: {}, senderFrame: mainFrame }), /Untrusted/);
  await assert.rejects(invoke({ sender: contents, senderFrame: { url: mainFrame.url } }), /Untrusted/);
  assert.equal(await invoke({ sender: contents, senderFrame: mainFrame }), 1);
  assert.equal(calls, 1);
});

test("Windows DACLs remove inherited broad grants, protect existing descendants and reject junctions", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-private-acl-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-acl-outside-"));
  try {
    fs.writeFileSync(path.join(root, "retained-session"), "retained");
    ensurePrivateDirectory(root, { recursive: true });
    verifyPrivatePath(root);
    verifyPrivatePath(path.join(root, "retained-session"));
    assert.equal(fs.readFileSync(path.join(root, "retained-session"), "utf8"), "retained");
    const script = windowsAclScript(true, false);
    assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
    assert.match(script, /S-1-5-18/);
    fs.symlinkSync(outside, path.join(root, "escape"), "junction");
    assert.throws(() => ensurePrivateDirectory(path.join(root, "escape", "secret")), /reparse/);
    assert.throws(() => protectPrivatePath(root, { recursive: true }), /reparse/);
    assert.equal(fs.existsSync(path.join(outside, "secret")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("Windows private targets allow legitimate junction ancestors but reject a reparse target", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-private-junction-parent-"));
  const actual = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-private-junction-target-"));
  try {
    const file = path.join(actual, "owner-control.json");
    fs.writeFileSync(file, "{}");
    const junction = path.join(root, "profile-link");
    fs.symlinkSync(actual, junction, "junction");
    const throughJunction = path.join(junction, "owner-control.json");
    assert.equal(assertNoReparsePath(throughJunction), path.resolve(throughJunction));
    protectPrivatePath(throughJunction);
    verifyPrivatePath(throughJunction);
    assert.throws(() => assertNoReparsePath(junction), /reparse/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(actual, { recursive: true, force: true });
  }
});

test("OAuth URL and serialized diagnostic canaries never reach persisted logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-log-canary-"));
  try {
    const filePath = path.join(root, "launcher.jsonl");
    const logger = createLogger({ filePath });
    for (const diagnostic of [
      "https://auth.openai.com/callback?code=CANARY_CODE&state=CANARY_STATE#CANARY_FRAGMENT",
      JSON.stringify({ access_token: "CANARY_ACCESS", refreshToken: "CANARY_REFRESH", nested: JSON.stringify({ session_token: "CANARY_SESSION" }) }),
      'child failed: {"access_token":"CANARY_EMBEDDED"}',
      JSON.stringify(JSON.stringify({ secret: "CANARY_ESCAPED" })),
    ]) logger.error("canary", { message: diagnostic });
    assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /CANARY_/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("runtime verification accepts trusted resources and rejects executable, helper, dependency and manifest tampering", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-integrity-"));
  try {
    const files = ["runtime/bun.exe", "app/cli.js", "app/browser-helper.cjs", "app/node_modules/dependency/index.js"];
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), file); }
    const identity = { appVersion: "4.1.0", platform: "win32", arch: "x64" };
    const { manifestHash } = sealRuntimeManifest(root, identity);
    assert.equal(validateRuntimeBundle(root, { version: "4.1.0", platform: "win32", arch: "x64", manifestHash }), root);
    for (const file of files) {
      fs.writeFileSync(path.join(root, file), "tampered");
      assert.throws(() => verifyRuntimeContent(root, manifestHash), /integrity/);
      fs.writeFileSync(path.join(root, file), file);
    }
    fs.rmSync(path.join(root, "app/browser-helper.cjs"));
    assert.throws(() => verifyRuntimeContent(root, manifestHash), /integrity/);
    fs.writeFileSync(path.join(root, "app/browser-helper.cjs"), "app/browser-helper.cjs");
    fs.writeFileSync(path.join(root, "manifest.json"), "{}");
    assert.throws(() => verifyRuntimeContent(root, manifestHash), /manifest integrity/);
    assert.throws(() => verifyRuntimeContent(root), /Trusted/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("effective renderer response CSP denies framing and limits connections to its exact development origin", () => {
  assert.match(rendererCsp(), /frame-ancestors 'none'/);
  assert.doesNotMatch(rendererCsp(), /127\.0\.0\.1:\*/);
  const dev = "http://127.0.0.1:4190/";
  let callback;
  installRendererCsp({ webRequest: { onHeadersReceived: handler => { callback = handler; } } }, dev, dev);
  let result;
  callback({ url: dev, responseHeaders: {} }, value => { result = value; });
  assert.match(result.responseHeaders["Content-Security-Policy"][0], /ws:\/\/127\.0\.0\.1:4190/);
  assert.equal(result.responseHeaders["X-Frame-Options"][0], "DENY");
  const main = fs.readFileSync(path.join(__dirname, "../electron/main-council.cjs"), "utf8");
  assert.match(main, /protocol.handle\("cwc-app"/);
  assert.match(main, /headers.set\("Content-Security-Policy", rendererCsp\(\)\)/);
  assert.doesNotMatch(main, /appendSwitch\("remote-debugging-/);
});

test("native Council sync reads carry the intended rotating capability and reject endpoint substitution", async () => {
  let requestHeaders;
  const client = createCouncilSyncClient({ baseUrl: "http://127.0.0.1:17842", readOwnerDescriptor: () => ({ endpoint: "http://127.0.0.1:17842/api/owner", token: "synthetic-owner" }),
    fetchImpl: async (_url, options) => { requestHeaders = options.headers; return new Response(null, { status: 204 }); } });
  assert.deepEqual(await client.next({ after: "synthetic-cursor" }), { type: "idle" });
  assert.equal(requestHeaders.authorization, "Bearer synthetic-owner");
  const substituted = createCouncilSyncClient({ baseUrl: "http://127.0.0.1:17842", readOwnerDescriptor: () => ({ endpoint: "http://127.0.0.1:9999/api/owner", token: "synthetic-owner" }) });
  await assert.rejects(substituted.getSnapshot(), /mismatch/);
});
