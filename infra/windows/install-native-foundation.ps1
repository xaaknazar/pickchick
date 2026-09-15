#Requires -Version 5.1
<#
.SYNOPSIS
Stage 1 only: verify and prepare fresh native Windows edge files.
.DESCRIPTION
Run in elevated 64-bit Windows PowerShell 5.1. This does not initialize a database,
create credentials, migrate schemas, register services, or enable restaurant orders.
It leaves a private preparation record. An interrupted run is deliberately not
resumed or removed automatically; inspect the protected directories first.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimeArchive,
    [Parameter(Mandatory = $true)][string]$NodeArchive,
    [Parameter(Mandatory = $true)][string]$PostgresArchive,
    [Parameter(Mandatory = $true)][string]$WinSwExecutable,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$ReleaseName,
    [Parameter(Mandatory = $true)][guid]$BranchId,
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$RuntimeSha256 = '911dc443115c80f3647980b27e7e7c287aac49be864010c4079dcc0eb67390c0',
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$NodeSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$PostgresSha256 = '59f8ce701c63c2ed623c665a5e51b3ef6f2e37ccf837b68ffeed0742d0ae6abd',
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$WinSwSha256 = 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LocalNtfsPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw 'Supply an absolute local NTFS path.' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -notmatch '^[a-zA-Z]:\\' -or $full.Substring(2).Contains(':')) {
        throw 'Only absolute local drive paths without alternate data streams are accepted.'
    }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full))
    if (-not $drive.IsReady -or $drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') {
        throw 'Every source and destination must be on a ready fixed NTFS drive.'
    }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Reparse points are not accepted in source or destination paths.'
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        $cursor = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
    return $full
}

function Open-VerifiedFile([string]$Path, [string]$ExpectedHash) {
    $full = Assert-LocalNtfsPath $Path
    # Keep this same handle through extraction, denying concurrent writes/deletion.
    $stream = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $hash = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $hash.Dispose() }
        if ($actual -ne $ExpectedHash.ToLowerInvariant()) { throw 'An input SHA-256 did not match its reviewed pin.' }
        $stream.Position = 0
        return $stream
    } catch { $stream.Dispose(); throw }
}

function Assert-ArchiveName([string]$Name) {
    if (-not $Name -or $Name.StartsWith('/') -or $Name.Contains('\')) { throw 'Unsafe ZIP path.' }
    $relative = $Name.TrimEnd('/')
    foreach ($part in $relative.Split('/')) {
        if (-not $part -or $part -in @('.', '..') -or $part.Length -gt 255 -or
            $part -match '[\x00-\x1f<>:"\\|?*]' -or $part -match '[ .]$' -or
            $part -match '^(?i:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)') {
            throw 'ZIP contains a Windows-invalid path component.'
        }
    }
    return $relative
}

function Get-ArchivePlan($Archive, [string]$Kind, [string]$Destination) {
    $seen = [Collections.Generic.Dictionary[string, bool]]::new([StringComparer]::OrdinalIgnoreCase)
    $explicit = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $plan = [Collections.Generic.List[object]]::new()
    [long]$expanded = 0
    if ($Archive.Entries.Count -gt 100000) { throw 'Too many ZIP entries.' }
    :entries foreach ($entry in $Archive.Entries) {
        $name = Assert-ArchiveName $entry.FullName
        $directory = $entry.FullName.EndsWith('/')
        $type = ($entry.ExternalAttributes -shr 16) -band 0xf000
        if ($type -notin @(0, 0x4000, 0x8000) -or ($entry.ExternalAttributes -band 0x400) -ne 0) {
            throw 'Links, reparse points and special ZIP entries are not accepted.'
        }
        if (-not $explicit.Add($name)) { throw 'ZIP has duplicate or case-colliding paths.' }
        if ($seen.ContainsKey($name) -and (-not $directory -or -not $seen[$name])) {
            throw 'ZIP has a file/directory collision.'
        }
        $seen[$name] = $directory
        $parts = $name.Split('/')
        for ($index = 1; $index -lt $parts.Length; $index++) {
            $parent = ($parts[0..($index - 1)] -join '/')
            if ($seen.ContainsKey($parent) -and -not $seen[$parent]) { throw 'ZIP descends through a file.' }
            $seen[$parent] = $true
        }
        $expanded += $entry.Length
        if ($expanded -gt 3GB -or $entry.Length -gt 512MB) { throw 'ZIP exceeds bounded extraction size.' }
        if ($directory) { continue entries }
        $relative = $name
        switch ($Kind) {
            'node' {
                if (-not $name.StartsWith('node-v24.21.0-win-x64/', [StringComparison]::Ordinal)) { throw 'Unexpected Node archive root.' }
                $relative = $name.Substring('node-v24.21.0-win-x64/'.Length)
                if ($relative -notin @('node.exe', 'LICENSE', 'README.md', 'CHANGELOG.md')) { continue entries }
            }
            'postgres' {
                if (-not $name.StartsWith('pgsql/', [StringComparison]::Ordinal)) { throw 'Unexpected PostgreSQL archive root.' }
                $relative = $name.Substring(6)
                # Retain the server, command-line tools, libraries, resources and licenses.
                # pgAdmin and StackBuilder have their own lifecycles and are not installed.
                if ($relative -notmatch '^(bin|lib|share)/' -and $relative -notmatch '^[^/]*licenses?\.txt$') { continue entries }
            }
            'runtime' { }
            default { throw 'Unknown archive kind.' }
        }
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($Destination, $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)))
        $prefix = $Destination.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $target.Length -gt 259) {
            throw 'An extracted path escapes its destination or exceeds the Windows path budget.'
        }
        $plan.Add([pscustomobject]@{ Entry = $entry; Relative = $relative; Target = $target })
    }
    if ($plan.Count -eq 0) { throw 'The ZIP contains no expected files.' }
    return ,$plan
}

