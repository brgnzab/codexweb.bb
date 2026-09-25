# CWC Personal — Outbound Network Surface Inventory

Baseline: upstream `Nolane-x/codexweb` v4.1.0 at `440bdfda86a9dda2e909b9f2e527433c0652fff7`.

CWC Personal source reviewed through `cwc-personal` commit `a0cd1592cf729c5afef8ac1c7122f009f85a9d4b`.

Purpose: map known network clients and endpoints before hardening/removal. CWC-005 is an inventory gate, not the final network-restriction gate. Runtime observation by independent Codex QA is required because Electron/Chromium and the prebuilt OpenAI tunnel client can make connections whose concrete remote hosts are not all visible as JavaScript URL literals.

## Classification

- **CORE OPENAI / CHATGPT** — required product traffic to ChatGPT/OpenAI services.
- **LOCALHOST / LOCAL IPC** — loopback HTTP/CDP/control or local pipe/socket traffic; not Internet egress.
- **CONDITIONAL INTERACTIVE AUTH** — third-party identity provider traffic only when the user chooses/signs in through that provider; not an app-owned background API client.
- **USER-INITIATED NAVIGATION** — external browser link opened explicitly by the user; not automatic runtime egress.
- **REMOVABLE APP TRAFFIC** — active or inherited app-owned Internet traffic not allowed in final CWC Personal.
- **BUILD / SUPPLY-CHAIN ONLY** — dependency/build/release tooling network, outside normal installed runtime; handled by supply-chain/release gates.
- **OPAQUE CORE CLIENT** — a required executable whose outbound service hosts are not encoded in repository JavaScript and therefore must be observed at runtime.
- **UNEXPLAINED** — observed/source traffic with no justified product role. No unexplained source-owned client was identified in this source pass; Codex runtime QA must fail the gate if it observes one.

## 1. Core ChatGPT / OpenAI traffic

| Client / code path | Endpoint / host | Trigger | Classification | CWC Personal action |
| --- | --- | --- | --- | --- |
| Electron browser host / Playwright browser surfaces (`launcher/electron/browser-host.cjs`, `src/chatgpt-session.ts`, browser adapter) | `https://chatgpt.com` | ChatGPT sign-in/session, Temporary Chat, managed Council conversations, model/turn automation | CORE OPENAI / CHATGPT | Preserve |
| Electron webRequest filter | `https://chatgpt.com/backend-api/*` | ChatGPT browser backend requests/challenge handling | CORE OPENAI / CHATGPT | Preserve; do not hardcode individual backend paths as a brittle final allowlist |
| Native Codex passthrough (`src/native-passthrough.ts`) | `https://chatgpt.com/backend-api/codex/models` | native model discovery | CORE OPENAI / CHATGPT, current compatibility | Preserve until later architecture proves removable |
| Native Codex passthrough | `https://chatgpt.com/backend-api/codex/responses` | native Responses passthrough | CORE OPENAI / CHATGPT, current compatibility | Preserve until later architecture proves removable |
| Native Codex passthrough | `https://chatgpt.com/backend-api/codex/responses/compact` | native compaction passthrough | CORE OPENAI / CHATGPT, current compatibility | Preserve until later architecture proves removable |
| Native Codex passthrough | `https://chatgpt.com/backend-api/codex/alpha/search` | native search passthrough | CORE OPENAI / CHATGPT, current compatibility | Preserve until later architecture proves removable |
| OpenAI tunnel-client process | OpenAI Tunnel service endpoints, exact remote host(s) not present in JS source | Council Secure MCP Tunnel start/recovery | OPAQUE CORE CLIENT | Preserve capability; Codex must observe and map actual process egress. Replace runtime binary download, not the tunnel service itself. |

The product should not assume that every valid ChatGPT request will forever use one static subpath/host combination. Later hardening should constrain capabilities/client ownership rather than build an unnecessarily brittle URL list.

## 2. Localhost and local IPC

| Client / code path | Endpoint | Purpose | Classification |
| --- | --- | --- | --- |
| Responses runtime config/server | `127.0.0.1:17841` default | Responses-compatible local API + admin lifecycle | LOCALHOST / LOCAL IPC |
| Council HTTP server | `127.0.0.1:17842` default | public Council sync + trusted owner API | LOCALHOST / LOCAL IPC |
| Electron browser CDP | dynamic `127.0.0.1:<port>` | Playwright/Electron browser control | LOCALHOST / LOCAL IPC |
| Electron browser control server | dynamic `127.0.0.1:<port>` | authenticated launcher/browser lifecycle control | LOCALHOST / LOCAL IPC |
| setup health check | `http://127.0.0.1:<configured-port>/healthz` | local runtime readiness | LOCALHOST / LOCAL IPC |
| turn broker | Windows `\\.\pipe\codex-chatgpt-web-*` or local Unix socket | local broker/tool/turn IPC | LOCALHOST / LOCAL IPC |
| MCP stdio | process stdin/stdout | tunnel-client → local Council MCP process | LOCALHOST / LOCAL IPC |

