import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigForSetup } from "../src/config";
import { setupCouncil } from "../src/council/setup";

const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;
const homes: string[] = [];

function isolatedHome(): { home: string; descriptor: string } {
  const home = mkdtempSync(join(tmpdir(), "cwc-local-setup-"));
  homes.push(home);
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  const runtime = join(home, "runtime");
  mkdirSync(runtime, { recursive: true });
  const descriptor = join(runtime, "launcher-browser.json");
  writeFileSync(descriptor, "{}\n", "utf8");
  return { home, descriptor };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
});

describe("Council local-only setup", () => {
  test("initializes a legitimate launcher-owned runtime without Tunnel credentials", async () => {
    const { descriptor } = isolatedHome();
    const result = await setupCouncil({ browserHostDescriptorPath: descriptor });
    expect(result.mode).toBe("browser-only");
    expect(result.appName).toBe("CodexWeb Council");
    expect(result.reusedCredentials).toBe(false);

    const config = loadConfigForSetup();
    expect(config.mode).toBe("browser-only");
    expect(config.appName).toBe("CodexWeb Council");
    expect(config.browserHost).toBe("launcher");
    expect(config.browserHostDescriptorPath).toBe(descriptor);
    expect(config.host).toBe("127.0.0.1");
    expect(config.tunnel).toBeUndefined();
    expect(config.controlToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(config.runtimeCommand.length).toBeGreaterThan(0);
  });

  test("explicit local-only setup does not inherit a Tunnel requirement", async () => {
    const { descriptor } = isolatedHome();
    const result = await setupCouncil({ browserHostDescriptorPath: descriptor, localOnly: true });
    expect(result.mode).toBe("browser-only");
    expect(loadConfigForSetup().tunnel).toBeUndefined();
  });

  test("still rejects incomplete optional Tunnel credential replacement", async () => {
    const { descriptor } = isolatedHome();
    await expect(setupCouncil({
      browserHostDescriptorPath: descriptor,
      tunnelId: `tunnel_${"a".repeat(32)}`,
    })).rejects.toThrow(/both tunnelId and runtimeKeyFile/);
  });
});
