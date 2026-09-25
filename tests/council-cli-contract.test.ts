import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");

describe("Council CLI dispatch", () => {
  test("dispatches only the supported Council commands without the retired legacy CLI", () => {
    expect(cli).toContain("const command = args[commandIndex]");
    expect(cli).toContain('command === "council-setup"');
    expect(cli).toContain("runCouncilSetupCommand");
    expect(cli).toContain('command === "mcp"');
    expect(cli).toContain("runCouncilMcpMain");
    expect(cli).toContain("Unsupported CWC Personal command");
    expect(cli).not.toContain("cli-legacy");
    expect(cli).not.toContain('command === "serve"');
    expect(cli).not.toContain('command === "doctor"');
  });

  test("preserves the global --home prefix for Council commands", () => {
    expect(cli).toContain('if (args[0] === "--home")');
    expect(cli).toContain("process.env.CODEX_CHATGPT_WEB_HOME = home");
    expect(cli).toContain("commandIndex = 2");
  });
});
