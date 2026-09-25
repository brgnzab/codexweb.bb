# CWC Personal — Current Release Capability and Exposure Inventory

Baseline reviewed: upstream `Nolane-x/codexweb` v4.1.0, locked commit `440bdfda86a9dda2e909b9f2e527433c0652fff7`.

CWC Personal branch reviewed for this inventory: `cwc-personal` through `1ee91fd1bcc1a6c69210a49d9a4257b1f28c4623`.

Purpose: establish the current-release functional, dependency, network, filesystem and process/IPC surface **before any deletion or hardening removal**. This document is an inventory, not an authorization to remove a module.

## 1. Product runtime planes

The current release has three overlapping runtime planes:

1. **Council state/orchestration plane** — managed projects and agents, rooms/messages/tasks/decisions/wakes, persistent conversation binding, wake/spawn scheduling, autonomy/supervisor, memory, observations/evidence, execution control and Council MCP/owner APIs.
2. **ChatGPT browser / Codex compatibility plane** — Electron/Playwright ChatGPT sessions and browser workers, routed ChatGPT Web models, Responses parsing/streaming/compaction/continuation, native Codex passthrough, turn broker and optional tool bridge.
3. **Electron launcher/supervision plane** — desktop UI, persistent browser partition, browser/control loopback servers, runtime/tunnel supervision, durable packaged-runtime installation, logging/state, autostart and current self-update machinery.

CWC Personal must preserve the Council capabilities and security boundaries required by the locked baseline while later removing unnecessary inherited/distribution machinery only after dependency reachability is proven.

## 2. Primary entry points

| Entry point | Current role | Key dependencies/exposure |
| --- | --- | --- |
| `launcher/electron/main-council.cjs` | Active Electron main process (`launcher/package.json` `main`) | Electron UI, Council browser host, loopback control, runtime/tunnel supervisor, state/logging, autostart, updater |
| `launcher/src/CouncilApp.tsx` / Mission Control components | Human operator UI | Preload IPC only; public/sanitized Council state |
| `src/cli.ts` | Runtime CLI entry | Intercepts `council-setup`; delegates all other commands to `cli-legacy.ts` |
| `src/cli-legacy.ts` | Inherited terminal/runtime command surface | setup/login/doctor/serve/MCP/service/tunnel/route/open/uninstall; major legacy seam |
| `src/server.ts` | Responses compatibility daemon | loopback HTTP; native Codex passthrough; ChatGPT Web adapter; compaction/continuation; admin lifecycle |
| `src/council/mcp-main.ts` / `mcp-server.ts` | Council MCP entry | Council tool facades and optional Secure MCP Tunnel connection |
| `src/council/http-server.ts` | Council public sync + trusted owner API | `127.0.0.1`, default port 17842; owner bearer; strict Origin/body/field validation |
| `src/adapters/chatgpt-web/browser-helper-main.ts` | Browser helper runtime | exact Electron browser surface / Playwright transport |

Additional packaged build entry points are `scripts/build-runtime-bundle.ts`, `launcher/scripts/prepare-runtime.cjs` and `launcher/scripts/package.cjs`; these create the embedded runtime and current installer artifacts rather than defining Council business behavior.

## 3. Functional capability inventory

### 3.1 Council state and collaboration

Core modules: `src/council/store.ts`, `state-file.ts`, `types.ts`, `validation.ts`, `work-operations.ts`.

Capabilities:
- authenticated Council agent identities/capability tokens;
- rooms, messages/threads/replies/mentions;
- proposals/decisions/tasks and bounded wake queues;
- atomic Council transactions and persisted mutation state;
- presence leases and revisioned snapshots;
- ACL/decision-gate enforcement.

### 3.2 Managed projects, agents and exact conversation continuity

Core modules: `managed-runtime.ts`, `agent-manager.ts`, `agent-registry.ts`, `managed-agent-state.ts`, `managed-project-state.ts`, `conversation-registry.ts`, `resurrection.ts`, `work-scheduler.ts`, `browser-transport.ts`, `playwright-council-driver.ts`, `playwright-council-surface.ts`.

Capabilities:
- one active managed project;
- persistent agent identity, mandate, permissions, conversation URL and checkpoint;
- exact-conversation focus and wake routing;
- bounded active browser surfaces;
- spawn/wake scheduling and retries;
- resurrection only after explicit unavailable/deleted evidence;
- private conversation URL/checkpoint excluded from renderer/public agent projections.

### 3.3 Autonomy, supervision and work recovery

