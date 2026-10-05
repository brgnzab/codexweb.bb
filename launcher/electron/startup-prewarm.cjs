const { spawn } = require("node:child_process");

function bounded(chunks) {
  return chunks.join("").trim().replace(/\s+/g, " ").slice(0, 2000);
}

async function runStartupPrewarm({
  workerPath,
  input,
  executable = process.execPath,
  spawnImpl = spawn,
} = {}) {
  if (typeof workerPath !== "string" || !workerPath) throw new Error("Startup prewarm worker path is required");
  const encoded = Buffer.from(JSON.stringify(input ?? {}), "utf8").toString("base64");
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, [workerPath], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CWC_STARTUP_PREWARM_INPUT: encoded,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(new Error(`Startup prewarm process failed to start: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const stdout = [];
    const stderr = [];
    child.stdout?.on?.("data", chunk => {
      if (stdout.join("").length < 64 * 1024) stdout.push(String(chunk));
    });
    child.stderr?.on?.("data", chunk => {
      if (stderr.join("").length < 64 * 1024) stderr.push(String(chunk));
    });
    child.once("error", error => reject(new Error(`Startup prewarm process failed: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        const detail = bounded(stderr) || bounded(stdout) || `worker exited with ${signal || code}`;
        reject(new Error(`Startup prewarm failed: ${detail}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.join("").trim());
        if (!result || typeof result !== "object" || !("installedRuntimeRoot" in result)) throw new Error("invalid worker result");
        resolve(result);
      } catch (error) {
        reject(new Error(`Startup prewarm returned invalid output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

module.exports = { runStartupPrewarm };
