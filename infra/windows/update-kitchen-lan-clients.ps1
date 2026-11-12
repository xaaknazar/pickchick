#Requires -Version 5.1
<# Rewrite the client list of the installed PickChick LAN gateway on the branch server
(cutover CL-4, contracts sections 5.5, 6.1, 6.2 steps 1 and 4).

-ClientsFile is a UTF-8 JSON array, one entry per monoblock:
  [{"address":"<private IPv4>","profile":"kitchen|display|pos","label":"<optional, 1..60>"}]
Up to 32 entries; the server's own address is never listed (it keeps the kitchen profile).

Two modes:
- default: installs the reviewed gateway, route profiles and check (SHA-256 pinned), validates
  the new config with `node kitchen-lan-gateway.mjs --check` before anything stops, and writes
  `clients[]` (maxConnections 64);
- -Legacy (task K7, before the gateway with profiles): keeps the installed gateway code and
  writes the old `clientAddresses` format; every entry must be a kitchen screen, at most 20.
Both: the private config is replaced in place (its protected ACL is kept and checked), the
firewall rule PickChickKitchenLAN gets exactly these remote addresses, the service restarts and
kitchen-lan-check.mjs must pass. Any failure after the service stopped restores the previous
config, code and firewall and starts the service again. The previous files stay in
private\backup-<UTC>. PostgreSQL, the edge service and iiko are not touched. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ClientsFile,
    [switch]$Legacy,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$GatewaySha256='',
    [ValidatePattern('^[a-f0-9]{64}$')][string]$ProfilesSha256='',
    [ValidatePattern('^[a-f0-9]{64}$')][string]$CheckSha256='',
    [string]$FoundationScript=(Join-Path $PSScriptRoot 'install-native-foundation.ps1'),
    [string]$GatewayScript=(Join-Path $PSScriptRoot 'kitchen-lan-gateway.mjs'),
    [string]$ProfilesScript=(Join-Path $PSScriptRoot 'lan-route-profiles.mjs'),
    [string]$CheckScript=(Join-Path $PSScriptRoot 'kitchen-lan-check.mjs')
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Test-LanIPv4([string]$Value) {
    $address=$null
    if(-not [Net.IPAddress]::TryParse($Value,[ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $address.ToString() -cne $Value) {return $false}
    $b=$address.GetAddressBytes()
    return $b[0] -eq 10 -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or ($b[0] -eq 192 -and $b[1] -eq 168)
}
function Test-LanText($Value,[int]$Max) {
    return $Value -is [string] -and $Value.Length -ge 1 -and $Value.Length -le $Max -and $Value -notmatch '[\x00-\x1f\x7f]'
}
function Read-LanClients([byte[]]$Bytes,[string]$BindAddress,[switch]$Legacy) {
    # The same rules as clientProfiles() in kitchen-lan-gateway.mjs, checked before any change.
    if($null -eq $Bytes -or $Bytes.Length -eq 0 -or $Bytes.Length -gt 16384) {throw 'LAN_CLIENTS_INVALID: the clients file is empty or too large.'}
    $offset=0
    if($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {$offset=3}
    try {$text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes,$offset,$Bytes.Length-$offset).Trim()} catch {throw 'LAN_CLIENTS_INVALID: the clients file is not UTF-8.'}
    if(-not $text.StartsWith('[') -or -not $text.EndsWith(']')) {throw 'LAN_CLIENTS_INVALID: a JSON array is required.'}
    try {$parsed=ConvertFrom-Json -InputObject $text} catch {throw 'LAN_CLIENTS_INVALID: not JSON.'}
    $items=@($parsed)
    $limit=32
    if($Legacy) {$limit=20}
    if($items.Count -lt 1 -or $items.Count -gt $limit) {throw "LAN_CLIENTS_INVALID: 1..$limit clients are required."}
    $seen=@{}
    $result=@()
    foreach($item in $items) {
        if($item -isnot [Management.Automation.PSCustomObject]) {throw 'LAN_CLIENTS_INVALID: every entry must be an object.'}
        $names=@($item.PSObject.Properties.Name)
        foreach($name in $names) {if($name -cnotin @('address','profile','label')) {throw "LAN_CLIENTS_INVALID: unexpected key $name."}}
        if($names -cnotcontains 'address' -or $names -cnotcontains 'profile') {throw 'LAN_CLIENTS_INVALID: address and profile are required.'}
        if($item.address -isnot [string] -or -not (Test-LanIPv4 $item.address)) {throw 'LAN_CLIENTS_INVALID: every address must be a private IPv4 in canonical form.'}
        if($item.address -ceq $BindAddress) {throw 'LAN_CLIENTS_INVALID: the server address is not a client.'}
        if($seen.ContainsKey($item.address)) {throw "LAN_CLIENTS_INVALID: $($item.address) is listed twice."}
        if($item.profile -isnot [string] -or $item.profile -cnotin @('kitchen','display','pos')) {throw 'LAN_CLIENTS_INVALID: profile must be kitchen, display or pos.'}
        if($Legacy -and $item.profile -cne 'kitchen') {throw 'LAN_CLIENTS_LEGACY_KITCHEN_ONLY: the installed gateway has no profiles; list kitchen screens only, the board and cash desks come with the gateway update.'}
        $entry=[ordered]@{address=$item.address;profile=$item.profile}
        if($names -ccontains 'label') {
            if(-not (Test-LanText $item.label 60)) {throw 'LAN_CLIENTS_INVALID: label must be 1..60 characters without control characters.'}
            $entry.label=$item.label
        }
        $seen[$item.address]=$true
        $result+=$entry
    }
    return $result
}
function ConvertTo-LanJsonString([string]$Value) {
    # ASCII JSON: every non-ASCII or control character as \uXXXX; deterministic on every edition.
    $builder=[Text.StringBuilder]::new()
    $null=$builder.Append('"')
    foreach($character in $Value.ToCharArray()) {
        $code=[int]$character
        if($code -eq 34) {$null=$builder.Append('\"')}
        elseif($code -eq 92) {$null=$builder.Append('\\')}
        elseif($code -lt 32 -or $code -gt 126) {$null=$builder.Append(('\u{0:x4}' -f $code))}
        else {$null=$builder.Append($character)}
    }
    $null=$builder.Append('"')
    return $builder.ToString()
}
function New-LanGatewayConfig($Current,$Clients,[switch]$Legacy) {
    # Keeps bindAddress, port, edgePort, pfxPath and passphrase of the installed config.
    $names=@($Current.PSObject.Properties.Name)
    foreach($name in $names) {if($name -cnotin @('bindAddress','port','clientAddresses','clients','maxConnections','edgePort','pfxPath','passphrase')) {throw "LAN_CONFIG_INVALID: unexpected key $name in the installed config."}}
    foreach($name in @('bindAddress','port','edgePort','pfxPath','passphrase')) {if($names -cnotcontains $name) {throw "LAN_CONFIG_INVALID: $name is missing in the installed config."}}
    if(-not (Test-LanIPv4 $Current.bindAddress)) {throw 'LAN_CONFIG_INVALID: bindAddress.'}
    foreach($port in @($Current.port,$Current.edgePort)) {if(($port -isnot [int] -and $port -isnot [long]) -or $port -lt 1 -or $port -gt 65535) {throw 'LAN_CONFIG_INVALID: port.'}}
    if($Current.pfxPath -isnot [string] -or $Current.passphrase -isnot [string] -or $Current.passphrase.Length -lt 32) {throw 'LAN_CONFIG_INVALID: TLS key settings.'}
    # Parenthesized: the array comma binds tighter than +.
    $parts=@(
        ('"bindAddress":'+(ConvertTo-LanJsonString $Current.bindAddress)),
        ('"port":'+[int]$Current.port)
    )
    if($Legacy) {
        $parts+='"clientAddresses":['+((@($Clients) | ForEach-Object {ConvertTo-LanJsonString $_.address}) -join ',')+']'
    } else {
        $items=@(foreach($client in @($Clients)) {
            $fields=@(('"address":'+(ConvertTo-LanJsonString $client.address)),('"profile":'+(ConvertTo-LanJsonString $client.profile)))
            if($client.Contains('label')) {$fields+='"label":'+(ConvertTo-LanJsonString $client.label)}
            '{'+($fields -join ',')+'}'
        })
        $parts+='"clients":['+($items -join ',')+']'
        $parts+='"maxConnections":64'
    }
    $parts+='"edgePort":'+[int]$Current.edgePort
    $parts+='"pfxPath":'+(ConvertTo-LanJsonString $Current.pfxPath)
    $parts+='"passphrase":'+(ConvertTo-LanJsonString $Current.passphrase)
    $json='{'+($parts -join ',')+'}'
    if($json.Length -gt 16384) {throw 'LAN_CONFIG_INVALID: the gateway config would exceed 16 KiB; shorten the labels.'}
    return $json
}
function Get-LanProfileCounts($Clients) {
    $counts=[ordered]@{kitchen=0;display=0;pos=0}
    foreach($client in @($Clients)) {$counts[$client.profile]++}
    return $counts
}
function Assert-LanAcl([string]$Path,[string]$ServiceRights='',[switch]$Protected) {
    $null=Assert-LocalNtfsPath $Path
    $acl=Get-Acl -LiteralPath $Path
    if ($Protected -and -not $acl.AreAccessRulesProtected) { throw 'Protected root ACL required.' }
    $trusted=@($script:OperatorSid.Value,'S-1-5-18','S-1-5-32-544')
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Unexpected file owner.' }
    [long]$effective=0
    foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        $sid=$ace.IdentityReference.Value
        if ($ace.AccessControlType -ne 'Allow') { throw 'Unexpected deny ACL.' }
        if ($sid -in $trusted) { continue }
        if ($sid -ne 'S-1-5-19' -or -not $ServiceRights) { throw 'Unexpected private/service principal.' }
        $limit=[long][Security.AccessControl.FileSystemRights]$ServiceRights -bor [long][Security.AccessControl.FileSystemRights]::Synchronize
        if (([long]$ace.FileSystemRights -band (-bnot $limit)) -ne 0) { throw 'Service rights exceed allowed access.' }
        if (($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) { $effective=$effective -bor [long]$ace.FileSystemRights }
    }
    if ($ServiceRights -and ($effective -band [long][Security.AccessControl.FileSystemRights]$ServiceRights) -ne [long][Security.AccessControl.FileSystemRights]$ServiceRights) { throw 'Required service access is missing.' }
}
function Write-LanNewFile([string]$Path,[byte[]]$Bytes) {
    # A new file in a protected directory inherits that directory's reviewed ACL.
    $null=Assert-LocalNtfsPath $Path
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
}
function Set-LanFile([string]$Path,[byte[]]$Bytes,[string]$Stamp,[string]$Suffix) {
    # Complete on disk first, then replaces the target; ReplaceFile keeps the target's ACL.
    # No backup file: Windows PowerShell 5.1 passes $null to a string parameter as an empty
    # string, which File.Replace refuses, so the null is spelled out with NullString.
    $temporary="$Path.$Suffix-$Stamp"
    Write-LanNewFile $temporary $Bytes
    try {
        if([IO.File]::Exists($Path)) {[IO.File]::Replace($temporary,$Path,[Management.Automation.Language.NullString]::Value)} else {[IO.File]::Move($temporary,$Path)}
    } finally {if([IO.File]::Exists($temporary)) {Remove-Item -LiteralPath $temporary -Force}}
}
function Get-LanFileSha256([string]$Path) {
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $hash=[Security.Cryptography.SHA256]::Create()
        try {return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant()} finally {$hash.Dispose()}
    } finally {$stream.Dispose()}
}

if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') {throw 'Use elevated x64 Windows PowerShell 5.1.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
if(-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Administrator elevation required.'}
if(-not $Legacy -and (-not $GatewaySha256 -or -not $ProfilesSha256 -or -not $CheckSha256)) {throw 'The gateway update needs -GatewaySha256, -ProfilesSha256 and -CheckSha256 from the delivery manifest (or -Legacy for the old format).'}
if($Legacy -and ($GatewaySha256 -or $ProfilesSha256 -or $CheckSha256)) {throw '-Legacy keeps the installed gateway code; do not pass new code hashes.'}
$program=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PickChick'
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PickChick'
$serviceRoot=Join-Path $program 'KitchenLAN'
$dataRoot=Join-Path $data 'KitchenLAN'
$privateRoot=Join-Path $dataRoot 'private'
$serviceXml=Join-Path $serviceRoot 'PickChickKitchenLAN.xml'
$gatewayTarget=Join-Path $serviceRoot 'kitchen-lan-gateway.mjs'
$profilesTarget=Join-Path $serviceRoot 'lan-route-profiles.mjs'
$checkTarget=Join-Path $serviceRoot 'kitchen-lan-check.mjs'
$configPath=Join-Path $privateRoot 'gateway.json'
$pfxPath=Join-Path $privateRoot 'server.pfx'
$publicPath=Join-Path $dataRoot 'public-kitchen-config.json'
$lanPublicPath=Join-Path $dataRoot 'public-lan-config.json'
$recordPath=Join-Path $dataRoot 'installation.json'
$stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')

$source=[IO.File]::Open($FoundationScript,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
    $hash=[Security.Cryptography.SHA256]::Create()
    try {$actual=[BitConverter]::ToString($hash.ComputeHash($source)).Replace('-','').ToLowerInvariant()} finally {$hash.Dispose()}
    if($actual -cne '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5') {throw 'Reviewed NTFS helpers differ.'}
    $source.Position=0;$reader=[IO.StreamReader]::new($source)
    try {$sourceText=$reader.ReadToEnd()} finally {$reader.Dispose()}
} finally {$source.Dispose()}
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($sourceText,[ref]$tokens,[ref]$errors)
if($errors.Count) {throw 'Invalid helper source.'}
foreach($name in @('Assert-LocalNtfsPath','Open-VerifiedFile','New-ProtectedDirectory','Assert-ProtectedDirectory')) {
    $found=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false)
    if(@($found).Count -ne 1) {throw 'Reviewed helper missing.'}
    . ([scriptblock]::Create($found[0].Extent.Text))
}

# ---- The installation as it is now: nothing below changes anything yet. ----
$service=Get-CimInstance Win32_Service -Filter "Name='PickChickKitchenLAN'"
if(-not $service -or $service.StartName -ne 'NT AUTHORITY\LocalService' -or $service.StartMode -ne 'Auto') {throw 'PickChickKitchenLAN is not installed as reviewed (run install-kitchen-lan.ps1 first).'}
Assert-ProtectedDirectory $serviceRoot 'ReadAndExecute'
Assert-ProtectedDirectory $dataRoot
Assert-ProtectedDirectory $privateRoot 'ReadAndExecute'
Assert-LanAcl $configPath 'ReadAndExecute'
Assert-LanAcl $pfxPath 'ReadAndExecute'
$recordBytes=[IO.File]::ReadAllBytes($recordPath)
if($recordBytes.Length -gt 16384) {throw 'Installation record is too large.'}
$record=ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false,$true).GetString($recordBytes))
if($record.format -cnotin @('pickchick-kitchen-lan-v1','pickchick-kitchen-lan-v2') -or $record.completed -ne $true) {throw 'A completed installation record is required.'}
$recordNames=@($record.PSObject.Properties.Name)
[xml]$xml=[IO.File]::ReadAllText($serviceXml)
$node=[string]$xml.service.executable
if(-not $node.StartsWith($program+'\',[StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($node)) {throw 'The service Node executable is not the reviewed one.'}
if([string]$xml.service.arguments -cne ('"'+$gatewayTarget+'" "'+$configPath+'"')) {throw 'The service arguments differ from the installation.'}
$nodeVersion=(& $node --version)
if($LASTEXITCODE -ne 0 -or [string]$nodeVersion -cnotmatch '\Av24\.') {throw 'Node 24 is required for the gateway.'}
if((Get-LanFileSha256 $gatewayTarget) -cne [string]$record.gatewaySha256 -or (Get-LanFileSha256 $checkTarget) -cne [string]$record.checkSha256) {throw 'The installed gateway files differ from the installation record; inspect before changing anything.'}
if($recordNames -ccontains 'profilesSha256' -and $record.profilesSha256 -and (Get-LanFileSha256 $profilesTarget) -cne [string]$record.profilesSha256) {throw 'The installed route profiles differ from the installation record.'}
$currentBytes=[IO.File]::ReadAllBytes($configPath)
if($currentBytes.Length -gt 16384) {throw 'The installed gateway config is too large.'}
$current=ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false,$true).GetString($currentBytes))
if($current.bindAddress -cne [string]$record.cashierAddress -or $current.pfxPath -cne $pfxPath) {throw 'The installed gateway config differs from the installation record.'}
$bind=[string]$current.bindAddress
$port=[int]$current.port
$clients=@(Read-LanClients ([IO.File]::ReadAllBytes($ClientsFile)) $bind -Legacy:$Legacy)
$addresses=@($clients | ForEach-Object {$_.address})
$counts=Get-LanProfileCounts $clients
$newJson=New-LanGatewayConfig $current $clients -Legacy:$Legacy
$rule=Get-NetFirewallRule -Name PickChickKitchenLAN
$addressFilter=$rule | Get-NetFirewallAddressFilter
$portFilter=$rule | Get-NetFirewallPortFilter
$appFilter=$rule | Get-NetFirewallApplicationFilter
if($rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or (@($addressFilter.LocalAddress) -join ',') -cne $bind -or $portFilter.Protocol -ne 'TCP' -or [string]$portFilter.LocalPort -cne [string]$port -or $appFilter.Program -ne $node) {throw 'The firewall rule PickChickKitchenLAN differs from the installation.'}
$previousRemote=@($addressFilter.RemoteAddress)
$handles=[Collections.Generic.List[IDisposable]]::new()
$newConfigPath="$configPath.new-$stamp"
$backupRoot=Join-Path $privateRoot "backup-$stamp"
$stopped=$false
try {
    $code=@()
    if(-not $Legacy) {
        if([IO.Path]::GetFileName($GatewayScript) -cne 'kitchen-lan-gateway.mjs' -or [IO.Path]::GetFileName($ProfilesScript) -cne 'lan-route-profiles.mjs' -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($GatewayScript)) -ne [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ProfilesScript))) {throw 'The gateway and its route profiles must be the delivered files side by side.'}
        $gatewaySource=Open-VerifiedFile $GatewayScript $GatewaySha256;$handles.Add($gatewaySource)
        $profilesSource=Open-VerifiedFile $ProfilesScript $ProfilesSha256;$handles.Add($profilesSource)
        $checkSource=Open-VerifiedFile $CheckScript $CheckSha256;$handles.Add($checkSource)
        $code=@(@($gatewaySource,$gatewayTarget,$GatewaySha256),@($profilesSource,$profilesTarget,$ProfilesSha256),@($checkSource,$checkTarget,$CheckSha256))
    }
    Write-LanNewFile $newConfigPath ([Text.UTF8Encoding]::new($false).GetBytes($newJson))
    Assert-LanAcl $newConfigPath 'ReadAndExecute'
    if(-not $Legacy) {
        # The delivered gateway validates the new config and the PFX passphrase; nothing stops yet.
        $checked=(& $node $GatewayScript --check $newConfigPath)
        if($LASTEXITCODE -ne 0) {throw 'The new gateway rejected the new config; nothing was changed.'}
        $summary=[string]$checked | ConvertFrom-Json
        if($summary.check -cne 'LAN_GATEWAY_CONFIG_OK' -or $summary.format -cne 'clients' -or $summary.clients.kitchen -ne $counts.kitchen -or $summary.clients.display -ne $counts.display -or $summary.clients.pos -ne $counts.pos -or $summary.maxConnections -ne 64) {throw 'The new gateway read another client list than requested; nothing was changed.'}
    }
    New-ProtectedDirectory $backupRoot
    [IO.File]::Copy($configPath,(Join-Path $backupRoot 'gateway.json'),$false)
    [IO.File]::Copy($recordPath,(Join-Path $backupRoot 'installation.json'),$false)
    foreach($target in @($gatewayTarget,$profilesTarget,$checkTarget)) {
        if([IO.File]::Exists($target)) {[IO.File]::Copy($target,(Join-Path $backupRoot ([IO.Path]::GetFileName($target))),$false)}
    }

    # ---- Change: stop, swap, firewall, start, check. Any failure restores the previous state. ----
    Stop-Service PickChickKitchenLAN
    (Get-Service PickChickKitchenLAN).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
    $stopped=$true
    [IO.File]::Replace($newConfigPath,$configPath,[Management.Automation.Language.NullString]::Value)
    Assert-LanAcl $configPath 'ReadAndExecute'
    foreach($item in $code) {
        $buffer=[IO.MemoryStream]::new()
        try {$item[0].Position=0;$item[0].CopyTo($buffer);Set-LanFile $item[1] $buffer.ToArray() $stamp 'new'} finally {$buffer.Dispose()}
        if((Get-LanFileSha256 $item[1]) -cne $item[2]) {throw 'An installed gateway file differs from its pin.'}
        Assert-LanAcl $item[1] 'ReadAndExecute'
    }
    Set-NetFirewallRule -Name PickChickKitchenLAN -RemoteAddress $addresses
    Start-Service PickChickKitchenLAN
    (Get-Service PickChickKitchenLAN).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
    $svc=Get-CimInstance Win32_Service -Filter "Name='PickChickKitchenLAN'"
    $listeners=@()
    for($attempt=0;$attempt -lt 40 -and -not $listeners.Count;$attempt++) {
        $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        if(-not $listeners.Count) {Start-Sleep -Milliseconds 250}
    }
    if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne $bind) {throw 'The gateway listener binding differs.'}
    $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$($listeners[0].OwningProcess)"
    if($proc.ExecutablePath -cne $node -or $proc.ParentProcessId -ne $svc.ProcessId) {throw 'The gateway listener ownership differs.'}
    & $node $checkTarget $publicPath
    if($LASTEXITCODE -ne 0) {throw 'The pinned TLS check of the gateway failed.'}
    $remote=@((Get-NetFirewallRule -Name PickChickKitchenLAN | Get-NetFirewallAddressFilter).RemoteAddress | Sort-Object)
    if(($remote -join ',') -cne (@($addresses | Sort-Object) -join ',')) {throw 'The firewall rule does not hold exactly the listed clients.'}
} catch {
    $failure=$_
    if($stopped) {
        Write-Warning 'The update failed after the gateway stopped; restoring the previous config, code and firewall.'
        try {
            Stop-Service PickChickKitchenLAN -ErrorAction SilentlyContinue
            (Get-Service PickChickKitchenLAN).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
            Set-LanFile $configPath ([IO.File]::ReadAllBytes((Join-Path $backupRoot 'gateway.json'))) $stamp 'rollback'
            foreach($target in @($gatewayTarget,$profilesTarget,$checkTarget)) {
                $saved=Join-Path $backupRoot ([IO.Path]::GetFileName($target))
                if([IO.File]::Exists($saved)) {Set-LanFile $target ([IO.File]::ReadAllBytes($saved)) $stamp 'rollback'}
            }
            Set-NetFirewallRule -Name PickChickKitchenLAN -RemoteAddress $previousRemote
            Start-Service PickChickKitchenLAN
            (Get-Service PickChickKitchenLAN).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
            Write-Warning 'The previous client list is restored and the gateway runs again. Nothing else changed.'
        } catch {
            Write-Warning ('ROLLBACK INCOMPLETE: the gateway may be stopped. Previous files: '+$backupRoot)
        }
    } else {
        Write-Warning 'The update stopped before any change; the gateway keeps its current clients.'
    }
    throw $failure
} finally {
    foreach($handle in $handles) {$handle.Dispose()}
    if([IO.File]::Exists($newConfigPath)) {Remove-Item -LiteralPath $newConfigPath -Force}
}

