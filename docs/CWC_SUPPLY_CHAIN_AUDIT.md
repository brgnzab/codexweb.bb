# CWC Personal supply-chain audit

Tracker acceptance for CWC-012:

> Frozen install path defined; pre/install/postinstall hooks inspected; dependency audit run; exact build toolchain recorded; no unexplained install-time code/downloads.

This document defines the reproducible GPT Web implementation side of that gate. Independent Windows execution and final acceptance belong to Codex QA.

## 1. Locked install path

CWC Personal has two Bun workspaces with committed lockfiles:

- root: `package.json` + `bun.lock`
- launcher: `launcher/package.json` + `launcher/bun.lock`

Required clean install commands:

```powershell
bun install --frozen-lockfile
Push-Location launcher
bun install --frozen-lockfile
Pop-Location
```

The install is invalid for this gate if either lockfile changes. Do not run `bun update`, unconstrained `bun add`, or regenerate a lockfile during CWC-012.

CI uses the same two `bun install --frozen-lockfile` commands before verification/package work.

## 2. Exact build toolchain recorded from manifests + lockfiles

Target product platform: **Windows 11 x64**.

| Component | Exact version / contract | Authority |
| --- | --- | --- |
| Bun package manager/runtime | `1.3.14` | root `packageManager`, root `engines`, CI setup |
| Node.js | `22.23.2` | root `engines`; CI/release `actions/setup-node@v6` pin |
| TypeScript | `5.9.3` | root + launcher manifests/locks |
| Electron | `41.7.1` | launcher manifest + launcher lock |
| electron-builder | `26.15.3` | launcher lock (manifest requests `^26.8.1`) |
| Vite | `6.4.3` | launcher lock (manifest requests `^6.0.0`) |
| esbuild | `0.25.12` | launcher lock, via Vite |
| Playwright Core | `1.62.0` | root manifest + root lock |
| MCP SDK | `1.30.0` | root lock |
| Windows packaged runtime | baseline Bun `1.3.14` prepared by `scripts/prepare-windows-baseline-bun.ps1` | CI/release build contract |

Before audit/build execution, verify the host toolchain:

```powershell
bun --version
node --version
```

Expected values are exactly `1.3.14` and `v22.23.2`.

CWC-012 does not update these versions merely to make an audit report cleaner. A dependency upgrade is required only when an advisory is materially reachable and cannot be adequately mitigated by the current application boundary.

## 3. Workspace lifecycle hooks

Neither CWC Personal workspace declares its own `preinstall`, `install`, or `postinstall` script.

Transitive package lifecycle hooks must be inspected from the **installed exact lockfile tree**, because Bun lock entries record dependency resolution/integrity but do not by themselves prove the lifecycle scripts contained in each installed package manifest.

After both frozen installs, run:

```powershell
bun run scripts/audit-install-hooks.ts > .cwc-data\qa-supply-chain\install-hooks.json
bun pm untrusted > .cwc-data\qa-supply-chain\root-untrusted.txt
Push-Location launcher
bun pm untrusted > ..\.cwc-data\qa-supply-chain\launcher-untrusted.txt
Pop-Location
```

`scripts/audit-install-hooks.ts` enumerates every installed package that declares `preinstall`, `install`, or `postinstall`, with package name, exact installed version, path and script text.

For every finding, Codex must classify it as:

- **REQUIRED + EXPLAINED** — necessary for this frozen Windows build and behavior understood;
- **PRESENT BUT BLOCKED** — Bun did not execute it and the build does not require it;
- **UNEXPLAINED** — purpose/side effect cannot be established. Any UNEXPLAINED finding fails CWC-012.

Packages that bootstrap platform binaries (for example Electron/esbuild if their installed manifests declare a lifecycle hook) are not automatically trusted. Record the exact hook, what executable/script it runs, whether it makes a network request, the destination/source if known, and why that acquisition is required for the frozen Windows build.

## 4. Install-time downloads: allowed versus prohibited

Expected package-manager activity during a cold install is Bun acquiring packages named by the committed lockfiles from the configured package registry/cache. That is dependency installation, not an application self-update mechanism.

Any dependency lifecycle process that performs a second-stage download must be identified and explained. It is acceptable only when it belongs to the exact frozen build toolchain, is version-bound, and is required to produce/run the Windows build. Unknown URLs, arbitrary code fetches, latest-version resolution, or mutable remote-code acquisition fail this gate.

Application-controlled runtime acquisition remains prohibited:

