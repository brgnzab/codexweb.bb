# CWC Personal — Legacy vs Current Dependency Map

Baseline: upstream `Nolane-x/codexweb` v4.1.0 at `440bdfda86a9dda2e909b9f2e527433c0652fff7`.

CWC Personal dependency mapping starts from `cwc-personal` commit `0e3fadaf0794e3ca0caa05011df29cfca56b3282` and the CWC-003 current-release inventory.

Purpose: classify legacy-looking launcher/runtime/distribution paths as either **REQUIRED-CURRENT** or **REMOVABLE**, with dependency evidence, before deletion begins.

Definitions:
- **REQUIRED-CURRENT** — production startup, Council runtime, current verification/package flow, or an active wrapper currently depends on the path. It cannot be deleted yet. Some items are still required only because current Council code subclasses/dispatches through inherited code; those must be replaced or split before removal.
- **REMOVABLE** — no required CWC Personal runtime dependency remains for the Windows Council product. Deletion is deferred to the explicit cleanup/hardening implementation gates, where associated tests/build references are removed or replaced together.

This classification does not itself delete anything.

## 1. Root CLI and runtime command path

### `src/cli.ts` — REQUIRED-CURRENT

Evidence: root `package.json` exposes this file as the `codex-chatgpt-web` binary. It handles `council-setup` directly and dynamically imports `cli-legacy.ts` for every other command.

### `src/cli-legacy.ts` — REQUIRED-CURRENT, split-before-remove

Despite its name, the current Council Tunnel reaches Council MCP through this file:

`runtime/tunnel MCP command -> src/cli.ts -> non-council-setup command "mcp" -> cli-legacy.ts -> runChatGptMcpMain()`.

`cli-legacy.ts` also statically imports legacy setup, Codex integration, service and tunnel-service modules. Therefore deleting it now would break current Council MCP startup and the runtime bundle, even though most of its command surface is not desired in CWC Personal.

Removal condition: introduce a Council-native `mcp` dispatch in `src/cli.ts` (or equivalent dedicated entry point) and remove remaining current Council calls to inherited CLI helpers; then legacy terminal setup/route/service/open/uninstall branches and their imports become removable.

### `src/adapters/chatgpt-web/mcp-main.ts` — REQUIRED-CURRENT

Evidence: `cli-legacy.ts` dispatches `mcp` here. This module checks configured `appName`; when it equals `CodexWeb Council`, it calls `runCouncilMcpMain()`. Its legacy direct-token broker branch remains only for non-Council compatibility, but the module itself is on the active Council path.

Removal condition: move the Council dispatch into a Council-specific CLI path; then the remaining legacy direct-token broker wrapper can be assessed separately.

### `src/council/mcp-main.ts` — REQUIRED-CURRENT

This is the active Council MCP/process composition root. It constructs Council state, managed agents/projects, browser transport, execution control, evidence/observations, supervisor, autonomy, memory, stale-work monitor, owner API and Council HTTP server.

### `src/council/setup.ts` — REQUIRED-CURRENT, tunnel-install portion replace-before-remove

`src/cli.ts` directly dispatches `council-setup` here. It currently imports `installTunnelClient`, `installRuntimeKey` and `createTunnelConfig` from `src/tunnel.ts`, writes the `CodexWeb Council` full-mode config and stores the launcher browser descriptor.

## 2. Tunnel and legacy terminal-service modules

### `src/tunnel.ts` — REQUIRED-CURRENT today; implementation must be narrowed

Current Council setup calls `installTunnelClient()` and tunnel configuration helpers from this module. The launcher supervisor then uses the configured tunnel binary/path/credentials.

The automatic GitHub release download inside `installTunnelClient()` is not acceptable for final CWC Personal and must be replaced by a prebundled/local-reviewed tunnel-client mechanism before this module can be reduced or removed.

### `src/service.ts` — REQUIRED-CURRENT transitively, removable after CLI split

Normal Electron Council runtime does not use the macOS launchd daemon service. However `cli-legacy.ts` statically imports service functions, and `cli-legacy.ts` is still on the current `mcp` path. Thus the source remains in the current runtime dependency graph even though its service commands are not required by the Windows Council product.