function New-ProtectedDirectory([string]$Path, [string]$ServiceRights = '') {
    if (Test-Path -LiteralPath $Path) { throw 'A fresh destination already exists. No existing data is changed.' }
    if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($Path))) { throw 'Create and protect the immediate parent before its child.' }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($script:OperatorSid)
    foreach ($sid in @($script:OperatorSid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if ($ServiceRights) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new('S-1-5-19'), $ServiceRights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    # Windows PowerShell/.NET Framework creates the directory with this ACL atomically.
    [IO.Directory]::CreateDirectory($Path, $acl) | Out-Null
    Assert-ProtectedDirectory $Path $ServiceRights
}

function Assert-ProtectedDirectory([string]$Path, [string]$ServiceRights = '') {
    $null = Assert-LocalNtfsPath $Path
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { throw 'Destination ACL inheritance is not protected.' }
    $allowed = @($script:OperatorSid.Value, 'S-1-5-18', 'S-1-5-32-544')
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $allowed) { throw 'Destination has an untrusted owner.' }
    foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne 'Allow') { throw 'Unexpected destination deny rule.' }
        $sid = $ace.IdentityReference.Value
        if ($sid -in $allowed) { continue }
        if ($sid -eq 'S-1-5-19' -and $ServiceRights) {
            $limit = [Security.AccessControl.FileSystemRights]$ServiceRights -bor [Security.AccessControl.FileSystemRights]::Synchronize
            if (($ace.FileSystemRights -band (-bnot $limit)) -eq 0) { continue }
        }
        throw 'Destination grants access beyond its reviewed principals or service rights.'
    }
}

function Expand-VerifiedPlan($Plan) {
    foreach ($item in $Plan) {
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target)) | Out-Null
        $source = $item.Entry.Open()
        try {
            $destination = [IO.File]::Open($item.Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $source.CopyTo($destination); $destination.Flush($true) }
            finally { $destination.Dispose() }
        } finally { $source.Dispose() }
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') {
    throw 'Use elevated 64-bit Windows PowerShell 5.1, not PowerShell Core or another OS.'
}
$script:OperatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated administrator shell is required.' }
if ($BranchId -eq [guid]::Empty) { throw 'Assign a nonempty branch ID outside this script.' }
$os = Get-CimInstance Win32_OperatingSystem
if ([version]$os.Version -lt [version]'10.0.18363' -or $os.OSArchitecture -notmatch '64') { throw 'This preparation requires Windows 10 build 18363 or later, x64.' }
$framework = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full'
if ($framework.Release -lt 528040) { throw 'Verify .NET Framework 4.8 before preparing this release.' }

$programRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PickChick'
$dataRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PickChick'
$edgeRoot = Join-Path $programRoot 'Edge'
$postgresRoot = Join-Path $programRoot 'Postgres'
$edgeDataRoot = Join-Path $dataRoot 'Edge'
$toolsRoot = Join-Path $dataRoot 'EdgeTools'
$postgresDataRoot = Join-Path $dataRoot 'Postgres'
$serviceRoot = Join-Path $edgeRoot $ReleaseName
$toolsRelease = Join-Path $toolsRoot $ReleaseName
$postgresBinaries = Join-Path $postgresRoot '18.6-3'
$runtimeRoot = Join-Path $serviceRoot 'app'
$nodeRoot = Join-Path $serviceRoot 'node'
$freshRoots = @($edgeRoot, $postgresRoot, $edgeDataRoot, $toolsRoot, $postgresDataRoot)
foreach ($path in @($programRoot, $dataRoot) + $freshRoots) {
    $null = Assert-LocalNtfsPath $path
    if ($path -in $freshRoots -and (Test-Path -LiteralPath $path)) { throw 'A PickChick server destination already exists; fresh installation is required.' }
}
foreach ($path in @($programRoot, $dataRoot)) {
    if (Test-Path -LiteralPath $path) { Assert-ProtectedDirectory $path }
}
$services = @(Get-Service | Where-Object { $_.Name -in @('PickChickPostgres', 'PickChickEdge') })
if ($services.Count) { throw 'A target Windows service already exists. This script does not upgrade services.' }
$listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners())
if (@($listeners | Where-Object { $_.Port -in @(55433, 3101) }).Count) { throw 'The dedicated PostgreSQL or edge port is occupied.' }
foreach ($root in @($programRoot, $dataRoot)) {
    if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($root)).AvailableFreeSpace -lt 4GB) { throw 'At least 4 GiB free space is required on each destination drive.' }
}

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
    $manifestEntry = $runtimeZip.GetEntry('runtime-manifest.json')
    if ($null -eq $manifestEntry -or $manifestEntry.Length -gt 4MB) { throw 'Missing or oversized runtime manifest.' }
    $reader = [IO.StreamReader]::new($manifestEntry.Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($manifest.format -ne 'pickchick-edge-runtime-v1' -or $manifest.target -ne 'windows-x64' -or
        $manifest.sourceCommit -ne '0186902b30b995ba49ab69346a2bcc1088bb3fa6') { throw 'This operator script accepts only reviewed edge source 0186902.' }
    $migrations = @($runtimePlan | Where-Object { $_.Relative -match '^db/edge/migrations/\d{3}_.*\.sql$' })
    if ($migrations.Count -ne 9 -or (($migrations.Relative | Sort-Object | ForEach-Object { $_.Substring(19, 3) }) -join ',') -ne '001,002,003,004,005,006,007,008,009') {
        throw 'Expected the complete, ordered edge migration set 001-009.'
    }
    # All source checks and path plans precede the first destination mutation.
    foreach ($path in @($programRoot, $dataRoot)) {
        if (-not (Test-Path -LiteralPath $path)) { New-ProtectedDirectory $path }
    }
    New-ProtectedDirectory $edgeRoot 'ReadAndExecute'
    New-ProtectedDirectory $postgresRoot 'ReadAndExecute'
    New-ProtectedDirectory $edgeDataRoot
    New-ProtectedDirectory $toolsRoot
    New-ProtectedDirectory $postgresDataRoot
    New-ProtectedDirectory $serviceRoot 'ReadAndExecute'
    New-ProtectedDirectory $runtimeRoot 'ReadAndExecute'
    New-ProtectedDirectory $nodeRoot 'ReadAndExecute'
    New-ProtectedDirectory $postgresBinaries 'ReadAndExecute'
    New-ProtectedDirectory $toolsRelease
    New-ProtectedDirectory (Join-Path $toolsRelease '.local')
    New-ProtectedDirectory (Join-Path $edgeDataRoot 'config') 'ReadAndExecute'
    New-ProtectedDirectory (Join-Path $edgeDataRoot 'logs') 'Modify'
    New-ProtectedDirectory (Join-Path $postgresDataRoot '18')
    New-ProtectedDirectory (Join-Path $postgresDataRoot '18\data')
    Expand-VerifiedPlan $runtimePlan
    Expand-VerifiedPlan $toolsPlan
    Expand-VerifiedPlan $nodePlan
    Expand-VerifiedPlan $postgresPlan
    $winswTarget = Join-Path $serviceRoot 'PickChickEdge.exe'
    $destination = [IO.File]::Open($winswTarget, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $winswFile.CopyTo($destination); $destination.Flush($true) } finally { $destination.Dispose() }
    $nodeVersion = & (Join-Path $nodeRoot 'node.exe') --version
    if ($LASTEXITCODE -ne 0 -or "$nodeVersion".Trim() -ne 'v24.21.0') { throw 'Pinned Node startup/version check failed.' }
    $postgresVersion = & (Join-Path $postgresBinaries 'bin\postgres.exe') --version
    if ($LASTEXITCODE -ne 0 -or "$postgresVersion".Trim() -ne 'postgres (PostgreSQL) 18.6') { throw 'PostgreSQL startup/version check failed; inspect its native dependencies.' }
    $winswVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($winswTarget)
    if ($winswVersion.FileMajorPart -ne 2 -or $winswVersion.FileMinorPart -ne 12) { throw 'Unexpected WinSW file version.' }
    $record = [ordered]@{
        stage = 'files_prepared_only'; recordedAt = [DateTime]::UtcNow.ToString('o'); branchId = $BranchId.ToString()
        releaseName = $ReleaseName; sourceCommit = $manifest.sourceCommit; windowsVersion = $os.Version
        serviceRoot = $serviceRoot; operatorRoot = $toolsRelease; postgresBinaries = $postgresBinaries
        runtimeSha256 = $RuntimeSha256; nodeSha256 = $NodeSha256; postgresSha256 = $PostgresSha256; winSwSha256 = $WinSwSha256
        nodeVersionVerified = $true; postgresVersionVerified = $true
        databaseInitialized = $false; credentialsIssued = $false; migrationsApplied = $false
        servicesRegistered = $false; healthVerified = $false; fulfillmentEnabled = $false
    }
    $recordPath = Join-Path $toolsRelease 'foundation-stage1.json'
    [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
    Write-Output "Stage 1 completed. Files prepared; no database, credentials or services were created. Record: $recordPath"
} catch {
    Write-Warning 'Preparation did not complete. Protected partial files are retained; do not treat them as an installed server or rerun over them.'
    throw
} finally {
    for ($index = $handles.Count - 1; $index -ge 0; $index--) { $handles[$index].Dispose() }
}
