# CWC Personal network and security DEV repair

Base: `a632392b968ee1e36b46162910dd06578eeafc3e`, branch `cwc-personal`.
The candidate is the commit containing this report; the delivery handoff records its exact SHA and independently verified remote SHA.

This is implementation and focused developer validation. It is **not an independent QA result or an N&S PASS**. No packaging, portable verification, release, merge, tag, or tracker update was performed.

## Finding disposition

| Finding | DEV status | Implementation |
| --- | --- | --- |
| NS-01 | FIXED | Chromium's raw remote-debugging listener is removed. A bearer-authenticated, exact-host, surface-scoped facade uses Electron's internal WebContents debugger. Launcher and authentication/identity-provider surfaces are excluded. Browser-wide commands and cookie commands are denied. Privileged IPC validates the expected renderer and its main frame. |
| NS-02 | FIXED | Windows native DACL protection removes inheritance and broad grants, allows only the current owning user and SYSTEM, and protects existing profile/config/state descendants before initialization. Sensitive path ancestors and recursive descendants reject links/junctions. Descriptors are verified before reading. No retained owner profile was reset. |
| NS-03 | FIXED | Sensitive Council state/snapshot/sync reads require the owner bearer and exact native Host. Browser Origins, including null and arbitrary loopback origins, are rejected. The native launcher sync client supplies the owner capability. |
| NS-04 | FIXED | Compatible locked resolutions: ip-address 10.7.1, affected brace-expansion 1.x entries 1.1.21, and affected undici 6.x entries 6.28.1. Unaffected major lines remain unchanged. The transport uses ws 8.21.0. Both frozen installs and dependency audits passed. |
| NS-05 | FIXED | Diagnostic URLs omit query, fragment and credentials. OAuth diagnostic events use origin/error code. Serialized JSON is recursively sanitized; embedded serialized payloads are suppressed. Persisted OAuth/token/session canaries are covered. Relay content/history is outside diagnostic sanitization. |
| NS-06 | FIXED | Schema-2 manifests inventory and hash every runtime file, including executables, helpers and dependencies. Verification recomputes the exact inventory and hashes. A separate application/ASAR reference anchors the manifest hash; copied roots receive private ACLs. Installation and execution fail closed on invalid content. Helper executable/script hashes are checked immediately before spawning. |
| NS-07 | FIXED | Production renderer uses a constrained cwc-app custom protocol with response-header CSP and frame-ancestors none. Development response headers use the exact configured Vite origin. Arbitrary loopback connect-src is removed; script/object/base restrictions remain. |
| NS-08 | FIXED | CI/release actions use reviewed immutable SHAs. Default workflow permissions are read-only; write scopes are job-specific. Publication requires manual dispatch, explicit approval and main. Frozen installs remain. |
| NS-09 | DEFERRED | MCP/Tunnel authorization redesign was explicitly excluded and was not changed. It is not required for GPT Web Relay. |

## Changed modules

- Browser transport and ownership: `launcher/electron/debugger-transport.cjs`, `main-council.cjs`, `browser-host.cjs`, `src/launcher-browser-host.ts`, both launcher helper clients.
- Sensitive storage: `launcher/electron/private-path.cjs` and its declarations, `atomic-file.cjs`, `council-owner-client.cjs`, logging storage, `src/config.ts`.
- Council read boundary: `src/council/http-server.ts`, `launcher/electron/council-connection-supervisor.cjs`.
- Diagnostics: `launcher/electron/logging.cjs`, `main-hardened.cjs`, fatal startup diagnostics in `main-council.cjs`.
- Runtime content: `launcher/electron/runtime-integrity.cjs` and declarations, `runtime-install.cjs`, `runtime-command.cjs`, `launcher/scripts/prepare-runtime.cjs`, `scripts/build-runtime-bundle.ts`, schema contract in `scripts/smoke-release.ts`.
- Renderer: `launcher/electron/renderer-security.cjs` and declarations, `main-council.cjs`, `launcher/index.html`, `launcher/vite.config.ts`.
- Dependencies/workflows: root and launcher manifests/lockfiles, both GitHub workflows, generated-reference ignore rules.
- Focused tests: security boundary, private debugger Electron fixture, network security, and existing descriptor/helper/sync/logging/runtime-install fixtures adjusted to the strengthened contracts. The exact changed-file list is available with `git show --name-only <candidate>`.