Core modules: `autonomy-*`, `supervisor.ts`, `stale-work-monitor.ts`, `agent-health.ts`, `hybrid-wake-delivery.ts`, `wake-engine.ts`.

Capabilities:
- durable work routing and bounded retry/exception handling;
- supervisor status/manager/manual run;
- stale-work detection;
- managed vs legacy wake delivery routing;
- explicit uncertain-work/operator handling.

### 3.4 Execution Control Plane / Deep State

Core modules: `execution-control-plane.ts`, `execution-policy.ts`, `chatgpt-deep-state.ts`, `evidence-store.ts`, `observation-store.ts`, `mcp-tools-execution.ts` plus Electron `CouncilExecutionInspector.tsx`.

Capabilities:
- stable execution-run identity and phases;
- Deep State lifecycle observations;
- immutable accepted/rejected receipts and bounded events;
- cancellation, focus, capture and retry authority;
- submission-boundary retry safety;
- observations/screenshots with bounded local retention;
- trusted owner/Electron projection without conversation URLs/prompts/tokens/raw DOM.

### 3.5 Memory

Core modules: `memory-index.ts`, `memory-projector.ts`, `mcp-tools-memory.ts`.

Capabilities:
- project/room-scoped indexed memory;
- recent/search/stats/clear operations;
- private persisted state exposed to renderer only through bounded public owner API results.

### 3.6 Council MCP

Core modules: `mcp-main.ts`, `mcp-server.ts`, `mcp-shared.ts`, `mcp-tools-discussion.ts`, `mcp-tools-managed.ts`, `mcp-tools-work.ts`, `mcp-tools-memory.ts`, `mcp-tools-observations.ts`, `mcp-tools-execution.ts`, `mcp-tools-autonomy.ts`, `mcp-tools-system.ts`.

Capabilities include Council join/start, discussion, managed agent control, task/work operations, memory, observations, execution operations, autonomy/system status, all governed by controller-side capability/ACL state.

### 3.7 ChatGPT browser automation

Core modules: `src/adapters/chatgpt-web/*`, `src/chatgpt-session.ts`, launcher `browser-host.cjs`, `council-browser-host.cjs`, `browser-helper-verifier.cjs`, `agent-surface-registry.cjs`.

Capabilities:
- persistent Electron login partition;
- exact task-bound surfaces and controlled Playwright attachment;
- Temporary Chat for routed model turns where applicable;
- persistent managed Council conversations for child agents;
- model/effort selection and account capability detection;
- image/context submission, response extraction, tool-round handling and cancellation;
- browser login/logout/smoke and surface focus/capture.

### 3.8 Responses/Codex compatibility

Core modules: `server.ts`, `bridge.ts`, `responses/*`, `native-passthrough.ts`, `chatgpt-web-models.ts`, `model-catalog.ts`, `codex-integration.ts`.

Capabilities:
- loopback Responses-compatible routing;
- fixed `chatgpt-web/*` routed models;
- native model passthrough to ChatGPT Codex backend;
- streaming and non-streaming response bridging;
- local previous-response continuation state;
- dedicated compaction flow;
- tool namespace mapping and turn lifecycle accounting.

Council product code explicitly disables legacy Codex bridge installation through `launcher/electron/runtime.cjs`, but inherited compatibility source remains reachable through other legacy/terminal paths and must be mapped in CWC-004 before deletion.

### 3.9 Desktop Mission Control / operator API

Core modules: `launcher/src/CouncilApp.tsx`, Agents/Dock/Execution/Setup/Supervisor panels, `preload.cjs`, `main-council.cjs`, `council-owner-client.cjs`, `council-connection-supervisor.cjs`.

Capabilities:
- Overview, ChatGPT, Agents, Work, Memory, Executions, Connections, Diagnostics and Settings;
- bind current ChatGPT conversation as Lead;
- focus/capture agents;
- execution/supervisor/autonomy/memory/observation operations;
- browser controls and setup/doctor;
- strict main-process IPC validation and renderer sandbox/context isolation.

## 4. Direct dependency inventory

### Root/runtime dependencies

- `@modelcontextprotocol/sdk` — MCP protocol/server transport.
- `playwright-core` — browser automation/control.
- `chromium-bidi` — browser protocol support pulled into the runtime surface.
- `fflate` — ZIP extraction, currently including downloaded tunnel-client archive.
- `tiktoken` — routed-model/context token accounting.
- `turndown`, `turndown-plugin-gfm` — HTML/Markdown response normalization.
- `zod` — schemas/validation and MCP-related contracts.

