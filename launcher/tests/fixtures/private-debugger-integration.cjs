const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, session } = require("electron");
const { DebuggerTransport } = require("../../electron/debugger-transport.cjs");
const { ensurePrivateDirectory } = require("../../electron/private-path.cjs");

app.setPath("userData", ensurePrivateDirectory(process.env.CWC_SECURITY_FIXTURE_HOME));
let transport;
let window;
app.whenReady().then(async () => {
  const privateSession = session.fromPartition("persist:synthetic-security-fixture");
  const retainedSession = (await privateSession.cookies.get({ url: "https://chatgpt.com", name: "cwc-synthetic-persistence" })).length === 1;
  if (!retainedSession) await privateSession.cookies.set({ url: "https://chatgpt.com", name: "cwc-synthetic-persistence", value: "synthetic-only", expirationDate: Math.floor(Date.now() / 1000) + 3600, secure: true, httpOnly: true });
  await privateSession.protocol.handle("https", () => new Response(`<!doctype html><title>Synthetic relay</title><textarea id="prompt"></textarea><button id="send">Send</button><pre id="answer"></pre><script>window.__CODEX_WEB_GPT_SURFACE_ID__='${"s".repeat(32)}';document.querySelector('#send').onclick=()=>document.querySelector('#answer').textContent=document.querySelector('#prompt').value;</script>`, { headers: { "content-type": "text/html" } }));
  window = new BrowserWindow({ show: false, webPreferences: { session: privateSession, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await window.loadURL("https://chatgpt.com/c/synthetic-security-fixture");
  const host = { state: { authenticated: true }, surfaceId: "s".repeat(32), view: { webContents: window.webContents }, turnTabs: new Map() };
  transport = await new DebuggerTransport({ getBrowserHost: () => host }).start();
  transport.commandObserver = method => fs.appendFileSync(path.join(process.env.CWC_SECURITY_FIXTURE_HOME, "commands.log"), `${method}\n`);
  const descriptor = { ...transport.descriptor(), retainedSession };
  process.stdout.write(`CWC_FIXTURE ${JSON.stringify(descriptor)}\n`);
  fs.writeFileSync(path.join(process.env.CWC_SECURITY_FIXTURE_HOME, "ready.json"), JSON.stringify(descriptor));
  const timer = setInterval(async () => {
    if (!fs.existsSync(path.join(process.env.CWC_SECURITY_FIXTURE_HOME, "stop"))) return;
    clearInterval(timer);
    await transport.close();
    privateSession.flushStorageData();
    await privateSession.cookies.flushStore();
    window.destroy(); app.quit();
  }, 100);
}).catch(error => { console.error(error); app.exit(1); });
