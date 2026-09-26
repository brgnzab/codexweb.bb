import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright-core";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(import.meta.dirname, "..");
const evidenceDir = path.resolve(process.env.CWC_QA_EVIDENCE_DIR || path.join(root, ".cwc-data", "qa-source-ui-gate"));
const runRoot = path.resolve(process.env.CWC_QA_RUNTIME_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), `cwc-source-ui-${process.pid}`));
const coreHome = path.join(runRoot, "core");
const launcherData = path.join(runRoot, "launcher");
const stdoutPath = path.join(evidenceDir, "source-launch.stdout.log");
const stderrPath = path.join(evidenceDir, "source-launch.stderr.log");
const reportPath = path.join(evidenceDir, "report.json");

fs.mkdirSync(evidenceDir, { recursive: true });
fs.rmSync(runRoot, { recursive: true, force: true });
fs.mkdirSync(coreHome, { recursive: true });
fs.mkdirSync(launcherData, { recursive: true });

const stdout = fs.createWriteStream(stdoutPath, { flags: "w" });
const stderr = fs.createWriteStream(stderrPath, { flags: "w" });
let child;
let browser;
let page;
let cdp;
const pageErrors = [];
const consoleErrors = [];
const results = { routes: {}, layout: [], runtime: {}, diagnostics: {}, process: {}, files: {} };

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

async function waitForRenderer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        if (/^http:\/\/127\.0\.0\.1:4178\/?/.test(candidate.url())) return candidate;
      }
    }
    await sleep(100);
  }
  throw new Error("renderer page did not appear over Electron CDP");
}

async function openMissionControl() {
  const button = page.getByRole("button", { name: "Open Mission Control" });
  if (await button.count()) {
    await button.evaluate(element => element.click());
    await page.waitForSelector(".council-shell", { timeout: 15_000 });
  }
}

async function openRoute(label) {
  await page.evaluate((routeLabel) => {
    const strong = [...document.querySelectorAll(".council-sidebar nav button strong")]
      .find(node => node.textContent?.trim() === routeLabel);
    const button = strong?.closest("button");
    if (!button) throw new Error(`route button not found: ${routeLabel}`);
    button.click();
  }, label);
  await sleep(300);
  const text = await page.locator(".council-workspace").innerText();
  assert(text.trim().length > 0, `${label} workspace is blank`);
  results.routes[label] = { textLength: text.trim().length, excerpt: text.trim().slice(0, 240) };
  return text;
}

async function setWindowWidth(width, height = 900) {
  try {
    const windowInfo = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId: windowInfo.windowId, bounds: { width, height, windowState: "normal" } });
  } catch {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }
  await sleep(350);
}

