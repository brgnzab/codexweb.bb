import { cpSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { VERSION } from "../src/version";

const sourceBundle = resolve(process.argv[2] ?? "dist/runtime");
const sourceRoot = resolve(import.meta.dir, "..");
const root = join(homedir(), `.codex-chatgpt-web-release-smoke-${process.pid}-${Date.now()}`);
const firstLocation = join(root, "first-location");
const runtimeRoot = join(root, "relocated-runtime");
cpSync(sourceBundle, firstLocation, { recursive: true });
renameSync(firstLocation, runtimeRoot);

try {
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
  if (manifest.schemaVersion !== 1
    || manifest.appVersion !== VERSION
    || manifest.playwright !== "1.62.0"
    || !/^[a-f0-9]{64}$/.test(String(manifest.bundleId ?? ""))) {
    throw new Error(`Unexpected runtime manifest: ${JSON.stringify(manifest)}`);
  }
  if (typeof manifest.launcher !== "string" || typeof manifest.entrypoint !== "string") {
    throw new Error(`Runtime manifest has no launcher or entrypoint: ${JSON.stringify(manifest)}`);
  }

  const launcher = join(runtimeRoot, manifest.launcher);
  const runtimeExecutable = join(runtimeRoot, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  const entrypoint = join(runtimeRoot, manifest.entrypoint);
  const runtimeCommand = [runtimeExecutable, entrypoint];
  const cliBundle = readFileSync(join(runtimeRoot, "app", "cli.js"), "utf8");
  const launcherText = readFileSync(launcher, "utf8");
  for (const forbidden of [sourceRoot, dirname(sourceBundle), "/private/tmp/codex-chatgpt-web-verify", "/tmp/codex-chatgpt-web-verify"]) {
    if (cliBundle.includes(forbidden) || launcherText.includes(forbidden)) {
      throw new Error(`Runtime artifact embeds an ephemeral build path: ${forbidden}`);
    }
  }

  const version = Bun.spawnSync([...runtimeCommand, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (version.exitCode !== 0 || version.stdout.toString().trim() !== VERSION) {
    throw new Error(`Relocated Council runtime version check failed: ${version.stderr.toString()}`);
  }

  const help = Bun.spawnSync([...runtimeCommand, "--help"], { stdout: "pipe", stderr: "pipe" });
  const helpText = help.stdout.toString();
  if (help.exitCode !== 0
    || !helpText.includes("council-setup")
    || !helpText.includes(" mcp ")
    || /\bserve\b|\bdoctor\b/.test(helpText)) {
    throw new Error(`Relocated Council runtime exposed an unexpected CLI surface: ${helpText || help.stderr.toString()}`);
  }

  process.stdout.write("COUNCIL_RUNTIME_RELOCATION_SMOKE_OK\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
