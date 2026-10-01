import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCouncilHttpServer } from "../src/council/http-server";
import { CouncilStore } from "../src/council/store";
import { verifyLauncherHelperIntegrity, type LauncherBrowserHostDescriptor } from "../src/launcher-browser-host";

test("Council confidential snapshots and sync require owner capability and exact native host without browser origins", async () => {
  const root = mkdtempSync(join(tmpdir(), "cwc-snapshot-security-"));
  const store = new CouncilStore(join(root, "state.json"));
  store.joinAgent({ id: "dev", name: "Dev", role: "Lead" });
  store.ensureRoom({ id: "private", name: "Private", mission: "CONFIDENTIAL_CANARY" });
  store.say({ roomId: "private", authorAgentId: "dev", body: "PRIVATE_MESSAGE_CANARY" });
  const token = "owner-capability-synthetic";
  const server = startCouncilHttpServer(store, { port: 0, owner: { token: () => token, startLead: async () => ({}), focusAgent: async () => ({}) } });
  if (!server) throw new Error("test server unavailable");
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const route of ["/api/state", "/api/sync/snapshot", "/api/sync/next?after=invalid&wait_ms=0"]) {
      const anonymous = await fetch(base + route);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.text()).not.toContain("CANARY");
      for (const origin of ["null", "http://127.0.0.1:9999", "http://localhost:4178", "https://foreign.example"]) {
        const invalid = await fetch(base + route, { headers: { authorization: `Bearer ${token}`, origin } });
        expect(invalid.status).toBe(403);
        expect(invalid.headers.get("access-control-allow-origin")).toBeNull();
      }
    }
    const trusted = await fetch(base + "/api/sync/snapshot", { headers: { authorization: `Bearer ${token}` } });
    expect(trusted.status).toBe(200);
    expect(await trusted.text()).toContain("PRIVATE_MESSAGE_CANARY");
    for (const host of ["foreign.example", `localhost:${server.port}`, "127.0.0.1:9999"]) {
      const foreign = await fetch(base + "/api/state", { headers: { authorization: `Bearer ${token}`, host } });
      expect(foreign.status).toBe(403);
    }
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("all workflow actions are immutable and release publication requires explicit approval on main", () => {
  for (const name of ["ci.yml", "release.yml"]) {
    const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", name), "utf8");
    const actions = [...workflow.matchAll(/uses:\s*(\S+)/g)].map(match => match[1]!);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/@[a-f0-9]{40}$/);
    expect(workflow).toContain("--frozen-lockfile");
  }
  const release = readFileSync(join(import.meta.dir, "..", ".github/workflows/release.yml"), "utf8");
  expect(release).toContain("inputs.approve_publish == true");
  expect(release).toContain("github.ref == 'refs/heads/main'");
  expect(release).not.toMatch(/\n  push:/);
});

test("helper bytes are checked immediately before spawning, against the protected publisher reference", () => {
  const root = mkdtempSync(join(tmpdir(), "cwc-helper-integrity-"));
  try {
    const executable = join(root, "helper.exe");
    const script = join(root, "helper.cjs");
    writeFileSync(executable, "synthetic executable");
    writeFileSync(script, "synthetic helper");
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const descriptor = { helper: { executable, script, executableHash: hash(executable), scriptHash: hash(script) } } as LauncherBrowserHostDescriptor;
    expect(() => verifyLauncherHelperIntegrity(descriptor)).not.toThrow();
    writeFileSync(script, "modified helper");
    expect(() => verifyLauncherHelperIntegrity(descriptor)).toThrow("integrity mismatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
