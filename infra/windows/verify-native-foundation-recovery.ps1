#Requires -Version 5.1
<#
.SYNOPSIS
Verify an already extracted, uninitialized stage 1 after native dependency repair.
.DESCRIPTION
Never extracts, deletes, changes ACLs, initializes PostgreSQL, or registers services.
Its sole destination write is a new foundation-stage1.json after all checks pass.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimeArchive,
    [Parameter(Mandatory = $true)][string]$NodeArchive,
    [Parameter(Mandatory = $true)][string]$PostgresArchive,
    [Parameter(Mandatory = $true)][string]$WinSwExecutable,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$ReleaseName,
    [Parameter(Mandatory = $true)][guid]$BranchId,
    [string]$Stage1Script = (Join-Path $PSScriptRoot 'install-native-foundation.ps1')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Import-ReviewedStage1Functions([string]$Path) {
    $source = [IO.File]::ReadAllBytes($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($source)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($hash -ne '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5') {
        throw 'The original reviewed stage 1 script does not match f345210.'
    }
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString($source), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'The reviewed stage 1 script did not parse.' }
    $names = @('Assert-LocalNtfsPath', 'Open-VerifiedFile', 'Assert-ArchiveName', 'Get-ArchivePlan')
    $functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) | Where-Object { $_.Name -in $names })
    if ($functions.Count -ne $names.Count) { throw 'The reviewed stage 1 helpers are incomplete.' }
    # Return only reviewed function declarations; never execute installer body.
    return [scriptblock]::Create(($functions.Extent.Text -join "`n"))
}

function Assert-RecoveryAclPolicy($Snapshot, [string]$ServiceRights, [bool]$Protected, [bool]$Directory) {
    if ($Snapshot.Protected -ne $Protected) { throw 'Unexpected ACL inheritance state.' }
    $trusted = @($script:OperatorSid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
    if ($Snapshot.Owner -notin $trusted) { throw 'Untrusted installed file owner.' }
    $full = [long][Security.AccessControl.FileSystemRights]::FullControl
    $sync = [long][Security.AccessControl.FileSystemRights]::Synchronize
    $expected = @{}
    foreach ($sid in $trusted) { $expected[$sid] = $full -band (-bnot $sync) }
    if ($ServiceRights) { $expected['S-1-5-19'] = ([long][Security.AccessControl.FileSystemRights]$ServiceRights) -band (-bnot $sync) }
    $effective = @{}
    if ($Snapshot.RawAceCount -ne @($Snapshot.Rules).Count) { throw 'Unsupported or hidden ACL entries.' }
    foreach ($rule in $Snapshot.Rules) {
        if ($rule.Type -ne 'Allow' -or -not $expected.ContainsKey($rule.Sid) -or $rule.InheritOnly) {
            throw 'Unexpected installed access rule.'
        }
        if ($Protected -and $rule.Inherited) { throw 'Unexpected inherited root rule.' }
        if (([long]$rule.Rights -band (-bnot $sync)) -ne $expected[$rule.Sid]) { throw 'Installed rights differ from stage 1.' }
        if ($Directory -and $rule.Inheritance -ne 3) { throw 'Directory rights do not propagate to both files and directories.' }
        $effective[$rule.Sid] = $true
    }
    foreach ($sid in $expected.Keys) { if (-not $effective.ContainsKey($sid)) { throw 'A required installed principal is missing.' } }
}

function Assert-RecoveryAcl([string]$Path, [string]$ServiceRights, [bool]$Protected, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $Directory) { throw 'Unexpected installed path kind.' }
    $acl = Get-Acl -LiteralPath $Path
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorSddlForm('Access,Owner'))
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
        [pscustomobject]@{
            Sid = $_.IdentityReference.Value; Type = $_.AccessControlType.ToString(); Rights = [long]$_.FileSystemRights
            Inherited = $_.IsInherited; Inheritance = [int]$_.InheritanceFlags
            InheritOnly = ($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
        }
    })
    if ($null -eq $raw.DiscretionaryAcl) { throw 'Null DACL is not accepted.' }
    Assert-RecoveryAclPolicy ([pscustomobject]@{
        Owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        Protected = $acl.AreAccessRulesProtected; Rules = $rules; RawAceCount = $raw.DiscretionaryAcl.Count
    }) $ServiceRights $Protected $Directory
}

