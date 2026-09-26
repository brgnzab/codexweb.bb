const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const legacy = require("./runtime-supervisor-legacy.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, processRunning, terminateOwnedProcessTree } = require("./process-tree.cjs");
const { setCouncilRuntimeLive } = require("./council-runtime-evidence.cjs");

const COUNCIL_CONNECTOR_NAME = "CodexWeb Council";
const OWNER_READY_TIMEOUT_MS = 20_000;
const OWNER_POLL_MS = 150;
const MAX_LOCAL_LOG_LINE_CHARS = 64 * 1024;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

function councilProduct() { return process.env.CODEXWEB_COUNCIL_PRODUCT === "1"; }
function isCouncilConfig(config) {
  return (config?.mode === "browser-only" || config?.mode === "full")
    && config?.appName === COUNCIL_CONNECTOR_NAME;
}
function isLocalCouncilConfig(config) { return isCouncilConfig(config) && config.mode === "browser-only"; }

function collectLocalLines(stream, onLine, onError) {
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      if (line) onLine(line);
    }
    if (buffered.length > MAX_LOCAL_LOG_LINE_CHARS) {
      onLine(`${buffered.slice(0, MAX_LOCAL_LOG_LINE_CHARS)}…[truncated]`);
      buffered = "";
    }
  });
  stream.on("end", () => {
    const line = buffered.trim();
    if (line) onLine(line);
  });
  stream.on("error", (error) => onError?.(error));
}

class RuntimeSupervisor extends legacy.RuntimeSupervisor {
  ownerDescriptorPath() { return path.join(this.coreHome, "council", "owner-control.json"); }

  readOwnerDescriptor() {
    const descriptorPath = this.ownerDescriptorPath();
    const stat = fs.lstatSync(descriptorPath);
    if (!stat.isFile()) throw new Error("Council owner-control descriptor is not a regular file");
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    if (descriptor?.version !== 1 || typeof descriptor.endpoint !== "string" || typeof descriptor.token !== "string") {
      throw new Error("Council owner-control descriptor is invalid");
    }
    if (!/^[A-Za-z0-9_-]{40,}$/.test(descriptor.token)) throw new Error("Council owner-control token is invalid");
    const endpoint = new URL(descriptor.endpoint);
    if (endpoint.protocol !== "http:"
      || endpoint.hostname !== "127.0.0.1"
      || !endpoint.port
      || endpoint.pathname !== "/api/owner"
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash) {
      throw new Error("Council owner-control endpoint is not a protected loopback endpoint");
    }
    return { descriptor, endpoint };
  }

