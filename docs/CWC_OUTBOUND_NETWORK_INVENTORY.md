# CWC Personal — Outbound Network Surface Inventory

Baseline: upstream `Nolane-x/codexweb` v4.1.0 at `440bdfda86a9dda2e909b9f2e527433c0652fff7`.

CWC Personal source inventory was created at `b3b9f5401b1bd889a793d09e71a4968b93212f0d` and corrected from independent Codex runtime evidence at the same tested revision.

Purpose: map known network clients and endpoints before hardening/removal. CWC-005 is an **inventory gate**, not the final network-restriction gate. Its tracker acceptance criterion explicitly allows known traffic to be classified as core OpenAI/ChatGPT, localhost/local IPC, removable, or unexplained. Unexplained observations must be recorded rather than guessed; later hardening/final network gates own their removal or conclusive attribution.

## Classification

- **CORE OPENAI / CHATGPT** — required product traffic to ChatGPT/OpenAI services.
- **LOCALHOST / LOCAL IPC** — loopback HTTP/CDP/control/dev-server or local pipe/socket/stdio traffic; not Internet egress.
- **CONDITIONAL INTERACTIVE AUTH** — identity-provider traffic used by the ChatGPT authentication surface, including provider resources that can load before a provider is explicitly selected.
- **USER-INITIATED NAVIGATION** — external browser links opened explicitly by the user; not automatic runtime egress.
- **REMOVABLE APP TRAFFIC** — active/inherited app-owned Internet traffic that conflicts with final CWC Personal requirements.
- **BUILD / SUPPLY-CHAIN ONLY** — dependency/build/release tooling traffic outside normal installed runtime.
- **OPAQUE CORE CLIENT** — required executable whose concrete service hosts are not encoded in repository JavaScript and therefore require runtime process observation.
- **UNEXPLAINED** — observed product-owned traffic whose hostname/purpose cannot yet be established reliably. CWC-005 may inventory such traffic; it must be resolved, eliminated, or explicitly allowed by the later hardening/final network gate.

## 1. Core ChatGPT / OpenAI traffic

| Client / code path | Endpoint / host | Trigger | Classification | Disposition |
| --- | --- | --- | --- | --- |
| Electron browser host / Playwright browser surfaces (`launcher/electron/browser-host.cjs`, `src/chatgpt-session.ts`, browser adapter) | `https://chatgpt.com` | ChatGPT session, Temporary Chat, managed Council conversations, model/turn automation | CORE OPENAI / CHATGPT | Preserve |
| Electron webRequest filter | `https://chatgpt.com/backend-api/*` | ChatGPT browser backend requests/challenge handling | CORE OPENAI / CHATGPT | Preserve; avoid brittle per-path final allowlist |
| Native Codex passthrough (`src/native-passthrough.ts`) | `https://chatgpt.com/backend-api/codex/models` | model discovery | CORE OPENAI / CHATGPT, current compatibility | Preserve until later architecture proves removable |
| Native Codex passthrough | `https://chatgpt.com/backend-api/codex/responses` | Responses passthrough | CORE OPENAI / CHATGPT, current compatibility | Preserve until later architecture proves removable |
| Native Codex passthrough | `https://chatgpt.com/backend-api/codex/responses/compact` | compaction passthrough | CORE OPENAI / CHATGPT, current compatibility | Preserve until later architecture proves removable |
| Native Codex passthrough | `https://chatgpt.com/backend-api/codex/alpha/search` | native search passthrough | CORE OPENAI / CHATGPT, current compatibility | Preserve until later architecture proves removable |
| OpenAI `tunnel-client` process | concrete service hosts not encoded in JS source | Council Secure MCP Tunnel start/recovery | OPAQUE CORE CLIENT | Preserve capability; later runtime test must identify/justify process egress |

## 2. Localhost and local IPC

