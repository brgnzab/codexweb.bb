import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(import.meta.dirname, "..");
const runRoot = path.resolve(process.env.CWC_LOCAL_QA_RUNTIME_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), `cwc-local-runtime-${process.pid}`));
const coreHome = path.join(runRoot, "core");
const launcherData = path.join(runRoot, "launcher");
let child;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForFile(filePath, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    if (child?.exitCode !== null) throw new Error(`source launcher exited before ${path.basename(filePath)} was created (exit=${child.exitCode})`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function ownerPost(endpoint, token, pathname, { origin, authorized = true } = {}) {
  const response = await fetch(`${endpoint.origin}${pathname}`, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: "{}",
  });
  return { status: response.status, text: await response.text() };
}

try {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("CWC local runtime smoke requires Windows x64");
  fs.rmSync(runRoot, { recursive: true, force: true });
  fs.mkdirSync(coreHome, { recursive: true });
  fs.mkdirSync(launcherData, { recursive: true });

  child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "scripts", "start-cwc.ps1"),
    "-SkipInstall",
  ], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: coreHome,
      CODEX_WEB_GPT_LAUNCHER_DATA_DIR: launcherData,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));

  const browserDescriptorPath = path.join(coreHome, "runtime", "launcher-browser.json");
  const ownerDescriptorPath = path.join(coreHome, "council", "owner-control.json");
  const configPath = path.join(coreHome, "config.json");
  await waitForFile(browserDescriptorPath);
  await waitForFile(configPath);
  await waitForFile(ownerDescriptorPath);

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert(config.mode === "browser-only", `expected browser-only local config, got ${config.mode}`);
  assert(config.appName === "CodexWeb Council", `unexpected Council app name: ${config.appName}`);
  assert(config.browserHost === "launcher", `unexpected browser host: ${config.browserHost}`);
  assert(path.resolve(config.browserHostDescriptorPath) === path.resolve(browserDescriptorPath), "config does not bind the active launcher browser descriptor");
  assert(config.host === "127.0.0.1", `unexpected configured host: ${config.host}`);
  assert(!Object.prototype.hasOwnProperty.call(config, "tunnel"), "local-only config unexpectedly contains Tunnel credentials/configuration");
  assert(typeof config.controlToken === "string" && /^[A-Za-z0-9_-]{40,}$/.test(config.controlToken), "local config lifecycle token is weak or missing");

  const owner = JSON.parse(fs.readFileSync(ownerDescriptorPath, "utf8"));
  assert(owner.version === 1, "owner-control descriptor version is invalid");
  assert(typeof owner.token === "string" && /^[A-Za-z0-9_-]{40,}$/.test(owner.token), "owner-control bearer token is weak or missing");
  const endpoint = new URL(owner.endpoint);
  assert(endpoint.protocol === "http:", `owner-control protocol is not HTTP loopback: ${owner.endpoint}`);
  assert(endpoint.hostname === "127.0.0.1", `owner-control is not bound to 127.0.0.1: ${owner.endpoint}`);
  assert(endpoint.pathname === "/api/owner" && endpoint.port, `owner-control endpoint is malformed: ${owner.endpoint}`);
  assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, "owner-control endpoint contains forbidden URL components");

  const authorized = await ownerPost(endpoint, owner.token, "/api/owner/execution/runs");
  assert(authorized.status === 200, `authorized owner-control probe failed with HTTP ${authorized.status}: ${authorized.text}`);
  const body = JSON.parse(authorized.text);
  assert(body?.ok === true && Array.isArray(body?.result), "authorized owner-control response is invalid");
  assert(body.result.length === 0, "fresh local runtime has unexpected execution history");

  const unauthorized = await ownerPost(endpoint, owner.token, "/api/owner/execution/runs", { authorized: false });
  assert(unauthorized.status === 401, `owner-control accepted missing bearer token: HTTP ${unauthorized.status}`);

  const originRejected = await ownerPost(endpoint, owner.token, "/api/owner/execution/runs", { origin: "http://127.0.0.1:4178" });
  assert(originRejected.status === 403, `owner-control accepted a browser Origin: HTTP ${originRejected.status}`);

  await sleep(1_000);
  assert(child.exitCode === null, `source launcher exited while local Council runtime should remain live (exit=${child.exitCode})`);
  assert(fs.existsSync(ownerDescriptorPath), "owner-control descriptor disappeared while runtime remained live");

  console.log(JSON.stringify({
    ok: true,
    mode: config.mode,
    ownerHost: endpoint.hostname,
    ownerPath: endpoint.pathname,
    bearerRequired: unauthorized.status === 401,
    originRejected: originRejected.status === 403,
    executionRuns: body.result.length,
  }));
} catch (error) {
  const stdoutText = child ? Buffer.concat(stdout ?? []).toString("utf8") : "";
  const stderrText = child ? Buffer.concat(stderr ?? []).toString("utf8") : "";
  if (stdoutText) console.error(stdoutText.slice(-4_000));
  if (stderrText) console.error(stderrText.slice(-4_000));
  throw error;
} finally {
  if (child && child.exitCode === null) {
    try { spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout: 10_000 }); } catch {}
  }
}