# ---- Records: installation.json v2 (v1/v2 kept in the backup) and the public client file. ----
$entries=@($clients | ForEach-Object {[ordered]@{address=$_.address;profile=$_.profile}})
$next=[ordered]@{format='pickchick-kitchen-lan-v2';completed=$true;cashierAddress=$bind;configFormat=$(if($Legacy){'clientAddresses'}else{'clients'});clients=$entries}
foreach($name in @('terminalId','certificateSha256','certificateExpiresAt')) {if($recordNames -ccontains $name) {$next[$name]=[string]$record.$name}}
$next.gatewaySha256=Get-LanFileSha256 $gatewayTarget
$next.checkSha256=Get-LanFileSha256 $checkTarget
$next.profilesSha256=$(if([IO.File]::Exists($profilesTarget)){Get-LanFileSha256 $profilesTarget}else{$null})
$next.previousRecord=Join-Path $backupRoot 'installation.json'
$next.checkedAt=[DateTime]::UtcNow.ToString('o')
Set-LanFile $recordPath ([Text.UTF8Encoding]::new($false).GetBytes(($next | ConvertTo-Json -Depth 5))) $stamp 'new'
$public=ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($publicPath)))
if($public.edgeHost -cne $bind) {throw 'The public kitchen config names another server address.'}
$lanPublic=[ordered]@{edgeHost=$bind;edgePort=$port;edgeCertificatePem=[string]$public.edgeCertificatePem}
if(@($public.PSObject.Properties.Name) -ccontains 'branchLabel') {$lanPublic.branchLabel=[string]$public.branchLabel}
Set-LanFile $lanPublicPath ([Text.UTF8Encoding]::new($false).GetBytes(($lanPublic | ConvertTo-Json -Compress))) $stamp 'new'
Write-Output ('LAN_CLIENTS_UPDATED format='+$next.configFormat+' kitchen='+$counts.kitchen+' display='+$counts.display+' pos='+$counts.pos+' certificateSha256='+$next.certificateSha256)
Write-Output ('Public client config: '+$lanPublicPath)
Write-Output ('Previous files: '+$backupRoot)
