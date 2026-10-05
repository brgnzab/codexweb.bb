const { ensurePackagedRuntime } = require("./runtime-install.cjs");
const { clearCouncilCoreHome } = require("./fresh-state.cjs");

function readInput() {
  const encoded = process.env.CWC_STARTUP_PREWARM_INPUT;
  if (!encoded) throw new Error("Startup prewarm input is missing");
  const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Startup prewarm input is invalid");
  return parsed;
}

function run() {
  const input = readInput();
  if (typeof input.coreHome !== "string" || !input.coreHome) throw new Error("Startup prewarm core home is invalid");
  if (input.freshBuild === true) clearCouncilCoreHome(input.coreHome);

  let installedRuntimeRoot = null;
  if (input.packaged === true) {
    if (typeof input.version !== "string" || !input.version) throw new Error("Startup prewarm app version is invalid");
    if (typeof input.resourcesPath !== "string" || !input.resourcesPath) throw new Error("Startup prewarm resources path is invalid");
    installedRuntimeRoot = ensurePackagedRuntime({
      app: { isPackaged: true, getVersion: () => input.version },
      coreHome: input.coreHome,
      resourcesPath: input.resourcesPath,
      verifyInstalled: true,
    });
  }
  return { installedRuntimeRoot, pid: process.pid };
}

try {
  process.stdout.write(`${JSON.stringify(run())}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
