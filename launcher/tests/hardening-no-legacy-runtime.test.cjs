const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

test("detached non-Council runtime entrypoints stay removed", () => {
  for (const relative of [
    "launcher/electron/main.cjs",
    "src/cli-legacy.ts",
    "src/setup.ts",
    "src/doctor.ts",
    "src/service.ts",
    "src/tunnel-service.ts",
    "src/codex-integration.ts",
    "src/server.ts",
    "src/bridge.ts",
    "src/model-catalog.ts",
    "src/native-passthrough.ts",
    "src/adapters/chatgpt-web/index.ts",
    "src/adapters/chatgpt-web/mcp-main.ts",
    "src/adapters/chatgpt-web/mcp-server.ts",
    "src/adapters/chatgpt-web/turn-broker.ts",
    "src/adapters/chatgpt-web/turn-execution.ts",
    "src/adapters/chatgpt-web/thread-environment.ts",
    "src/adapters/chatgpt-web/usage.ts",
    "scripts/smoke-codex-catalog.ts",
    "launcher/src/council-update.css",
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, relative)), false, `${relative} must stay removed`);
  }
});

test("active browser-helper response and environment dependencies stay present", () => {
  for (const relative of [
    "src/adapters/chatgpt-web/environment.ts",
    "src/responses/parser.ts",
    "src/responses/reasoning-envelope.ts",
    "src/responses/schema.ts",
    "src/responses/state.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, relative)), true, `${relative} is a current runtime dependency`);
  }
  const parser = read(repoRoot, "src", "responses", "parser.ts");
  assert.match(parser, /responsesRequestSchema/);
  assert.match(parser, /previousResponseReplayPrefixLength/);
  assert.match(parser, /decodeReasoningEnvelope/);
  const environment = read(repoRoot, "src", "adapters", "chatgpt-web", "environment.ts");
  assert.match(environment, /extractChatGptTurnUserRevision/);
  assert.match(environment, /ChatGptTurnEnvironment/);
});

test("current CLI exposes only Council runtime commands", () => {
  const cli = read(repoRoot, "src", "cli.ts");
  const packageJson = JSON.parse(read(repoRoot, "package.json"));
  assert.doesNotMatch(cli, /cli-legacy|\bserve\b|\bdoctor\b/);
  assert.match(cli, /runCouncilSetupCommand/);
  assert.match(cli, /runCouncilMcpMain/);
  assert.equal(packageJson.scripts.start, "bun run scripts/start-launcher.ts");
  assert.equal(packageJson.scripts.setup, undefined);
  assert.equal(packageJson.scripts.doctor, undefined);
  assert.equal(packageJson.scripts["smoke:codex"], undefined);
});

test("legacy-named launcher bases remain only as demonstrated current dependencies", () => {
  const runtime = read(launcherRoot, "electron", "runtime.cjs");
  const supervisor = read(launcherRoot, "electron", "runtime-supervisor.cjs");
  assert.match(runtime, /require\("\.\/runtime-legacy\.cjs"\)/);
  assert.match(runtime, /extends legacy\.RuntimeHost/);
  assert.match(supervisor, /require\("\.\/runtime-supervisor-legacy\.cjs"\)/);
  assert.match(supervisor, /extends legacy\.RuntimeSupervisor/);
  assert.equal(fs.existsSync(path.join(repoRoot, "docs", "CWC_LEGACY_CLEANUP_RETENTION.md")), true);
});

test("packaged browser helper keeps only its current verification-path compatibility helper", () => {
  const login = read(repoRoot, "src", "browser-login.ts");
  const worker = read(repoRoot, "src", "adapters", "chatgpt-web", "browser-worker.ts");
  assert.match(login, /export function loginVerificationMarkerPath/);
  assert.doesNotMatch(login, /loginToChatGpt|inspectBrowserLoginCapabilities|chromium\.launch|spawn\(/);
  assert.match(worker, /loginVerificationMarkerPath/);
});
