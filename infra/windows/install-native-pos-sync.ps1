#Requires -Version 5.1
<# Prepare generates Windows-only transport keys and a separate database login.
Configure consumes operator-provided trusted host/identity files; Install registers
only the two new transport services. Every phase is resumable by the same private
record. No existing PostgreSQL/Edge service, ordering flag or firewall is changed. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Prepare','Configure','Install','Verify')][string]$Mode,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$ReleaseName,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
    [Parameter(Mandatory=$true)][guid]$BranchId,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$FoundationReleaseName='edge-0186902',
    [string]$ConnectionFile, [string]$KnownHostsFile, [string]$KnownHostsSha256, [string]$IdentityFile,
    [switch]$Resume
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Assert-NtfsPath([string]$Path) {
    if ($Path -notmatch '^[a-zA-Z]:\\' -or $Path.Substring(2).Contains(':')) { throw 'Absolute local NTFS path required.' }
    $full=[IO.Path]::GetFullPath($Path)
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($full))
    if (-not $drive.IsReady -or $drive.DriveFormat -ne 'NTFS' -or $drive.DriveType -ne 'Fixed') { throw 'Fixed NTFS storage required.' }
    $cursor=$full
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Reparse paths are forbidden.' }
        $parent=[IO.Directory]::GetParent($cursor)
        $cursor=if ($null -eq $parent) {$null} else {$parent.FullName}
    }
}
function Assert-Acl([string]$Path,[switch]$ServiceRead,[switch]$ServiceModify,[switch]$Foundation,[switch]$InheritedAllowed) {
    Assert-NtfsPath $Path
    $acl=Get-Acl -LiteralPath $Path
    if (-not $InheritedAllowed -and -not $acl.AreAccessRulesProtected) { throw 'Protected ACL required.' }
    $trusted=@('S-1-5-18','S-1-5-32-544')
    if ($Foundation) { $trusted+= $script:operatorSid.Value }
    $owners=$trusted
    if ($ServiceRead -or $ServiceModify) { $owners+= 'S-1-5-19' }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $owners) { throw 'Unexpected filesystem owner.' }
    [long]$effective=0
    foreach ($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne 'Allow') { throw 'Unexpected ACL entry.' }
        if ($ace.IdentityReference.Value -in $trusted) { continue }
        $rights=if ($ServiceModify) {[Security.AccessControl.FileSystemRights]::Modify} else {[Security.AccessControl.FileSystemRights]::ReadAndExecute}
        $limit=$rights -bor [Security.AccessControl.FileSystemRights]::Synchronize
        if (($ServiceRead -or $ServiceModify) -and $ace.IdentityReference.Value -eq 'S-1-5-19' -and ($ace.FileSystemRights -band (-bnot $limit)) -eq 0) {
            if (($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) {$effective=$effective -bor [long]$ace.FileSystemRights}
            continue
        }
        throw 'Filesystem permissions exceed reviewed principals.'
    }
    if ($ServiceRead -or $ServiceModify) {
        $required=if ($ServiceModify) {[long][Security.AccessControl.FileSystemRights]::Modify} else {[long][Security.AccessControl.FileSystemRights]::ReadAndExecute}
        if (($effective -band $required) -ne $required) {throw 'Required LocalService access is missing.'}
    }
}
function Set-ProtectedAcl([string]$Path,[switch]$Directory,[switch]$ServiceRead,[switch]$ServiceModify) {
    Assert-NtfsPath $Path
    $acl=if ($Directory) {[Security.AccessControl.DirectorySecurity]::new()} else {[Security.AccessControl.FileSecurity]::new()}
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $grants=@{'S-1-5-18'='FullControl';'S-1-5-32-544'='FullControl'}
    if ($ServiceRead) {$grants['S-1-5-19']='ReadAndExecute'}
    if ($ServiceModify) {$grants['S-1-5-19']='Modify'}
    foreach ($sid in $grants.Keys) {
        $inherit=if ($Directory) {'ContainerInherit,ObjectInherit'} else {'None'}
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$grants[$sid],$inherit,'None','Allow'))
    }
    if ($Directory -and -not (Test-Path -LiteralPath $Path)) { [IO.Directory]::CreateDirectory($Path,$acl) | Out-Null }
    else { Set-Acl -LiteralPath $Path -AclObject $acl }
    Assert-Acl $Path -ServiceRead:$ServiceRead -ServiceModify:$ServiceModify
}
function Write-NewText([string]$Path,[string]$Text,[switch]$ServiceRead) {
    Assert-NtfsPath $Path
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
    Set-ProtectedAcl $Path -ServiceRead:$ServiceRead
}
function Save-State {
    $script:state.updatedAt=[DateTime]::UtcNow.ToString('o')
    $temp=Join-Path $script:operatorRoot ('state-'+[guid]::NewGuid().ToString()+'.tmp')
    Write-NewText $temp ($script:state | ConvertTo-Json -Depth 6)
    if (Test-Path -LiteralPath $script:statePath) { [IO.File]::Replace($temp,$script:statePath,[Management.Automation.Language.NullString]::Value) }
    else {[IO.File]::Move($temp,$script:statePath)}
}
function New-Secret {
    $bytes=[byte[]]::new(32);$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try {$rng.GetBytes($bytes)} finally {$rng.Dispose()}
    return [BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
}
function Quote-WindowsArgument([string]$Value) {
    if ($Value.Contains([char]0) -or $Value.Contains("`n") -or $Value.Contains("`r")) {throw 'Unsafe process argument.'}
    $escaped=[regex]::Replace($Value,'(\\*)"','$1$1\"')
    $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
    return '"'+$escaped+'"'
}
function Run-Tool([string]$Exe,[string[]]$Arguments,[int]$TimeoutSeconds=60) {
    $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$Exe
    $start.Arguments=($Arguments | ForEach-Object {Quote-WindowsArgument $_}) -join ' '
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.WorkingDirectory=$script:operatorRoot
    $start.EnvironmentVariables.Clear()
    foreach ($key in @('SystemRoot','WINDIR','ComSpec','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','ProgramData','SystemDrive')) {
        $value=[Environment]::GetEnvironmentVariable($key);if ($value) {$start.EnvironmentVariables[$key]=$value}
    }
    $start.EnvironmentVariables['PATH']=([IO.Path]::GetDirectoryName($script:nodeExe),(Join-Path $env:SystemRoot 'System32')) -join ';'
    $process=[Diagnostics.Process]::new();$process.StartInfo=$start
    try {
        if (-not $process.Start()) {throw 'Operator subprocess could not start.'}
        $output=$process.StandardOutput.ReadToEndAsync();$errors=$process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds*1000)) {$process.Kill();throw 'Operator subprocess timed out; private state retained.'}
        $result=$output.GetAwaiter().GetResult();$null=$errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {throw ('Operator subprocess failed: '+[IO.Path]::GetFileName($Exe)+'. Private state retained; no secret diagnostic was printed.')}
        return $result.Trim()
    } finally {$process.Dispose()}
}
function Read-Json([string]$Path,[int]$Limit=16384) {
    Assert-NtfsPath $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Item -LiteralPath $Path).Length -gt $Limit) {throw 'Missing or oversized operator file.'}
    try {return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)} catch {throw 'Operator JSON could not be decoded; no private content was printed.'}
}
function Hash-File([string]$Path) {Assert-NtfsPath $Path;return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Ensure-Text([string]$Path,[string]$Text,[switch]$ServiceRead) {
    if (Test-Path -LiteralPath $Path) {
        Assert-Acl $Path -ServiceRead:$ServiceRead
        if ([IO.File]::ReadAllText($Path) -cne $Text) {throw 'Existing setup file differs; it was not overwritten.'}
    } else {Write-NewText $Path $Text -ServiceRead:$ServiceRead}
}
function Validate-Connection($Value) {
    if (($Value.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'branchId,deviceId,format,organizationId,remoteApiPort,sshHost,sshPort,sshUser') {throw 'Connection fields differ.'}
    if ($Value.format -cne 'pickchick-pos-sync-connection-v1' -or $Value.sshHost -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$' -or
        $Value.sshUser -cnotmatch '^[a-z_][a-z0-9_-]{0,31}$' -or $Value.sshUser -in @('root','pickchick-ops') -or
        ($Value.sshPort -isnot [int] -and $Value.sshPort -isnot [long]) -or $Value.sshPort -lt 1 -or $Value.sshPort -gt 65535 -or
        ($Value.remoteApiPort -isnot [int] -and $Value.remoteApiPort -isnot [long]) -or $Value.remoteApiPort -lt 1024 -or $Value.remoteApiPort -gt 65535) {throw 'Invalid dedicated tunnel endpoint.'}
    foreach ($name in @('branchId','organizationId','deviceId')) {if ($Value.$name -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') {throw 'Invalid scope UUID.'}}
}
function Validate-KnownHosts([string]$Text,$Connection) {
    $expected=if ($Connection.sshPort -eq 22) {$Connection.sshHost} else {'['+$Connection.sshHost+']:'+$Connection.sshPort}
    $line=$Text.Trim()
    if ($line.Contains("`n") -or $line.Contains("`r")) {throw 'Exactly one trusted host key is required.'}
    $parts=$line -split '\s+'
    if ($parts.Count -ne 3 -or $parts[0] -cne $expected -or $parts[1] -cne 'ssh-ed25519' -or $parts[2] -cnotmatch '^[A-Za-z0-9+/]+={0,2}$') {throw 'Pinned known_hosts differs from the endpoint.'}
    $decoded=[Convert]::FromBase64String($parts[2])
    if ($decoded.Length -ne 51 -or ($decoded[0..3] -join ',') -cne '0,0,0,11' -or ($decoded[15..18] -join ',') -cne '0,0,0,32' -or [Text.Encoding]::ASCII.GetString($decoded,4,11) -cne 'ssh-ed25519') {throw 'Invalid ED25519 host key.'}
}
function Read-KeyBodyAsOperator([string]$Key,[string]$Keygen) {
    # Windows OpenSSH refuses another account's private key even for an elevated
    # operator. Verify an ephemeral operator-only copy, never widen the final
    # LocalService key ACL. The copy remains on this Windows machine only.
    $probe=Join-Path $script:operatorRoot ('key-probe-'+[guid]::NewGuid().ToString())
    Assert-NtfsPath $Key;Assert-NtfsPath $probe
    $created=$false
    try {
        [IO.File]::Copy($Key,$probe,$false);$created=$true
        Set-ProtectedAcl $probe
        return (Public-KeyBody (Run-Tool $Keygen @('-y','-P','','-f',$probe)))
    } finally {if ($created) {[IO.File]::Delete($probe)}}
}
function Public-KeyBody([string]$Text) {
    $line=$Text.Trim()
    if ($line -cnotmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [a-zA-Z0-9._-]{1,80})?$') {throw 'Invalid derived public key.'}
    return (($line -split ' ')[0..1] -join ' ')
}
function Ssh-Path([string]$Path) {
    if ($Path -match '["\r\n%]' -or $Path.Contains([char]0)) {throw 'Unsafe SSH configuration path.'}
    return '"'+$Path.Replace('\','/')+'"'
}
function Build-SshConfig($Connection,[string]$Key,[string]$Hosts) {
    Validate-Connection $Connection
    return @"
Host pickchick-pos-private
  HostName $($Connection.sshHost)
  Port $($Connection.sshPort)
  User $($Connection.sshUser)
  IdentityFile $(Ssh-Path $Key)
  IdentitiesOnly yes
  IdentityAgent none
  BatchMode yes
  PasswordAuthentication no
  ChallengeResponseAuthentication no
  StrictHostKeyChecking yes
  UserKnownHostsFile $(Ssh-Path $Hosts)
  GlobalKnownHostsFile NUL
  UpdateHostKeys no
  ForwardAgent no
  ForwardX11 no
  RequestTTY no
  PermitLocalCommand no
  ExitOnForwardFailure yes
  ServerAliveInterval 15
  ServerAliveCountMax 3
  ConnectTimeout 10
  ConnectionAttempts 1
  LogLevel ERROR
  GatewayPorts no
  EscapeChar none
  LocalForward 127.0.0.1:43100 127.0.0.1:$($Connection.remoteApiPort)
"@
}
function Build-ServiceXml([string]$Id,[string]$Executable,[string[]]$Arguments,[string[]]$Depends) {
    $xmlEscape={param($value) [Security.SecurityElement]::Escape($value)}
    $argsText=($Arguments | ForEach-Object {Quote-WindowsArgument $_}) -join ' '
    $dependencies=($Depends | ForEach-Object {'<depend>'+(& $xmlEscape $_)+'</depend>'}) -join ''
    return @"
<service><id>$Id</id><name>$Id</name><description>PickChick private POS synchronization</description>
<executable>$(& $xmlEscape $Executable)</executable><arguments>$(& $xmlEscape $argsText)</arguments>
<workingdirectory>$(& $xmlEscape $script:runtimeRoot)</workingdirectory>
<serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
<startmode>Automatic</startmode><delayedAutoStart>true</delayedAutoStart>$dependencies
<env name="NODE_OPTIONS" value=""/><env name="NODE_PATH" value=""/>
<stoptimeout>30 sec</stoptimeout><onfailure action="restart" delay="5 sec"/><onfailure action="restart" delay="15 sec"/><onfailure action="restart" delay="60 sec"/>
<resetfailure>1 hour</resetfailure><logpath>$(& $xmlEscape $script:logRoot)</logpath>
<log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log></service>
"@
}
function Read-SyncSecret {
    $path=Join-Path $script:operatorRoot 'sync-secrets.json';Assert-Acl $path
    $value=Read-Json $path
    if ($value.format -cne 'pickchick-pos-sync-secrets-v1' -or $value.syncInstallId -cne $script:state.syncInstallId -or $value.installId -cne $script:state.installId -or $value.branchId -cne $script:state.branchId -or $value.password -cnotmatch '^[a-f0-9]{64}$') {throw 'Private transport secret differs from setup checkpoint.'}
    return $value
}
function Database-Step([string]$Operation,[string]$Binding='') {
    $null=Read-SyncSecret
    $databaseArguments=@((Join-Path $script:runtimeRoot 'infra\windows\native-pos-sync-db.mjs'),$Operation,$script:runtimeRoot,$script:foundationPrivate,$script:operatorRoot,$script:pgData,$script:foundation.systemIdentifier)
    if ($Binding) {$databaseArguments+=$Binding}
    return (Run-Tool $script:nodeExe $databaseArguments | ConvertFrom-Json)
}
function Assert-TransportService([string]$Name,[string]$Image,[string[]]$Depends) {
    $service=Get-CimInstance Win32_Service -Filter "Name='$Name'"
    if ($null -eq $service -or $service.PathName -cne (Quote-WindowsArgument $Image) -or $service.StartName -ine 'NT AUTHORITY\LocalService' -or $service.StartMode -ne 'Auto') {throw 'Existing transport service differs.'}
    $registry=Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\'+$Name)
    if ($registry.DelayedAutoStart -ne 1) {throw 'Transport service must use delayed automatic startup.'}
    $actualDepends=@((Get-Service $Name).ServicesDependedOn | ForEach-Object {$_.Name} | Sort-Object)
    if (($actualDepends -join ',') -cne (($Depends | Sort-Object) -join ',')) {throw 'Transport SCM dependencies differ.'}
    return $service
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') {throw 'Use elevated x64 Windows PowerShell 5.1.'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$script:operatorSid=$identity.User
if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Administrator session required.'}
$branch=$BranchId.ToString()
$root=Join-Path $env:ProgramData 'PickChick\PosSync'
$script:operatorRoot=Join-Path $root 'operator';$serviceRoot=Join-Path $root 'service';$script:logRoot=Join-Path $root 'logs'
$binRoot=Join-Path $env:ProgramFiles 'PickChick\PosSync'
$script:statePath=Join-Path $operatorRoot 'sync-state.json'
$script:runtimeRoot=Join-Path $env:ProgramFiles ('PickChick\Edge\'+$ReleaseName+'\app')
$foundationRoot=Join-Path $env:ProgramData ('PickChick\EdgeTools\'+$FoundationReleaseName)
$script:foundationPrivate=Join-Path $foundationRoot 'private'
$script:nodeExe=Join-Path $env:ProgramFiles ('PickChick\Edge\'+$FoundationReleaseName+'\node\node.exe')
$wrapperSource=Join-Path $env:ProgramFiles ('PickChick\Edge\'+$FoundationReleaseName+'\PickChickEdge.exe')
$script:pgData=Join-Path $env:ProgramData 'PickChick\Postgres\18\data'
$ssh=Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe';$keygen=Join-Path $env:SystemRoot 'System32\OpenSSH\ssh-keygen.exe'
foreach ($path in @($root,$operatorRoot,$serviceRoot,$logRoot,$binRoot,$runtimeRoot,$foundationPrivate,$nodeExe,$wrapperSource,$ssh,$keygen)) {Assert-NtfsPath $path}
foreach ($path in @($ssh,$keygen)) {if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-AuthenticodeSignature -LiteralPath $path).Status -ne 'Valid') {throw 'Signed Windows OpenSSH Client is required. Run inspect-native-ssh.ps1; no Windows capability was installed.'}}
Assert-Acl (Join-Path $env:ProgramData 'PickChick') -Foundation
Assert-Acl (Join-Path $env:ProgramData 'PickChick\EdgeTools') -Foundation
Assert-Acl (Join-Path $env:ProgramFiles 'PickChick') -Foundation
Assert-Acl (Join-Path $env:ProgramFiles 'PickChick\Edge') -Foundation -ServiceRead
Assert-Acl ([IO.Path]::GetDirectoryName($wrapperSource)) -Foundation -ServiceRead
Assert-Acl ([IO.Path]::GetDirectoryName($nodeExe)) -Foundation -ServiceRead
Assert-Acl $nodeExe -Foundation -ServiceRead -InheritedAllowed
Assert-Acl $wrapperSource -Foundation -ServiceRead -InheritedAllowed
Assert-Acl $foundationPrivate -Foundation
Assert-Acl $foundationRoot -Foundation
Assert-Acl (Join-Path $foundationRoot 'foundation-stage1.json') -Foundation -InheritedAllowed
Assert-Acl ([IO.Path]::GetDirectoryName($runtimeRoot)) -Foundation -ServiceRead
Assert-Acl $runtimeRoot -Foundation -ServiceRead
foreach ($file in @('foundation-state.json','foundation-credentials.json')) {
    # Existing foundation files inherit their protected, operator-owned directory.
    $path=Join-Path $foundationPrivate $file
    Assert-Acl $path -Foundation -InheritedAllowed
}
$script:foundation=Read-Json (Join-Path $foundationPrivate 'foundation-state.json')
$stage=Read-Json (Join-Path $foundationRoot 'foundation-stage1.json')
if ($foundation.format -cne 'pickchick-native-state-v1' -or -not $foundation.complete -or $foundation.branchId -cne $branch -or $foundation.releaseName -cne $FoundationReleaseName -or $foundation.computerName -ine $env:COMPUTERNAME -or $foundation.operatorSid -cne $operatorSid.Value -or $stage.branchId -cne $branch -or $foundation.systemIdentifier -cnotmatch '^\d{10,20}$') {throw 'Completed native foundation binding required.'}
# Foundation nodeSha256 pins the ZIP, not the extracted executable. Both bytes are pinned here.
if ($stage.nodeSha256 -cne '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541' -or (Hash-File $nodeExe) -cne 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32' -or (Hash-File $wrapperSource) -cne $stage.winSwSha256) {throw 'Pinned foundation Node or WinSW differs.'}
$manifest=Read-Json (Join-Path $runtimeRoot 'runtime-manifest.json') 8388608
if ($manifest.format -cne 'pickchick-edge-runtime-v1' -or $manifest.sourceCommit -cne $SourceCommit) {throw 'Immutable runtime source differs.'}
# Verify every shipped file before any privileged helper is executed.
foreach ($relative in @('infra/windows/native-pos-sync-db.mjs','infra/windows/native-foundation-db.mjs','infra/windows/pos-sync-worker-grants.mjs','infra/windows/native-pos-sync-worker.mjs','infra/windows/native-pos-sync-permissions.ps1')) {
    if (@($manifest.files | Where-Object {$_.path -ceq $relative}).Count -ne 1) {throw 'Required sync administration file is not pinned in the manifest.'}
}
foreach ($file in $manifest.files) {
    if ($file.path -match '(^|/)\.\.?(/|$)|[:\\]' -or [IO.Path]::IsPathRooted($file.path)) {throw 'Unsafe manifest path.'}
    $path=Join-Path $runtimeRoot $file.path
    Assert-Acl $path -Foundation -ServiceRead -InheritedAllowed
    if ((Hash-File $path) -cne $file.sha256) {throw 'Runtime artifact hash differs.'}
}
if (@($manifest.dependencies | Where-Object {$_.name -ceq '@pickchick/pos-order-sync'}).Count -ne 1) {throw 'Runtime must include the POS sync package and its dependency closure.'}
if (-not (Test-Path -LiteralPath $statePath)) {
    if ($Mode -ne 'Prepare' -or (Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $binRoot)) {throw 'New setup requires Prepare and unused transport directories. Uncertain files were retained.'}
    foreach ($name in @('PickChickSyncTunnel','PickChickPosSync')) {if (Get-Service $name -ErrorAction SilentlyContinue) {throw 'Unowned transport service already exists.'}}
    if (@(Get-NetTCPConnection -LocalPort 43100 -State Listen -ErrorAction SilentlyContinue).Count) {throw 'Local forward port is already occupied.'}
    Set-ProtectedAcl $root -Directory -ServiceRead
    Set-ProtectedAcl $operatorRoot -Directory
    $script:state=[pscustomobject]@{format='pickchick-native-pos-sync-v1';syncInstallId=[guid]::NewGuid().ToString();installId=$foundation.installId;branchId=$branch;computerName=$env:COMPUTERNAME;operatorSid=$operatorSid.Value;releaseName=$ReleaseName;sourceCommit=$SourceCommit;manifestHash=(Hash-File (Join-Path $runtimeRoot 'runtime-manifest.json'));prepared=$false;configured=$false;installed=$false;sshHash=(Hash-File $ssh);keygenHash=(Hash-File $keygen);connectionHash='';identityHash='';knownHostsHash='';publicKeyHash='';updatedAt=''}
    Save-State
} else {
    Assert-Acl $root -ServiceRead;Assert-Acl $operatorRoot;Assert-Acl $statePath
    $script:state=Read-Json $statePath
    if ($state.format -cne 'pickchick-native-pos-sync-v1' -or $state.installId -cne $foundation.installId -or $state.branchId -cne $branch -or $state.computerName -ine $env:COMPUTERNAME -or $state.operatorSid -cne $operatorSid.Value -or $state.releaseName -cne $ReleaseName -or $state.sourceCommit -cne $SourceCommit -or $state.manifestHash -cne (Hash-File (Join-Path $runtimeRoot 'runtime-manifest.json')) -or $state.sshHash -cne (Hash-File $ssh) -or $state.keygenHash -cne (Hash-File $keygen)) {throw 'Existing transport setup binding differs.'}
    if ($Mode -eq 'Prepare' -and -not $Resume) {throw 'Matching existing setup requires -Resume.'}
}
$keyPath=Join-Path $serviceRoot 'id_ed25519'
$identityPath=Join-Path $serviceRoot 'device-identity.json'
$hostsPath=Join-Path $serviceRoot 'known_hosts'
$configPath=Join-Path $serviceRoot 'ssh_config'
$connectionPath=Join-Path $operatorRoot 'connection.json'
$envPath=Join-Path $serviceRoot 'worker.env'
if ($Mode -eq 'Prepare') {
    foreach ($entry in @(@($serviceRoot,'read'),@($binRoot,'read'),@($logRoot,'modify'))) {
        if (Test-Path -LiteralPath $entry[0]) {Assert-Acl $entry[0] -ServiceRead:($entry[1] -eq 'read') -ServiceModify:($entry[1] -eq 'modify')}
        else {Set-ProtectedAcl $entry[0] -Directory -ServiceRead:($entry[1] -eq 'read') -ServiceModify:($entry[1] -eq 'modify')}
    }
    $secretPath=Join-Path $operatorRoot 'sync-secrets.json'
    if (-not (Test-Path -LiteralPath $secretPath)) {Write-NewText $secretPath ([pscustomobject]@{format='pickchick-pos-sync-secrets-v1';installId=$foundation.installId;branchId=$branch;syncInstallId=$state.syncInstallId;password=(New-Secret)} | ConvertTo-Json)}
    $null=Read-SyncSecret
    if (-not (Test-Path -LiteralPath $keyPath) -and -not (Test-Path -LiteralPath ($keyPath+'.pub'))) {
        $null=Run-Tool $keygen @('-q','-t','ed25519','-N','','-C','pickchick-pos-sync','-f',$keyPath)
        Set-ProtectedAcl $keyPath -ServiceRead
        $null=Run-Tool (Join-Path $env:SystemRoot 'System32\icacls.exe') @($keyPath,'/setowner','*S-1-5-19')
        Set-ProtectedAcl ($keyPath+'.pub') -ServiceRead
    }
    Assert-Acl $keyPath -ServiceRead
    if ((Get-Acl -LiteralPath $keyPath).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-19') {throw 'SSH private key must be LocalService-owned; partial key generation requires protected operator inspection.'}
    Assert-Acl ($keyPath+'.pub') -ServiceRead
    $public=[IO.File]::ReadAllText($keyPath+'.pub').Trim()
    if ($public -cnotmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2} pickchick-pos-sync$') {throw 'Generated public key differs.'}
    Ensure-Text (Join-Path $operatorRoot 'tunnel-public-key.pub') ($public+"`n")
    $derived=Read-KeyBodyAsOperator $keyPath $keygen
    if ((Public-KeyBody $public) -cne (Public-KeyBody $derived)) {throw 'SSH public and private key differ.'}
    $hash=Hash-File ($keyPath+'.pub')
    if ($state.publicKeyHash -and $state.publicKeyHash -cne $hash) {throw 'Prepared public key changed.'}
    $state.publicKeyHash=$hash
    $null=Database-Step 'prepare'
    $state.prepared=$true;Save-State
    [pscustomobject]@{phase='prepared';publicKeyFile=(Join-Path $operatorRoot 'tunnel-public-key.pub');privateKeyExported=$false;servicesStarted=$false} | ConvertTo-Json
    return
}
if (-not $state.prepared) {throw 'Prepare must complete first.'}
foreach ($path in @($serviceRoot,$binRoot,$keyPath)) {Assert-Acl $path -ServiceRead}
Assert-Acl $logRoot -ServiceModify
if ((Get-Acl -LiteralPath $keyPath).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-19' -or (Hash-File ($keyPath+'.pub')) -cne $state.publicKeyHash) {throw 'Prepared transport key differs.'}
$derived=Read-KeyBodyAsOperator $keyPath $keygen
if ((Public-KeyBody ([IO.File]::ReadAllText($keyPath+'.pub'))) -cne (Public-KeyBody $derived)) {throw 'SSH key pair differs.'}
if ($Mode -eq 'Configure') {
    if (-not $ConnectionFile -or -not $KnownHostsFile -or -not $IdentityFile -or $KnownHostsSha256 -cnotmatch '^[a-f0-9]{64}$') {throw 'Configure requires operator connection, trusted known_hosts and private identity files.'}
    $connection=Read-Json $ConnectionFile
    Validate-Connection $connection
    if ($connection.branchId -cne $branch) {throw 'Connection branch differs.'}
    if ((Hash-File $KnownHostsFile) -cne $KnownHostsSha256) {throw 'Trusted known_hosts hash differs.'}
    if ((Get-Item -LiteralPath $KnownHostsFile).Length -gt 4096) {throw 'Host key file too large.'}
    $hosts=[IO.File]::ReadAllText($KnownHostsFile);Validate-KnownHosts $hosts $connection
    Assert-Acl $IdentityFile -Foundation
    $device=Read-Json $IdentityFile 4096
    if (($device.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'branch_id,device_id,expires_at,token' -or $device.branch_id -cne $branch -or $device.device_id -cne $connection.deviceId -or $device.token -cnotmatch '^[a-f0-9]{64}$' -or [DateTimeOffset]::Parse($device.expires_at).UtcDateTime -le [DateTime]::UtcNow) {throw 'Transport identity expired or differs from the explicit scope.'}
    $connectionText=$connection | ConvertTo-Json -Compress
    $identityText=$device | ConvertTo-Json -Compress
    Ensure-Text $connectionPath $connectionText
    Ensure-Text $hostsPath $hosts -ServiceRead
    Ensure-Text $identityPath $identityText -ServiceRead
    Ensure-Text $configPath (Build-SshConfig $connection $keyPath $hostsPath) -ServiceRead
    $secret=Read-SyncSecret
    $workerEnv="APP_ENV=local`nEDGE_BRANCH_ID=$branch`nEDGE_DEVICE_ID=$($connection.deviceId)`nEDGE_POS_ORDER_SYNC_ENABLED=true`nEDGE_POS_ORDER_SYNC_CLOUD_ORIGIN=http://127.0.0.1:43100`nEDGE_DATABASE_URL=postgresql://pickchick_pos_sync:$($secret.password)@127.0.0.1:55433/pickchick_edge`n"
    Ensure-Text $envPath $workerEnv -ServiceRead
    $bindingPath=Join-Path $operatorRoot 'binding-input.json'
    Ensure-Text $bindingPath ([pscustomobject]@{branchId=$branch;organizationId=$connection.organizationId;deviceId=$connection.deviceId} | ConvertTo-Json -Compress)
    $bound=Database-Step 'bind' $bindingPath
    Ensure-Text (Join-Path $operatorRoot 'cloud-binding.json') ($bound.scope | ConvertTo-Json -Compress)
    $state.connectionHash=Hash-File $connectionPath;$state.identityHash=Hash-File $identityPath;$state.knownHostsHash=Hash-File $hostsPath
    $state.configured=$true;Save-State
    [pscustomobject]@{phase='configured';cloudBindingFile=(Join-Path $operatorRoot 'cloud-binding.json');servicesStarted=$false;orderingChanged=$false} | ConvertTo-Json
    return
}
if (-not $state.configured) {throw 'Configure must complete first; then register cloud-binding.json on the private cloud database.'}
foreach ($path in @($identityPath,$hostsPath,$configPath,$envPath)) {Assert-Acl $path -ServiceRead}
if ((Hash-File $connectionPath) -cne $state.connectionHash -or (Hash-File $identityPath) -cne $state.identityHash -or (Hash-File $hostsPath) -cne $state.knownHostsHash) {throw 'Configured identity or endpoint changed.'}
Assert-Acl $connectionPath
$connection=Read-Json $connectionPath;Validate-Connection $connection
$device=Read-Json $identityPath 4096
if ($device.branch_id -cne $branch -or $device.device_id -cne $connection.deviceId -or [DateTimeOffset]::Parse($device.expires_at).UtcDateTime -le [DateTime]::UtcNow) {throw 'Configured device identity is expired or changed.'}
$secret=Read-SyncSecret
$expectedEnv="APP_ENV=local`nEDGE_BRANCH_ID=$branch`nEDGE_DEVICE_ID=$($connection.deviceId)`nEDGE_POS_ORDER_SYNC_ENABLED=true`nEDGE_POS_ORDER_SYNC_CLOUD_ORIGIN=http://127.0.0.1:43100`nEDGE_DATABASE_URL=postgresql://pickchick_pos_sync:$($secret.password)@127.0.0.1:55433/pickchick_edge`n"
if ([IO.File]::ReadAllText($envPath) -cne $expectedEnv) {throw 'Dedicated worker environment changed.'}
Validate-KnownHosts ([IO.File]::ReadAllText($hostsPath)) $connection
if ([IO.File]::ReadAllText($configPath) -cne (Build-SshConfig $connection $keyPath $hostsPath)) {throw 'SSH configuration changed.'}
$null=Database-Step 'verify'
$services=@(
    [pscustomobject]@{id='PickChickSyncTunnel';exe=$ssh;args=@('-F',$configPath,'-N','-T','pickchick-pos-private');depends=@()},
    [pscustomobject]@{id='PickChickPosSync';exe=$nodeExe;args=@(('--env-file='+$envPath),(Join-Path $runtimeRoot 'infra\windows\native-pos-sync-worker.mjs'),$identityPath,$branch,$connection.deviceId);depends=@('PickChickEdge','PickChickSyncTunnel')}
)
foreach ($service in $services) {
    $image=Join-Path $binRoot ($service.id+'.exe');$xmlPath=Join-Path $binRoot ($service.id+'.xml')
    $xml=Build-ServiceXml $service.id $service.exe $service.args $service.depends
    if ($Mode -eq 'Install') {
        if (-not (Test-Path -LiteralPath $image)) {[IO.File]::Copy($wrapperSource,$image,$false);Set-ProtectedAcl $image -ServiceRead}
        Ensure-Text $xmlPath $xml -ServiceRead
    }
    Assert-Acl $image -ServiceRead;Assert-Acl $xmlPath -ServiceRead
    if ((Hash-File $image) -cne $stage.winSwSha256 -or [IO.File]::ReadAllText($xmlPath) -cne $xml) {throw 'Transport wrapper or service XML differs.'}
    if (-not (Get-Service $service.id -ErrorAction SilentlyContinue)) {
        if ($Mode -ne 'Install') {throw 'Transport service is missing.'}
        $null=Run-Tool $image @('install')
    }
    $installed=Assert-TransportService $service.id $image $service.depends
    if ($Mode -eq 'Install' -and $installed.State -ne 'Running') {Start-Service $service.id}
}
foreach ($service in $services) {
    $current=Get-Service $service.id;$current.WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
    $null=Assert-TransportService $service.id (Join-Path $binRoot ($service.id+'.exe')) $service.depends
}
$deadline=[DateTime]::UtcNow.AddSeconds(15)
do {
    $listeners=@(Get-NetTCPConnection -LocalPort 43100 -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -or [DateTime]::UtcNow -ge $deadline) {break}
    Start-Sleep -Milliseconds 500
} while ($true)
if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') {throw 'SSH tunnel must bind only 127.0.0.1:43100.'}
$process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listeners[0].OwningProcess)
$tunnel=Get-CimInstance Win32_Service -Filter "Name='PickChickSyncTunnel'"
if ($process.ExecutablePath -ine $ssh -or $process.ParentProcessId -ne $tunnel.ProcessId) {throw 'Local forward is not owned by the reviewed service.'}
$state.installed=$true;Save-State
[pscustomobject]@{phase='running';localForward='127.0.0.1:43100';databaseRole='pickchick_pos_sync';cloudDeliveryVerified=$false;note='Service and listener checks do not prove cloud acknowledgment. Verify real order and kitchen checkpoints separately.'} | ConvertTo-Json
