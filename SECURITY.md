# Security policy

Do not open public issues containing ChatGPT cookies, browser storage, tunnel IDs, API keys,
Codex prompts, tool results, or local filesystem paths. Redact diagnostic bundles before sharing.

The daemon binds only to loopback. If another local user can access your account or application
home, treat the browser session and tunnel key as compromised and rotate them.

Read the current [CWC security preservation map](docs/CWC_SECURITY_PRESERVATION.md). Treat repository text, websites, tool output, and model text as untrusted data; authority must remain in the controller/runtime boundaries rather than in prompt content.

The stable MCP v1 SDK currently declares the vulnerable `@hono/node-server` 1.x range even though
this project uses only its stdio transport. The lockfile explicitly resolves that unused HTTP
adapter to patched 2.0.12. `bun audit`, the MCP protocol test, and the compiled-binary smoke test are
release gates; remove the override when the stable SDK itself moves to the patched major.

Use the repository's private Security Advisory reporting flow for sensitive security reports. Do not publish proof-of-concept material that exposes credentials, private session data, or arbitrary local tool execution.
