import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const panel = readFileSync(join(import.meta.dir, "..", "launcher", "src", "ProjectRelayPanel.tsx"), "utf8");
const app = readFileSync(join(import.meta.dir, "..", "launcher", "src", "CouncilApp.tsx"), "utf8");

test("only nonterminal relay states expose Stop while completed segments remain resumable", () => {
  expect(panel).toContain('const stoppableRelay = (relay: ProjectRelayView) => !["completed", "uat-ready", "stopped", "cancelled"].includes(relay.state);');
  expect(panel).toContain('if (relay.state === "completed") return "Handoff segment completed";');
  expect(panel).toContain('{stoppableRelay(relay) && <button disabled={busy} onClick={() => void cancel(relay.id)}>Stop relay</button>}');
  expect(panel).toContain('{recoverableRelay(relay) && <button disabled={busy || resumeBlocked} onClick={() => void resume(relay)}>Resume relay</button>}');
});

test("ChatGPT toolbar can assign the current conversation directly to either relay participant", () => {
  expect(panel).toContain("export function assignProjectRelayParticipant(index: 0 | 1, conversation: string): string");
  expect(panel).toContain('i === index ? { ...peer, kind: "gw", conversation: url }');
  expect(panel).toContain('<option value={0}>Participant 1</option>');
  expect(panel).toContain('<option value={1}>Participant 2</option>');
  expect(panel).toContain('>USE CURRENT CHAT</button>');
  expect(app).toContain('import { ProjectRelayPanel, RelayAssignmentControls } from "./ProjectRelayPanel";');
  expect(app).toContain('<RelayAssignmentControls conversation={browser?.url} busy={busy} />');
});