- launcher self-updater/release polling/update worker: removed by CWC-006;
- automatic `tunnel-client` acquisition: removed by CWC-006; fresh Tunnel setup requires an explicitly selected local reviewed binary;
- arbitrary Electron browser downloads: blocked by CWC-008;
- retired standalone installer/download paths: removed by CWC-009/CWC-010.

## 5. Dependency audit

Run both audits against the exact frozen tree:

```powershell
bun audit > .cwc-data\qa-supply-chain\root-audit.txt
Push-Location launcher
bun audit > ..\.cwc-data\qa-supply-chain\launcher-audit.txt
Pop-Location
```

Do not reuse an advisory count from an older CWC revision. Record every advisory returned at the tested HEAD, its GHSA/CVE identifier, severity, affected package/version, dependency path, whether it is direct/transitive, and whether it is reachable/material to CWC Personal. Do not update dependencies inside this gate merely to make the report cleaner; a material advisory that blocks acceptance must be returned to GPT Web as a finding.

### Electron reachability review

Electron is a direct runtime dependency and therefore its advisories require application-specific reachability review rather than a blanket "build-only" classification.

For popup/window-sandbox advisories, verify the exact advisory's documented affected versions and workaround against the **production entrypoint** `launcher/electron/main-hardened.cjs`, not merely the inherited base browser-host source. Current CWC boundaries that must be checked include:

- the local main renderer is sandboxed with `contextIsolation: true`, `nodeIntegration: false`, and installs `setWindowOpenHandler` that denies child-window creation;
- managed ChatGPT turn tabs are sandboxed and their `setWindowOpenHandler` always returns `deny` after either blocking authentication or forwarding ordinary HTTP(S) links externally;
- the production ChatGPT home surface overrides the inherited popup handler before `main-council.cjs` starts and returns `deny` for **every** window-open request, including authentication requests;
- an allowlisted authentication request is redirected into a fresh launcher-owned `WebContentsView` with the same persistent ChatGPT partition, `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`; popup-provided `options.webContents` is not reused;
- authentication navigation is restricted to the explicit identity-provider allowlist plus the HTTPS `chatgpt.com/api/auth/` callback path;
- the authentication surface installs its own `setWindowOpenHandler`; nested authentication requests are navigated in that same controlled surface and child-window creation still returns `deny`.

Codex must report the exact Electron GHSA IDs returned by `bun audit`. For `GHSA-9f4c-93c8-jc8g` and `GHSA-hq2x-r82h-9wj4`, independently verify that the production wrapper actually satisfies the upstream deny/constrain workaround at runtime. Do not accept the mitigation merely because a static test says so. If either direct High advisory remains materially reachable, or another direct High/Critical Electron advisory has no applicable app-side workaround, CWC-012 fails and Electron must be upgraded to a patched release; the previous QA identified `41.10.4` as the minimum version covering both known High popup advisories.

## 6. Lockfile and build integrity checks

Before and after frozen installation/testing:

```powershell
git status --short
git diff -- bun.lock launcher/bun.lock
Get-FileHash bun.lock -Algorithm SHA256
Get-FileHash launcher\bun.lock -Algorithm SHA256
```

The two lockfiles must remain byte-for-byte unchanged.

Then execute the declared verification path:

```powershell
bun run check-version
bun run typecheck
bun run test
bun run launcher:typecheck
bun run launcher:test
bun run launcher:build
bun run verify
```

On the Windows gate host, also run the current package path when practical:

```powershell
bun run app:package
bun run app:smoke
```

## 7. CWC-012 PASS rule

CWC-012 may PASS only when independent Codex QA demonstrates all of the following at the exact requested HEAD:

1. both installs succeed with `--frozen-lockfile` and neither lockfile changes;
2. every installed lifecycle hook is enumerated and classified with no UNEXPLAINED hook;
3. any lifecycle-driven download is version-bound, required and explained; no arbitrary/latest remote-code acquisition is observed;
4. root and launcher `bun audit` results are captured and materially assessed, including exact Electron advisory IDs and reachability;
5. exact build toolchain versions, including Node `22.23.2`, match this document and the committed workflow/manifest/locks;
6. verification/build tests pass, or any failure is returned as a concrete CWC-012 defect rather than ignored;
7. the current Windows package is produced and its packaged smoke passes before the gate closes.

This document is an audit specification and source evidence. It is not a substitute for the Codex Windows execution required by the tracker.