function Assert-ExactChildren([string]$Path, [string[]]$Names) {
    $actual = @(Get-ChildItem -LiteralPath $Path -Force | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Names.Count) { throw "Unexpected contents in stage 1 directory: $Path" }
    foreach ($name in $actual) { if ($name -notin $Names) { throw "Unexpected contents in stage 1 directory: $Path" } }
}

function Assert-UninitializedStage([string]$ServiceRoot, [string]$PostgresBinaries, [string[]]$EmptyPaths) {
    $services = @(Get-CimInstance Win32_Service | Where-Object {
        $_.Name -in @('PickChickPostgres', 'PickChickEdge') -or
        ($_.PathName -and ($_.PathName.IndexOf($ServiceRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.PathName.IndexOf($PostgresBinaries, [StringComparison]::OrdinalIgnoreCase) -ge 0))
    })
    if ($services.Count) { throw 'A target service is already registered; stage 1 recovery is not applicable.' }
    if (@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -in @(55433, 3101) }).Count) { throw 'A dedicated server port is occupied.' }
    foreach ($empty in $EmptyPaths) { Assert-ExactChildren $empty @() }
}

function Get-StreamSha256($Stream) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Assert-InstalledPlan($Plan, [string]$Root, [string]$ServiceRights, [string[]]$ExtraEmptyDirectories = @()) {
    $files = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
    $directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($planned in $Plan) {
        $files.Add($planned.Target, $planned)
        $parent = [IO.Path]::GetDirectoryName($planned.Target)
        while ($parent -ne $Root) { $null = $directories.Add($parent); $parent = [IO.Path]::GetDirectoryName($parent) }
    }
    foreach ($relative in $ExtraEmptyDirectories) { $null = $directories.Add((Join-Path $Root $relative)) }
    $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($Root)
    [long]$verified = 0
    while ($pending.Count) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Installed tree contains a reparse point.' }
            if ($item.PSIsContainer) {
                if (-not $directories.Remove($item.FullName)) { throw 'Installed tree has an unexpected directory.' }
                $extra = $item.FullName -in @($ExtraEmptyDirectories | ForEach-Object { Join-Path $Root $_ })
                Assert-RecoveryAcl $item.FullName $ServiceRights $extra $true
                $pending.Push($item.FullName)
                continue
            }
            if (-not $files.ContainsKey($item.FullName)) { throw 'Installed tree has an unexpected file.' }
            $planned = $files[$item.FullName]
            Assert-RecoveryAcl $item.FullName $ServiceRights $false $false
            $source = $planned.Entry.Open()
            try { $expected = Get-StreamSha256 $source } finally { $source.Dispose() }
            $installed = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                if ($installed.Length -ne $planned.Entry.Length -or (Get-StreamSha256 $installed) -ne $expected) { throw 'Installed bytes differ from the pinned archive.' }
            } finally { $installed.Dispose() }
            $null = $files.Remove($item.FullName)
            $verified++
            if (($verified % 500) -eq 0) { Write-Progress -Activity 'Verifying existing stage 1 files' -Status "$verified checked in $Root" }
        }
    }
    if ($files.Count -or $directories.Count) { throw 'Installed tree is missing expected archive paths.' }
    foreach ($relative in $ExtraEmptyDirectories) { Assert-ExactChildren (Join-Path $Root $relative) @() }
    return $verified
}

