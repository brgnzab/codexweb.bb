#!/usr/bin/env bun
import { runCouncilMcpMain } from "./council/mcp-main";
import { runCouncilSetupCommand } from "./council/setup";
import { VERSION } from "./version";

const HELP = `CodexWeb Council ${VERSION}

Usage:
  codex-chatgpt-web --version
  codex-chatgpt-web council-setup --browser-host-descriptor PATH [--tunnel-id ID --runtime-key-file PATH --tunnel-client-path PATH]
  codex-chatgpt-web mcp [--broker-socket PATH] [--store PATH]

Global:
  --home PATH    Override the CWC runtime data root
  -h, --help
  -v, --version
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let commandIndex = 0;

  if (args[0] === "--home") {
    const home = args[1]?.trim();
    if (!home) throw new Error("--home requires a value");
    process.env.CODEX_CHATGPT_WEB_HOME = home;
    commandIndex = 2;
  }

  const command = args[commandIndex];
  const commandArgs = args.slice(commandIndex + 1);

  if (command === "-v" || command === "--version") {
    if (commandArgs.length) throw new Error(`Unknown arguments: ${commandArgs.join(" ")}`);
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "-h" || command === "--help" || !command) {
    if (commandArgs.length) throw new Error(`Unknown arguments: ${commandArgs.join(" ")}`);
    process.stdout.write(HELP);
    return;
  }
  if (command === "council-setup") {
    await runCouncilSetupCommand(commandArgs);
    return;
  }
  if (command === "mcp") {
    await runCouncilMcpMain(commandArgs);
    return;
  }

  throw new Error(`Unsupported CWC Personal command: ${command}. Use --help for supported commands.`);
}

main().catch(error => {
  process.stderr.write(`codexweb: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
