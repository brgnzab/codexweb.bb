# CWC Personal legacy-cleanup retention record

CWC-010 removes inherited non-Council launcher/runtime entrypoints that are no longer required by the v4.1.0 Council product. A legacy-looking file may remain only when the active Council path still depends on it.

## Removed runtime surfaces

The following inherited runtime surfaces are intentionally no longer part of CWC Personal:

- legacy terminal CLI dispatcher and its `serve`, standalone `setup`, `doctor`, service and tunnel-service branches;
- Codex route/config integration and native Codex model-catalog/passthrough support;
- standalone browser-login workflow (only the verification-marker path helper remains because the packaged browser helper imports it);
- legacy Responses HTTP proxy, SSE bridge, request parser/state/schema/reasoning-envelope path;
- old ChatGPT Responses adapter orchestration: adapter entrypoint, adapter MCP server, turn broker/execution, request environment/thread projection and adapter usage estimator;
- retired Electron `main.cjs`, legacy launcher contracts, updater stylesheet, and prior installer/distribution entrypoints.

The current runtime CLI is limited to `--version`, `--help`, `council-setup`, `mcp`, and the `--home` override. Source `start` launches the Electron Council application.

## Retained legacy-named launcher bases

### `launcher/electron/runtime-legacy.cjs`

**Retained: CURRENT DEPENDENCY.**

`launcher/electron/runtime.cjs` directly imports this module and subclasses `legacy.RuntimeHost`. The current Council `RuntimeHost` relies on inherited construction, operation execution, runtime/config inspection, credential checks and supervisor integration while overriding Council-specific setup/doctor/bridge behavior. `main-council.cjs` instantiates this current wrapper for every Council launch.

Deleting or mechanically trimming the base without runtime execution evidence would change the active Council lifecycle rather than remove a detached path.

### `launcher/electron/runtime-supervisor-legacy.cjs`

**Retained: CURRENT DEPENDENCY.**

`launcher/electron/runtime-supervisor.cjs` directly imports this module and subclasses `legacy.RuntimeSupervisor`. The Council wrapper calls inherited methods/properties including config reading, ownership-state persistence, child cleanup, Tunnel start/health/recovery, shutdown, runtime command construction, configured-runtime startup, setup stop and state clearing. `main-council.cjs` instantiates this wrapper for the live Council Tunnel runtime.

Deleting or trimming this base before independent runtime testing would alter current process/Tunnel lifecycle behavior. Its retention therefore satisfies the CWC-010 rule that legacy-looking code must have a demonstrated current dependency.

## Current browser-helper compatibility

`src/browser-login.ts` remains only as a small `loginVerificationMarkerPath()` helper because `src/adapters/chatgpt-web/browser-worker.ts`, which is bundled by `scripts/build-browser-helper.ts`, imports that path function. The old standalone login flow and its test were removed.

The remaining browser-worker/model/prompt/rolling-checkpoint modules are retained because the launcher packages `browser-helper-main.ts` and uses that helper for current ChatGPT browser verification/smoke behavior.

## CWC-010 boundary

This gate is source cleanup, not an untested rewrite of process lifecycle primitives. The retained legacy-named bases above are active dependencies and are explicitly documented rather than falsely classified as dead code. Later independent regression/runtime gates must test them before any deeper extraction is attempted.
