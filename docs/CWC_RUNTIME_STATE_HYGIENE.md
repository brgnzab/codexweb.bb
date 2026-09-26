# CWC Personal runtime-state and logging hygiene

CWC Personal treats all user, browser, credential, runtime, and diagnostic state as private mutable data. None of that state is a distributable application input.

## Runtime state locations

The Council core defaults to `~/.codex-chatgpt-web`. The Electron launcher defaults to its operating-system application-data directory. The persistent ChatGPT Electron partition is therefore stored beneath launcher `userData`, not beneath the repository or packaged application.

Two environment variables may override these private roots:

- `CODEX_CHATGPT_WEB_HOME`
- `CODEX_WEB_GPT_LAUNCHER_DATA_DIR`

`launcher/electron/main-hardened.cjs` validates configured overrides before loading the Council main process. An override is rejected if it resolves inside the repository/source tree, Electron packaged resources, or the executable directory. This is fail-closed: CWC does not start with a configured mutable-state root inside distributable application files.

## Logging

`launcher/electron/logging.cjs` sanitizes structured values before records enter memory, disk, or renderer publication. Sensitive object keys and text patterns cover, at minimum:

- bearer and authorization credentials;
- cookies and set-cookie values;
- OpenAI-style runtime keys and GitHub tokens;
- API/runtime/control/private keys;
- access and refresh tokens;
- passwords, secrets, and credentials;
- session IDs/keys/tokens;
- CSRF/XSRF tokens;
- credential-bearing URLs and secret query parameters.

Diagnostic stream errors pass through the same text redaction boundary. Activity files are private-mode JSONL files under launcher user data and are size-bounded/rotated. Previously stored records are sanitized again when read.

## Repository hygiene

`.gitignore` excludes CWC private state roots, browser storage, logs, runtime descriptors, credentials, caches, and generated package/build outputs. This is defense in depth rather than the package boundary itself.

`scripts/check-public-hygiene.ts` scans every tracked repository file and every explicit package-input tree supplied to it. It rejects high-confidence credentials and private state paths, including nested:

- `.cwc-data`;
- `.codex-chatgpt-web`;
- `.launcher-runtime`;
- Chromium `Local Storage`, `Session Storage`, `WebStorage`, `IndexedDB`, `Service Worker`, `Code Cache`, `GPUCache`, `DawnCache`, and `blob_storage` trees;
- sensitive browser/runtime state basenames such as Cookies, Login Data, Local State, owner-control and managed-state files.

## Portable/package contamination boundary

The launcher package manifest permits only these application file inputs:

- `dist/**`
- `electron/**`
- `assets/icon.png`
- `package.json`

The only extra resource is the freshly built `build/runtime` tree.

`scripts/build-runtime-bundle.ts` recursively removes the previous runtime output before creating a new bundle. It then builds from source, performs a frozen production dependency install with lifecycle scripts disabled, writes the runtime manifest, and never copies user/runtime/browser state.

`launcher/scripts/prepare-runtime.cjs` runs the public-hygiene scanner against `launcher/electron`, the freshly rebuilt runtime, `launcher/package.json`, and renderer output when present before electron-builder is invoked.

`launcher/scripts/package.cjs` sends electron-builder output to a new OS-temporary staging directory and copies only produced Windows package artifacts to the ignored artifacts directory. The staging directory is removed afterward.

Together these constraints mean an existing login/session/browser profile may remain available to the local installed application, but it is not a package source and cannot be inherited by a newly built distributable artifact.

## Verification for CWC-014

Independent QA should verify:

1. logging tests prove representative auth, cookie, session, CSRF/XSRF, API-key, URL-credential, and structured secret values are absent from persisted log bytes;
2. configured runtime roots inside the repository/application tree are rejected and external absolute private roots are accepted;
3. tracked-repository hygiene and nested browser-state path tests pass;
4. package input allowlists contain no mutable state roots;
5. the runtime output is purged before rebuild and the package preparation hygiene scan runs before packaging;
6. a package built while sentinel private state exists in local runtime/browser directories contains none of those sentinels or state paths;
7. normal root and launcher regression suites remain green.
