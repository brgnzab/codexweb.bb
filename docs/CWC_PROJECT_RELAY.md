# CWC Personal: existing-chat project relay

## Owner's requirement (2026-09-28)

Remove the owner from copying prompts/results between existing GPT Web, Codex, and Work chats. Support GPT Web ↔ GPT Web, GPT Web ↔ Codex/Work, and Codex/Work ↔ Codex/Work. Continue useful work and review automatically until a real owner blocker/decision or a UAT-ready result. The owner's instructions are authoritative; the tracker is a guide. Build CWC-017/G9 and CWC-018/G10 together before independent QA.

The owner selected existing desktop chats. Dedicated CLI conversations are not a substitute. The bridge controller, when authorized, is only a courier; it is not a replacement project participant. No merge, tag, release, or UAT approval is implied.

## Project relay

The launcher Project relay page accepts two existing chat bindings, a project task, and a turn budget. Participant 1 works; participant 2 reviews and can request more work. Completed visible answers alternate between the two fixed destinations. Participants cannot change the destination or grant themselves additional permissions. Existing project context and permissions remain in effect.

The final answer may end with `CWC_STATE: CONTINUE`, `CWC_STATE: BLOCKED`, or `CWC_STATE: UAT_READY`. Only the reviewer's unambiguous UAT_READY finishes the project. BLOCKED reports an owner dependency. A missing or malformed hint simply forwards the answer for review; CWC never submits a second prompt to repair formatting. Repeated identical replies and the owner-set budget stop unproductive loops.

This route does not require Council SAY/WAKE/SLEEP actions. The existing Council action parser remains strict and its post-submit no-replay rules remain intact.

## Delivery and recovery

- Exact GPT Web conversation URLs use the existing persistent browser transport, without conversation resurrection or new-chat fallback.
- Existing native Codex/Work chat IDs use an owner-authorized controller running inside Codex with its native chat tools. The local helper is `scripts/cwc-desktop-bridge.cjs`; it talks only to the authenticated loopback owner API. It never prints credentials.
- A delivery is durably marked submitted before calling an external send. An uncertain delivery is never automatically replayed. A desktop controller reconnects by inspecting the exact prompt in the bound chat and accepting only that turn's completed final answer.
- A claimed but unsubmitted desktop delivery may be reclaimed after its two-minute lease expires. The old lease cannot send or complete it.
- Cancellation prevents future handoffs; it cannot undo a message already submitted. A cancelled relay with an outstanding submission continues reserving its chats until the response is reconciled.
- State is private in `council/project-relays.json`. It contains prompts and answers; never publish it or bridge request files. Storage failure stops delivery.

## Desktop controller prerequisite

Codex app tools are available inside a Codex chat, not directly to a standalone Node process. The shipped helper and controller instructions bridge that boundary without starting substitute CLI sessions or reading private app databases. The controller must be running, on the same host and CWC runtime home, with permission to coordinate the selected chats. The UI reports its recent heartbeat. Without it, desktop deliveries remain queued; GPT Web-only projects can still run.

The controller setup instructions are in [CWC_DESKTOP_CONTROLLER.md](CWC_DESKTOP_CONTROLLER.md). Creating a new controller chat requires owner authorization. Recurring wakeups also require an explicitly requested automation. This implementation does not silently install background services or change global Codex settings.

## Validation boundary

DEV tests exercise routing, native response correlation, HTTP authorization, cancellation, restart, and duplicate prevention with controlled adapters. They are not proof of independent live G9/G10 acceptance. Live acceptance must demonstrate useful task delivery, review/repair, and a final result across all three pairings in existing chats, with unchanged control chats and no duplicate submissions. Marker loops are supporting diagnostics, not the product goal. Report actual defects and coverage; do not claim a statistical defect-free percentage from a test count.