| Client / code path | Endpoint | Purpose | Classification |
| --- | --- | --- | --- |
| Responses runtime | `127.0.0.1:17841` default | Responses-compatible local API + admin lifecycle | LOCALHOST / LOCAL IPC |
| Council HTTP server | `127.0.0.1:17842` default | public Council sync + trusted owner API | LOCALHOST / LOCAL IPC |
| Electron browser CDP | dynamic `127.0.0.1:<port>` | Playwright/Electron browser control | LOCALHOST / LOCAL IPC |
| Electron browser control server | dynamic `127.0.0.1:<port>` | authenticated launcher/browser lifecycle control | LOCALHOST / LOCAL IPC |
| Source-development Vite server (`launcher/scripts/dev.cjs`) | `127.0.0.1:4178` | renderer development server used by `scripts/start-launcher.ts` | LOCALHOST / LOCAL IPC; dev-only |
| setup health check | `http://127.0.0.1:<configured-port>/healthz` | local runtime readiness | LOCALHOST / LOCAL IPC |
| turn broker | Windows `\\.\pipe\codex-chatgpt-web-*` or local Unix socket | local broker/tool/turn IPC | LOCALHOST / LOCAL IPC |
| MCP stdio | process stdin/stdout | tunnel-client → local Council MCP process | LOCALHOST / LOCAL IPC |

Independent Codex observation at revision `b3b9f5401b1bd889a793d09e71a4968b93212f0d` confirmed dev Vite, dynamic CDP and browser-control listeners were loopback-only and found no CWC listener on `0.0.0.0` or `::`.

## 3. Conditional authentication traffic

The Electron ChatGPT browser allows a bounded authentication set:

- `auth.openai.com`
- `auth0.openai.com`
- `login.openai.com`
- `accounts.openai.com`
- `accounts.google.com`
- `login.microsoftonline.com`
- `appleid.apple.com`
- `idmsa.apple.com`

Classification: **CONDITIONAL INTERACTIVE AUTH**.

This does not mean provider traffic appears only after the user clicks a provider. Independent QA observed the unauthenticated ChatGPT landing page load `accounts.google.com` Script/Stylesheet resources before any provider was selected. Such resources belong to the authentication surface, not an independently implemented CWC background API client.

## 4. User-initiated external links

`main-council.cjs` permits explicit `shell.openExternal` navigation to:

- `https://github.com/Nolane-x/codexweb`
- `https://chatgpt.com/#settings/Plugins`
- `https://platform.openai.com/settings/organization/tunnels`
- `https://platform.openai.com/settings/organization/api-keys`

Classification: **USER-INITIATED NAVIGATION**.

## 5. Known removable runtime Internet traffic

### 5.1 Council self-updater

Production packaged path:

`main-council.cjs -> createUpdateController(...) -> updateController.checkOnce()`.

`launcher/electron/council-update.cjs` creates an enabled updater only when the app is packaged and the current platform/architecture has a supported release asset. Therefore:

- **packaged supported startup:** automatic release check is active;
- **source-development startup via `scripts/start-launcher.ts`:** `app.isPackaged === false`, updater controller is disabled and `checkOnce()` performs no GitHub request.

Known packaged endpoints:

- `https://api.github.com/repos/Nolane-x/codexweb/releases/latest`
- constrained `https://github.com/Nolane-x/codexweb/releases/download/v<version>/...` release asset
- `checksums.txt` from the same release

Classification: **REMOVABLE APP TRAFFIC**.

CWC-006 owns removal of release polling, downloads, update worker/deferred replacement and related UI/IPC/tests.

### 5.2 Automatic OpenAI tunnel-client acquisition

`src/council/setup.ts` currently calls `installTunnelClient()` from `src/tunnel.ts` for first/replacement setup.

Pinned release base:

`https://github.com/openai/tunnel-client/releases/download/v0.0.10`

Current setup can download:

- `tunnel-client-v0.0.10-<os>-<arch>.zip`
- `SHA256SUMS.txt`

The downloader verifies the archive checksum, extracts the expected executable, verifies `--version`, records the binary hash, and executes the binary.

Classification of download/install client: **REMOVABLE APP TRAFFIC**.

Classification of the resulting tunnel process: **OPAQUE CORE CLIENT**.

CWC-006 must remove automatic remote executable acquisition without removing required Secure MCP Tunnel functionality.

## 6. Inherited / detached removable paths

- `launcher/electron/update.cjs` targets old `miuuyy/codex-chatgpt-web` releases and is detached from the packaged Council entry point. Classification: **REMOVABLE APP TRAFFIC / detached legacy**.
- `scripts/install-launcher.ps1` resolves/downloads GitHub release installer assets and executes the installer. Classification: **REMOVABLE DISTRIBUTION TRAFFIC**.
- standalone Unix/cross-platform install/release paths can resolve/download release assets; CWC Personal is Windows-only portable-first. Classification: **REMOVABLE DISTRIBUTION TRAFFIC**.

## 7. Build / supply-chain traffic

