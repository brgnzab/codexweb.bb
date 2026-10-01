import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const panel = readFileSync(join(import.meta.dir, "..", "launcher", "src", "ProjectRelayPanel.tsx"), "utf8");
const app = readFileSync(join(import.meta.dir, "..", "launcher", "src", "CouncilApp.tsx"), "utf8");

test("blocked relays expose Stop relay owner control", () => {
  expect(panel).toContain('const stoppableRelay = (relay: ProjectRelayView) => relay.state === "running" || relay.state === "blocked";');
  expect(panel).toContain('{stoppableRelay(relay) && <button disabled={busy} onClick={() => void cancel(relay.id)}>Stop relay</button>}');
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