Root tooling: Bun 1.3.14, TypeScript 5.9.3. Lockfile and overrides are supply-chain inputs; dependency advisories are handled in the later integrity gate, not by this inventory.

### Launcher dependencies

Runtime UI: `react`, `react-dom`, `motion`.

Build/distribution tooling: Electron 41.7.1, Vite, TypeScript, electron-builder and React typings/plugins.

The current Windows distribution target is NSIS. Portable CWC Personal will later replace installer-oriented distribution; this inventory does not delete it.

## 5. Network exposure inventory

| Endpoint / transport | Direction | Current purpose | Classification for CWC Personal |
| --- | --- | --- | --- |
| `https://chatgpt.com` | outbound browser/HTTP | ChatGPT UI, session, connector settings and native Codex backend | Core/expected |
| `https://chatgpt.com/backend-api/codex/*` | outbound HTTP | Native Codex models/responses/compact/search passthrough | Current compatibility; reachability to be mapped before any removal |
| OpenAI Secure MCP Tunnel | outbound tunnel process | Optional ChatGPT connector → local Council MCP | Preserved capability, implementation to be hardened |
| `https://platform.openai.com/...` | external browser links | Tunnel/runtime-key management | Setup convenience; not runtime data path |
| `https://github.com/openai/tunnel-client/releases/...` | outbound HTTPS | Automatic pinned tunnel-client archive + checksum download | **Later removal/redesign: remote code acquisition** |
| `https://api.github.com/repos/Nolane-x/codexweb/releases/latest` and release assets | outbound HTTPS | Automatic launcher release check and user-triggered self-update | **Required later removal** |
| `127.0.0.1:17841` default | local loopback | Responses daemon/admin lifecycle | Local core compatibility |
| `127.0.0.1:17842` default | local loopback | Council public sync + owner API | Council core |
| dynamic `127.0.0.1` CDP/control ports | local loopback | Electron browser surface control | Browser core |
| Windows named pipe / Unix socket broker | local IPC | turn/tool broker | Full-mode compatibility/tool bridge |
| renderer file URL / dev localhost origin | local | Electron renderer | Desktop core |

No telemetry network path was identified in the reviewed current entry points. CWC-005 will perform the dedicated outbound-network inventory and runtime confirmation; this table is the CWC-003 pre-deletion exposure map.

## 6. Filesystem and persisted-state exposure

| Location / class | Content / purpose | Notes |
| --- | --- | --- |
| `CODEX_CHATGPT_WEB_HOME` or `~/.codex-chatgpt-web` | core config/runtime state | Default private application home |
| `<core-home>/config.json` | runtime mode, localhost port, browser/tunnel paths, control token | strict validation; private file |
| `<core-home>/browser/storage-state.json` | legacy/managed-Chrome browser state path | private sensitive state; launcher uses persistent Electron partition |
| `<core-home>/versions/<version-platform-arch>` | durable copied packaged runtime | current packaged launcher install behavior |
| `<core-home>/bin/tunnel-client(.exe)` + manifest | downloaded tunnel binary | later remote-acquisition cleanup target |
| `<core-home>/secrets/tunnel-runtime.key` | tunnel runtime key | sensitive; private atomic file |
| `<core-home>/tunnel/profiles` | tunnel-client profiles | private runtime state |
| Council state files under Council home | agents/credentials, rooms/messages/tasks/decisions/wakes | atomic persistent Council state |
| managed project/agent state | persistent conversation URLs/checkpoints/permissions | private; not renderer-projected |
| memory index/projected memory | Council memory | private local state |
| observations index/screenshots | execution evidence; default bounded retention | directories `0700`, files `0600`; default 72 runs / 512 MiB |
| Electron `userData` (`%APPDATA%/Codex Web GPT` by default on Windows) | persistent ChatGPT partition, launcher state, window state, secrets | private launcher-owned state |
| Electron logs path | JSONL activity/process diagnostic/update logs | secret-redaction layer applies |
| OS autostart/login item state | startup persistence | required later removal |
| macOS `~/Library/LaunchAgents/...` | terminal-managed daemon definition | non-Windows legacy/advanced path; later cleanup candidate |
| temporary update directories | downloaded installer/update worker job | required later removal with updater |

CWC-002 already established public-repository/package hygiene; none of the private state above is intended to be committed or shipped with owner data.

## 7. Process, IPC and execution exposure

### Spawned/external processes

