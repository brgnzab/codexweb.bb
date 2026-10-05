const { resolveCodexExecutable } = require("./codex-controller-wake.cjs");

try {
  process.stdout.write(`${resolveCodexExecutable()}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
