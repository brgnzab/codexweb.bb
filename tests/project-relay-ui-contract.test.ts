import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const panel = readFileSync(join(import.meta.dir, "..", "launcher", "src", "ProjectRelayPanel.tsx"), "utf8");

test("blocked relays expose Stop relay owner control", () => {
  expect(panel).toContain('const stoppableRelay = (relay: ProjectRelayView) => relay.state === "running" || relay.state === "blocked";');
  expect(panel).toContain('{stoppableRelay(relay) && <button disabled={busy} onClick={() => void cancel(relay.id)}>Stop relay</button>}');
});
