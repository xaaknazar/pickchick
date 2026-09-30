# Parser, ACL-policy and real temporary-file byte comparisons. No Windows installation.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '../../infra/windows/verify-native-foundation-recovery.ps1'
$stage1Path = Join-Path $PSScriptRoot '../../infra/windows/install-native-foundation.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
. ([scriptblock]::Create(($functions.Extent.Text -join "`n")))
. (Import-ReviewedStage1Functions $stage1Path)
Add-Type -AssemblyName System.IO.Compression
$passed = 0
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'An unsafe recovery state was accepted.' }
}
$temp = Join-Path ([IO.Path]::GetTempPath()) ('pc-recovery-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp) | Out-Null
try {
    $changed = Join-Path $temp 'changed.ps1'
    [IO.File]::WriteAllText($changed, [IO.File]::ReadAllText($stage1Path) + "`n")
    Assert-Rejected { Import-ReviewedStage1Functions $changed }
    $passed++
    $script:OperatorSid = [pscustomobject]@{ Value = 'S-1-5-21-1-2-3-1001' }
    $full = [long][Security.AccessControl.FileSystemRights]::FullControl
    $read = [long][Security.AccessControl.FileSystemRights]::ReadAndExecute
    function New-Snapshot {
        $rules = @('S-1-5-21-1-2-3-1001', 'S-1-5-18', 'S-1-5-32-544') | ForEach-Object {
            [pscustomobject]@{ Sid = $_; Type = 'Allow'; Rights = $full; Inherited = $false; Inheritance = 3; InheritOnly = $false }
        }
        $rules += [pscustomobject]@{ Sid = 'S-1-5-19'; Type = 'Allow'; Rights = $read; Inherited = $false; Inheritance = 3; InheritOnly = $false }
        return [pscustomobject]@{ Owner = $script:OperatorSid.Value; Protected = $true; RawAceCount = 4; Rules = $rules }
    }
    Assert-RecoveryAclPolicy (New-Snapshot) 'ReadAndExecute' $true $true
    foreach ($mutation in @(
        { param($s) $s.Protected = $false },
        { param($s) $s.Owner = 'S-1-1-0' },
        { param($s) $s.Rules[0].Sid = 'S-1-1-0' },
        { param($s) $s.Rules[3].Rights = $full },
        { param($s) $s.Rules[0].Type = 'Deny' },
        { param($s) $s.Rules[0].InheritOnly = $true },
        { param($s) $s.Rules[0].Inherited = $true },
        { param($s) $s.Rules[0].Inheritance = 0 },
        { param($s) $s.RawAceCount = 5 },
        { param($s) $s.Rules = @(); $s.RawAceCount = 0 }
    )) {
        $snapshot = New-Snapshot; & $mutation $snapshot
        Assert-Rejected { Assert-RecoveryAclPolicy $snapshot 'ReadAndExecute' $true $true }
    }
    $passed++
    $root = Join-Path $temp 'installed'; [IO.Directory]::CreateDirectory($root) | Out-Null
    Assert-ExactChildren $root @()
    [IO.File]::WriteAllText((Join-Path $root 'unexpected'), '')
    Assert-Rejected { Assert-ExactChildren $root @() }
    [IO.File]::Delete((Join-Path $root 'unexpected'))
    Assert-Rejected { Assert-ExactChildren $root @('missing') }
    $passed++
    # Only the NTFS observation adapter is stubbed: policy was exercised above;
    # plan traversal, byte streams and exact file/directory checks run unchanged.
    function Assert-RecoveryAcl([string]$Path, [string]$ServiceRights, [bool]$Protected, [bool]$Directory) { }
    $stream = [IO.MemoryStream]::new()
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    foreach ($name in @('one.bin', 'nested/two.bin')) {
        $entry = $zip.CreateEntry($name); $writer = [IO.StreamWriter]::new($entry.Open())
        try { $writer.Write('known bytes') } finally { $writer.Dispose() }
    }
    $zip.Dispose(); $stream.Position = 0
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        $plan = Get-ArchivePlan $zip 'runtime' $root
        foreach ($item in $plan) {
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target)) | Out-Null
            $source = $item.Entry.Open(); $target = [IO.File]::Create($item.Target)
            try { $source.CopyTo($target) } finally { $source.Dispose(); $target.Dispose() }
        }
        if ((Assert-InstalledPlan $plan $root '') -ne 2) { throw 'Expected both installed byte streams to pass.' }
        [IO.File]::WriteAllText((Join-Path $root 'extra.bin'), 'extra')
        Assert-Rejected { Assert-InstalledPlan $plan $root '' }
        [IO.File]::Delete((Join-Path $root 'extra.bin'))
        [IO.Directory]::CreateDirectory((Join-Path $root 'extra-directory')) | Out-Null
        Assert-Rejected { Assert-InstalledPlan $plan $root '' }
        [IO.Directory]::Delete((Join-Path $root 'extra-directory'))
        $saved = [IO.File]::ReadAllBytes($plan[0].Target)
        [IO.File]::WriteAllText($plan[0].Target, 'wrong bytes')
        Assert-Rejected { Assert-InstalledPlan $plan $root '' }
        [IO.File]::WriteAllBytes($plan[0].Target, $saved)
        [IO.File]::Delete($plan[0].Target)
        Assert-Rejected { Assert-InstalledPlan $plan $root '' }
        [IO.File]::WriteAllBytes($plan[0].Target, $saved)
        [IO.Directory]::CreateDirectory((Join-Path $root '.local')) | Out-Null
        if ((Assert-InstalledPlan $plan $root '' @('.local')) -ne 2) { throw 'Expected an explicitly allowed empty operator directory.' }
        [IO.File]::WriteAllText((Join-Path $root '.local/credential.json'), 'synthetic')
        Assert-Rejected { Assert-InstalledPlan $plan $root '' @('.local') }
        $passed++
    } finally { $zip.Dispose(); $stream.Dispose() }
    $node = (Get-Command node -CommandType Application).Source
    $version = (& $node --version).Trim()
    $previousOptions = $env:NODE_OPTIONS
    try {
        $env:NODE_OPTIONS = '--require /nonexistent-recovery-probe-module'
        if ((Get-NativeVersion $node $version) -ne $version) { throw 'Native version result was not checked.' }
        Assert-Rejected { Get-NativeVersion $node 'v0.0.0' }
    } finally { $env:NODE_OPTIONS = $previousOptions }
    $passed++
    [pscustomobject]@{ parser = 'pass'; recoveryGroups = $passed; windowsAclAndExecution = 'not tested by this suite'; destinationMutation = 'temporary test fixture only' } | ConvertTo-Json
} finally { [IO.Directory]::Delete($temp, $true) }
