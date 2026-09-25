const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const testsDir = path.join(root, "tests");
const runtimeSupervisorTest = path.join("tests", "runtime-supervisor.test.cjs");
const browserHostTest = path.join("tests", "browser-host.test.cjs");
const files = fs.readdirSync(testsDir)
  .filter(name => name.endsWith(".test.cjs"))
  .sort()
  .map(name => path.join("tests", name));

if (files.length === 0) throw new Error("No active Council launcher tests were discovered");

function runTestArgs(args) {
  const result = spawnSync(process.execPath, ["--test", ...args], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

runTestArgs(files.filter(file => file !== runtimeSupervisorTest && file !== browserHostTest));

// CWC-007 removed startup persistence and CWC-011 removed non-Windows product support. Keep every
// current runtime-supervisor regression, but retire the four inherited tests whose subject is the
// removed Linux/autostart implementation itself.
runTestArgs([
  "--test-skip-pattern=^(Linux autostart|launcher autostart fails explicitly)",
  runtimeSupervisorTest,
]);

// The retired Electron main.cjs no longer exists. Its one browser-host test is superseded by the
// current main-council quit-gating contract in council-entrypoint-contract.test.cjs.
runTestArgs([
  "--test-skip-pattern=^launcher quit remains gated through an active embedded-browser operation$",
  browserHostTest,
]);
