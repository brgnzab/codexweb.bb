# CWC-013 security preservation map

Tracker acceptance:

> Localhost binding, auth/tokens, origin/input validation, renderer sandbox/context isolation, path/request checks, cleanup/timeouts, and hostile-content defenses remain functional.

This gate does not redesign the security model. It records the post-hardening implementation and the existing behavioral evidence that must remain green after CWC-006 through CWC-012 cleanup.

## 1. Localhost binding

Current controls:

- `src/council/http-server.ts` fixes `COUNCIL_HTTP_HOST` to `127.0.0.1` and passes it as the Bun listener hostname.
- runtime configuration requires `host === "127.0.0.1"`.
- `launcher/electron/control-server.cjs` listens on an ephemeral `127.0.0.1` port and publishes only a loopback endpoint.
- launcher free-port discovery also binds `127.0.0.1`.

Behavioral evidence:

- `tests/council-http-contract.test.ts`
- `tests/runtime-layout.test.ts`
- `launcher/tests/control-server.test.cjs`
- `tests/cwc-security-preservation.test.ts`

Codex should additionally inspect live listeners during QA and fail if a CWC service unexpectedly binds `0.0.0.0` or `::`.

## 2. Authentication, capabilities, and secret handling

Current controls:

- Council agents authenticate with per-agent capabilities; ordinary public agent records do not expose those tokens.
- Council mutations reject content that would disclose the caller capability.
- owner control issues a random 32-byte bearer token and compares it with `timingSafeEqual`.
- browser control independently creates a random 32-byte bearer token and compares it with `timingSafeEqual`.
- owner-control state and other private configuration are written through private/atomic file paths.
- launcher logging redacts tunnel IDs, runtime keys, bearer values, cookies, access/refresh tokens, API keys, passwords, secrets, URL credentials and related sensitive fields.

Behavioral evidence:

- `tests/council-security.test.ts`
- `tests/council-owner-control.test.ts`
- `tests/council-owner-http-security.test.ts`
- `launcher/tests/control-server.test.cjs`
- `launcher/tests/logging.test.cjs`

## 3. Origin and request/input validation

Current controls:

- owner HTTP operations reject any request carrying an `Origin` header, including `null`, and require the private bearer token.
- owner request bodies are capped at 64 KiB and must decode to plain JSON objects.
- owner execution operations enforce exact allowed key sets, validated opaque IDs, bounded text and bounded limits.
- browser control caps bodies at 16 KiB and validates trace IDs, helper PIDs and terminal status values.
- Council browser actions accept only declared action fields/types, cap a batch at 16 actions and cap action JSON at 64 KiB.
- generic Responses request decoding caps encoded and decoded sizes and rejects unsupported content encodings.

Behavioral evidence:

- `tests/council-owner-http-security.test.ts`
- `launcher/tests/control-server.test.cjs`
- `launcher/tests/council-control-server.test.cjs`
- `tests/council-browser-actions.test.ts`
- `tests/http-body.test.ts`
- `tests/cwc-security-preservation.test.ts`

## 4. Renderer sandbox and browser navigation isolation

Current controls:

