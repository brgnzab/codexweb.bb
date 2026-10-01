const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { chromium } = require("../../node_modules/playwright-core");

test("Playwright drives exact synthetic relay content through Electron private debugger without a raw CDP listener", { skip: !process.env.CWC_TEST_ELECTRON, timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-debugger-integration-"));
  const env = { ...process.env, CWC_SECURITY_FIXTURE_HOME: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const start = () => spawn(process.env.CWC_TEST_ELECTRON, [path.join(__dirname, "fixtures", "private-debugger-integration.cjs")], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let child = start();
  let browser;
  try {
    const readDescriptor = () => new Promise((resolve, reject) => {
      let output = "";
      let errors = "";
      const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${errors}`)), 15_000);
      const poll = setInterval(() => {
        const ready = path.join(root, "ready.json");
        if (fs.existsSync(ready)) { clearTimeout(timer); clearInterval(poll); resolve(JSON.parse(fs.readFileSync(ready))); }
      }, 100);
      child.once("exit", () => { clearTimeout(timer); clearInterval(poll); });
      child.stdout.on("data", chunk => {
        output += chunk;
        const match = /CWC_FIXTURE (.+)\r?\n/.exec(output);
        if (match) { clearTimeout(timer); clearInterval(poll); resolve(JSON.parse(match[1])); }
      });
      child.stderr.on("data", chunk => { errors += chunk; });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Fixture exited ${code}: ${errors}`)));
    });
    const descriptor = await readDescriptor();
    assert.equal(descriptor.retainedSession, false);
    assert.equal((await fetch(`${descriptor.endpoint}/json/version`)).status, 401);
    browser = await chromium.connectOverCDP(descriptor.endpoint, { timeout: 15_000, headers: { authorization: `Bearer ${descriptor.token}`, "x-cwc-surface": "s".repeat(32) } });
    const pages = browser.contexts().flatMap(context => context.pages());
    assert.equal(pages.length, 1);
    const page = pages[0];
    assert.equal(await page.evaluate(() => window.__CODEX_WEB_GPT_SURFACE_ID__), "s".repeat(32));
    const exact = "Task & Boundaries\n  Keep whitespace.\nCWC_STATE: CONTINUE\n{\"token\":\"relay content must stay exact\"}";
    await page.locator("#prompt").fill(exact);
    await page.locator("#send").click();
    assert.equal(await page.locator("#answer").textContent(), exact);
    await assert.rejects(page.context().cookies(), /denied/);
    await browser.close(); browser = null;
    const exited = once(child, "exit");
    fs.writeFileSync(path.join(root, "stop"), "quit");
    await exited;
    fs.rmSync(path.join(root, "ready.json"));
    fs.rmSync(path.join(root, "stop"));
    child = start();
    const reopened = await readDescriptor();
    assert.equal(reopened.retainedSession, true, "synthetic HttpOnly session survives normal close/reopen");
    const reopenedExit = once(child, "exit");
    fs.writeFileSync(path.join(root, "stop"), "quit");
    await reopenedExit;
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