Bun dependency installation and Electron/electron-builder tooling may contact configured registries or upstream release infrastructure during development/CI/build. This is not normal installed-product runtime traffic.

Classification: **BUILD / SUPPLY-CHAIN ONLY**.

## 8. Runtime observations from independent Codex QA

Codex tested source revision `b3b9f5401b1bd889a793d09e71a4968b93212f0d` with an isolated CWC data/core-home profile.

Observed product-owned external peers:

| Process/component | Observed peer | Scenario | Evidence/classification |
| --- | --- | --- | --- |
| Electron/Chromium | `104.18.32.47:443` | startup | resolver cache + ChatGPT page target → CORE OPENAI / CHATGPT |
| Electron/Chromium | `108.177.97.84:443` | startup | temporally correlated with captured `accounts.google.com` Script/Stylesheet resources → CONDITIONAL INTERACTIVE AUTH |
| Electron/Chromium | `172.217.27.110:443` (`sin11s04-in-f110.1e100.net` reverse DNS) | startup only | Google-owned infrastructure, but requested hostname/purpose not established → UNEXPLAINED |
| Electron/Chromium | `35.190.80.1:443` (`1.80.190.35.bc.googleusercontent.com` reverse DNS) | startup and idle | Google-owned infrastructure, but requested hostname/purpose not established → UNEXPLAINED |

The two Google-owned IPs above are deliberately **not** promoted to authentication, telemetry, or core traffic based only on reverse DNS. They remain inventory items requiring later attribution or elimination.

No explicit Sentry, PostHog, Segment, Mixpanel, Amplitude, Datadog, or crash-upload client was found in the reviewed source. This is source evidence only, not a claim that the two unexplained browser connections are harmless.

The QA run could not exercise an existing tunnel-client or authenticated managed ChatGPT turn because the isolated profile had no pre-existing Council config/tunnel binary/authenticated CWC session. Those are runtime-coverage limitations, not source-inventory omissions.

## 9. Network-capable mechanisms without an independent destination class

Current mechanisms include:

- Node/Bun `fetch` / HTTP(S) in setup/update/tunnel/server modules;
- Chromium networking inside controlled ChatGPT/authentication surfaces;
- `shell.openExternal` for explicit UI navigation;
- spawned `tunnel-client` process;
- local `net` servers;
- named pipe / Unix socket broker;
- stdio MCP transport.

Hardening should reason about component ownership and destination class, not merely grep networking APIs.

## 10. CWC-005 acceptance interpretation

Tracker acceptance criterion:

> Known endpoints/clients are mapped to core OpenAI/ChatGPT, localhost, or removable/unexplained traffic.

Accordingly, CWC-005 does **not** require the `UNEXPLAINED` class to be empty. It requires observed/source network surfaces to be explicitly inventoried rather than omitted or guessed.

The two observed Google IP peers are now explicitly classified **UNEXPLAINED**. Later hardening/final portable network verification must determine whether they are legitimate Chromium/ChatGPT/authentication infrastructure, eliminate them through browser/runtime hardening, or otherwise justify their retention.

## 11. Expected later verification boundaries

- **CWC-006:** remove self-updater, release polling, update worker and automatic remote code/package acquisition.
- Later networking/hardening work: remove remaining unnecessary external clients and investigate the unexplained Electron-owned Google peers.
- Final portable network test: verify the shipped Windows portable product exposes only intended ChatGPT/OpenAI traffic plus localhost/local IPC, with no unresolved unwanted third-party egress.

## 12. CWC-005 conclusion

Known network surface is now mapped as:

- **Core:** ChatGPT/OpenAI browser/backend traffic and required OpenAI Secure MCP Tunnel service.
- **Local:** Responses/Council/CDP/control/Vite-dev endpoints plus pipe/socket/stdio IPC.
- **Conditional auth:** bounded OpenAI/Google/Microsoft/Apple authentication surface, including passive provider UI resources.
- **Removable:** packaged GitHub Council updater, automatic GitHub tunnel-client acquisition, detached old updater and standalone/non-Windows distribution paths.
- **Build-only:** dependency/release acquisition outside installed runtime.
- **Opaque core:** concrete service hosts used by the pinned OpenAI tunnel-client.
- **Unexplained runtime observations:** `172.217.27.110:443` and `35.190.80.1:443`, Electron-owned Google infrastructure not yet conclusively attributed.

No network-capable production source was removed in CWC-005.