- the launcher renderer uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` and a preload capability bridge.
- the normal production entry runs through `main-dispatch.cjs` -> `main-hardened.cjs` -> `main-council.cjs`.
- local renderer navigation is restricted to the expected dev origin or exact packaged renderer URL.
- child windows are denied.
- managed ChatGPT content uses sandboxed/context-isolated WebContents.
- identity-provider popup requests are denied as popup-owned WebContents and recreated as a fresh launcher-owned sandboxed `WebContentsView` in the existing private partition.
- authentication navigation is allowlisted and bounded by a 60-second navigation timeout.

Behavioral evidence:

- `launcher/tests/electron-advisory-boundary.test.cjs`
- `launcher/tests/browser-host.test.cjs`
- `launcher/tests/council-entrypoint-contract.test.cjs`
- `tests/cwc-security-preservation.test.ts`

## 5. Path, repository, and request authority checks

Current controls:

- runtime executables must be absolute, durable and outside temporary roots.
- Windows outer-tool broker endpoints must be native named pipes; Unix endpoints must be absolute sockets.
- launcher runtime configuration validates absolute tunnel/runtime/descriptor paths before process spawn.
- repository workspace metadata accepts only fixed fields, validates owner/name/repo identity, rejects unsafe branch forms, and requires immutable commit hashes.
- execution compares the deliberated base commit to observed HEAD and reports `STALE_BASE` rather than silently applying work to a moved repository.

Behavioral evidence:

- `tests/runtime-layout.test.ts`
- `launcher/tests/runtime-supervisor.test.cjs`
- `tests/council-repo-workspace.test.ts`
- `tests/cwc-security-preservation.test.ts`

## 6. Cleanup, cancellation, and bounded timeouts

Current controls:

- bridge stall detection remains bounded; the default upstream silence budget is 300 seconds with a minimum of one second.
- authentication navigation is bounded at 60 seconds and clears its timer on completion/failure/closure.
- Windows owned process trees are terminated with `taskkill /T /F` under a 10-second bound and failures are surfaced if the process remains alive.
- runtime supervisor retains bounded command/restart/health behavior and cancellation/quit coordination.
- atomic replacement retries only known transient Windows lock errors within a finite retry schedule and then fails closed.
- packaged cold-runtime smoke has a dedicated finite six-minute QA timeout; normal subprocess timeout remains 45 seconds.

Behavioral evidence:

- `launcher/tests/runtime-supervisor.test.cjs`
- `launcher/tests/atomic-file.test.cjs`
- `launcher/tests/packaging-contract.test.cjs`
- `tests/cwc-security-preservation.test.ts`

## 7. Hostile-content and prompt-injection boundaries

The product does not claim that model text can be made intrinsically trustworthy. Instead it keeps authority outside untrusted text and constrains what untrusted output can request.

Current controls:

- repository text, websites, tool output and prompt text remain documented as untrusted data.
- Codex operational context, including `<environment_context>`, is transported at its original role/priority and explicitly distinguished from human-authored user text.
- the current turn capability token is supplied separately and replayed old turn/binding handles are retired before transport.
- tool-capable mode requires the active turn token; read-only mode must not receive one.
- Council action output is parsed only from one terminal structured block and rejects unknown action fields such as injected source identity or arbitrary command fields.
- owner execution routes reject URL/script/selector/prompt smuggling.
- execution commands remain permission-gated with the existing Council ACL vocabulary.

Behavioral evidence:

- `tests/prompt-contract.test.ts`
- `tests/council-browser-actions.test.ts`
- `tests/council-owner-http-security.test.ts`
- `tests/council-execution-policy.test.ts`
- `tests/council-chatgpt-connector-policy.test.ts`
- `tests/cwc-security-preservation.test.ts`

## 8. Public/private state separation

Current controls:

- the public Council snapshot excludes private checkpoints and bounded history is exposed rather than raw internal state.
- private browser session/profile state stays under launcher user data and is not part of runtime descriptors or public repository/package state.
- security-sensitive logs are redacted before persistence or renderer publication.

Behavioral evidence:

- `tests/council-http-contract.test.ts`
- `tests/council-security.test.ts`
- `launcher/tests/logging.test.cjs`
- public-hygiene/package evidence from CWC-002 and CWC-012.

## Independent CWC-013 QA requirement

Codex must independently run the focused security suites plus the normal root/launcher regression on the exact requested revision. Static contract evidence is not sufficient by itself. QA should also exercise the owner HTTP boundary and browser-control boundary against unauthorized/malformed requests, verify the Electron security preferences and popup denial on the real source, and inspect live CWC listeners for loopback-only binding.

PASS requires no material security-control regression. If a test fails only because its expectation describes an intentionally removed feature, Codex must show that conflict explicitly rather than weakening or restoring security-sensitive behavior by assumption.