Removal condition: extract Council `mcp` from `cli-legacy.ts`, then delete this non-Windows terminal-managed service path and its tests/imports.

### `src/tunnel-service.ts` — REQUIRED-CURRENT transitively, removable after CLI split

Same dependency reason as `src/service.ts`: statically imported by current `cli-legacy.ts`, but the launcher-owned Council runtime uses `RuntimeSupervisor`, not terminal launchd tunnel service management.

Removal condition: Council CLI split, then remove.

### `src/codex-integration.ts` — REQUIRED-CURRENT transitively, removable after CLI split

`cli-legacy.ts` statically imports route connect/disconnect/uninstall functions. `launcher/electron/runtime.cjs` explicitly disables Codex bridge setup/routing for the Council product, so the feature is not current Council behavior; it remains in the current bundle because of the CLI dependency.

Removal condition: Council CLI split and removal of legacy route/setup/uninstall commands.

### legacy `src/setup.ts`, `browser-login.ts`, `doctor.ts` terminal setup paths — REQUIRED-CURRENT transitively / partially shared

`cli-legacy.ts` imports them. Some lower-level browser/config diagnostics remain useful, but the old standalone `setup --browser-only/--full`, standalone managed-Chrome login and terminal Codex setup contract are not CWC Personal product requirements.

Removal condition: separate reusable diagnostics/browser helpers from legacy terminal command orchestration before deleting the latter.

## 3. Electron main-process entry points

### `launcher/electron/main-council.cjs` — REQUIRED-CURRENT

Evidence: `launcher/package.json` `main` points to `electron/main-council.cjs`. It is the packaged Electron main process and owns current browser host, Council control, owner client, runtime host/supervisor, persistent state/logs and current updater/autostart wiring.

### `launcher/electron/main.cjs` — REMOVABLE

Evidence: package `main` no longer points here; the active entry point is `main-council.cjs`. This file is the older Codex launcher shell and imports the old `update.cjs` path and obsolete upstream/social links. No active CWC entry point imports it.

Delete together with references/tests that exist only for the old launcher shell.

### `launcher/src/App.tsx` — REQUIRED-CURRENT compatibility shim

It no longer implements an old UI; it simply re-exports `CouncilApp` as `App`. It is harmless current renderer wiring and can be retained until import cleanup makes the shim unnecessary.

## 4. Runtime host inheritance

### `launcher/electron/runtime.cjs` — REQUIRED-CURRENT

The active `main-council.cjs` imports this module. Its Council `RuntimeHost` subclasses `legacy.RuntimeHost`, overrides Council setup/doctor/upgrade behavior and disables Codex bridge functions.

### `launcher/electron/runtime-legacy.cjs` — REQUIRED-CURRENT, extract-before-remove

Evidence: `runtime.cjs` directly `require()`s it and extends `legacy.RuntimeHost`. Current Council methods inherited from it include runtime command spawning, operation serialization/timeouts/process-tree cleanup, runtime config snapshots and saved MCP credential checks.

This file therefore cannot be deleted simply because it is named legacy.

Removal condition: extract the shared current launcher process/runtime-host mechanics into a Council/current module, migrate `runtime.cjs`, then delete Codex setup/bridge/terminal rollback branches no longer needed.

### `launcher/electron/runtime-supervisor.cjs` — REQUIRED-CURRENT

Active current supervisor imported by `main-council.cjs`. It applies Council-specific config rules and tunnel-only startup/recovery.

### `launcher/electron/runtime-supervisor-legacy.cjs` — REQUIRED-CURRENT, extract-before-remove

Evidence: `runtime-supervisor.cjs` directly requires it and subclasses `legacy.RuntimeSupervisor`. The current subclass relies on inherited config reading/state, tunnel process spawning/health, stop/cleanup, monitoring, process-tree termination and lifecycle mechanics.

Removal condition: extract the shared tunnel/process supervision needed by Council into a current module; delete daemon/legacy compatibility branches after migration.

### `launcher/electron/runtime-command.cjs` — REQUIRED-CURRENT

Used by runtime host, supervisor and packaged runtime validation/invocation. Needed to launch the embedded/current Bun runtime and Council CLI.

### `launcher/electron/runtime-install.cjs` — REQUIRED-CURRENT today; portable-replace candidate

