const { createServer } = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { WebSocketServer } = require("ws");

function automationUrlAllowed(value) {
  if (value === "about:blank#codex-web-gpt-browser-host" || value === "about:blank") return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && !url.username && !url.password
      && !url.hash && (!url.search || url.search === "?temporary-chat=true")
      && (url.pathname === "/" || /^\/c\/[A-Za-z0-9_-]+$/.test(url.pathname));
  } catch { return false; }
}

function bearerMatches(token, authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A browser-protocol facade backed by a single Electron WebContents debugger.
// Chromium remote debugging is never enabled; neither launcher nor auth windows are targets.
class DebuggerTransport {
  constructor({ getBrowserHost }) {
    this.getBrowserHost = getBrowserHost;
    this.token = randomBytes(32).toString("base64url");
    this.connections = new Set();
    this.ws = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.server = createServer((request, response) => {
      if (!this.authorized(request)) { response.writeHead(401); response.end(); return; }
      if (!["/json/version", "/json/version/"].includes(request.url)) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/browser` }));
    });
    this.server.on("upgrade", (request, socket, head) => {
      const contents = this.resolveSurface(request.headers["x-cwc-surface"]);
      if (!this.authorized(request) || request.url !== "/browser" || !contents) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
      }
      this.ws.handleUpgrade(request, socket, head, connection => this.attach(connection, contents));
    });
  }

  authorized(request) {
    return !request.headers.origin && request.headers.host === `127.0.0.1:${this.port}`
      && bearerMatches(this.token, request.headers.authorization);
  }

  resolveSurface(surfaceId) {
    const host = this.getBrowserHost();
    if (host?.state?.authenticated !== true || host.authView) return null;
    const candidates = [{ surfaceId: host?.surfaceId, view: host?.view }, ...Array.from(host?.turnTabs?.values?.() || [])];
    const matches = candidates.filter(candidate => candidate.surfaceId === surfaceId);
    const contents = matches.length === 1 ? matches[0].view?.webContents : null;
    return contents && !contents.isDestroyed() && automationUrlAllowed(contents.getURL()) ? contents : null;
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); this.port = this.server.address().port; resolve(); });
    });
    return this;
  }

  descriptor() { return { endpoint: `http://127.0.0.1:${this.port}`, token: this.token }; }

  attach(connection, contents) {
    const debuggerApi = contents.debugger;
    if (debuggerApi.isAttached()) { connection.close(1008, "Surface already attached"); return; }
    try { debuggerApi.attach("1.3"); } catch { connection.close(1008, "Debugger unavailable"); return; }
    this.connections.add(connection);
    const sessionId = randomBytes(16).toString("hex");
    let targetId;
    let browserContextId;
    const ready = debuggerApi.sendCommand("Target.getTargetInfo").then(({ targetInfo }) => {
      targetId = targetInfo.targetId;
      browserContextId = targetInfo.browserContextId || "cwc-private-context";
    });
    const targetInfo = () => ({ targetId, browserContextId, type: "page", title: "CWC ChatGPT", url: contents.getURL(), attached: true, canAccessOpener: false });
    const send = value => { if (connection.readyState === 1) connection.send(JSON.stringify(value)); };
    const valid = () => {
      const host = this.getBrowserHost();
      return !contents.isDestroyed() && host?.state?.authenticated === true && !host.authView && automationUrlAllowed(contents.getURL());
    };
    const onMessage = (_event, method, params, childSession) => {
      if (!valid()) { connection.close(1008, "Authentication surface excluded"); return; }
      // Workers and child targets are not automation surfaces. Do not auto-attach them.
      if (method.startsWith("Target.")) return;
      send({ method, params, sessionId: childSession || sessionId });
    };
    const onNavigate = (event, url) => {
      if (!automationUrlAllowed(url)) { connection.close(1008, "Authentication surface excluded"); }
    };
    const onDetach = () => connection.close(1008, "Debugger detached");
    debuggerApi.on("message", onMessage);
    debuggerApi.on("detach", onDetach);
    contents.on("will-navigate", onNavigate);
    contents.on("will-redirect", onNavigate);
    connection.on("error", () => {});
    connection.once("close", () => {
      this.connections.delete(connection);
      debuggerApi.removeListener("message", onMessage);
      debuggerApi.removeListener("detach", onDetach);
      contents.removeListener("will-navigate", onNavigate);
      contents.removeListener("will-redirect", onNavigate);
      if (!contents.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
    });
    // Serialize commands to preserve CDP target initialization ordering.
    let queue = ready;
    connection.on("message", bytes => {
      queue = queue.then(async () => {
        let message;
        try {
          message = JSON.parse(bytes.toString());
          const { id, method, params = {}, sessionId: requestedSession } = message;
          this.commandObserver?.(method);
          if (!Number.isSafeInteger(id) || typeof method !== "string" || !valid()) throw new Error("Invalid or excluded debugger request");
          if (requestedSession && requestedSession !== sessionId) throw new Error("Unknown debugger session");
          let result;
          if (!requestedSession) {
            if (method === "Browser.getVersion") result = { protocolVersion: "1.3", product: `Chrome/${process.versions.chrome || "146.0.0.0"}`, userAgent: "CWC/Electron", revision: "cwc" };
            else if (method === "Target.setAutoAttach") {
              if (params.autoAttach) send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: targetInfo(), waitingForDebugger: false } });
              result = {};
            } else if (method === "Target.getTargetInfo") result = { targetInfo: targetInfo() };
            else if (method === "Target.getTargets") result = { targetInfos: [targetInfo()] };
            else if (method === "Browser.setDownloadBehavior") result = {};
            else throw new Error("Browser-wide debugger command denied");
          } else {
            const domain = method.split(".")[0];
            if (!["Page", "Runtime", "DOM", "CSS", "Accessibility", "Input", "Network", "Emulation", "Log", "Performance", "Debugger"].includes(domain)
              && method !== "Target.setAutoAttach") throw new Error("Debugger domain denied");
            if (["Network.getCookies", "Network.getAllCookies", "Network.setCookie", "Network.setCookies", "Network.deleteCookies", "Network.clearBrowserCookies", "Network.getResponseBody", "Network.getRequestPostData"].includes(method)) throw new Error("Credential debugger command denied");
            if (method === "Page.navigate" && !automationUrlAllowed(params.url)) throw new Error("Authentication navigation denied");
            if (method === "Target.setAutoAttach") result = {};
            else result = await debuggerApi.sendCommand(method, params);
          }
          if (!valid()) throw new Error("Authentication surface excluded");
          send({ id, ...(requestedSession ? { sessionId: requestedSession } : {}), result });
        } catch (error) {
          send({ id: message?.id, ...(message?.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: error.message } });
        }
      }).catch(() => connection.close(1011));
    });
  }

  async close() {
    for (const connection of this.connections) connection.terminate();
    this.ws.close();
    if (this.server.listening) await new Promise(resolve => this.server.close(resolve));
  }
}

module.exports = { DebuggerTransport, automationUrlAllowed, bearerMatches };
