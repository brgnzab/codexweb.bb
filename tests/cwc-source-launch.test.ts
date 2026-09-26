import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const launcherScript = readFileSync(resolve(root, "scripts", "start-cwc.ps1"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const sourceRunDoc = readFileSync(resolve(root, "docs", "CWC_SOURCE_RUN.md"), "utf8");

describe("CWC Personal hardened source launch", () => {
  test("PowerShell entrypoint is Windows x64 only and enforces the frozen toolchain", () => {
    expect(launcherScript).toContain('Windows_NT');
    expect(launcherScript).toContain('[Environment]::Is64BitOperatingSystem');
    expect(launcherScript).toContain('$RequiredBun = "1.3.14"');
    expect(launcherScript).toContain('$RequiredNode = "v22.23.2"');
    expect(launcherScript).toContain('--frozen-lockfile');
  });

  test("source launch does not invoke installer, package, elevation, startup persistence, or updater paths", () => {
    expect(launcherScript).toContain('scripts/start-launcher.ts');
    expect(launcherScript).not.toMatch(/app:package|package:win|electron-builder|makensis|nsis/i);
    expect(launcherScript).not.toMatch(/-Verb\s+RunAs|Start-Process/i);
    expect(launcherScript).not.toMatch(/CurrentVersion\\Run|Set-ItemProperty|New-ItemProperty|schtasks|Register-ScheduledTask/i);
    expect(launcherScript).not.toMatch(/update-worker|self-update|check.*release/i);
  });

  test("repo exposes and documents the PowerShell source launch path", () => {
    expect(packageJson.scripts?.["app:powershell"]).toBe("powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/start-cwc.ps1");
    expect(sourceRunDoc).toContain('scripts\\start-cwc.ps1');
    expect(sourceRunDoc).toContain('Windows 11 x64');
    expect(sourceRunDoc).toContain('-ValidateOnly');
  });
});
