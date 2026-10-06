const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

function relayBlocksCacheClear(relay) {
  return relay?.state === "running";

}

function uncertainSubmissionTombstones(relays) {
  if (!Array.isArray(relays)) return [];
  const tombstones = [];
  for (const relay of relays) {
    if (!["uncertain", "stopped", "terminated"].includes(relay?.state) || !Array.isArray(relay.turns) || relay.turns.length === 0) continue;
    const turn = relay.turns.at(-1);
    if (!turn || turn.state !== "submitted" || turn.receipt) continue;
    tombstones.push({
      id: relay.id,
      requestId: relay.requestId,
      name: relay.name,
      task: relay.task,
      peers: relay.peers,
      maxTurns: relay.maxTurns,
      segmentStartTurn: 0,
      state: "uncertain",
      turns: [{ ...turn }],
      result: relay.result,
      event: relay.event,
      createdAt: relay.createdAt,
      updatedAt: relay.updatedAt,
    });
  }
  return tombstones;
}

function restoreUncertainSubmissionTombstones(coreHome, tombstones) {
  if (!Array.isArray(tombstones) || tombstones.length === 0) return false;
  const relayPath = path.join(coreHome, "council", "project-relays.json");
  writePrivateFileAtomic(relayPath, `${JSON.stringify({ version: 1, sessions: tombstones })}\n`, { personalRoot: coreHome });
  return true;
}

module.exports = {
  relayBlocksCacheClear,
  uncertainSubmissionTombstones,
  restoreUncertainSubmissionTombstones,
};
