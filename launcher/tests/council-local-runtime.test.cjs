const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function tempHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "cwc-local-runtime-")); }
function logger() { return { info() {}, warn() {}, error() {} }; }
function app() { return { getVersion: () => "4.1.0" }; }
function config(mode) {
  return { mode, appName: "CodexWeb Council", releaseVersion: "4.1.0" };
}
function supervisorOptions(home) {
  const descriptor = path.join(home, "runtime", "launcher-browser.json");
  fs.mkdirSync(path.dirname(descriptor), { recursive: true });
  fs.writeFileSync(descriptor, "{}\n");
  return {
    app: app(),
    logger: logger(),
    sourceRoot: home,
    installedRuntimeRoot: home,
    coreHome: home,
    browserDescriptorPath: descriptor,
    publishOperation() {},
    runtimeInvocationFactory() { throw new Error("not used in branch-selection test"); },
  };
}

test("browser-only Council starts the local managed runtime without starting a Tunnel", async (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  class LocalSupervisor extends RuntimeSupervisor {
    readConfig() { return config("browser-only"); }
    async startLocalCouncil() { this.localStarts = (this.localStarts || 0) + 1; this.daemon = { pid: 1234, exitCode: null, signalCode: null }; }
    async startTunnel() { this.tunnelStarts = (this.tunnelStarts || 0) + 1; }
  }
  const supervisor = new LocalSupervisor(supervisorOptions(home));
  const result = await supervisor.startConfigured();
  assert.equal(result.status, "ready");
  assert.equal(result.daemonPid, 1234);
  assert.equal(result.tunnelPid, null);
  assert.equal(supervisor.localStarts, 1);
  assert.equal(supervisor.tunnelStarts || 0, 0);
});

test("full Council retains the optional Tunnel startup branch", async (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  class FullSupervisor extends RuntimeSupervisor {
    readConfig() { return config("full"); }
    async startLocalCouncil() { this.localStarts = (this.localStarts || 0) + 1; }
    async startTunnel() { this.tunnelStarts = (this.tunnelStarts || 0) + 1; this.tunnel = { pid: 5678, exitCode: null, signalCode: null, managed: true }; }
  }
  const supervisor = new FullSupervisor(supervisorOptions(home));
  const result = await supervisor.startConfigured();
  assert.equal(result.status, "ready");
  assert.equal(result.daemonPid, null);
  assert.equal(result.tunnelPid, 5678);
  assert.equal(supervisor.tunnelStarts, 1);
  assert.equal(supervisor.localStarts || 0, 0);
});

test("owner-control readiness requires loopback descriptor plus bearer authentication and no Origin", async (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const supervisor = new RuntimeSupervisor(supervisorOptions(home));
  const token = "A".repeat(43);
  let observed;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      observed = {
        method: request.method,
        authorization: request.headers.authorization,
        origin: request.headers.origin,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: [] }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const ownerDir = path.join(home, "council");
  fs.mkdirSync(ownerDir, { recursive: true });
  fs.writeFileSync(path.join(ownerDir, "owner-control.json"), `${JSON.stringify({
    version: 1,
    endpoint: `http://127.0.0.1:${address.port}/api/owner`,
    token,
    issuedAt: new Date().toISOString(),
  })}\n`);

  assert.equal(await supervisor.ownerControlReady(), true);
  assert.deepEqual(observed, {
    method: "POST",
    authorization: `Bearer ${token}`,
    origin: undefined,
    body: "{}",
  });

  fs.writeFileSync(path.join(ownerDir, "owner-control.json"), `${JSON.stringify({
    version: 1,
    endpoint: `http://localhost:${address.port}/api/owner`,
    token,
    issuedAt: new Date().toISOString(),
  })}\n`);
  assert.equal(await supervisor.ownerControlReady(), false);
});
