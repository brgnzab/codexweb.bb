import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const SAFE_FIXTURES = [
  "sk-exampleRuntimeSecret123",
  "Bearer this-must-never-be-recorded",
  "https://owner:password@example.invalid/path?access_token=very-secret-access-token",
];
const SENSITIVE_STATE_BASENAMES = new Set([
  "cookies",
  "cookies-journal",
  "login data",
  "login data for account",
  "local state",
  "launcher-state.json",
  "managed-agents.json",
  "managed-project.json",
  "memory-index.json",
  "owner-control.json",
  "preferences",
  "secure preferences",
  "storage-state.json",
  "supervisor.json",
  "window-state.json",
]);
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["OpenAI-style secret", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Bearer credential", /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/i],
  ["credential-bearing URL", /\bhttps?:\/\/[^/\s:@]+:[^@\s/]+@/i],
  ["secret URL query parameter", /[?&](?:access_token|refresh_token|token|api[_-]?key|secret|password)=[^&#\s]{8,}/i],
];

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function forbiddenPublicPathReason(value: string): string | undefined {
  const normalized = normalizePath(value);
  const lower = normalized.toLowerCase();
  const name = basename(lower);

  if (/^\.env(?:\.|$)/i.test(name) && name !== ".env.example") return "environment file";
  if (/\.jsonl$/i.test(name) || /\.(?:log|pid|sock|key|pem|p12|pfx)$/i.test(name)) return "runtime/credential file type";
  if (/^storage-state(?:\.[^/]+)?\.json$/i.test(name)) return "browser storage state";
  if (SENSITIVE_STATE_BASENAMES.has(name)) return "browser/session/runtime state";
  if (!normalized.includes("/") && name === "config.json") return "runtime configuration";
  return undefined;
}

function scrubKnownFixtures(value: string): string {
  let scrubbed = value;
  for (const fixture of SAFE_FIXTURES) scrubbed = scrubbed.split(fixture).join("[known-test-fixture]");
  return scrubbed;
}

export function secretTextFindings(value: string): string[] {
  const text = scrubKnownFixtures(value);
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function textContent(path: string): string | undefined {
  const size = statSync(path).size;
  if (size > MAX_TEXT_BYTES) return undefined;
  const buffer = readFileSync(path);
  if (buffer.includes(0)) return undefined;
  return buffer.toString("utf8");
}

function scanFile(path: string, displayPath: string, findings: string[]): void {
  const pathReason = forbiddenPublicPathReason(displayPath);
  if (pathReason) findings.push(`${displayPath}: forbidden ${pathReason}`);
  const text = textContent(path);
  if (text === undefined) return;
  for (const finding of secretTextFindings(text)) findings.push(`${displayPath}: detected ${finding}`);
}

function trackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr || result.stdout}`);
  return result.stdout.split("\0").filter(Boolean);
}

function scanTrackedRepository(findings: string[]): void {
  for (const path of trackedFiles()) scanFile(resolve(ROOT, path), normalizePath(path), findings);
}

function scanExtraPath(rootPath: string, findings: string[]): void {
  const absoluteRoot = resolve(rootPath);
  const rootStat = statSync(absoluteRoot, { throwIfNoEntry: false });
  if (!rootStat) throw new Error(`Hygiene scan path does not exist: ${absoluteRoot}`);

  if (rootStat.isFile()) {
    scanFile(absoluteRoot, basename(absoluteRoot), findings);
    return;
  }

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) scanFile(absolute, normalizePath(relative(absoluteRoot, absolute)), findings);
    }
  };
  visit(absoluteRoot);
}

export function runPublicHygieneScan(extraPaths: string[] = []): string[] {
  const findings: string[] = [];
  scanTrackedRepository(findings);
  for (const path of extraPaths) scanExtraPath(path, findings);
  return findings;
}

if (import.meta.main) {
  const findings = runPublicHygieneScan(process.argv.slice(2));
  if (findings.length > 0) {
    process.stderr.write(`Public-repository hygiene check failed:\n- ${findings.join("\n- ")}\n`);
    process.exit(1);
  }
  process.stdout.write("Public-repository hygiene check passed.\n");
}