`main-council.cjs` calls packaged-runtime installation. It validates the signed/packaged runtime and copies it transactionally into `<core-home>/versions/...`. This is current package behavior and has active tests.

Final portable CWC may run a validated runtime directly from the portable folder; only after that path exists and passes portable data-write/runtime tests does `runtime-install.cjs` become removable.

## 5. Updater paths

### `launcher/electron/council-update.cjs` — REQUIRED-CURRENT release behavior, policy-removal target

Active `main-council.cjs` uses the Council updater and calls `checkOnce()` on startup. It checks `Nolane-x/codexweb`, validates asset paths/checksums and coordinates install.

Final CWC Personal explicitly forbids auto release checking/self-update, so this active feature must be removed in the hardening/removal gate.

### `launcher/electron/update-worker.cjs` — REQUIRED-CURRENT only because Council updater uses it; removable with updater

`council-update.cjs` copies/spawns it to perform replacement/install work. Remove at the same time as the active Council self-updater.

### `launcher/src/CouncilUpdatePrompt.tsx` and updater IPC/state — REQUIRED-CURRENT only because updater is active; removable with updater

Delete the UI/IPC/state contract together with the self-update feature; do not leave a disabled but dead update surface.

### `launcher/electron/update.cjs` — REMOVABLE

This is the older updater used by `main.cjs`, targeting the old `miuuyy/codex-chatgpt-web` repository. Active `main-council.cjs` uses `council-update.cjs` instead.

`launcher/tests/update.test.cjs` is currently included by the generic active-test enumerator, but that test is validation of the obsolete updater rather than evidence of production reachability. Delete/update the obsolete test with the obsolete module.

### `launcher/tests/council-update.test.cjs` — REQUIRED-CURRENT until self-update removal

Tests the active Council updater. Remove only when the product updater itself is removed and replacement behavior is explicitly “no self-update”.

## 6. Autostart / startup persistence

### `launcher/electron/autostart.cjs` — REQUIRED-CURRENT behavior, policy-removal target

Active `main-council.cjs` imports it and exposes/synchronizes autostart state. On Windows it uses Electron login-item settings; Linux writes an autostart desktop file.

Final CWC Personal forbids startup persistence. Remove module + IPC/settings/UI/tests during hardening rather than merely defaulting the toggle off.

### Linux autostart tests / desktop-association support — REMOVABLE for Windows-only CWC

After autostart removal and Windows-only narrowing, Linux-specific autostart/desktop association tests are no longer product dependencies.

## 7. Packaging and distribution

### `scripts/build-runtime-bundle.ts` — REQUIRED-CURRENT

Builds the current relocatable runtime using the pinned Bun version and frozen production dependencies. This is useful for the eventual portable package as well as the current Electron package.

### `launcher/scripts/prepare-runtime.cjs` — REQUIRED-CURRENT

Current package path uses it to build/copy licenses and run public-hygiene checks on package inputs. Preserve/adapt for portable build unless replaced by an equivalent validated portable assembly step.

### `launcher/scripts/package.cjs` + electron-builder packaging — REQUIRED-CURRENT today; replace for final portable distribution

Current QA/release packaging and CWC-002 final artifact use this path. Windows target is NSIS. It is not final CWC Personal distribution because portable folder/ZIP is required.

Removal condition: portable Windows assembly, smoke, data-write and hash/evidence flow exists and passes later gates.

### Windows NSIS config in `launcher/package.json` — REQUIRED-CURRENT today; REMOVABLE after portable replacement

No longer needed once folder/ZIP becomes the verified distribution artifact.

### macOS targets (`package:mac`, DMG/ZIP config) — REMOVABLE

CWC Personal target is Windows 11 x64. They are invoked only by explicit cross-platform packaging/release jobs, not Windows runtime behavior.

### Linux targets (`package:linux`, AppImage config, Linux desktop association) — REMOVABLE

Same reason: independent distribution path outside the Windows product target.

### `scripts/install-launcher.ps1` — REMOVABLE

Standalone Windows latest-release installer downloads the NSIS artifact/checksums from GitHub, silently runs the installer, assumes an installed `%LOCALAPPDATA%\Programs` location, then launches it. This conflicts with the final portable/folder-first product and remote-code acquisition policy; no active launcher/runtime entry imports it.

