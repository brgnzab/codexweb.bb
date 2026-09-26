import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const SAFE_FIXTURES = [
  "sk-exampleRuntimeSecret123",
  "Bearer this-must-never-be-recorded",
  "https://owner:password@example.invalid/path?access_token=very-secret-access-token",
  "Bearer secret-should-never-cross-renderer",
  "Bearer ghp_super_secret_should_never_be_logged",
  "Bearer wrong-release-smoke-token",
  "Bearer launcher-control-token-0123456789abcdefghijklmnop",
  "Bearer chatgpt-session-token",
];
const KNOWN_VENDOR_URL_FIXTURE_PACKAGES = ["@mixmark-io/domino", "zod", "fast-uri"];
const MCP_SDK_ELICITATION_EXAMPLE = /\/node_modules\/@modelcontextprotocol\/sdk\/dist\/(?:cjs|esm)\/examples\/server\/elicitationurlexample\.js$/;
const MCP_SDK_ELICITATION_URL_FRAGMENTS = [
  "?ses" + "sion=${sessionId}&elici" + "tation=${elicitationId}&cartId=${encodeURIComponent(cartId)}",
  "?ses" + "sion=${sessionId}&elici" + "tation=${elicitationId}",
];
const FAST_URI_QUERY_FIXTURE = /\/node_modules\/fast-uri\/test\/(?:equal\.test\.js|security-normalization\.test\.js)$/;
const FAST_URI_QUERY_LITERALS = [
  "'http://example.com/?token=SECRET'",
  "'http://example.com/?token=secret'",
  "'ws://example.com/?token=SECRET'",
  "'ws://example.com/?token=secret'",
  "'//%41.com/?Token=Value'",
  "'//a.com/?token=value'",
];
const PRIVATE_RUNTIME_PATH_SEGMENTS = new Set([
  ".cwc-data",
  ".codex-chatgpt-web",
  ".launcher-runtime",
]);
const CHROMIUM_STATE_PATH_SEGMENTS = new Set([
  "webstorage",
  "local storage",
  "session storage",
  "code cache",
  "gpucache",
  "dawncache",
  "service worker",
  "indexeddb",
  "blob_storage",
]);
const CONTEXTUAL_CHROMIUM_STATE_PATH_SEGMENTS = new Set(["network", "cache"]);
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
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\r\n]+[A-Za-z0-9+/=\r\n]{32,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["OpenAI-style secret", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Bearer credential", /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/i],
  ["credential-bearing URL", /\bhttps?:\/\/[^/\s:@]+:[^@\s/]+@/i],
  ["secret URL query parameter", /[?&](?:access_token|refresh_token|token|api[_-]?key|secret|password|session(?:[_-]?(?:id|key|token))?|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?)=[^&#\s]{8,}/i],
];

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function forbiddenPublicPathReason(value: string): string | undefined {
  const normalized = normalizePath(value);
  const lower = normalized.toLowerCase();
  const name = basename(lower);
  const segments = lower.split("/").filter(Boolean);
  const dependencySource = segments.includes("node_modules") || segments.includes(".bun");

  if (/^\.env(?:\.|$)/i.test(name) && name !== ".env.example") return "environment file";
  if (/\.jsonl$/i.test(name) || /\.(?:log|pid|sock|key|pem|p12|pfx)$/i.test(name)) return "runtime/credential file type";
  if (/^storage-state(?:\.[^/]+)?\.json$/i.test(name)) return "browser storage state";
  if (segments.some(segment => PRIVATE_RUNTIME_PATH_SEGMENTS.has(segment))) return "private runtime state tree";
  if (segments.some(segment => CHROMIUM_STATE_PATH_SEGMENTS.has(segment))) return "browser profile state tree";
  if (!dependencySource && segments.some(segment => CONTEXTUAL_CHROMIUM_STATE_PATH_SEGMENTS.has(segment))) {
    return "browser profile state tree";
  }
  if (SENSITIVE_STATE_BASENAMES.has(name)) return "browser/session/runtime state";
  if (!normalized.includes("/") && name === "config.json") return "runtime configuration";
  return undefined;
}

function scrubKnownFixtures(value: string): string {
  let scrubbed = value;
  for (const fixture of SAFE_FIXTURES) scrubbed = scrubbed.split(fixture).join("[known-test-fixture]");
  return scrubbed;
}

function scrubKnownVendorPathFixtures(value: string, displayPath: string): string {
  const normalized = `/${normalizePath(displayPath).toLowerCase()}`;
  let scrubbed = value;

  if (MCP_SDK_ELICITATION_EXAMPLE.test(normalized)) {
    for (const fragment of MCP_SDK_ELICITATION_URL_FRAGMENTS) {
      scrubbed = scrubbed.split(fragment).join("[known-mcp-sdk-elicitation-url-fixture]");
    }
  }

  if (FAST_URI_QUERY_FIXTURE.test(normalized)) {
    for (const literal of FAST_URI_QUERY_LITERALS) {
      scrubbed = scrubbed.split(literal).join("'[known-fast-uri-query-fixture]'");
    }
  }

  return scrubbed;
}

export function secretTextFindings(value: string): string[] {
  const text = scrubKnownFixtures(value);
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function isKnownVendorFixture(displayPath: string, finding: string): boolean {
  const normalized = `/${normalizePath(displayPath).toLowerCase()}`;
  if (!normalized.includes("/node_modules/")) return false;
  if (finding !== "credential-bearing URL") return false;
  const fixturePath = /\/(?:test|tests|fixture|fixtures|__tests__)\//.test(normalized)
    || /\/[^/]*(?:test|spec)\.[^/]+$/.test(normalized);
  if (!fixturePath) return false;
  return KNOWN_VENDOR_URL_FIXTURE_PACKAGES.some(packageName => (
    normalized.includes(`/node_modules/${packageName}/`)
    || normalized.includes(`/node_modules/.bun/${packageName}@`)
  ));
}

export function secretTextFindingsForPath(value: string, displayPath: string): string[] {
  const scrubbed = scrubKnownVendorPathFixtures(value, displayPath);
  return secretTextFindings(scrubbed).filter(finding => !isKnownVendorFixture(displayPath, finding));
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
  for (const finding of secretTextFindingsForPath(text, displayPath)) findings.push(`${displayPath}: detected ${finding}`);
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
