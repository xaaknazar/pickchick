# Parser and actual pure functions only. No Windows service/ACL mutation.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../../infra/windows/install-native-menu-sync.ps1'),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) {throw ($parseErrors | Out-String)}
$functions=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
. ([scriptblock]::Create(($functions.Extent.Text -join "`n")))
function Rejects([scriptblock]$Action) {$rejected=$false;try {& $Action | Out-Null} catch {$rejected=$true};if(-not $rejected){throw 'Expected rejection.'}}
foreach ($case in @(@('','""'),@('a"b','"a\"b"'),@('C:\path\','"C:\path\\"'))) {
    if ((Quote-WindowsArgument $case[0]) -cne $case[1]) {throw 'Process argument escaping differs.'}
}
Rejects {Quote-WindowsArgument "unsafe`nargument"}
$script:runtimeRoot='C:\Program Files\PickChick\Edge\edge-abcdef0\app';$script:logRoot='C:\ProgramData\PickChick\MenuSync\logs'
$arguments=@('--env-file=C:\ProgramData\PickChick\MenuSync\service\menu-sync.env','C:\Program Files\PickChick\Edge\edge-abcdef0\app\infra\windows\native-menu-sync-worker.mjs','C:\ProgramData\PickChick\FulfillmentWorker\device-identity.json','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
[xml]$xml=Build-ServiceXml 'PickChickMenuSyncWorker' 'C:\Program Files\PickChick\Edge\edge-0186902\node\node.exe' $arguments @('PickChickPostgres','PickChickFulfillmentTunnel')
if ($xml.service.id -cne 'PickChickMenuSyncWorker' -or $xml.service.serviceaccount.user -cne 'LocalService' -or $xml.service.delayedAutoStart -cne 'true') {throw 'Service identity differs.'}
if (($xml.service.depend -join ',') -cne 'PickChickPostgres,PickChickFulfillmentTunnel') {throw 'Service dependencies differ.'}
if (-not $xml.service.arguments.StartsWith('"--env-file=C:\ProgramData\PickChick\MenuSync\service\menu-sync.env" "C:\Program Files\PickChick\Edge\edge-abcdef0\app\infra\windows\native-menu-sync-worker.mjs"')) {throw 'Node env-file boundaries differ.'}
if (-not $xml.service.arguments.EndsWith('"C:\ProgramData\PickChick\FulfillmentWorker\device-identity.json" "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"')) {throw 'Identity and scope arguments differ.'}
if (@($xml.service.env | Where-Object {$_.name -in @('NODE_OPTIONS','NODE_PATH') -and $_.value -eq ''}).Count -ne 2) {throw 'Node environment overrides must be cleared.'}
# The installer's own text must keep the reviewed safety properties.
$text=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../infra/windows/install-native-menu-sync.ps1'))
foreach ($required in @("ValidateSet('Inspect','Prepare','Install','Verify')","'PickChickPostgres','PickChickFulfillmentTunnel'",'EDGE_MENU_SYNC_MODE=(off|report|apply)','pickchick_menu_sync:[a-f0-9]{64}@127\.0\.0\.1:55433/pickchick_edge','Stop PickChickMenuSyncWorker before the database phase','FulfillmentWorker\device-identity.json')) {
    if (-not $text.Contains($required)) {throw "Missing installer guard: $required"}
}
foreach ($forbidden in @('Remove-Item','Set-Service','sc.exe','New-NetFirewallRule','Stop-Service','Restart-Computer')) {
    if ($text.Contains($forbidden)) {throw "Unexpected destructive or broad action: $forbidden"}
}
Write-Output 'windows-menu-sync installer checks passed'
