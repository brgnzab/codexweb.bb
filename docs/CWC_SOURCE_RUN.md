# CWC Personal — Windows Source Run

CWC Personal is supported as a hardened **Windows 11 x64** source run. This path launches the Electron application directly from the checked-out source tree and does not execute an installer, request elevation, register startup persistence, or invoke update/release machinery.

## Required toolchain

- Windows 11 x64
- Bun `1.3.14`
- Node `22.23.2`
- PowerShell

The PowerShell entrypoint fails closed if the OS/architecture or Bun/Node versions do not match these pinned values.

## Launch

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-cwc.ps1
```

The script performs frozen root and launcher installs, sets the controller-owned Bun path for the runtime, then launches the existing source Electron/Vite path through `scripts/start-launcher.ts`.

No NSIS/package executable is required for this source-run gate.

## Preflight without opening Electron

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-cwc.ps1 -ValidateOnly
```

Preflight performs frozen installs and runs the launcher typecheck/build without opening the Electron UI. This is suitable for automated source-launch contract validation; G8 acceptance still requires an independent Windows source launch and functional UI check.

If dependencies are already installed from the exact frozen lockfiles, `-SkipInstall` may be combined with `-ValidateOnly` or the normal source launch.

## Stop

Close the Electron window or press `Ctrl+C` in the PowerShell session.

## Security boundary

The source launcher is intentionally narrow. It does not:

- invoke `app:package`, electron-builder, NSIS, or any installer;
- request administrator elevation;
- create startup tasks, registry Run entries, or services;
- perform release/update checks or remote executable acquisition.

The application continues to use the existing hardened runtime, browser, authentication, loopback, origin/path validation, transaction, and cleanup boundaries.
