const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Existing sensitive targets may live below legitimate ancestor junctions, provided the target
// itself is not a reparse point and its protected DACL is verified. Creating a NEW sensitive
// target through a junction is different: the junction could redirect the write outside the
// intended protected tree, so every existing ancestor on a creation path must be non-reparse.
function assertNoReparsePath(value) {
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error("Sensitive path contains a reparse point");
  if (stat) return absolute;

  let current = path.dirname(absolute);
  while (true) {
    const ancestor = fs.lstatSync(current, { throwIfNoEntry: false });
    if (ancestor) {
      if (ancestor.isSymbolicLink()) throw new Error("Sensitive path contains a reparse point");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
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
  // CWC Personal is a single-owner local app. Native ACL hardening adds multiple synchronous
  // PowerShell launches to startup and relay I/O without changing this owner's trust boundary.
  if (process.env.CODEXWEB_COUNCIL_PRODUCT === "1") return;
  const result = spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsAclScript(recursive, verifyOnly), "utf16le").toString("base64")],
    { env: { ...process.env, CWC_PRIVATE_PATH: target }, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Sensitive Windows ACL ${verifyOnly ? "verification" : "protection"} failed: ${result.error?.message || result.stderr?.trim() || "unknown error"}`);
}

function protectPrivatePath(value, { recursive = false, personalRoot } = {}) {
  const target = personalRoot !== undefined ? assertWithinPrivateRoot(value, personalRoot) : assertNoReparsePath(value);
  if (recursive) assertNoReparseDescendants(target);
  if (process.platform === "win32") {
    if (personalRoot === undefined) windowsAcl(target, recursive, false);
  }
  else fs.chmodSync(target, fs.statSync(target).isDirectory() ? 0o700 : 0o600);
  return target;
}

function ensurePrivateDirectory(value, options) {
  const target = options?.personalRoot !== undefined ? assertWithinPrivateRoot(value, options.personalRoot) : assertNoReparsePath(value);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return protectPrivatePath(target, options);
}

function assertWithinPrivateRoot(value, root) {
  if (!path.isAbsolute(root)) throw new Error("Personal runtime root must be absolute");
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(value);
  const relative = path.relative(absoluteRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Personal path is outside the configured runtime root");
  // Inspect only the configured root and its path components, never the whole drive.
  let current = absoluteRoot;
  for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Sensitive path contains a reparse point");
  }
  return target;
}

function verifyPrivatePath(value, { personalRoot } = {}) {
  const target = personalRoot !== undefined ? assertWithinPrivateRoot(value, personalRoot) : assertNoReparsePath(value);
  const stat = fs.statSync(target); // Preserve ENOENT for a fresh, unconfigured runtime.
  if (process.platform === "win32") {
    // The standalone Personal bridge uses the same single-owner policy as the launcher,
    // explicitly scoped to its configured runtime. Other clients retain strict DACL checks.
    if (personalRoot === undefined) windowsAcl(target, false, true);
  }
  else {
    if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe sensitive path permissions");
  }
  return target;
}

module.exports = { assertNoReparsePath, assertWithinPrivateRoot, ensurePrivateDirectory, protectPrivatePath, verifyPrivatePath, windowsAclScript };
