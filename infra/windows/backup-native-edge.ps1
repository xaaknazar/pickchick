#Requires -Version 5.1
<# Local protected backup and disposable restore rehearsal; no remote export. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$ReleaseName,
    [Parameter(Mandatory = $true)][guid]$BranchId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use elevated x64 Windows PowerShell 5.1.' }
$script:operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevated administrator shell required.' }
if ($BranchId -eq [guid]::Empty) { throw 'Assigned branch UUID required.' }

# Reuse only named function declarations from immutable reviewed bytes. The
# installer's executable body and parameter block are never dot-sourced/run.
$installerPath = Join-Path $PSScriptRoot 'install-native-services.ps1'
$installerBytes = [IO.File]::ReadAllBytes($installerPath)
$hash = [Security.Cryptography.SHA256]::Create()
try { $actual = [BitConverter]::ToString($hash.ComputeHash($installerBytes)).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
if ($actual -ne '694cb1ea869b651e3a7b060e62da71d8c1ccf2a9a9dcf65cf8914e0e12d929b8') { throw 'Reviewed foundation function source differs.' }
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput([Text.UTF8Encoding]::new($false, $true).GetString($installerBytes), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Foundation helper source cannot be parsed.' }
$names = @('Assert-NtfsPath', 'Assert-Acl', 'Set-KnownDirectoryAcl', 'Write-PrivateText', 'Quote-WindowsArgument', 'Invoke-SetupProcess')
$definitions = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -in $names })
if ($definitions.Count -ne $names.Count -or @($definitions.Name | Sort-Object -Unique).Count -ne $names.Count) { throw 'Expected reviewed helper definitions are missing.' }
. ([scriptblock]::Create(($definitions.Extent.Text -join "`n")))

$dataRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PickChick'
$programRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PickChick'
$script:toolsRoot = Join-Path $dataRoot "EdgeTools\$ReleaseName"
$script:nodeExe = Join-Path $programRoot "Edge\$ReleaseName\node\node.exe"
$script:pgBin = Join-Path $programRoot 'Postgres\18.6-3\bin'
foreach ($path in @($dataRoot, $programRoot, $toolsRoot, (Join-Path $toolsRoot 'private'))) { Assert-Acl $path }
foreach ($file in @('foundation-state.json', 'foundation-credentials.json')) { Assert-Acl (Join-Path $toolsRoot "private\$file") -InheritedAllowed }
$state = Get-Content -LiteralPath (Join-Path $toolsRoot 'private\foundation-state.json') -Raw | ConvertFrom-Json
if (-not $state.complete -or $state.branchId -ne $BranchId.ToString() -or $state.releaseName -ne $ReleaseName -or $state.operatorSid -ne $operatorSid.Value -or $state.computerName -ne $env:COMPUTERNAME) { throw 'Completed matching local foundation required.' }
$backupsRoot = Join-Path $dataRoot 'Backups'
if (Test-Path -LiteralPath $backupsRoot) { Assert-Acl $backupsRoot } else { Set-KnownDirectoryAcl $backupsRoot -Create }
$script:privateRoot = Join-Path $backupsRoot ([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
Set-KnownDirectoryAcl $privateRoot -Create
$script:secrets = @()
$pins = @{
    'backup-native-edge.mjs' = 'b0a92104101d3d8176fffac0079659a1c1c9debea21d6f6189af89929bf4a92a'
    'native-foundation-db.mjs' = '01a376ee8848cbd53cb62b125d706039dd103205acfabeef0e20bdfed91e433e'
}
foreach ($name in $pins.Keys) {
    $source = Join-Path $PSScriptRoot $name
    $target = Join-Path $privateRoot $name
    [IO.File]::Copy($source, $target, $false)
    Assert-Acl $target -InheritedAllowed
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pins[$name]) { throw 'Copied backup helper differs from reviewed bytes.' }
}
$result = Invoke-SetupProcess $nodeExe @((Join-Path $privateRoot 'backup-native-edge.mjs'), $toolsRoot, $pgBin, $privateRoot, $BranchId.ToString()) 'backup-rehearsal' 300
$summary = $result | ConvertFrom-Json
if ($summary.event -ne 'native_backup_verified' -or -not $summary.backupVerified -or -not $summary.restoreVerified -or -not $summary.rehearsalDropped) { throw 'Backup and restore verification did not finish.' }
Write-Output $result
Write-Output "Protected local backup and manifest: $privateRoot"
