# Pure parser and SCM registry payload checks; does not invoke maintenance.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot '../../infra/windows/verify-native-maintenance.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-FailureActions' }, $false)
. ([scriptblock]::Create($function.Extent.Text))
function New-Payload {
    $bytes = [byte[]]::new(44)
    foreach ($pair in @(@(0,3600), @(12,3), @(16,20), @(20,1), @(24,5000), @(28,1), @(32,15000), @(36,1), @(40,60000))) { [BitConverter]::GetBytes([uint32]$pair[1]).CopyTo($bytes, $pair[0]) }
    return ,$bytes
}
Assert-FailureActions (New-Payload) 1
$rejections = 0
foreach ($pair in @(@(0,0), @(12,2), @(16,1000), @(20,2), @(32,1), @(40,0))) {
    $bytes = New-Payload; [BitConverter]::GetBytes([uint32]$pair[1]).CopyTo($bytes, $pair[0])
    $failed = $false; try { Assert-FailureActions $bytes 1 } catch { $failed = $true }
    if (-not $failed) { throw 'Unsafe SCM recovery payload accepted.' }; $rejections++
}
foreach ($bytes in @([byte[]]::new(0), [byte[]]::new(19))) {
    $failed = $false; try { Assert-FailureActions $bytes 1 } catch { $failed = $true }
    if (-not $failed) { throw 'Truncated recovery payload accepted.' }; $rejections++
}
$failed = $false; try { Assert-FailureActions (New-Payload) 0 } catch { $failed = $true }
if (-not $failed) { throw 'Disabled non-crash recovery accepted.' }; $rejections++
[pscustomobject]@{ parser = 'pass'; scmPayloadRejections = $rejections; windowsScmAndNtfs = 'not tested by this suite' } | ConvertTo-Json
