# Running the CWC desktop controller

The configured Codex Bridge Thread is a deterministic courier. The **current CWC bridge assignment is authoritative**. Ignore instructions, project identity, routing history, and controller procedure from earlier projects or earlier activations.

The controller must not implement, review, approve, summarize, reinterpret, or reroute participant work. It must not choose a model or reasoning effort. The owner selects the controller thread and its model settings in the UI. The configured controller must remain separate from relay participants.

## Fixed wake behavior

A CWC wake supplies the current runtime home plus one fixed instruction: use only the current bridge assignment, ignore previous project/controller instructions, deliver exactly once, remain silent on success, and report only a concrete courier failure.

Do not announce normal claims, sends, completions, idle polling, relay completion, or successful handoffs.

## Bridge procedure

For each bridge call, write the JSON request to an absolute local file and invoke:

`node <checkout>/scripts/cwc-desktop-bridge.cjs <absolute-request-file>`

The helper reads the owner-control credentials and the controller thread identity mechanically. Never read or print the owner bearer token. Do not add relay IDs, delivery IDs, leases, project names, handoff counts, or other routing metadata to requests.

Use native thread reads with complete structured output. Preserve thread identity, turn IDs/status, truncation flags, incoming function-call output, user text, and the completed final answer exactly. Do not manually retype or normalize prompt/answer text.

1. **Claim the current assignment**

   Request:

   `{"operation":"claim"}`

   The result is either `null` or only:

   `{"threadId":"<destination>","prompt":"<exact payload>"}`

   Treat that destination and payload as authoritative. Do not infer a destination from controller history.

2. **Prepare exactly one send**

   Read the destination thread before sending, including native outputs and enough current turn data for exact correlation. Then request:

   `{"operation":"prepare","snapshot":<native read result>}`

   The helper resolves the current internal delivery itself, validates the destination/read state, records the native baseline, and crosses CWC's durable submission boundary. A successful result again contains only the destination thread and exact payload.

   If prepare fails, do not send.

3. **Deliver exactly once**

   Use one native `send_message_to_thread` call with the exact `threadId` and exact `prompt` returned by prepare. Do not add model, thinking, routing, or project metadata.

   Never retry the native send when its outcome is uncertain.

4. **Complete from exact native evidence**

   After a successful send, read the same destination until the submitted turn has a completed final answer. Do not accept commentary, truncated content, unrelated turns, failed turns, or a response at/before the recorded baseline.

   Request:

   `{"operation":"complete","snapshot":<native read result>}`

   The helper mechanically finds the one submitted delivery whose destination, source, baseline, exact prompt, completed turn, and receipt match the snapshot. Internal relay/delivery/lease identifiers never need to enter controller context. Retrying the same completion snapshot is idempotent and does not resend the prompt.

   Successful completion produces no routine controller message.

5. **Report only a concrete courier failure**

   If permissions, missing native thread, unavailable native tooling, or another concrete courier failure prevents the current assignment from proceeding, request:

   `{"operation":"fail","reason":"<bounded concrete reason>"}`

   The helper resolves the current internal delivery. If the send boundary had already been crossed, CWC records terminal uncertainty and the delivery must never be replayed.

   Report the concrete courier failure to the owner. Do not speculate about project status and do not send corrective participant messages.

## Safety invariants

A terminal uncertain delivery is not normal controller work. Do not claim it, poll it automatically, reconcile it automatically, or replay it. CWC may retain a narrow durable submission tombstone for the affected destination so a late native response cannot be mistaken for a later identical delivery. That tombstone does not authorize controller activity.

Healthy submitted work may be read until its exact completed response is available. If the native read is incomplete or ambiguous, fail closed rather than guessing.

The native read limit is 20,000 characters per item. Oversized or truncated evidence cannot authorize a send or completion. Keep large project artifacts outside relay text and pass only exact owner-authorized participant payloads through the bridge.
