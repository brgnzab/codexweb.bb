import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const councilSetup = readFileSync(join(root, "src", "council", "setup.ts"), "utf8");
const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");
const mcpServer = readFileSync(join(root, "src", "council", "mcp-server.ts"), "utf8");
const launcherRuntime = readFileSync(join(root, "launcher", "electron", "runtime.cjs"), "utf8");
const supervisor = readFileSync(join(root, "launcher", "electron", "runtime-supervisor.cjs"), "utf8");
const entrypoint = readFileSync(join(root, "launcher", "electron", "main-council.cjs"), "utf8");
const preload = readFileSync(join(root, "launcher", "electron", "preload.cjs"), "utf8");

describe("Council standalone product boundary", () => {
  test("Council setup never reads, restores, installs, or removes a Codex route", () => {
    expect(councilSetup).not.toContain("codex-route-removal");
    expect(councilSetup).not.toContain("removeManagedCodexRoute");
    expect(councilSetup).not.toContain("installCodexIntegration");
    expect(councilSetup).not.toContain("uninstallCodexIntegration");
    expect(councilSetup).not.toContain("preflightCodexIntegration");
    expect(councilSetup).toContain("COUNCIL_CONNECTOR_NAME");
  });

  test("packaged Council entrypoint does not load the legacy Codex launcher main", () => {
    expect(entrypoint).toContain('CODEXWEB_COUNCIL_PRODUCT = "1"');
    expect(entrypoint).not.toContain('require("./main.cjs")');
    expect(entrypoint).not.toContain("setupCore");
    expect(entrypoint).not.toContain("setBridgeEnabled");
    expect(entrypoint).not.toContain("restoreCodexRoute");
    expect(preload).not.toContain("setBridgeEnabled");
    expect(preload).not.toContain("uninstallIntegration");
    expect(preload).not.toContain("setupCore");
  });

  test("CLI has a dedicated Council setup command with explicit local-only support", () => {
    expect(cli).toContain('command === "council-setup"');
    expect(cli).toContain("runCouncilSetupCommand");
    expect(councilSetup).toContain('takeFlag(args, "--local-only")');
    expect(councilSetup).toContain('mode: RuntimeMode = useTunnel ? "full" : "browser-only"');
  });

  test("launcher defaults an unconfigured Council product to local-only setup", () => {
    expect(launcherRuntime).toContain("async setupCouncilLocal()");
    expect(launcherRuntime).toContain('"--local-only"');
    expect(launcherRuntime).toContain("if (!existing.configured)");
    expect(launcherRuntime).toContain("await this.setupCouncilLocal()");
    expect(launcherRuntime).toContain('mode: "browser-only"');
  });

  test("Secure MCP Tunnel remains an explicit optional full-mode capability", () => {
    expect(launcherRuntime).toContain("async setupCouncilMcp");
    expect(launcherRuntime).toContain('args.push("--tunnel-id", tunnelId, "--runtime-key-file", keyPath, "--tunnel-client-path", tunnelClientPath)');
    expect(councilSetup).toContain("const useTunnel = options.localOnly !== true && (freshCredentials || Boolean(reusableTunnel))");
    expect(councilSetup).toContain('mode: RuntimeMode = useTunnel ? "full" : "browser-only"');
  });

  test("Council supervisor uses the real MCP runtime locally and never restores the Responses serve daemon", () => {
    const councilStart = supervisor.slice(supervisor.indexOf("async startConfigured()"), supervisor.indexOf("async recover(name)"));
    expect(councilStart).toContain("await this.startLocalCouncil(config)");
    expect(councilStart).toContain("await this.startTunnel(config");
    expect(supervisor).toContain('this.runtimeCommand(["mcp", "--broker-socket", config.brokerSocketPath])');
    expect(supervisor).not.toContain('this.runtimeCommand(["serve"])');
    expect(supervisor).toContain('CODEX_CHATGPT_WEB_HOME: this.coreHome');
    expect(supervisor).toContain('endpoint.hostname !== "127.0.0.1"');
    expect(supervisor).toContain('authorization: `Bearer ${owner.descriptor.token}`');
  });

  test("MCP process lifetime is shared by local-only and Tunnel modes through stdio", () => {
    expect(mcpServer).toContain("await waitForStdioLifetime()");
    expect(mcpServer).toContain('process.stdin.once("end", done)');
    expect(mcpServer).toContain("process.stdin.resume()");
  });
});
