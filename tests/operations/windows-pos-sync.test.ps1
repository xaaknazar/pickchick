# Parser and actual pure functions only. No Windows service/ACL mutation.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
foreach ($name in @('inspect-native-ssh.ps1','native-pos-sync-permissions.ps1','install-native-pos-sync.ps1')) {
    $tokens=$null;$parseErrors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot ('../../infra/windows/'+$name)),[ref]$tokens,[ref]$parseErrors)
    if ($parseErrors.Count) {throw ($parseErrors | Out-String)}
}
$functions=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
. ([scriptblock]::Create(($functions.Extent.Text -join "`n")))
function Rejects([scriptblock]$Action) {$rejected=$false;try {& $Action | Out-Null} catch {$rejected=$true};if(-not $rejected){throw 'Expected rejection.'}}
foreach ($case in @(@('','""'),@('a"b','"a\"b"'),@('C:\path\','"C:\path\\"'))) {
    if ((Quote-WindowsArgument $case[0]) -cne $case[1]) {throw 'Process argument escaping differs.'}
}
Rejects {Quote-WindowsArgument "unsafe`nargument"}
$connection='{"format":"pickchick-pos-sync-connection-v1","sshHost":"vps.example.test","sshPort":22,"sshUser":"dedicated_tunnel","remoteApiPort":13100,"branchId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","deviceId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","organizationId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}' | ConvertFrom-Json
Validate-Connection $connection
$ssh=Build-SshConfig $connection 'C:\Private Folder\id_ed25519' 'C:\Private Folder\known_hosts'
foreach ($required in @('BatchMode yes','IdentityAgent none','StrictHostKeyChecking yes','ExitOnForwardFailure yes','ServerAliveInterval 15','ServerAliveCountMax 3','ForwardAgent no','ForwardX11 no','GlobalKnownHostsFile NUL','LocalForward 127.0.0.1:43100 127.0.0.1:13100','IdentityFile "C:/Private Folder/id_ed25519"')) {
    if (-not $ssh.Contains($required)) {throw 'Missing SSH restriction.'}
}
Rejects {Build-SshConfig $connection 'C:\%h\key' 'C:\known_hosts'}
$connection.sshUser='root';Rejects {Validate-Connection $connection};$connection.sshUser='dedicated_tunnel'
$connection.sshHost="host`nProxyCommand evil";Rejects {Validate-Connection $connection};$connection.sshHost='vps.example.test'
# Structurally valid synthetic public ED25519 wire blob, no actual key/secret.
$bytes=[byte[]]::new(51);$bytes[3]=11;[Text.Encoding]::ASCII.GetBytes('ssh-ed25519').CopyTo($bytes,4);$bytes[18]=32
$public=[Convert]::ToBase64String($bytes)
$keyBody='ssh-ed25519 '+$public
if ((Public-KeyBody $keyBody) -cne (Public-KeyBody ($keyBody+' pickchick-pos-sync'))) {throw 'Derived key comment must not affect identity.'}
Rejects {Public-KeyBody ($keyBody+"`nssh-ed25519 "+$public)}

Validate-KnownHosts ("vps.example.test ssh-ed25519 "+$public+"`n") $connection
Rejects {Validate-KnownHosts ("other.example.test ssh-ed25519 "+$public) $connection}
Rejects {Validate-KnownHosts ("vps.example.test ssh-ed25519 "+$public+"`nother ssh-ed25519 "+$public) $connection}
$connection.sshPort=2222
Validate-KnownHosts ("[vps.example.test]:2222 ssh-ed25519 "+$public) $connection
$script:runtimeRoot='C:\Program Files\PickChick\App';$script:logRoot='C:\ProgramData\PickChick\Logs'
[xml]$xml=Build-ServiceXml 'PickChickPosSync' 'C:\Program Files\Node\node.exe' @('--env-file=C:\Private Folder\worker.env','worker.mjs') @('PickChickEdge','PickChickSyncTunnel')
if ($xml.service.serviceaccount.user -cne 'LocalService' -or $xml.service.delayedAutoStart -cne 'true' -or ($xml.service.depend -join ',') -cne 'PickChickEdge,PickChickSyncTunnel') {throw 'Service identity/dependencies differ.'}
if ($xml.service.arguments -cne '"--env-file=C:\Private Folder\worker.env" "worker.mjs"') {throw 'Node env-file boundaries differ.'}
# Test durable File.Replace/CreateNew on a new disposable local directory only.
$script:operatorRoot=Join-Path ([IO.Path]::GetTempPath()) ('sync-state-test-'+[guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($script:operatorRoot) | Out-Null
$script:statePath=Join-Path $script:operatorRoot 'state.json'
function Assert-NtfsPath([string]$Path) {if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)) -cne $script:operatorRoot) {throw 'Test path escaped temporary root.'}}
function Set-ProtectedAcl([string]$Path,[switch]$ServiceRead) {Assert-NtfsPath $Path}
function Assert-Acl([string]$Path,[switch]$ServiceRead) {Assert-NtfsPath $Path}
try {
    $script:state=[pscustomobject]@{prepared=$false;updatedAt=''};Save-State
    $script:state.prepared=$true;Save-State
    if (-not (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).prepared) {throw 'State replacement failed.'}
    $file=Join-Path $operatorRoot 'immutable.json';Ensure-Text $file 'first';Ensure-Text $file 'first'
    Rejects {Ensure-Text $file 'different'}
    if ([IO.File]::ReadAllText($file) -cne 'first') {throw 'Immutable setup file overwritten.'}
    $script:state=[pscustomobject]@{syncInstallId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';installId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';branchId='cccccccc-cccc-4ccc-8ccc-cccccccccccc'}
    $private=[pscustomobject]@{format='pickchick-pos-sync-secrets-v1';syncInstallId=$state.syncInstallId;installId=$state.installId;branchId=$state.branchId;password=('0'*64)}
    $secretFile=Join-Path $operatorRoot 'sync-secrets.json'
    Write-NewText $secretFile ($private | ConvertTo-Json)
    $null=Read-SyncSecret
    $script:state.syncInstallId='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    Rejects {Read-SyncSecret}
    $key=Join-Path $operatorRoot 'synthetic-key';Write-NewText $key 'synthetic local-only private fixture'
    $script:probeSeen=''
    function Run-Tool([string]$Exe,[string[]]$Arguments) {
        $script:probeSeen=$Arguments[-1]
        if (-not (Test-Path -LiteralPath $script:probeSeen) -or [IO.Path]::GetDirectoryName($script:probeSeen) -cne $script:operatorRoot) {throw 'Private key probe escaped protected operator root.'}
        return $keyBody+' pickchick-pos-sync'
    }
    if ((Read-KeyBodyAsOperator $key 'synthetic-keygen') -cne $keyBody -or (Test-Path -LiteralPath $script:probeSeen)) {throw 'Temporary private probe not cleaned after verification.'}
    function Run-Tool([string]$Exe,[string[]]$Arguments) {$script:probeSeen=$Arguments[-1];throw 'synthetic verification failure'}
    Rejects {Read-KeyBodyAsOperator $key 'synthetic-keygen'}
    if (Test-Path -LiteralPath $script:probeSeen) {throw 'Temporary private probe not cleaned after failure.'}


} finally {[IO.Directory]::Delete($script:operatorRoot,$true)}
[pscustomobject]@{parser='pass';sshAndHostPinning='pass';serviceArguments='pass';stateRecovery='pass';windowsAclAndScm='not executed on this host'} | ConvertTo-Json