async function inspectWorkLayout(width) {
  await setWindowWidth(width);
  await openRoute("Work");
  const layout = await page.evaluate(() => {
    const split = document.querySelector(".work-split");
    const tasks = document.querySelector(".work-tasks");
    const autonomy = document.querySelector(".work-autonomy");
    const manager = document.querySelector(".manager-control");
    const managerCopy = document.querySelector(".manager-control-copy");
    const managerActions = document.querySelector(".manager-control-actions");
    if (!split || !tasks || !autonomy || !manager || !managerCopy || !managerActions) throw new Error("Work layout surfaces are missing");
    const splitStyle = getComputedStyle(split);
    const managerStyle = getComputedStyle(manager);
    const tasksRect = tasks.getBoundingClientRect();
    const autonomyRect = autonomy.getBoundingClientRect();
    const managerRect = manager.getBoundingClientRect();
    const managerCopyRect = managerCopy.getBoundingClientRect();
    const managerActionsRect = managerActions.getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      gridTemplateColumns: splitStyle.gridTemplateColumns,
      managerGridTemplateColumns: managerStyle.gridTemplateColumns,
      tasks: { x: tasksRect.x, y: tasksRect.y, width: tasksRect.width, height: tasksRect.height },
      autonomy: { x: autonomyRect.x, y: autonomyRect.y, width: autonomyRect.width, height: autonomyRect.height },
      manager: { x: managerRect.x, y: managerRect.y, width: managerRect.width, height: managerRect.height },
      managerCopy: { x: managerCopyRect.x, y: managerCopyRect.y, width: managerCopyRect.width, height: managerCopyRect.height },
      managerActions: { x: managerActionsRect.x, y: managerActionsRect.y, width: managerActionsRect.width, height: managerActionsRect.height },
    };
  });
  assert(layout.tasks.width >= 280, `Work tasks column collapsed at requested width ${width}: ${layout.tasks.width}`);
  assert(layout.autonomy.width >= 280, `Autonomy column collapsed at requested width ${width}: ${layout.autonomy.width}`);
  assert(layout.managerCopy.width >= 240, `Project Manager copy collapsed at requested width ${width}: ${layout.managerCopy.width}`);
  if (layout.viewportWidth <= 1280) {
    assert(layout.autonomy.y >= layout.tasks.y + Math.min(100, layout.tasks.height / 4), `Work panes did not stack at viewport ${layout.viewportWidth}`);
  }
  const screenshot = path.join(evidenceDir, `work-${width}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  results.layout.push({ requestedWidth: width, ...layout, screenshot: path.basename(screenshot) });
}

async function readLauncherLogs() {
  return await page.evaluate(async () => await window.codexWebLauncher.logs(250));
}

try {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("CWC source UI gate requires Windows x64");

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
      CWC_QA_SOURCE_UI: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  const descriptorPath = path.join(coreHome, "runtime", "launcher-browser.json");
  await waitForFile(descriptorPath);
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  assert(descriptor?.version === 1 && descriptor?.kind === "codex-web-gpt-launcher", "invalid Council browser descriptor");
  const endpoint = new URL(descriptor.endpoint);
  assert(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1" && endpoint.port, `invalid loopback CDP endpoint: ${descriptor.endpoint}`);
  results.process.browserDescriptor = path.relative(runRoot, descriptorPath);
  results.process.cdpEndpoint = endpoint.origin;

  browser = await chromium.connectOverCDP(endpoint.origin, { timeout: 15_000 });
  page = await waitForRenderer();
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  cdp = await page.context().newCDPSession(page);

  await page.waitForLoadState("domcontentloaded");
  await openMissionControl();
  await page.waitForSelector(".council-sidebar", { timeout: 15_000 });

  for (const route of ["Overview", "Agents", "Work", "Executions", "Memory", "Connections", "Diagnostics", "Settings", "ChatGPT"]) {
    const text = await openRoute(route);
    if (route === "Work" || route === "Executions") {
      assert(!/ENOENT|owner-control\.json/i.test(text), `${route} leaks missing owner-control filesystem failure`);
    }
  }

  results.runtime.neutral = await page.evaluate(async () => {
    const api = window.codexWebLauncher;
    return {
      runs: await api.councilExecutionRuns(),
      receipts: await api.councilExecutionReceipts(),
      observations: await api.councilObservations(),
      supervisor: await api.councilSupervisorStatus(),
      autonomy: await api.councilAutonomyStatus(),
      memory: await api.councilMemoryStats(null),
    };
  });
  assert(Array.isArray(results.runtime.neutral.runs) && results.runtime.neutral.runs.length === 0, "fresh profile execution runs are not neutral/empty");
  assert(Array.isArray(results.runtime.neutral.receipts) && results.runtime.neutral.receipts.length === 0, "fresh profile receipts are not neutral/empty");
  assert(Array.isArray(results.runtime.neutral.observations) && results.runtime.neutral.observations.length === 0, "fresh profile observations are not neutral/empty");

  results.runtime.privilegedProbe = await page.evaluate(async () => {
    try {
      await window.codexWebLauncher.runCouncilSupervisorNow();
      return { ok: true, message: "unexpected success" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  assert(results.runtime.privilegedProbe.ok === false, "privileged fresh-profile operation unexpectedly succeeded");
  assert(/Council runtime is not configured or running/i.test(results.runtime.privilegedProbe.message), `privileged failure is not operator-safe: ${results.runtime.privilegedProbe.message}`);
  assert(!/ENOENT|owner-control\.json/i.test(results.runtime.privilegedProbe.message), "privileged failure leaks filesystem details");

  await openRoute("Diagnostics");
  await sleep(2_500);
  const logs = await readLauncherLogs();
  const badSnapshotLogs = logs.filter(record => record?.event === "council.shared_snapshot_failed" || /council\.shared_snapshot_failed/.test(JSON.stringify(record)));
  results.diagnostics = { logCount: logs.length, badSnapshotLogs };
  assert(badSnapshotLogs.length === 0, "fresh unconfigured profile emitted council.shared_snapshot_failed");

  for (const width of [1400, 1280, 1100]) await inspectWorkLayout(width);

  assert(pageErrors.length === 0, `renderer page errors: ${pageErrors.join(" | ")}`);
  results.process.pageErrors = pageErrors;
  results.process.consoleErrors = consoleErrors;

  results.process.closePreference = await page.evaluate(async () => {
    const state = await window.codexWebLauncher.setPreference("keepRunningOnClose", false);
    return state.keepRunningOnClose;
  });
  assert(results.process.closePreference === false, "isolated source profile did not accept keepRunningOnClose=false");
  await page.evaluate(() => window.codexWebLauncher.windowControl("close"));
  const exitDeadline = Date.now() + 15_000;
  while (child.exitCode === null && Date.now() < exitDeadline) await sleep(100);
  assert(child.exitCode !== null, "source launcher did not exit after normal window close with keepRunningOnClose=false");
  assert(child.exitCode === 0, `source launcher exited with ${child.exitCode}`);

  const launcherLogPath = path.join(launcherData, "logs", "launcher.jsonl");
  if (fs.existsSync(launcherLogPath)) {
    const logText = fs.readFileSync(launcherLogPath, "utf8");
    fs.copyFileSync(launcherLogPath, path.join(evidenceDir, "launcher.jsonl"));
    assert(!/council\.shared_snapshot_failed/.test(logText), "launcher log contains council.shared_snapshot_failed on an unconfigured fresh profile");
    results.files.launcherLog = "launcher.jsonl";
  }

  results.ok = true;
  fs.writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`CWC_SOURCE_UI_GATE_PASS ${reportPath}`);
} catch (error) {
  results.ok = false;
  results.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
  results.process.pageErrors = pageErrors;
  results.process.consoleErrors = consoleErrors;
  fs.writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`);
  console.error(error);
  process.exitCode = 1;
} finally {
  try { await cdp?.detach(); } catch {}
  try { await browser?.close(); } catch {}
  if (child && child.exitCode === null) {
    try { spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout: 10_000 }); } catch {}
  }
  stdout.end();
  stderr.end();
}
