$ErrorActionPreference = "Stop"

$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$qaUser = "cwcverify"
Remove-LocalUser -Name $qaUser -ErrorAction SilentlyContinue

$qaPasswordText = "V5!" + [Guid]::NewGuid().ToString("N") + "#Q7"
$qaPassword = ConvertTo-SecureString $qaPasswordText -AsPlainText -Force
$qaCredential = [pscredential]::new("$env:COMPUTERNAME\$qaUser", $qaPassword)
New-LocalUser -Name $qaUser -Password $qaPassword -PasswordNeverExpires | Out-Null
$qaIdentity = "$env:COMPUTERNAME\$qaUser"

$runnerTemp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$qaScript = Join-Path $runnerTemp "cwc-full-source-verify.ps1"
$qaStdout = "C:\Users\Public\cwc-full-source-verify.stdout.txt"
$qaStderr = "C:\Users\Public\cwc-full-source-verify.stderr.txt"
$qaBin = "C:\Users\Public\cwc-full-source-verify-bin"

Remove-Item -LiteralPath $qaBin -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $qaBin -Force | Out-Null

$bun = Join-Path $qaBin "bun.exe"
Copy-Item -LiteralPath (Get-Command bun).Source -Destination $bun -Force
$node = (Get-Command node).Source
$embeddedBun = $env:CODEX_CHATGPT_WEB_EMBEDDED_BUN

@'
param(
  [string]$Workspace,
  [string]$Node,
  [string]$Bun,
  [string]$EmbeddedBun
)
$ErrorActionPreference = "Stop"
$qaTemp = Join-Path "C:\Users\Public" ("cwc-full-verify-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $qaTemp -Force | Out-Null
$env:TEMP = $qaTemp
$env:TMP = $qaTemp
$env:PATH = "$(Split-Path -Parent $Bun);$(Split-Path -Parent $Node);$env:PATH"
if ($EmbeddedBun) { $env:CODEX_CHATGPT_WEB_EMBEDDED_BUN = $EmbeddedBun }
Set-Location $Workspace
& $Bun run verify
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $qaScript -Encoding UTF8

& icacls.exe $workspace /grant:r "${qaIdentity}:(OI)(CI)(M)" /T /C /Q | Out-Null
& icacls.exe $qaScript /grant:r "${qaIdentity}:(R)" /Q | Out-Null
& icacls.exe $qaBin /grant:r "${qaIdentity}:(OI)(CI)(RX)" /T /C /Q | Out-Null

try {
  $args = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $qaScript, "-Workspace", $workspace, "-Node", $node, "-Bun", $bun, "-EmbeddedBun", $embeddedBun)
  $process = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $qaCredential -WorkingDirectory "C:\Users\Public" -ArgumentList $args -RedirectStandardOutput $qaStdout -RedirectStandardError $qaStderr -Wait -PassThru
  if (Test-Path $qaStdout) { Get-Content $qaStdout }
  if (Test-Path $qaStderr) { Get-Content $qaStderr | ForEach-Object { Write-Host $_ } }
  if ($process.ExitCode -ne 0) { exit $process.ExitCode }
} finally {
  Remove-LocalUser -Name $qaUser -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $qaBin -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $qaStdout,$qaStderr -Force -ErrorAction SilentlyContinue
}