### `scripts/install-launcher.sh` and `scripts/install.sh` — REMOVABLE

Standalone Unix/cross-platform installation machinery is outside Windows portable CWC and not imported by the current runtime.

### `scripts/prepare-windows-baseline-bun.ps1` — REQUIRED-CURRENT build/QA utility until portable toolchain is finalized

Windows build preparation is not a runtime dependency but can remain as deterministic build support while the portable assembly is established.

### `launcher/scripts/smoke-package.cjs`, `scripts/smoke-release.ts` — REQUIRED-CURRENT verification assets, adapt for portable

Current release/package smoke coverage remains useful evidence. Replace installer assumptions as portable artifacts supersede NSIS; do not discard equivalent regression coverage.

## 8. Test lineage / legacy contracts

### `launcher/tests/runtime-host.test.cjs` and `renderer-wiring.test.cjs` — REMOVABLE

`launcher/scripts/test-active.cjs` explicitly classifies these two files as `retiredCodexContracts` and excludes them from active Council tests. `launcher/package.json` exposes them separately as `test:legacy`.

This is direct evidence that failures in these suites are inherited legacy-contract failures, not active Council acceptance failures.

### Active Council runtime/supervisor/install tests — REQUIRED-CURRENT

`runtime-supervisor.test.cjs`, `runtime-install.test.cjs`, Council runtime behavior, entrypoint, packaging and other Council contract suites are included by `test-active.cjs`. Keep them until the corresponding current implementation is intentionally replaced, then migrate the tests to the replacement.

## 9. Native Codex / Responses compatibility modules

### `src/server.ts`, `native-passthrough.ts`, Responses modules and fixed web-model routing — REQUIRED-CURRENT pending architecture gate

They are still part of the root current runtime and release verification. CWC Personal’s primary relay is Council/Playwright, but removal would alter the current compatibility surface and could remove useful browser-worker mechanics or diagnostics. They are not classified removable at CWC-004 without a replacement dependency proof.

### old Codex configuration mutation (`codex-integration.ts`) — REQUIRED-CURRENT transitively now, removable after CLI split

As noted above, active Council launcher explicitly disables bridge routing; the remaining reachability is inherited CLI import coupling, not a Council feature requirement.

## 10. Dependency-cut sequence established by this map

Safe later cleanup order implied by the evidence:

1. Add a Council-native CLI `mcp` path so current Tunnel/Council MCP no longer imports `cli-legacy.ts`.
2. Remove legacy CLI command surface and thereby detach macOS service/tunnel-service/Codex-integration/old setup orchestration.
3. Extract current runtime-host and runtime-supervisor shared mechanics from `*-legacy.cjs`; migrate active Council wrappers; then delete legacy implementations/contracts.
4. Remove active self-update stack (`council-update`, update-worker, update prompt/IPC/state) and obsolete old updater (`update.cjs`).
5. Remove active autostart stack.
6. Remove old `main.cjs` and retired Codex launcher tests/contracts.
7. Narrow distribution to Windows, removing macOS/Linux package/install paths.
8. Replace NSIS/install scripts with verified Windows portable folder/ZIP assembly; adapt smoke/hash/license checks.
9. Only then reassess native Codex/Responses compatibility for removal based on actual relay/runtime test evidence.

## 11. CWC-004 conclusion

Every identified legacy-looking launcher/runtime/distribution path from CWC-003 now has a dependency class:

- **REQUIRED-CURRENT** where current Council startup, MCP dispatch, subclass inheritance, packaging/verification or direct active behavior still depends on it; or
- **REMOVABLE** where it is an old entry point, retired contract, unsupported platform distribution/install path, or obsolete updater with no production CWC dependency.

Most importantly, `cli-legacy.ts`, `runtime-legacy.cjs` and `runtime-supervisor-legacy.cjs` are **not dead code today**. They require dependency cuts/extraction before deletion. By contrast, old `main.cjs`, old `update.cjs`, retired Codex launcher tests and standalone/non-Windows installer paths have no required Windows CWC runtime role.

No source deletion was performed in CWC-004. This map is the evidence basis for later hardening/removal work.
