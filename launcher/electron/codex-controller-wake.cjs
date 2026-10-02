const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const CODEX_THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const WAKE_PROMPT = "Process the active CWC Project Relay queue using the existing CWC desktop controller procedure. Claim only CWC-prepared native deliveries, preserve the exact target and payload, send only after sendOnce:true, never replay submitted or uncertain deliveries, and keep polling while an active relay may still need native delivery. Stop when no active relay remains or CWC reports a blocker or UAT-ready result.";

function needsNativeRelay(peers) {
  return Array.isArray(peers) && peers.some(peer => peer?.kind === "codex" || peer?.kind === "work");
}

function resolveCodexExecutable({
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
  find = spawnSync,
} = {}) {
  const override = env.CODEX_CLI_PATH?.trim();
  if (override) {
    if (!path.isAbsolute(override) || !exists(override)) throw new Error("CODEX_CLI_PATH must point to an existing Codex executable");
    return override;
  }

  const candidates = platform === "win32"
    ? [
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
        env.APPDATA && path.join(env.APPDATA, "npm", "codex.cmd"),
      ].filter(Boolean)
    : [
        path.join(os.homedir(), ".local", "bin", "codex"),
        "/usr/local/bin/codex",
      ];

  for (const candidate of candidates) if (exists(candidate)) return candidate;

  const locator = platform === "win32"
    ? path.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "where.exe")
    : "which";
  const result = find(locator, [platform === "win32" ? "codex.exe" : "codex"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  const found = result.status === 0 ? String(result.stdout || "").split(/\r?\n/).map(value => value.trim()).find(Boolean) : "";
  if (found) return found;
  throw new Error("Codex could not be found. Install/open Codex Desktop or set CODEX_CLI_PATH once, then reconnect the controller.");
}

class CodexControllerWake {
  constructor({ coreHome, logger, spawnImpl = spawn, resolveExecutable = resolveCodexExecutable } = {}) {
    if (!coreHome || !path.isAbsolute(coreHome)) throw new Error("Codex controller wake requires an absolute CWC runtime home");
    this.coreHome = coreHome;
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.resolveExecutable = resolveExecutable;
    this.child = null;
  }

  activate(rawThreadId) {
    const threadId = String(rawThreadId || "").trim().toLowerCase();
    if (!CODEX_THREAD_ID.test(threadId)) throw new Error("Configured Codex Bridge Thread ID is invalid");
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      return { requested: false, alreadyRunning: true, threadId };
    }

    const executable = this.resolveExecutable();
    const args = ["exec", "resume", threadId, "--json", "--skip-git-repo-check", WAKE_PROMPT];
    const child = this.spawnImpl(executable, args, {
      cwd: this.coreHome,
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: this.coreHome },
      stdio: "ignore",
      windowsHide: true,
    });
    if (!child || typeof child.once !== "function") throw new Error("Codex controller activation did not start");
    this.child = child;

    const release = () => { if (this.child === child) this.child = null; };
    child.once("error", error => {
      this.logger?.warn?.("codex.bridge_activation_failed", { message: error instanceof Error ? error.message : String(error) });
      release();
    });
    child.once("exit", (code, signal) => {
      this.logger?.info?.("codex.bridge_activation_exited", { code, signal });
      release();
    });
    child.unref?.();
    this.logger?.info?.("codex.bridge_activation_requested", { threadId });
    return { requested: true, alreadyRunning: false, threadId };
  }
}

module.exports = {
  CODEX_THREAD_ID,
  WAKE_PROMPT,
  CodexControllerWake,
  needsNativeRelay,
  resolveCodexExecutable,
};
