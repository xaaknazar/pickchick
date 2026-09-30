# Pure archive/parser checks; this file never invokes Windows installation steps.
param([string]$RuntimeArchive = '', [string]$NodeArchive = '', [string]$PostgresArchive = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '../../infra/windows/install-native-foundation.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
. ([scriptblock]::Create(($functions.Extent.Text -join "`n")))
Add-Type -AssemblyName System.IO.Compression
$destination = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'pc-stage1-test')
$passed = 0

function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'An unsafe archive input was accepted.' }
}

function Test-Zip([string[]]$Names, [scriptblock]$Action, [switch]$Symlink) {
    $stream = [IO.MemoryStream]::new()
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    foreach ($name in $Names) {
        $entry = $zip.CreateEntry($name)
        if ($Symlink) { $entry.ExternalAttributes = -1610612736 }
    }
    $zip.Dispose()
    $stream.Position = 0
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try { & $Action $zip } finally { $zip.Dispose(); $stream.Dispose() }
}

foreach ($name in @('../outside', '/absolute', 'a/../../outside', 'a\outside', 'a/file:stream', 'a/NUL.txt', 'a/COM1', 'a/trailing.', 'a/trailing ', 'a//b')) {
    Assert-Rejected { Assert-ArchiveName $name }
}
$passed++
Test-Zip @('node_modules/A.js', 'node_modules/a.js') { param($zip) Assert-Rejected { Get-ArchivePlan $zip 'runtime' $destination } }
Test-Zip @('a', 'a/b.js') { param($zip) Assert-Rejected { Get-ArchivePlan $zip 'runtime' $destination } }
Test-Zip @('a/b.js', 'a') { param($zip) Assert-Rejected { Get-ArchivePlan $zip 'runtime' $destination } }
$passed++
Test-Zip @('link') { param($zip) Assert-Rejected { Get-ArchivePlan $zip 'runtime' $destination } } -Symlink
$passed++
Test-Zip @(('a' * 240) + '/file.js') { param($zip) Assert-Rejected { Get-ArchivePlan $zip 'runtime' ($destination + '/longer-parent-directory') } }
$passed++
Test-Zip @('a/', 'a/b.js', 'a/c.js') {
    param($zip)
    $plan = Get-ArchivePlan $zip 'runtime' $destination
    if ($plan.Count -ne 2 -or $plan[0].Relative -ne 'a/b.js') { throw 'Valid ordinary files were not preserved.' }
}
Test-Zip @('node-v24.21.0-win-x64/node.exe', 'node-v24.21.0-win-x64/LICENSE', 'node-v24.21.0-win-x64/node_modules/npm/index.js') {
    param($zip)
    if ((Get-ArchivePlan $zip 'node' $destination).Count -ne 2) { throw 'Node runtime selection included package-manager code.' }
}
Test-Zip @('pgsql/bin/postgres.exe', 'pgsql/lib/example.dll', 'pgsql/share/postgresql.conf.sample', 'pgsql/server_license.txt', 'pgsql/pgAdmin 4/pgAdmin4.exe') {
    param($zip)
    if ((Get-ArchivePlan $zip 'postgres' $destination).Count -ne 4) { throw 'PostgreSQL server selection was incomplete or included pgAdmin.' }
}
$passed++

$realPlans = @()
foreach ($input in @(@('runtime', $RuntimeArchive), @('node', $NodeArchive), @('postgres', $PostgresArchive))) {
    if (-not $input[1]) { continue }
    $stream = [IO.File]::OpenRead($input[1])
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        $plan = Get-ArchivePlan $zip $input[0] $destination
        $realPlans += [pscustomobject]@{ kind = $input[0]; files = $plan.Count }
    } finally { $zip.Dispose(); $stream.Dispose() }
}
[pscustomobject]@{ parser = 'pass'; archiveChecks = $passed; realArchivePlans = $realPlans; windowsAclAndExecution = 'not tested by this suite' } | ConvertTo-Json -Depth 4