function Get-NativeVersion([string]$Executable, [string]$Expected) {
    $process = [Diagnostics.Process]::new()
    try {
        $process.StartInfo.FileName = $Executable
        $process.StartInfo.Arguments = '--version'
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.EnvironmentVariables.Remove('NODE_OPTIONS')
        $process.StartInfo.EnvironmentVariables.Remove('NODE_PATH')
        if (-not $process.Start()) { throw 'Native version process did not start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); $process.WaitForExit(); throw 'Native version process timed out.' }
        if ($process.ExitCode -ne 0 -or $stdout.Result.Trim() -ne $Expected -or $stderr.Result.Trim()) { throw 'Native startup/version verification failed.' }
        return $Expected
    } finally { $process.Dispose() }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use elevated 64-bit Windows PowerShell 5.1.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$script:OperatorSid = $identity.User
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated administrator shell is required.' }
if ($BranchId -eq [guid]::Empty) { throw 'A nonempty branch ID is required.' }
. (Import-ReviewedStage1Functions $Stage1Script)
$null = Assert-LocalNtfsPath $Stage1Script
$os = Get-CimInstance Win32_OperatingSystem
if ([version]$os.Version -lt [version]'10.0.18363' -or $os.OSArchitecture -notmatch '64') { throw 'Unexpected Windows architecture/build.' }
if ((Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full').Release -lt 528040) { throw '.NET Framework 4.8 is required.' }

$programRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PickChick'
$dataRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PickChick'
$edgeRoot = Join-Path $programRoot 'Edge'; $postgresRoot = Join-Path $programRoot 'Postgres'
$edgeDataRoot = Join-Path $dataRoot 'Edge'; $toolsRoot = Join-Path $dataRoot 'EdgeTools'; $postgresDataRoot = Join-Path $dataRoot 'Postgres'
$serviceRoot = Join-Path $edgeRoot $ReleaseName; $toolsRelease = Join-Path $toolsRoot $ReleaseName
$postgresBinaries = Join-Path $postgresRoot '18.6-3'; $runtimeRoot = Join-Path $serviceRoot 'app'; $nodeRoot = Join-Path $serviceRoot 'node'
$recordPath = Join-Path $toolsRelease 'foundation-stage1.json'
if (Test-Path -LiteralPath $recordPath) { throw 'A stage 1 record already exists; it will not be overwritten.' }
$emptyPaths = @((Join-Path $toolsRelease '.local'), (Join-Path $edgeDataRoot 'config'), (Join-Path $edgeDataRoot 'logs'), (Join-Path $postgresDataRoot '18\data'))

$roots = @(
    @($programRoot, ''), @($dataRoot, ''), @($edgeRoot, 'ReadAndExecute'), @($postgresRoot, 'ReadAndExecute'),
    @($edgeDataRoot, ''), @($toolsRoot, ''), @($postgresDataRoot, ''), @($serviceRoot, 'ReadAndExecute'),
    @($runtimeRoot, 'ReadAndExecute'), @($nodeRoot, 'ReadAndExecute'), @($postgresBinaries, 'ReadAndExecute'),
    @($toolsRelease, ''), @((Join-Path $toolsRelease '.local'), ''),
    @((Join-Path $edgeDataRoot 'config'), 'ReadAndExecute'), @((Join-Path $edgeDataRoot 'logs'), 'Modify'),
    @((Join-Path $postgresDataRoot '18'), ''), @((Join-Path $postgresDataRoot '18\data'), '')
)
foreach ($root in $roots) { $null = Assert-LocalNtfsPath $root[0]; Assert-RecoveryAcl $root[0] $root[1] $true $true }
Assert-ExactChildren $edgeRoot @($ReleaseName); Assert-ExactChildren $postgresRoot @('18.6-3')
Assert-ExactChildren $serviceRoot @('app', 'node', 'PickChickEdge.exe'); Assert-ExactChildren $toolsRoot @($ReleaseName)
Assert-ExactChildren $edgeDataRoot @('config', 'logs'); Assert-ExactChildren $postgresDataRoot @('18')
Assert-ExactChildren (Join-Path $postgresDataRoot '18') @('data')
Assert-UninitializedStage $serviceRoot $postgresBinaries $emptyPaths

# Fixed reviewed download pins; there is deliberately no hash override parameter.
$RuntimeSha256 = '911dc443115c80f3647980b27e7e7c287aac49be864010c4079dcc0eb67390c0'
$NodeSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$PostgresSha256 = '59f8ce701c63c2ed623c665a5e51b3ef6f2e37ccf837b68ffeed0742d0ae6abd'
$WinSwSha256 = 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f'
Add-Type -AssemblyName System.IO.Compression
$handles = [Collections.Generic.List[IDisposable]]::new()
try {
    $runtimeFile = Open-VerifiedFile $RuntimeArchive $RuntimeSha256; $handles.Add($runtimeFile)
    $nodeFile = Open-VerifiedFile $NodeArchive $NodeSha256; $handles.Add($nodeFile)
    $postgresFile = Open-VerifiedFile $PostgresArchive $PostgresSha256; $handles.Add($postgresFile)
    $winswFile = Open-VerifiedFile $WinSwExecutable $WinSwSha256; $handles.Add($winswFile)
    $runtimeZip = [IO.Compression.ZipArchive]::new($runtimeFile, [IO.Compression.ZipArchiveMode]::Read, $true); $handles.Add($runtimeZip)
    $nodeZip = [IO.Compression.ZipArchive]::new($nodeFile, [IO.Compression.ZipArchiveMode]::Read, $true); $handles.Add($nodeZip)
    $postgresZip = [IO.Compression.ZipArchive]::new($postgresFile, [IO.Compression.ZipArchiveMode]::Read, $true); $handles.Add($postgresZip)
    $runtimePlan = Get-ArchivePlan $runtimeZip 'runtime' $runtimeRoot
    $toolsPlan = Get-ArchivePlan $runtimeZip 'runtime' $toolsRelease
    $nodePlan = Get-ArchivePlan $nodeZip 'node' $nodeRoot
    $postgresPlan = Get-ArchivePlan $postgresZip 'postgres' $postgresBinaries
    $entry = $runtimeZip.GetEntry('runtime-manifest.json')
    if ($null -eq $entry -or $entry.Length -gt 4MB) { throw 'Missing or oversized runtime manifest.' }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($manifest.format -ne 'pickchick-edge-runtime-v1' -or $manifest.target -ne 'windows-x64' -or $manifest.sourceCommit -ne '0186902b30b995ba49ab69346a2bcc1088bb3fa6') { throw 'Unreviewed runtime source.' }
    $migrations = @($runtimePlan | Where-Object { $_.Relative -match '^db/edge/migrations/\d{3}_.*\.sql$' })
    if ($migrations.Count -ne 9 -or (($migrations.Relative | Sort-Object | ForEach-Object { $_.Substring(19, 3) }) -join ',') -ne '001,002,003,004,005,006,007,008,009') { throw 'Incomplete edge migration plan.' }
    $counts = [ordered]@{
        runtimeFiles = Assert-InstalledPlan $runtimePlan $runtimeRoot 'ReadAndExecute'
        operatorFiles = Assert-InstalledPlan $toolsPlan $toolsRelease '' @('.local')
        nodeFiles = Assert-InstalledPlan $nodePlan $nodeRoot 'ReadAndExecute'
        postgresFiles = Assert-InstalledPlan $postgresPlan $postgresBinaries 'ReadAndExecute'
    }
    $winswTarget = Join-Path $serviceRoot 'PickChickEdge.exe'
    Assert-RecoveryAcl $winswTarget 'ReadAndExecute' $false $false
    $installedWinsw = Open-VerifiedFile $winswTarget $WinSwSha256; $handles.Add($installedWinsw)
    $null = Get-NativeVersion (Join-Path $nodeRoot 'node.exe') 'v24.21.0'
    $null = Get-NativeVersion (Join-Path $postgresBinaries 'bin\postgres.exe') 'postgres (PostgreSQL) 18.6'
    $winswVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($winswTarget)
    if ($winswVersion.FileMajorPart -ne 2 -or $winswVersion.FileMinorPart -ne 12) { throw 'Unexpected WinSW file version.' }
    Assert-UninitializedStage $serviceRoot $postgresBinaries $emptyPaths
    $record = [ordered]@{
        stage = 'files_prepared_only'; recordedAt = [DateTime]::UtcNow.ToString('o'); branchId = $BranchId.ToString()
        releaseName = $ReleaseName; sourceCommit = $manifest.sourceCommit; windowsVersion = $os.Version
        serviceRoot = $serviceRoot; operatorRoot = $toolsRelease; postgresBinaries = $postgresBinaries
        runtimeSha256 = $RuntimeSha256; nodeSha256 = $NodeSha256; postgresSha256 = $PostgresSha256; winSwSha256 = $WinSwSha256
        nodeVersionVerified = $true; postgresVersionVerified = $true
        databaseInitialized = $false; credentialsIssued = $false; migrationsApplied = $false
        servicesRegistered = $false; healthVerified = $false; fulfillmentEnabled = $false
        recovery = 'verified_existing_extraction_after_native_dependency_repair'; verificationCounts = $counts
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Depth 4))
    $output = [IO.File]::Open($recordPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $output.Write($bytes, 0, $bytes.Length); $output.Flush($true) } finally { $output.Dispose() }
    Write-Progress -Activity 'Verifying existing stage 1 files' -Completed
    Write-Output "Stage 1 recovery verified. Existing bytes and ACLs match; database and services remain uninitialized. Record: $recordPath"
} finally {
    for ($index = $handles.Count - 1; $index -ge 0; $index--) { $handles[$index].Dispose() }
}
