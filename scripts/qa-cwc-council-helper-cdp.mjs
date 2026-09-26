import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(import.meta.dirname, "..");
const runRoot = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `cwc-council-helper-cdp-${process.pid}`);
const coreHome = path.join(runRoot, "core");
const launcherData = path.join(runRoot, "launcher");
let launcher;
let helper;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForFile(filePath, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    if (launcher?.exitCode !== null) throw new Error(`source launcher exited before ${path.basename(filePath)} was created`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${path.basename(filePath)}`);
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

try {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("CWC Council helper CDP probe requires Windows x64");
  fs.rmSync(runRoot, { recursive: true, force: true });
  fs.mkdirSync(coreHome, { recursive: true });
  fs.mkdirSync(launcherData, { recursive: true });

  launcher = spawn("powershell.exe", [
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
      CWC_QA_SOURCE_UI: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  launcher.stdout.resume();
  launcher.stderr.resume();

  const descriptorPath = path.join(coreHome, "runtime", "launcher-browser.json");
  await waitForFile(descriptorPath);
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  assert(descriptor?.version === 1 && descriptor?.kind === "codex-web-gpt-launcher", "invalid launcher browser descriptor");
  assert(typeof descriptor?.helper?.executable === "string" && fs.existsSync(descriptor.helper.executable), "launcher Node helper executable is missing");
  assert(typeof descriptor?.helper?.script === "string" && fs.existsSync(descriptor.helper.script), "launcher Node helper script is missing");
  assert(typeof descriptor?.surfaceId === "string" && /^[A-Za-z0-9_-]{32}$/.test(descriptor.surfaceId), "launcher owned surface id is invalid");

  helper = spawn(descriptor.helper.executable, [descriptor.helper.script], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderrTail = "";
  createInterface({ input: helper.stderr }).on("line", line => {
    stderrTail = `${stderrTail} ${line}`.replace(/[\r\n\t]+/g, " ").slice(-2_000);
  });

  const id = "cwc017nodehelperprobe";
  const terminal = await new Promise((resolve, reject) => {
    let sent = false;
    const timer = setTimeout(() => reject(new Error(`Council helper probe timed out${stderrTail ? `: ${stderrTail}` : ""}`)), 90_000);
    const output = createInterface({ input: helper.stdout });
    const finish = value => {
      clearTimeout(timer);
      output.close();
      resolve(value);
    };
    helper.once("error", error => { clearTimeout(timer); reject(error); });
    helper.once("exit", (code, signal) => {
      if (!sent) {
        clearTimeout(timer);
        reject(new Error(`Council Node helper exited before probe dispatch (${signal || code})${stderrTail ? `: ${stderrTail}` : ""}`));
      }
    });
    output.on("line", line => {
      let message;
      try { message = JSON.parse(line); }
      catch { return; }
      if (message.type === "ready" && !sent) {
        sent = true;
        helper.stdin.write(`${JSON.stringify({
          type: "council",
          id,
          operation: "focus",
          config: { browserHostDescriptorPath: descriptorPath },
          input: {
            surfaceId: descriptor.surfaceId,
            conversationUrl: "https://chatgpt.com/c/cwc017-node-helper-probe",
          },
        })}\n`);
        return;
      }
      if (message.id !== id) return;
      if (message.type === "council-result" || message.type === "council-error") finish(message);
    });
  });

  if (terminal.type === "council-error") {
    const message = String(terminal.message || "");
    assert(!/connectOverCDP|Could not connect Playwright to the launcher browser|Launcher browser CDP endpoint is not ready/i.test(message), `Council Node helper reproduced the CDP attach defect: ${message}`);
  }
  assert(terminal.type === "council-result" || terminal.type === "council-error", "Council helper did not return a terminal protocol result");
  console.log(`CWC_COUNCIL_NODE_HELPER_CDP_PASS terminal=${terminal.type}${terminal.name ? ` name=${terminal.name}` : ""}`);
} finally {
  if (helper && helper.exitCode === null) {
    try { helper.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`); } catch {}
    try { helper.stdin.end(); } catch {}
    if (!await waitForExit(helper, 2_000)) {
      try { helper.kill("SIGTERM"); } catch {}
      await waitForExit(helper, 2_000).catch(() => false);
    }
  }
  if (launcher && launcher.exitCode === null) {
    try { spawnSync("taskkill.exe", ["/pid", String(launcher.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout: 10_000 }); } catch {}
    await waitForExit(launcher, 3_000).catch(() => false);
  }
  try {
    fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (error) {
    console.warn(`CWC helper probe cleanup deferred: ${error instanceof Error ? error.message : String(error)}`);
  }
}
