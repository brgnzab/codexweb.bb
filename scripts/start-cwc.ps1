[CmdletBinding()]
param(
  [switch]$ValidateOnly,
  [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RequiredBun = "1.3.14"
$RequiredNode = "v22.23.2"

if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitOperatingSystem) {
  throw "CWC Personal source launch supports Windows 11 x64 only."
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Launcher = Join-Path $Root "launcher"

function Resolve-Executable([string]$Name) {
  $Command = Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1
  if (-not $Command -or -not $Command.Source) {
    throw "Required executable not found: $Name"
  }
  return $Command.Source
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location $WorkingDirectory
  try {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed with exit code ${LASTEXITCODE}: $Executable $($Arguments -join ' ')"
    }
  }
  finally {
    Pop-Location
  }
}

$Bun = Resolve-Executable "bun"
$Node = Resolve-Executable "node"
$BunVersion = (& $Bun --version).Trim()
$NodeVersion = (& $Node --version).Trim()

if ($BunVersion -ne $RequiredBun) {
  throw "CWC Personal requires Bun $RequiredBun; found $BunVersion at $Bun."
}
if ($NodeVersion -ne $RequiredNode) {
  throw "CWC Personal requires Node $RequiredNode; found $NodeVersion at $Node."
}

$env:CODEX_WEB_GPT_BUN = $Bun
$env:CODEX_CHATGPT_WEB_BUN = $Bun

if (-not $SkipInstall) {
  Invoke-Checked $Bun @("install", "--frozen-lockfile") $Root
  Invoke-Checked $Bun @("install", "--frozen-lockfile") $Launcher
}

if ($ValidateOnly) {
  Invoke-Checked $Bun @("run", "launcher:typecheck") $Root
  Invoke-Checked $Bun @("run", "launcher:build") $Root
  Write-Host "CWC Personal source-launch preflight PASS (Windows x64, Bun $BunVersion, Node $NodeVersion)."
  exit 0
}

Write-Host "Launching CWC Personal directly from source. Close the Electron window or press Ctrl+C here to stop."
Invoke-Checked $Bun @("run", "scripts/start-launcher.ts") $Root