## Developer validation

All commands ran in the isolated D: DEV checkout. The synthetic Electron fixture used a new D: profile and the existing D: Electron executable, without opening or changing the retained owner session.

| Check | Observed result |
| --- | --- |
| Focused root tests, 9 files | 74 passed, 0 failed; 475 assertions |
| Focused launcher tests, 11 files | 45 passed, 0 failed, 0 skipped |
| Real Electron private-debugger fixture | Passed; Playwright filled/clicked exact multiline relay text, cookie API access was denied, unauthenticated metadata was rejected, and a synthetic HttpOnly session survived close/reopen |
| Root typecheck | Passed |
| Launcher typecheck | Passed |
| Renderer-only Vite build | Passed; no runtime bundle/package was built |
| Root and launcher frozen dependency installs | Passed |
| Root and launcher dependency audits | Both returned empty advisory objects |
| Git whitespace check | Passed |

Root tests:

```text
bun test tests/network-security.test.ts tests/council-http-sync.test.ts tests/council-owner-http-security.test.ts tests/project-relay.test.ts tests/project-relay-owner-control.test.ts tests/project-relay-ui-contract.test.ts tests/launcher-browser-host.test.ts tests/launcher-helper-client.test.ts tests/council-node-playwright-helper.test.ts
```

Launcher tests (CWC_TEST_ELECTRON must identify an installed Electron for the integration fixture):

```text
node --test --test-reporter=spec launcher/tests/security-boundaries.test.cjs launcher/tests/private-debugger-integration.test.cjs launcher/tests/logging.test.cjs launcher/tests/runtime-install.test.cjs launcher/tests/council-connection-supervisor.test.cjs launcher/tests/atomic-file.test.cjs launcher/tests/council-entrypoint-contract.test.cjs launcher/tests/council-control-server.test.cjs launcher/tests/council-browser-host.test.cjs launcher/tests/control-server.test.cjs launcher/tests/cwc-fresh-profile-source-run.test.cjs
bun run typecheck
bun run --cwd launcher typecheck
bun run --cwd launcher build:renderer
bun install --frozen-lockfile --ignore-scripts
bun install --cwd launcher --frozen-lockfile --ignore-scripts
bun audit --json
bun audit --cwd launcher --json
```

The integration test was rerun after adding its restart/persistence assertion and passed. Root tests and typechecks were rerun after the final source changes. Test counts above count unique tests, not repeated invocations.

## Regression findings and remaining verification

A fresh-profile regression discovered during development was fixed: private-path verification now retains the ENOENT behavior required for an unconfigured runtime. The existing fresh-profile source-run test passed after that correction. No unresolved regression was observed in these focused checks.

Existing relay tests cover exact first/subsequent content, routing, toolbar/draft contracts, duplicate prevention and Stop/Resume reconciliation. They are developer contracts; live GPT Web-to-GPT Web acceptance against the real service remains for independent QA. The synthetic session persistence check does not certify retention of the owner's live ChatGPT session.

Windows ACL checks ran against actual synthetic directories/files and a junction. A separate Windows-account access attempt remains independent QA work. Paths owned by another principal fail closed rather than taking ownership. Filesystems without the required Windows ACL support likewise fail closed and would need an owner decision on location.

The bearer transport treats CWC helpers as trusted capability holders. It does not claim isolation from malware already executing as the owner or an administrator. Packaged application signing/ASAR trust and final portable verification remain later work; the source packaging pipeline generates the separate runtime trust reference, but was deliberately not executed in this pass.

Normal retained-session lifecycle and Project Relay logic were preserved. Original FORK and audited QA checkouts, the owner's profile, and Tunnel/MCP authorization were left intact. Independent QA/N&S retest must decide whether the security gate can reopen.
