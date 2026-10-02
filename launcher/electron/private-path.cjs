const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// A sensitive target itself must never be a link/reparse point. Ancestor junctions are allowed:
// Windows installations commonly place application/profile trees below legitimate junctions.
// The target's own protected DACL is still enforced/verified after traversal, so an ancestor
// redirect cannot bypass the owner+SYSTEM permission boundary.
function assertNoReparsePath(value) {
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error("Sensitive path contains a reparse point");
  return absolute;
}

function assertNoReparseDescendants(value) {
  const root = path.resolve(value);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) return root;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error("Sensitive path contains a reparse point");
      if (stat.isDirectory()) pending.push(child);
    }
  }
  return root;
}

function windowsAclScript(recursive, verifyOnly) {
  return `
$ErrorActionPreference = 'Stop'
$target = $env:CWC_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowed = @($sid.Value, $system.Value)
if ([IO.Directory]::Exists($target)) { $item = [IO.DirectoryInfo]::new($target) }
elseif ([IO.File]::Exists($target)) { $item = [IO.FileInfo]::new($target) }
else { throw 'Sensitive path does not exist' }
$items = [Collections.Generic.List[object]]::new()
$items.Add($item)
for ($i = 0; $i -lt $items.Count; $i++) {
  $entry = $items[$i]
  if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Sensitive path contains a reparse point' }
  ${recursive ? "if ($entry -is [IO.DirectoryInfo]) { foreach ($child in $entry.GetFileSystemInfos()) { $items.Add($child) } }" : ""}
}
foreach ($entry in $items) {
  ${verifyOnly ? "" : `
  $acl = $entry.GetAccessControl()
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Sensitive path is not owned by the current Windows user' }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($existing in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($existing) }
  foreach ($principal in @($sid, $system)) {
    if ($entry -is [IO.DirectoryInfo]) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else { $rule = [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow') }
    $acl.AddAccessRule($rule)
  }
  $entry.SetAccessControl($acl)
  `}
  $actual = $entry.GetAccessControl()
  if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unsafe sensitive path owner or inheritance' }
  $grants = @{}
  foreach ($rule in $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne 'Allow' -or $allowed -notcontains $rule.IdentityReference.Value) { throw 'Unsafe sensitive path grant' }
    $grants[$rule.IdentityReference.Value] = $true
  }
  foreach ($principal in $allowed) { if (!$grants[$principal]) { throw 'Required private path principal missing' } }
}
`;
}

function windowsAcl(target, recursive, verifyOnly) {
  const result = spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsAclScript(recursive, verifyOnly), "utf16le").toString("base64")],
    { env: { ...process.env, CWC_PRIVATE_PATH: target }, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Sensitive Windows ACL ${verifyOnly ? "verification" : "protection"} failed: ${result.error?.message || result.stderr?.trim() || "unknown error"}`);
}

function protectPrivatePath(value, { recursive = false } = {}) {
  const target = assertNoReparsePath(value);
  if (recursive) assertNoReparseDescendants(target);
  if (process.platform === "win32") windowsAcl(target, recursive, false);
  else fs.chmodSync(target, fs.statSync(target).isDirectory() ? 0o700 : 0o600);
  return target;
}

function ensurePrivateDirectory(value, options) {
  const target = assertNoReparsePath(value);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return protectPrivatePath(target, options);
}

function verifyPrivatePath(value) {
  const target = assertNoReparsePath(value);
  const stat = fs.statSync(target); // Preserve ENOENT for a fresh, unconfigured runtime.
  if (process.platform === "win32") windowsAcl(target, false, true);
  else {
    if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe sensitive path permissions");
  }
  return target;
}

module.exports = { assertNoReparsePath, ensurePrivateDirectory, protectPrivatePath, verifyPrivatePath, windowsAclScript };
