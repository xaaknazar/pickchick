# Parser, pure functions and synthetic temporary state files; no installation.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '../../infra/windows/install-native-services.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
. ([scriptblock]::Create(($functions.Extent.Text -join "`n")))
$cases = @(
    @('', '""'), @('plain', '"plain"'), @('C:\test folder\file', '"C:\test folder\file"'),
    @('C:\folder\', '"C:\folder\\"'), @('a"b', '"a\"b"'), @('a\"b', '"a\\\"b"')
)
foreach ($case in $cases) { if ((Quote-WindowsArgument $case[0]) -cne $case[1]) { throw 'CRT argument escaping differs.' } }
foreach ($invalid in @("a`nb", "a`rb", ('a' + [char]0 + 'b'))) {
    $rejected = $false
    try { Quote-WindowsArgument $invalid | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Unsafe process argument was accepted.' }
}
$secrets = @(1..100 | ForEach-Object { New-Secret })
if (@($secrets | Sort-Object -Unique).Count -ne 100 -or @($secrets | Where-Object { $_ -cnotmatch '^[a-f0-9]{64}$' }).Count) { throw 'Generated password format/uniqueness failed.' }
# Evaluate the actual argument-array AST with harmless mock paths, so regression
# coverage catches PowerShell comma/concatenation precedence in the installer.
$pwFile = 'password with space'; $ownerEnv = 'owner with space'; $pgData = 'data'
$toolsRoot = 'tools'; $copiedHelper = 'helper'; $branch = 'branch'
$argumentArrays = $ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.ArrayExpressionAst] -and
    ($node.Extent.Text -match "--pwfile=|--env-file=")
}, $true)
if ($argumentArrays.Count -ne 3) { throw 'Expected exactly three process argument regression cases.' }
foreach ($array in $argumentArrays) {
    $values = & ([scriptblock]::Create($array.Extent.Text))
    if ($array.Extent.Text.Contains('--pwfile=')) {
        if ($values.Count -ne 10 -or $values[3] -cne '--pwfile=password with space' -or $values[4] -cne '--encoding=UTF8') { throw 'initdb arguments lost their boundaries.' }
    } else {
        if ($values[0] -cne '--env-file=owner with space' -or $values.Count -lt 2) { throw 'Node arguments lost their boundaries.' }
    }
}
# Real filesystem writes exercise the actual Save-State/File.Replace overload.
# Only the NTFS-path guard is replaced, confined to this synthetic temp directory;
# no ACL/service installation functions execute in this suite.
$script:privateRoot = Join-Path ([IO.Path]::GetTempPath()) ('pickchick-state-test-' + [guid]::NewGuid().ToString())
$script:statePath = Join-Path $script:privateRoot 'foundation-state.json'
[IO.Directory]::CreateDirectory($script:privateRoot) | Out-Null
function Assert-NtfsPath([string]$Path) {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)) -ne $script:privateRoot) { throw 'Test attempted a path outside its temporary directory.' }
}
try {
    $script:state = [pscustomobject]@{ marker = 'first'; updatedAt = '' }
    Save-State
    foreach ($marker in @('second', 'third')) {
        $script:state.marker = $marker
        Save-State
        $recorded = Get-Content -LiteralPath $script:statePath -Raw | ConvertFrom-Json
        if ($recorded.marker -cne $marker -or -not $recorded.updatedAt) { throw 'Atomic state replacement did not persist the new record.' }
    }
    if (@(Get-ChildItem -LiteralPath $script:privateRoot -Force).Count -ne 1) { throw 'Successful replacement left an unexpected backup/temp file.' }
} finally { [IO.Directory]::Delete($script:privateRoot, $true) }
[pscustomobject]@{ parser = "pass"; argumentEscaping = "pass"; generatedCredentials = "pass"; argumentArrays = 3; stateReplacements = 2; windowsServicesAndAcl = "not tested by this suite" } | ConvertTo-Json