Config constrains the Responses host type to literal `127.0.0.1`; the Council HTTP server also binds loopback. Dynamic CDP/control ports explicitly bind `127.0.0.1`.

## 3. Conditional interactive authentication

The Electron browser permits HTTPS navigation to a bounded set of identity-provider hosts during ChatGPT authentication:

- `auth.openai.com`
- `auth0.openai.com`
- `login.openai.com`
- `accounts.openai.com`
- `accounts.google.com`
- `login.microsoftonline.com`
- `appleid.apple.com`
- `idmsa.apple.com`

Classification: **CONDITIONAL INTERACTIVE AUTH**.

These are not direct background API clients in application code. Google/Microsoft/Apple hosts should appear only if the user chooses the associated sign-in method or the ChatGPT authentication flow redirects there. A normal steady-state already-authenticated Council run should not require the application itself to initiate arbitrary traffic to these providers.

Codex QA should distinguish authentication-browser navigation from background application egress.

## 4. User-initiated external links

`main-council.cjs` permits explicit `shell.openExternal` navigation to a small UI set:

- `https://github.com/Nolane-x/codexweb`
- `https://chatgpt.com/#settings/Plugins`
- `https://platform.openai.com/settings/organization/tunnels`
- `https://platform.openai.com/settings/organization/api-keys`

Classification: **USER-INITIATED NAVIGATION**.

These links are not automatic network clients. The ChatGPT/Platform OpenAI destinations are product setup/navigation conveniences. The GitHub project link is not core runtime traffic and may be removed/repointed as product branding/distribution is finalized.

## 5. Active removable Internet traffic

### 5.1 Council self-updater — REMOVABLE APP TRAFFIC

Active path:

`main-council.cjs -> createUpdateController(...) -> void updateController.checkOnce()` on normal launcher startup.

Known endpoints/client behavior in `launcher/electron/council-update.cjs`:

- `https://api.github.com/repos/Nolane-x/codexweb/releases/latest`
- release asset URLs constrained to `https://github.com/Nolane-x/codexweb/releases/download/v<version>/...`
- `checksums.txt` from the same GitHub release
- HTTPS redirect following for those downloads
- downloaded release executable/archive is checksum-verified and later handed to a detached update worker.

Classification: **REMOVABLE APP TRAFFIC**.

Final CWC Personal requires no self-updater/automatic release checking/remote code replacement. Remove the startup check, updater HTTP client, asset download, update worker, prompt/IPC/state, and associated tests together; do not merely hide the UI.

### 5.2 Automatic OpenAI tunnel-client download — REMOVABLE APP TRAFFIC around a core capability

`src/council/setup.ts` currently calls `installTunnelClient()` from `src/tunnel.ts` on first/replacement setup.

Known download endpoints:

- base: `https://github.com/openai/tunnel-client/releases/download/v0.0.10`
- platform ZIP: `tunnel-client-v0.0.10-<os>-<arch>.zip`
- `SHA256SUMS.txt`

The downloader follows redirects, limits payloads to 100 MiB, verifies the archive SHA-256, extracts the expected executable, verifies `--version`, stores its binary hash, then executes the downloaded tunnel client.

Classification of the **download/install client**: **REMOVABLE APP TRAFFIC**.

Classification of the **resulting tunnel process connection to OpenAI**: **OPAQUE CORE CLIENT**.

Final design must preserve Secure MCP Tunnel functionality without automatic remote executable acquisition—for example by packaging/requiring a reviewed local pinned binary and verifying it before use.

## 6. Inherited / detached removable network paths

### Old updater

`launcher/electron/update.cjs` targets the older `miuuyy/codex-chatgpt-web` release API/assets. CWC-004 proved old `main.cjs` is detached from the packaged Council entry point.

Classification: **REMOVABLE APP TRAFFIC / detached legacy**.

Delete with old launcher/updater cleanup.

### Standalone Windows latest-release installer

`scripts/install-launcher.ps1`:

