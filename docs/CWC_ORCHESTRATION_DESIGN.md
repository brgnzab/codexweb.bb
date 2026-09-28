# Controller and future multi-role orchestration

Owner direction, 2026-09-28: CWC Controller is a normal, independently configurable Codex chat. Existing DEV/QA/Work chats remain the project participants. The controller does mechanical routing and orchestration; it does not become a worker, reviewer, or approver by default. Model and reasoning selection stay in the Codex UI and are not part of CWC routing policy.

## Current implementation

The durable relay service owns delivery state and fixed destinations. The controller is a replaceable native-chat transport worker. The GPT Web transport and native desktop helper consume delivery identities and conversation bindings, not model identifiers. This separation allows transport and controller intelligence to change without changing participant roles or work history.

Version 1 is deliberately a two-participant worker/reviewer workflow. Its scheduler, prompt roles and UI are pair-specific. Multi-participant execution is not implemented or claimed. The claim/prepare/complete protocol is reusable for one delivery to any registered participant; only the scheduling and role/configuration layer needs to grow.

## Expansion contract

1. Introduce a versioned project definition with stable participant IDs, role labels, existing conversation bindings, and owner-approved routing edges. Migrate existing pairs into worker/reviewer participants with two directed edges. Keep the version-1 reader and migration explicit; never reinterpret an in-flight delivery.
2. Store the controller binding separately from participants. Its default capability is transport/orchestration only. A future owner configuration may also assign it a substantive participant role, but that must use a separate explicit role binding and scheduling rule; never infer that assignment from chat titles or peer messages. Avoid self-send deadlocks.
3. Extract next-participant selection from the pair scheduler into an owner-configured routing policy. A transport delivery carries project ID, delivery ID, destination participant ID, correlation/parent ID, immutable prompt, lease and receipt. Keep prepare-before-send and exact completed-response correlation unchanged.
4. Add explicit policies for sequential review, bounded fan-out/fan-in and final approval. The owner chooses required reviewers and completion conditions. A worker cannot declare another role's approval or nominate arbitrary recipients. Start with serialized sends per conversation, preserving isolation across projects.
5. Persist per-participant progress, review dependencies, budgets and final outcome. Resume queued work after restart; reconcile submitted work without replay. Cancel stops future routing and preserves already-submitted receipts. Do not broaden retry privileges as the graph grows.
6. Keep role names, model choice and transport independent. DEV and QA can use different manually selected models; CWC never resets either. Controller capability failures become concrete setup blockers. Configuration changes are versioned and apply to future deliveries, not existing submissions.

The next extension should test one worker and two independent reviewers, a return-for-repair path, and an explicitly designated final reviewer. Verify exact target IDs, one submission per delivery, fan-in completion, cancellation and restart. Those future checks do not replace the currently required live G9/G10 acceptance of existing-chat pairs.