  async ownerControlReady(timeoutMs = 2_000) {
    let owner;
    try { owner = this.readOwnerDescriptor(); }
    catch { return false; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${owner.endpoint.origin}/api/owner/execution/runs`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${owner.descriptor.token}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const body = await response.json();
      return body?.ok === true && Array.isArray(body?.result);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async waitForOwnerControl(child, timeoutMs = OWNER_READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.daemon !== child || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(this.lastChildFailure.daemon || "Local Council process exited before owner-control became ready");
      }
      if (await this.ownerControlReady()) return;
      await sleep(OWNER_POLL_MS);
    }
    throw new Error(`Local Council owner-control did not become ready within ${timeoutMs}ms`);
  }

  spawnLocalCouncil(config) {
    const invocation = this.runtimeCommand(["mcp", "--broker-socket", config.brokerSocketPath]);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      detached: DETACH_OWNED_CHILD,
      env: {
        ...process.env,
        CODEX_CHATGPT_WEB_HOME: this.coreHome,
        CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.daemon = child;
    this.lastChildFailure.daemon = null;
    this.lastChildOutput.daemon = null;
    collectLocalLines(child.stdout, (line) => {
      this.lastChildOutput.daemon = redactText(line).slice(0, 1_000);
      this.logger.info("runtime.council_stdout", { line });
    }, (error) => this.logger.warn("runtime.council_stdout_unavailable", { message: errorMessage(error) }));
    collectLocalLines(child.stderr, (line) => {
      this.lastChildOutput.daemon = redactText(line).slice(0, 1_000);
      this.logger.warn("runtime.council_stderr", { line });
    }, (error) => this.logger.warn("runtime.council_stderr_unavailable", { message: errorMessage(error) }));

    let terminalHandled = false;
    const handleTerminal = ({ code = null, signal = null, error = null }) => {
      if (terminalHandled) return;
      terminalHandled = true;
      const expected = this.stopping || this.expectedExits.has(child);
      this.expectedExits.delete(child);
      const restartable = this.restartableChildren.has(child);
      this.restartableChildren.delete(child);
      if (this.daemon === child) this.daemon = null;
      const detail = error
        ? `Council process failed to start: ${error.message}`
        : `Council process exited (${signal || code})${this.lastChildOutput.daemon ? `: ${this.lastChildOutput.daemon}` : ""}`;
      this.lastChildFailure.daemon = detail;
      const persisted = this.tryWriteState(expected ? "stopping" : "degraded", detail);
      this.logger[expected ? "info" : "error"](error ? "runtime.council_spawn_failed" : "runtime.council_exited", error ? { message: error.message } : { code, signal });
      if (!expected && restartable && persisted) this.scheduleRecovery("daemon");
    };
    child.once("error", (error) => {
      if (!Number.isInteger(child.pid)) handleTerminal({ error });
      else this.logger.error("runtime.council_process_error", { message: error.message, pid: child.pid });
    });
    child.once("exit", (code, signal) => handleTerminal({ code, signal }));
    this.logger.info("runtime.council_started", { pid: child.pid });
    this.writeState("starting");
    return child;
  }

  async startLocalCouncil(config) {
    if (this.daemon) {
      const child = this.daemon;
      if (child.exitCode === null && child.signalCode === null && processRunning(child.pid) && await this.ownerControlReady()) {
        this.restartableChildren.add(child);
        return;
      }
      await this.stopLocalCouncil();
    }
    fs.rmSync(this.ownerDescriptorPath(), { force: true });
    let child;
    try {
      child = this.spawnLocalCouncil(config);
      await this.waitForOwnerControl(child);
      if (this.daemon !== child) throw new Error("Local Council process exited immediately after becoming ready");
      this.restartableChildren.add(child);
    } catch (error) {
      let cleanupError;
      try { await this.stopLocalCouncil(); }
      catch (caught) { cleanupError = caught; }
      if (cleanupError) throw new Error(`${errorMessage(error)}; local Council startup cleanup failed: ${errorMessage(cleanupError)}`);
      throw error;
    }
  }

  async stopLocalCouncil(timeoutMs = 10_000) {
    const child = this.daemon;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.daemon = null;
      fs.rmSync(this.ownerDescriptorPath(), { force: true });
      return;
    }
    this.expectedExits.add(child);
    try { child.stdin?.end(); } catch {}
    try {
      await this.waitForChildExit("Council process", child, timeoutMs);
    } catch (gracefulError) {
      this.expectedExits.add(child);
      try {
        terminateOwnedProcessTree(child);
        await this.waitForChildExit("Council process", child, 2_000);
      } catch (forceError) {
        throw new Error(`${errorMessage(gracefulError)}; forced local Council shutdown failed: ${errorMessage(forceError)}`);
      }
    }
    this.daemon = null;
    fs.rmSync(this.ownerDescriptorPath(), { force: true });
  }

  async startConfigured() {
    let config;
    try {
      config = this.readConfig();
    } catch {
      if (!councilProduct()) return super.startConfigured();
      setCouncilRuntimeLive(false);
      this.writeState("not-configured");
      return { status: "not-configured" };
    }
    if (!isCouncilConfig(config)) {
      if (!councilProduct()) return super.startConfigured();
      setCouncilRuntimeLive(false);
      this.writeState("not-configured");
      return { status: "not-configured" };
    }
    if (config.releaseVersion !== this.app.getVersion()) {
      setCouncilRuntimeLive(false);
      const detail = `Council config requires ${config.releaseVersion}; launcher is ${this.app.getVersion()}`;
      this.writeState("needs-setup", detail);
      return { status: "needs-setup", detail };
    }

    this.stopping = false;
    setCouncilRuntimeLive(false);
    const localOnly = isLocalCouncilConfig(config);
    this.publishOperation?.({ name: "runtime-start", status: "running", message: localOnly ? "Starting local ChatGPT Council runtime" : "Starting ChatGPT Council Tunnel" });
    try {
      if (localOnly) {
        if (this.tunnel) throw new Error("Local-only Council configuration cannot adopt an active Tunnel runtime");
        await this.startLocalCouncil(config);
      } else {
        if (this.daemon) await this.stopLocalCouncil();
        await this.startTunnel(config, "runtime-start");
      }
      this.restartHistory.daemon = [];
      this.restartHistory.tunnel = [];
      this.writeState("ready");
      setCouncilRuntimeLive(true);
      this.publishOperation?.({ name: "runtime-start", status: "completed", message: localOnly ? "Local ChatGPT Council runtime is ready" : "ChatGPT Council Tunnel is ready" });
      return { status: "ready", daemonPid: localOnly ? this.daemon?.pid ?? null : null, tunnelPid: localOnly ? null : this.tunnel?.pid ?? null };
    } catch (error) {
      setCouncilRuntimeLive(false);
      this.stopping = true;
      let cleanupError;
      try {
        if (localOnly) await this.stopLocalCouncil();
        else await this.cleanupFailedStart(config);
      } catch (caught) { cleanupError = caught; }
      finally { this.stopping = false; }
      const primary = errorMessage(error);
      const message = cleanupError ? `${primary}; Council startup cleanup failed: ${errorMessage(cleanupError)}` : primary;
      this.tryWriteState("failed", message);
      this.publishOperation?.({ name: "runtime-start", status: "failed", message });
      throw new Error(message);
    }
  }

  async recover(name) {
    let config;
    try { config = this.readConfig(); }
    catch {
      if (councilProduct()) { setCouncilRuntimeLive(false); return; }
      return super.recover(name);
    }
    if (!isCouncilConfig(config)) {
      if (councilProduct()) { setCouncilRuntimeLive(false); return; }
      return super.recover(name);
    }
    if (this.stopping) return;
    if (isLocalCouncilConfig(config)) {
      if (name !== "daemon") return;
      this.publishOperation?.({ name: "runtime-recovery", status: "running", message: "Restarting local Council runtime" });
      setCouncilRuntimeLive(false);
      await this.startLocalCouncil(config);
      if (!await this.ownerControlReady()) throw new Error("Local Council owner-control is unavailable after recovery");
      if (!this.tryWriteState("ready")) throw new Error("Recovered local Council runtime could not persist launcher ownership");
      this.publishOperation?.({ name: "runtime-recovery", status: "completed", message: "Local Council runtime recovered" });
      setCouncilRuntimeLive(true);
      return;
    }
    if (name !== "tunnel") return;
    this.publishOperation?.({ name: "runtime-recovery", status: "running", message: "Restarting Council Tunnel" });
    setCouncilRuntimeLive(false);
    await this.startTunnel(config, "runtime-recovery");
    if (!this.tunnel || !await this.tunnelHealth(config)) throw new Error("Council Tunnel is unavailable after recovery");
    if (!this.tryWriteState("ready")) throw new Error("Recovered Council runtime could not persist launcher ownership");
    this.publishOperation?.({ name: "runtime-recovery", status: "completed", message: "Council Tunnel recovered" });
    setCouncilRuntimeLive(true);
  }

  async performStopForSetup() {
    let config;
    try { config = this.readConfig(); } catch { config = null; }
    if (!isLocalCouncilConfig(config)) return await super.performStopForSetup();
    if (this.startPromise) {
      try { await this.startPromise; }
      catch (error) { this.logger.warn("runtime.start_failed_before_stop", { message: errorMessage(error) }); }
    }
    this.stopping = true;
    for (const name of ["daemon", "tunnel"]) {
      if (this.restartTimers[name]) {
        clearTimeout(this.restartTimers[name]);
        this.restartTimers[name] = null;
      }
    }
    if (this.recoveryTasks.size > 0) await Promise.allSettled([...this.recoveryTasks]);
    try {
      if (this.tunnel) throw new Error("Local-only Council runtime unexpectedly owns a Tunnel process");
      await this.stopLocalCouncil();
      this.clearState();
      setCouncilRuntimeLive(false);
      return { status: "stopped" };
    } catch (error) {
      const message = errorMessage(error);
      this.tryWriteState("failed", message);
      throw new Error(message);
    } finally {
      this.stopping = false;
    }
  }

  async shutdown() {
    try { return await super.shutdown(); }
    finally { setCouncilRuntimeLive(false); }
  }

  async ownedRuntimeReady(config) {
    if (!isCouncilConfig(config)) return councilProduct() ? false : super.ownedRuntimeReady(config);
    if (isLocalCouncilConfig(config)) {
      const child = this.daemon;
      return Boolean(child
        && Number.isInteger(child.pid)
        && child.exitCode === null
        && child.signalCode === null
        && processRunning(child.pid)
        && await this.ownerControlReady());
    }
    return Boolean(this.tunnel && await this.tunnelHealth(config));
  }
}

module.exports = {
  ...legacy,
  COUNCIL_CONNECTOR_NAME,
  RuntimeSupervisor,
};
