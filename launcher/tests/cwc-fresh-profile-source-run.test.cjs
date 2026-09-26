const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const owner = require("../electron/council-owner-client.cjs");
const { CouncilConnectionSupervisor } = require("../electron/council-connection-supervisor.cjs");

function withFreshCouncilHome(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-fresh-profile-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  return Promise.resolve()
    .then(() => run(root))
    .finally(() => {
      if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = previous;
      fs.rmSync(root, { recursive: true, force: true });
    });
}

test("fresh profile hides owner-control ENOENT and supplies neutral read models", async () => {
  await withFreshCouncilHome(async () => {
    assert.throws(
      () => owner.readOwnerDescriptor(),
      error => error?.code === owner.RUNTIME_UNAVAILABLE_CODE
        && /not configured or running/i.test(error.message)
        && !/ENOENT|owner-control\.json/i.test(error.message),
    );

    assert.deepEqual(await owner.listExecutionRuns(), []);
    assert.deepEqual(await owner.readExecutionReceipts(), []);
    assert.deepEqual(await owner.listObservations(), []);
    assert.equal(await owner.observationStorageStats(), null);
    assert.deepEqual(await owner.listExceptionalWork(), []);
    assert.deepEqual(await owner.memoryStats(), { entries: 0, oldestAt: null, newestAt: null });

    const supervisor = await owner.supervisorStatus();
    assert.equal(supervisor.enabled, false);
    assert.equal(supervisor.running, false);
    assert.deepEqual(supervisor.scheduler, { active: null, queued: 0, completed: 0, failed: 0 });

    const autonomy = await owner.autonomyStatus();
    assert.equal(autonomy.version, 1);
    assert.equal(autonomy.projectRoomId, null);
    assert.equal(autonomy.dispatcher.running, false);
    assert.equal(autonomy.queue.totalActive, 0);
    assert.deepEqual(autonomy.health, []);

    await assert.rejects(
      () => owner.runSupervisorNow(),
      error => error?.code === owner.RUNTIME_UNAVAILABLE_CODE
        && /not configured or running/i.test(error.message)
        && !/ENOENT|owner-control\.json/i.test(error.message),
    );
  });
});

test("connection supervisor treats an unconfigured runtime as quiet offline state", async () => {
  const diagnostics = [];
  let snapshotCalls = 0;
  const abort = new AbortController();
  const supervisor = new CouncilConnectionSupervisor({
    client: {
      async getSnapshot() { snapshotCalls += 1; throw new Error("must not poll while unavailable"); },
    },
    runtimeAvailable: () => false,
    logger: {
      warn(event, fields) { diagnostics.push({ level: "warn", event, fields }); },
      info(event, fields) { diagnostics.push({ level: "info", event, fields }); },
    },
    subscribeCapabilityChanges: () => () => {},
  });
  supervisor.sleep = async () => { abort.abort(); };

  await supervisor.run(abort.signal);

  const state = supervisor.snapshot();
  assert.equal(snapshotCalls, 0);
  assert.equal(state.controlPlane.state, "offline");
  assert.equal(state.controlPlane.reason.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(state.projection.syncState, "idle");
  assert.equal(state.managedProject.state, "unattached");
  assert.equal(diagnostics.some(item => item.event === "council.shared_snapshot_failed"), false);
});

test("Work stacks before its two-column minimum can crush Project Manager", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../src/council-4-responsive.css"), "utf8");
  assert.match(css, /@media \(max-width: 1280px\)[\s\S]*?\.work-split \{ grid-template-columns: minmax\(0,1fr\); overflow: auto; \}/);
  assert.match(css, /@media \(max-width: 1280px\)[\s\S]*?\.work-tasks \{ min-width: 0;/);
  assert.match(css, /@media \(max-width: 1280px\)[\s\S]*?\.work-autonomy \{ min-width: 0;/);
});