- resolves GitHub `releases/latest` unless a version is supplied;
- downloads the Windows NSIS executable and `checksums.txt` from GitHub;
- hash-verifies the executable;
- silently executes the installer and launches the installed application.

Classification: **REMOVABLE distribution traffic**.

The final product is portable folder/ZIP, so this remote installer path conflicts with the portable/no-auto-acquisition target.

### Unix/cross-platform install scripts and non-Windows release paths

Standalone install/release scripts and explicit macOS/Linux distribution jobs may resolve/download GitHub release assets or package dependencies. CWC-004 classified these distribution paths removable for Windows-only CWC Personal.

Classification: **REMOVABLE distribution traffic**.

## 7. Build / supply-chain network

Bun dependency installation and build/release tooling can contact configured package registries or GitHub during developer/CI setup. This is not installed-product runtime traffic.

Classification: **BUILD / SUPPLY-CHAIN ONLY**.

The later dependency/build-integrity gate owns frozen installs, lifecycle-script review, exact versions, advisories and download/execution investigation. Do not confuse build-time registry traffic with normal CWC runtime egress.

## 8. Network-capable mechanisms without independent Internet destination

These mechanisms are network-capable but their current use is local or delegated:

- Node/Bun `fetch` / `http` / `https` in server/setup/update/tunnel modules;
- Playwright/Electron Chromium networking inside controlled ChatGPT surfaces;
- `shell.openExternal` for explicit UI navigation;
- spawned `tunnel-client` process;
- local `net` servers for free-port discovery/control;
- named pipe / Unix socket broker.

Hardening should reason about which component owns the capability and which destination class it serves, not merely grep for networking APIs.

## 9. No source-identified telemetry/unexplained client

This source inventory did **not** identify an application telemetry/analytics/crash-report upload client or another unexplained product-owned Internet endpoint in the reviewed active paths.

This is not yet a runtime proof. Electron/Chromium, auth redirects, dependencies and the prebuilt tunnel executable may resolve/connect to hosts not represented by string literals in this repository. Independent CWC-005 Codex QA must capture process-associated runtime connections and reconcile every observed external endpoint with this inventory.

Any external endpoint observed during the defined runtime scenarios that cannot be classified as:

1. ChatGPT/OpenAI core traffic;
2. conditional user authentication;
3. current known removable GitHub updater/tunnel-download traffic;
4. explicit user-opened navigation; or
5. build/supply-chain activity outside installed runtime

must be reported as **UNEXPLAINED** and fails CWC-005 until mapped.

## 10. Expected runtime scenarios for independent verification

Codex QA should independently observe at least these scenarios on Windows:

1. **Launcher startup with an existing authenticated session** — expect ChatGPT session/browser traffic, loopback control, and currently an automatic GitHub release-check attempt because `checkOnce()` is still active before CWC-006 removal.
2. **Idle steady-state after startup** — expect no periodic arbitrary third-party application API traffic; ChatGPT/browser background requests may continue.
3. **Council runtime/tunnel start** — expect the pinned tunnel-client process to connect to OpenAI-managed infrastructure; map remote host/IP/process evidence if tooling exposes it.
4. **Council managed browser action / real ChatGPT turn** — expect ChatGPT/OpenAI browser traffic plus localhost/CDP/control IPC.
5. **First/replacement tunnel setup only** — current source can contact GitHub `openai/tunnel-client` release URLs to obtain the executable; this is known removable traffic.
6. **Authentication only if intentionally tested** — Google/Microsoft/Apple identity hosts are conditional browser authentication, not steady-state background clients.

Package-manager/build traffic should be captured separately from installed-runtime traffic.

## 11. CWC-005 conclusion

Known source-owned network clients/endpoints are mapped as follows:

- **Core:** ChatGPT/OpenAI browser/backend traffic and the OpenAI Secure MCP Tunnel service.
- **Local:** loopback Responses/Council/CDP/control endpoints and local pipe/socket/stdio IPC.
- **Conditional:** bounded browser authentication providers selected by the user.
- **Removable:** active GitHub Council updater, automatic GitHub tunnel-client acquisition, old updater, standalone release installers and non-Windows distribution traffic.
- **Build-only:** dependency/release acquisition outside installed runtime.
- **Unexplained in source:** none identified.
- **Runtime-opaque:** concrete remote hosts used internally by the pinned OpenAI tunnel-client; independent process/network observation is required.

No removal was performed in CWC-005. CWC-006 and later hardening work will remove the known unwanted clients while preserving required ChatGPT/OpenAI and localhost behavior.
