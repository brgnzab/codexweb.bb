const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const CODEX_THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const WAKE_PROMPT = "Run CWC controller procedure; process relay queue; never replay submitted/uncertain.";

function buildWakePrompt(coreHome) {
  return `CODEX_CHATGPT_WEB_HOME=${coreHome}. ${WAKE_PROMPT}`;
}

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

function boundedOutput(chunks) {
  return chunks.join("").trim().replace(/\s+/g, " ").slice(0, 1200);
}

class CodexControllerWake {
  constructor({ coreHome, logger, spawnImpl = spawn, resolveExecutable = resolveCodexExecutable } = {}) {
    if (!coreHome || !path.isAbsolute(coreHome)) throw new Error("Codex controller wake requires an absolute CWC runtime home");
    this.coreHome = coreHome;
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.resolveExecutable = resolveExecutable;
    this.pending = null;
  }

  async activate(rawThreadId) {
    const threadId = String(rawThreadId || "").trim().toLowerCase();
    if (!CODEX_THREAD_ID.test(threadId)) throw new Error("Configured Codex Bridge Thread ID is invalid");
    if (this.pending) return await this.pending;

    this.pending = this.queue(threadId);
    try { return await this.pending; }
    finally { this.pending = null; }
  }

  async queue(threadId) {
    const executable = this.resolveExecutable();
    const args = ["queue", "--thread", threadId, "--message", buildWakePrompt(this.coreHome)];
    this.logger?.info?.("codex.bridge_activation_requested", { threadId });

    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl(executable, args, {
          cwd: this.coreHome,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        reject(new Error(`Codex controller reconnect failed: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (!child || typeof child.once !== "function") {
        reject(new Error("Codex controller reconnect failed: Codex did not start"));
        return;
      }

      const stdout = [];
      const stderr = [];
      child.stdout?.on?.("data", chunk => stdout.push(String(chunk)));
      child.stderr?.on?.("data", chunk => stderr.push(String(chunk)));
      child.once("error", error => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn?.("codex.bridge_activation_failed", { message });
        reject(new Error(`Codex controller reconnect failed: ${message}`));
      });
      child.once("exit", (code, signal) => {
        if (code === 0) {
          this.logger?.info?.("codex.bridge_activation_queued", { threadId });
          resolve({ requested: true, threadId });
          return;
        }
        const status = signal || (code ?? "unknown status");
        const detail = boundedOutput(stderr) || boundedOutput(stdout) || `Codex exited with ${status}`;
        this.logger?.warn?.("codex.bridge_activation_failed", { message: detail });
        reject(new Error(`Codex controller reconnect failed: ${detail}`));
      });
    });
  }
}

module.exports = {
  CODEX_THREAD_ID,
  WAKE_PROMPT,
  buildWakePrompt,
  CodexControllerWake,
  needsNativeRelay,
  resolveCodexExecutable,
};
