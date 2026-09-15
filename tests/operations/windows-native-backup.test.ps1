# No database or installation actions: parser, source pins and argument binding.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '../../infra/windows'
$tokens = $null; $errors = $null
$path = Join-Path $root 'backup-native-edge.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$installer = Join-Path $root 'install-native-services.ps1'
$source = [IO.File]::ReadAllText($path)
if (-not $source.Contains((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant())) { throw 'Foundation source pin differs.' }
foreach ($name in @('backup-native-edge.mjs', 'native-foundation-db.mjs')) {
    if (-not $source.Contains((Get-FileHash -LiteralPath (Join-Path $root $name) -Algorithm SHA256).Hash.ToLowerInvariant())) { throw 'Backup helper pin differs.' }
}
$foundation = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Foundation parser failed.' }
$names = @('Assert-NtfsPath', 'Assert-Acl', 'Set-KnownDirectoryAcl', 'Write-PrivateText', 'Quote-WindowsArgument', 'Invoke-SetupProcess')
$definitions = @($foundation.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -in $names })
if ($definitions.Count -ne 6) { throw 'Unexpected foundation declarations.' }
. ([scriptblock]::Create(($definitions.Extent.Text -join "`n")))
$privateRoot = 'private folder'; $toolsRoot = 'tools folder'; $pgBin = 'postgres bin'; $BranchId = [guid]::NewGuid()
$arrays = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.ArrayExpressionAst] -and $node.Extent.Text.Contains("'backup-native-edge.mjs'") -and $node.Extent.Text.Contains('$BranchId.ToString()') }, $true)
if ($arrays.Count -ne 1) { throw 'Expected one backup command argument array.' }
$values = @(& ([scriptblock]::Create($arrays[0].Extent.Text)))
if ($values.Count -ne 5 -or $values[1] -cne $toolsRoot -or $values[2] -cne $pgBin -or $values[3] -cne $privateRoot -or $values[4] -cne $BranchId.ToString()) { throw 'Backup command arguments lost boundaries.' }
if ((Quote-WindowsArgument 'C:\ProgramData\PickChick\Backups\test folder\') -cne '"C:\ProgramData\PickChick\Backups\test folder\\"') { throw 'Backup path escaping failed.' }
[pscustomobject]@{ parser = 'pass'; helperPins = 'pass'; reusedDeclarations = 6; argumentBinding = 'pass'; databaseOrWindowsBackupExecuted = $false } | ConvertTo-Json
