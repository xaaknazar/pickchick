import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const aclProbe = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:PICKCHICK_STAFF_ACL_PATH
$item = Get-Item -LiteralPath $path -Force
$acl = Get-Acl -LiteralPath $path
$raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{
    sid = $_.IdentityReference.Value
    type = $_.AccessControlType.ToString()
    inherited = $_.IsInherited
  }
})
@{
  filesystem = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($item.FullName)).DriveFormat
  current_sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  owner_sid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  protected = $acl.AreAccessRulesProtected
  dacl_present = (($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0 -and $null -ne $raw.DiscretionaryAcl)
  ace_count = $(if ($null -eq $raw.DiscretionaryAcl) { 0 } else { $raw.DiscretionaryAcl.Count })
  directory = $item.PSIsContainer
  reparse = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  rules = $rules
} | ConvertTo-Json -Depth 4 -Compress
`;

function permissionError(kind) {
  return new Error(
    kind === 'directory' ? 'Private directory required' : 'Private credential file required',
  );
}

// Compare SIDs rather than localized account names. Unknown/conditional ACEs fail closed.
export function validateStaffWindowsAcl(acl, kind) {
  const allowed = new Set([acl?.current_sid, 'S-1-5-18', 'S-1-5-32-544']);
  if (
    !/^S-1-\d+(?:-\d+)+$/.test(acl?.current_sid ?? '') ||
    acl.filesystem !== 'NTFS' ||
    !allowed.has(acl.owner_sid) ||
    acl.reparse !== false ||
    acl.directory !== (kind === 'directory') ||
    acl.dacl_present !== true ||
    typeof acl.protected !== 'boolean' ||
    !Array.isArray(acl.rules) ||
    acl.rules.length === 0 ||
    acl.ace_count !== acl.rules.length ||
    (kind === 'directory' && acl.protected !== true) ||
    acl.rules.some(
      (rule) =>
        !rule ||
        typeof rule.sid !== 'string' ||
        !['Allow', 'Deny'].includes(rule.type) ||
        typeof rule.inherited !== 'boolean' ||
        (kind === 'directory' && rule.inherited) ||
        (rule.type === 'Allow' && !allowed.has(rule.sid)),
    )
  ) {
    throw permissionError(kind);
  }
}

export async function inspectStaffWindowsAcl(path, run = execute) {
  try {
    const { stdout } = await run(
      win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(aclProbe, 'utf16le').toString('base64'),
      ],
      {
        env: { ...process.env, PICKCHICK_STAFF_ACL_PATH: path },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 64 * 1024,
      },
    );
    return JSON.parse(stdout.trim());
  } catch {
    // Do not expose process output, paths or credential values in subprocess errors.
    throw new Error('Unable to verify private Windows credential permissions');
  }
}

export async function assertPrivateStaffPath(
  path,
  kind,
  { platform = process.platform, inspectAcl = inspectStaffWindowsAcl } = {},
) {
  if (!['directory', 'file'].includes(kind)) throw new Error('Invalid private path kind');
  const nativePath = resolve(path instanceof URL ? fileURLToPath(path) : path);
  // File inheritance is accepted only beneath a separately verified private directory.
  if (kind === 'file')
    await assertPrivateStaffPath(dirname(nativePath), 'directory', { platform, inspectAcl });
  const info = await lstat(nativePath);
  if (info.isSymbolicLink() || !(kind === 'directory' ? info.isDirectory() : info.isFile()))
    throw permissionError(kind);
  if (platform === 'win32') {
    validateStaffWindowsAcl(await inspectAcl(nativePath), kind);
  } else if ((info.mode & 0o077) !== 0) {
    throw permissionError(kind);
  }
}
