Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$path=Join-Path $PSScriptRoot '../../infra/windows/verify-native-connection-recovery.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw ($errors | Out-String)}
$commands=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true) | ForEach-Object {$_.GetCommandName()})
foreach($forbidden in @('Start-Service','Stop-Service','Restart-Service','Set-Service','Set-ItemProperty','Set-Content','Get-Content','Get-ChildItem')) {
    if($forbidden -in $commands) {throw "Unexpected mutation or private file read: $forbidden"}
}
# Execute actual observation helper against mocked SCM, without touching a service.
$fn=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
. ([scriptblock]::Create(($fn.Extent.Text -join "`n")))
function Get-CimInstance { return $null }
$value=Read-ServicePolicy 'PickChickEdge'
if($value.installed -ne $false -or $value.name -ne 'PickChickEdge') {throw 'Missing service observation differs.'}
Write-Output 'PASS: parser, read-only commands, missing service; Windows SCM/reboot/WAN acceptance remains separate.'