- bundled Bun runtime commands and browser helper;
- tunnel-client process and tunnel runtime lifecycle;
- detached launcher update worker (current self-update path);
- macOS `launchctl` for terminal-managed services;
- platform package/update helpers (for example macOS `ditto`);
- generic synchronous process helper `src/process.ts` used by controlled runtime/service/tunnel setup paths;
- Electron/Chromium renderer and browser subprocesses.

Council browser actions do **not** map to arbitrary shell execution. Process-launch capability is controller/launcher implementation machinery and must remain unreachable from untrusted model action payloads.

### Local IPC / servers

- Responses loopback HTTP + authenticated admin endpoints;
- Council loopback HTTP sync API and no-Origin bearer-authenticated owner endpoints;
- launcher browser-control loopback server;
- Electron preload IPC with explicit channel handlers and field validation;
- named-pipe/Unix-socket turn broker;
- Playwright/CDP bound to `127.0.0.1`;
- stdio MCP server invoked by tunnel-client.

## 8. Security boundaries confirmed during inventory

- Responses and Council HTTP bind to loopback.
- Council owner routes reject browser Origin and require a private bearer.
- config/state writers use atomic private-file patterns and path/value validation.
- Electron renderer uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` and navigation guards.
- renderer receives sanitized managed-agent/execution projections instead of private conversation URLs/checkpoints/tokens.
- Council identities and permissions are controller state, not trusted model-supplied identity text.
- browser surface identity is controller-owned.
- lifecycle drain/shutdown and cancellation accounting exist for controlled process transitions.

These are preservation constraints for later cleanup.

## 9. Explicit later-removal / dependency-mapping candidates — do not delete in CWC-003

The following are **candidates**, not deletion decisions. CWC-004 must prove current/legacy reachability, and the later hardening gates must preserve required capability before removal.

1. `launcher/electron/council-update.cjs`, `update-worker.cjs`, `update.cjs`, `CouncilUpdatePrompt.tsx`, startup `updateController.checkOnce()` and update-install IPC — self-update / release checking.
2. `launcher/electron/autostart.cjs` and Settings/startup synchronization — OS startup persistence.
3. automatic `openai/tunnel-client` downloader in `src/tunnel.ts` — generic remote executable acquisition despite checksum pinning; retained Council Tunnel capability needs a local/prebundled alternative.
4. `src/service.ts` / tunnel-service launchd behavior — non-Windows terminal-managed service path.
5. launcher macOS/Linux packaging targets and installer-oriented NSIS/electron-builder paths — final product is Windows portable folder/ZIP.
6. `src/cli-legacy.ts` and legacy setup/route/service/tunnel/open/uninstall branches not required by the Council Windows product.
7. `launcher/electron/main.cjs`, `runtime-legacy.cjs`, `runtime-supervisor-legacy.cjs` and legacy tests — inherited implementations currently wrapped/subclassed by Council code; cannot be deleted until CWC-004 maps live inheritance and replacement needs.
8. legacy managed-Chrome/browser-storage-state terminal path if the Windows Council product proves it is independent of the launcher-owned Electron session.
9. native Codex Responses passthrough / old Codex integration modules if they are proven not required by the final CWC relay architecture; do not assume this yet.
10. durable packaged-runtime copying under `<core-home>/versions` if the portable folder can run safely in place; later portable/data-write gates decide this.

## 10. Preserve-first capability set

Later removals must not regress:

- persistent managed ChatGPT conversations and exact-thread targeting;
- agent registry/state, wake/spawn, scheduling, resurrection and retries;
- supervisor/autonomy and bounded exceptional-work handling;
- Council rooms/messages/tasks/decisions and ACL/DecisionGate semantics;
- memory, observations/evidence and Execution Control Plane / Deep State;
- Council MCP and trusted owner/Electron operations required for relay;
- ChatGPT browser automation needed to drive and observe real human-like functional conversations;
- cancellation, timeouts, process cleanup and retry-safety boundaries;
- localhost/auth/origin/input/path validation and Electron sandbox/context isolation;
- private-state separation and log redaction.

## 11. CWC-003 conclusion

The current release has been inventoried across functional modules, direct dependencies, public/local network endpoints, filesystem/state writes, process spawning and IPC/control boundaries. The inventory identifies concrete inherited/removal candidates without deleting or disabling anything.

Next engineering gate: **CWC-004 — map legacy/current dependency reachability** so each cleanup candidate can be classified as active, indirectly required, replace-before-remove, or dead/independent before source deletion begins.
