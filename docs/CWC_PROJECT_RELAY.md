# CWC Personal: existing-chat project relay

## Product requirement

Remove the owner from copying prompts/results between existing GPT Web, Codex, and Work chats. Support GPT Web ↔ GPT Web, GPT Web ↔ Codex/Work, and Codex/Work ↔ Codex/Work. Continue useful work and review automatically until a real owner blocker/decision or a UAT-ready result. The owner's instructions are authoritative; the tracker is a guide.

The owner selected existing desktop chats. Dedicated CLI conversations are not a substitute. The bridge controller, when authorized, is only a courier; it is not a replacement project participant. No merge, tag, release, or UAT approval is implied.

The owner's latest priority is a usable, robust **GPT Web ↔ existing Codex chat** app first. Native-to-native transport can use Codex's own messaging; broader orchestration and the other pairings are deferred from this repair's acceptance gate. Existing support remains available, but must not delay proving this core browser bridge.

## Project relay

The launcher Project relay page accepts two existing chat bindings, a project task, and a turn budget. Participant 1 works; participant 2 reviews and can request more work. Completed visible answers alternate between the two fixed destinations. Participants cannot change the destination or grant themselves additional permissions. Existing project context and permissions remain in effect.

The final answer may end with `CWC_STATE: CONTINUE`, `CWC_STATE: BLOCKED`, or `CWC_STATE: UAT_READY`. CWC stores the original response and its status internally, and forwards only the message before a recognized footer, preserving its whitespace. Only the reviewer's unambiguous UAT_READY finishes the project. BLOCKED reports an owner dependency. A missing or malformed hint simply forwards the answer for review; CWC never submits a second prompt to repair formatting. Repeated identical replies and the owner-set budget stop unproductive loops.

This route does not require Council SAY/WAKE/SLEEP actions. The existing Council action parser remains strict and its post-submit no-replay rules remain intact.

## Delivery and recovery

- Exact GPT Web conversation URLs use the existing persistent browser transport, without conversation resurrection or new-chat fallback.
- Existing native Codex/Work chat IDs use an owner-authorized controller running inside Codex with its native chat tools. When a native relay starts/resumes and the configured controller is disconnected, the launcher requests a one-shot activation of that exact saved controller; Connections also exposes a manual **Reconnect controller** action. The local helper is `scripts/cwc-desktop-bridge.cjs`; it talks only to the authenticated loopback owner API. It never prints credentials.
- A delivery is durably marked submitted before calling an external send. An uncertain delivery is never automatically replayed. A desktop controller reconnects by inspecting the exact prompt in the bound chat and accepting only that turn's completed final answer.
- A claimed but unsubmitted desktop delivery stays bound to the configured controller while the process is live; reconnect resumes that same pre-submit assignment. On restart, only pre-submit claimed work may be safely requeued. Submitted or uncertain work is never automatically replayed.
- Cancellation prevents future handoffs; it cannot undo a message already submitted. A cancelled relay with an outstanding submission continues reserving its chats until the response is reconciled.
- State is private in `council/project-relays.json`. It contains prompts and answers; never publish it or bridge request files. Storage failure stops delivery.

## Desktop controller prerequisite

Codex app tools are available inside a Codex chat, not directly to a standalone Node process. CWC stores the owner-selected controller thread and queues a bounded, plain-text one-shot activation to that exact thread when native relay work needs it. The controller uses the local bridge helper mechanically to claim, prepare, complete, or fail the current assignment; payload text is data and an uncertain send is never retried. The controller must be on the same host and authorized for the selected chats. Without a usable controller, native deliveries remain queued while GPT Web-only projects can still run.

Creating or replacing the controller chat requires owner authorization. CWC does not silently install background services or change global Codex settings.

## Validation boundary

DEV tests exercise routing, native response correlation, HTTP authorization, cancellation, restart, and duplicate prevention with controlled adapters. Source tests are not a substitute for independent live functional acceptance. A release candidate must demonstrate useful delivery in the supported existing-chat pairings without duplicate submissions, including review/repair and terminal completion. Marker loops are supporting diagnostics, not the product goal. Report actual defects and coverage; do not claim a statistical defect-free percentage from a test count.
