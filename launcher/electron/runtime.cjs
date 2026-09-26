const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const legacy = require("./runtime-legacy.cjs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const COUNCIL_CONNECTOR_NAME = "CodexWeb Council";
const MCP_SETUP_TIMEOUT_MS = 10 * 60_000;

function snapshotRegularFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) throw new Error(`Council setup checkpoint is not a regular file: ${filePath}`);
    return { path: filePath, exists: true, data: fs.readFileSync(filePath), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: filePath, exists: false };
    throw error;
  }
}

function restoreRegularFile(snapshot, platform = process.platform) {
  if (!snapshot.exists) {
    fs.rmSync(snapshot.path, { force: true });
    return;
  }
  writePrivateFileAtomic(snapshot.path, snapshot.data);
  if (platform !== "win32") fs.chmodSync(snapshot.path, snapshot.mode);
}

class RuntimeHost extends legacy.RuntimeHost {
  isCouncilRuntime() {
    const current = this.runtimeConfigSnapshot();
    return current.configured
      && (current.mode === "browser-only" || current.mode === "full")
      && current.config?.appName === COUNCIL_CONNECTOR_NAME;
  }

  // Tunnel credentials remain an optional capability. This reads only codexweb's private config/key.
  mcpCredentialsConfigured() { return super.mcpCredentialsConfigured(); }

  mcpConnectorName() { return COUNCIL_CONNECTOR_NAME; }
  browserConnectorName() { return COUNCIL_CONNECTOR_NAME; }

  setupEnvironment() {
    if (typeof this.supervisor.coreHome !== "string" || !path.isAbsolute(this.supervisor.coreHome)) {
      throw new Error("Council runtime supervisor has no absolute core home");
    }
    return { CODEX_CHATGPT_WEB_HOME: this.supervisor.coreHome };
  }

  async doctor() {
    if (!this.isCouncilRuntime()) {
      return { ok: false, checks: [{ id: "council-runtime", status: "warning", message: "Local Council runtime is not configured" }] };
    }
    try {
      const current = this.runtimeConfigSnapshot();
      const runtime = await this.supervisor.startIfConfigured();
      const ok = runtime.status === "ready";
      const readyMessage = current.mode === "full"
        ? "Local Council runtime and optional Secure MCP Tunnel are ready"
        : "Local Council runtime is ready";
      return { ok, checks: [{ id: "council-runtime", status: ok ? "ok" : "error", message: ok ? readyMessage : `Council runtime is ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}` }] };
    } catch (error) {
      return { ok: false, checks: [{ id: "council-runtime", status: "error", message: error instanceof Error ? error.message : String(error) }] };
    }
  }

