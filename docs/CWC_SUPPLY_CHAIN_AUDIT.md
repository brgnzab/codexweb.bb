# CWC Personal supply-chain audit

Tracker acceptance for CWC-012:

> Frozen install path defined; pre/install/postinstall hooks inspected; dependency audit run; exact build toolchain recorded; no unexplained install-time code/downloads.

This document defines the reproducible supply-chain contract for CWC Personal. Independent Windows execution and final gate acceptance belong to Codex QA.

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

The install is invalid if either lockfile changes during a frozen install. Do not run unconstrained dependency updates during QA.

CI uses the same two frozen installs before verification/package work.

## 2. Exact Windows build toolchain

Target product platform: **Windows 11 x64**.

| Component | Exact version / contract | Authority |
| --- | --- | --- |
| Bun package manager/runtime | `1.3.14` | root `packageManager`, root `engines`, CI setup |
| Node.js | `22.23.2` | root `engines`; CI/release setup pin |
| TypeScript | `5.9.3` | root + launcher manifests/locks |
| Electron | `41.10.7` | launcher manifest + launcher lock |
| electron-builder | `26.15.3` | launcher lock (manifest requests `^26.8.1`) |
| Vite | `6.4.3` | launcher lock |
| esbuild | `0.25.12` | launcher lock, via Vite |
| Playwright Core | `1.62.0` | root manifest + root lock |
| MCP SDK | `1.30.0` | root lock |
| Windows packaged runtime | baseline Bun `1.3.14` prepared by `scripts/prepare-windows-baseline-bun.ps1` | CI/release build contract |

Host checks:

```powershell
bun --version
node --version
```

Expected values are exactly `1.3.14` and `v22.23.2`.

### CWC-014 security refresh

On 2026-09-26, CWC-014 independent QA exposed current advisories after the original CWC-012 toolchain freeze. The security repair intentionally kept the existing major toolchain and changed only the minimum audited dependency surfaces:

- Electron `41.7.1` -> `41.10.7` on the same 41.x line. This also replaces Electron's legacy `extract-zip` dependency with the hardened `@electron-internal/extract-zip` dependency in the resolved tree.
- Root security resolutions: `fast-uri 3.1.8`, `hono 4.13.7`, `qs 6.16.0`.
- Launcher security resolutions are **version-scoped to vulnerable ranges** so unrelated newer major lines are not downgraded:
  - `@xmldom/xmldom@<=0.8.14` -> `0.8.15`
  - `brace-expansion@<1.1.18` -> `1.1.18`
  - `fast-uri@<3.1.8` -> `3.1.8`
  - `js-yaml@>=4.0.0 <4.3.2` -> `4.3.2`
  - `nanoid@<3.3.18` -> `3.3.18`

Any future change to these pins requires a regenerated committed lockfile plus fresh root and launcher audits, verification, Windows package, and packaged smoke evidence.

## 3. Workspace lifecycle hooks

Neither CWC Personal workspace declares its own `preinstall`, `install`, or `postinstall` script.

Transitive package lifecycle hooks must be inspected from the installed exact lockfile tree. After both frozen installs, run:

```powershell
bun run scripts/audit-install-hooks.ts > .cwc-data\qa-supply-chain\install-hooks.json
bun pm untrusted > .cwc-data\qa-supply-chain\root-untrusted.txt
Push-Location launcher
bun pm untrusted > ..\.cwc-data\qa-supply-chain\launcher-untrusted.txt
Pop-Location
```

Classify every lifecycle finding as:

- **REQUIRED + EXPLAINED** — necessary for the frozen Windows build and behavior understood;
- **PRESENT BUT BLOCKED** — Bun did not execute it and the build does not require it;
- **UNEXPLAINED** — purpose/side effect cannot be established. Any UNEXPLAINED finding fails the supply-chain gate.

Packages that bootstrap platform binaries are not automatically trusted. Record the exact hook, what it runs, any network request, and why the acquisition is required.

## 4. Install-time downloads

Expected cold-install package-manager activity is limited to packages and exact resolutions represented by the committed lockfiles plus documented build-tool bootstrap behavior.

Any lifecycle process that performs a second-stage download must be version-bound, required and explained. Unknown URLs, latest-version acquisition, or arbitrary remote-code acquisition fail the gate.

Application-controlled runtime acquisition remains prohibited:

- launcher self-updater/release polling/update worker: removed by CWC-006;
- automatic `tunnel-client` acquisition: removed by CWC-006;
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

Do not reuse an advisory count from an older revision. Record every advisory returned at the tested HEAD. A new material High/Critical runtime advisory, or an unresolved audit result required by the active gate, must be returned as a finding rather than ignored.

Electron is a direct runtime dependency. Its security review must use the production entrypoint and current sandbox/context-isolation/window-open boundaries rather than assuming build-only exposure.

Current production boundaries include:

- local main renderer: `contextIsolation: true`, `nodeIntegration: false`, sandboxed, child windows denied;
- managed ChatGPT turn surfaces: sandboxed and child windows denied;
- production ChatGPT home surface: popup creation denied; permitted authentication is redirected into a fresh launcher-owned sandboxed surface;
- authentication navigation: constrained to the explicit identity-provider allowlist plus the HTTPS ChatGPT auth callback path;
- owner/control credentials remain in the main process and are not exposed to the renderer.

## 6. Lockfile and build integrity

Before and after frozen installation/testing:

```powershell
git status --short
git diff -- bun.lock launcher/bun.lock
Get-FileHash bun.lock -Algorithm SHA256
Get-FileHash launcher\bun.lock -Algorithm SHA256
```

Frozen installation must leave both lockfiles byte-for-byte unchanged.

Verification path:

```powershell
bun run check-version
bun run typecheck
bun run test
bun run launcher:typecheck
bun run launcher:test
bun run launcher:build
bun run verify
```

Windows package gate:

```powershell
bun run app:package
bun run app:smoke
```

## 7. PASS rule

The supply-chain contract passes only when independent QA demonstrates all of the following at the exact requested HEAD:

1. both installs succeed with `--frozen-lockfile` and neither lockfile changes;
2. installed lifecycle hooks are enumerated and have no UNEXPLAINED hook;
3. lifecycle-driven downloads are version-bound, required and explained;
4. root and launcher audits are captured and materially assessed;
5. exact toolchain versions match this document and committed manifests/locks;
6. verification/build tests pass, or any failure is returned as a concrete defect;
7. the Windows package is produced and its packaged smoke passes.

This document is source evidence and an audit specification. It is not a substitute for independent Codex Windows execution.
