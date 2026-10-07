# Contributing

Keep the project narrow: ChatGPT web-backed Codex models only. Generic providers and unrelated
product surfaces are out of scope.

Core invariants:

- Model selection is explicit; never silently fall back to another model or reasoning level.
- Full mode exposes local tools only through the active outer Codex registry and official MCP
  tunnel.
- Browser-only mode never creates a broker capability or attaches an MCP connector; Pro remains
  read-only in every mode.
- Browser state, API keys, tunnel IDs, cookies, Codex history, and absolute user paths never enter
  the repository.

Before opening a pull request:

1. Run `bun install --frozen-lockfile`, `bun install --frozen-lockfile` in `launcher/`, and
   `bun run verify`.
2. Add a focused regression test for protocol, compaction, MCP, browser parsing, relay, or portable-packaging changes.
3. Do not commit cookies, browser state, tunnel ids, API keys, local absolute paths, or generated logs.
4. Preserve fail-closed behavior. A UI selector failure must not pick another model or claim success.
5. Keep Terms/trademark claims factual and never market the project as quota or rate-limit bypass.

Browser UI changes should include the exact observed DOM evidence and a reproducible test fixture.
Do not broaden selectors speculatively.

CWC Personal targets Windows 11 x64. Launcher and release changes must preserve the verified Windows portable package, source-run path, security boundaries, and fail-closed behavior. Do not restore installer, self-update, startup-persistence, macOS, or Linux product paths unless the owner explicitly changes the product boundary.