  async setupCouncilLocal() {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const configPath = this.supervisor.configPath;
    if (typeof configPath !== "string" || !path.isAbsolute(configPath)) throw new Error("Council runtime supervisor has no absolute configuration path");
    const configCheckpoint = snapshotRegularFile(configPath);
    const previousWasCouncil = this.isCouncilRuntime();
    const args = ["council-setup", "--browser-host-descriptor", this.browserDescriptorPath, "--local-only"];

    this.lifecycleOperation = "council-setup";
    try {
      if (previousWasCouncil) await this.supervisor.stopForSetup();
      const result = await this.run("council-setup", args, {
        message: "Configuring local Council runtime",
        successMessage: "Local Council configuration saved",
        timeoutMs: MCP_SETUP_TIMEOUT_MS,
        env: this.setupEnvironment(),
      });
      const runtime = await this.supervisor.startIfConfigured();
      if (runtime.status !== "ready") throw new Error(`Council local setup completed, but the runtime is ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
      return result;
    } catch (error) {
      const primary = error instanceof Error ? error.message : String(error);
      const recovery = [];
      try { await this.supervisor.stopForSetup(); } catch (caught) { recovery.push(`stopping failed Council runtime failed: ${caught instanceof Error ? caught.message : String(caught)}`); }
      try { restoreRegularFile(configCheckpoint, this.platform); } catch (caught) { recovery.push(`restoring Council config failed: ${caught instanceof Error ? caught.message : String(caught)}`); }
      this.supervisor.clearState();
      if (previousWasCouncil) {
        try {
          const restored = await this.supervisor.startIfConfigured();
          if (restored.status !== "ready") recovery.push(`previous Council runtime restored as ${restored.status}`);
        } catch (caught) { recovery.push(`restarting previous Council runtime failed: ${caught instanceof Error ? caught.message : String(caught)}`); }
      }
      throw new Error([primary, ...recovery].join("; "));
    } finally {
      this.lifecycleOperation = null;
    }
  }

  async setupCouncilMcp({ tunnelId = "", runtimeKey = "", tunnelClientPath = "", replace = false } = {}) {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const reuseSavedCredentials = replace !== true && this.mcpCredentialsConfigured();
    if (!reuseSavedCredentials && !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters");
    if (!reuseSavedCredentials && (typeof runtimeKey !== "string" || runtimeKey.trim().length < 20)) throw new Error("A Tunnels Read + Use runtime key is required");
    if (!reuseSavedCredentials) {
      if (typeof tunnelClientPath !== "string" || !path.isAbsolute(tunnelClientPath)) {
        throw new Error("Fresh Council Tunnel setup requires an absolute local tunnel-client path");
      }
      const clientStat = fs.lstatSync(tunnelClientPath);
      if (!clientStat.isFile()) throw new Error(`Tunnel client must be a regular local file: ${tunnelClientPath}`);
    }

    const configPath = this.supervisor.configPath;
    if (typeof configPath !== "string" || !path.isAbsolute(configPath)) throw new Error("Council runtime supervisor has no absolute configuration path");
    const configCheckpoint = snapshotRegularFile(configPath);
    const previousWasCouncil = this.isCouncilRuntime();
    const args = ["council-setup", "--browser-host-descriptor", this.browserDescriptorPath];
    let keyPath;
    if (!reuseSavedCredentials) {
      const secretsDir = path.join(this.app.getPath("userData"), "secrets");
      fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(secretsDir, 0o700); } catch {}
      keyPath = path.join(secretsDir, `runtime-key-${randomBytes(16).toString("hex")}.tmp`);
      fs.writeFileSync(keyPath, runtimeKey.trim(), { flag: "wx", mode: 0o600 });
      args.push("--tunnel-id", tunnelId, "--runtime-key-file", keyPath, "--tunnel-client-path", tunnelClientPath);
    }

    this.lifecycleOperation = "council-setup";
    try {
      if (previousWasCouncil) await this.supervisor.stopForSetup();
      const result = await this.run("council-setup", args, {
        message: reuseSavedCredentials ? "Reconnecting optional Council Tunnel" : "Connecting optional Council Tunnel",
        successMessage: "Council Tunnel configuration saved",
        timeoutMs: MCP_SETUP_TIMEOUT_MS,
        env: this.setupEnvironment(),
      });
      const runtime = await this.supervisor.startIfConfigured();
      if (runtime.status !== "ready") throw new Error(`Council setup completed, but the runtime is ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
      return result;
    } catch (error) {
      const primary = error instanceof Error ? error.message : String(error);
      const recovery = [];
      try { await this.supervisor.stopForSetup(); } catch (caught) { recovery.push(`stopping failed Council runtime failed: ${caught instanceof Error ? caught.message : String(caught)}`); }
      try { restoreRegularFile(configCheckpoint, this.platform); } catch (caught) { recovery.push(`restoring Council config failed: ${caught instanceof Error ? caught.message : String(caught)}`); }
      this.supervisor.clearState();
      if (previousWasCouncil) {
        try {
          const restored = await this.supervisor.startIfConfigured();
          if (restored.status !== "ready") recovery.push(`previous Council runtime restored as ${restored.status}`);
        } catch (caught) { recovery.push(`restarting previous Council runtime failed: ${caught instanceof Error ? caught.message : String(caught)}`); }
      }
      throw new Error([primary, ...recovery].join("; "));
    } finally {
      this.lifecycleOperation = null;
      if (keyPath) fs.rmSync(keyPath, { force: true });
    }
  }

  setupMcp(options) { return this.setupCouncilMcp(options); }

  async upgradeManagedRuntime() {
    const existing = this.runtimeConfigSnapshot();
    if (!existing.configured) {
      const result = await this.setupCouncilLocal();
      return { updated: true, mode: "browser-only", bridgeEnabled: false, fromVersion: undefined, toVersion: this.app.getVersion(), connectorMigrated: false, stdout: result.stdout };
    }
    if (!this.isCouncilRuntime()) return { updated: false };
    if (existing.config?.releaseVersion === this.app.getVersion()) return { updated: false };
    if (existing.mode === "full") {
      const result = await this.setupCouncilMcp({ replace: false });
      return { updated: true, mode: "full", bridgeEnabled: false, fromVersion: existing.config?.releaseVersion, toVersion: this.app.getVersion(), connectorMigrated: false, stdout: result.stdout };
    }
    const result = await this.setupCouncilLocal();
    return { updated: true, mode: "browser-only", bridgeEnabled: false, fromVersion: existing.config?.releaseVersion, toVersion: this.app.getVersion(), connectorMigrated: false, stdout: result.stdout };
  }

  async setupCore() { throw new Error("Codex integration is not part of CodexWeb Council"); }
  async bridgeStatus() { return { installed: false, active: false, changed: false }; }
  async restoreBridgeRoute() { return { installed: false, active: false, changed: false }; }
  async setBridgeEnabled() { throw new Error("Codex bridge routing is not part of CodexWeb Council"); }
  async uninstallIntegration() { return { changed: false }; }
}

module.exports = { ...legacy, COUNCIL_CONNECTOR_NAME, RuntimeHost };
