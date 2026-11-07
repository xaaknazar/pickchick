#Requires -Version 5.1
<# Connect PickChick Kitchen on one kitchen monoblock or the order board to the branch server
over the LAN gateway (cutover CL-5, contracts section 00 item 4).

Run as the Windows user that runs PickChick Kitchen, after the Kitchen installer and after
update-kitchen-lan-clients.ps1 has listed this monoblock on the server. The script:
- reads the server's public config file and checks the gateway certificate against the SHA-256
  from the installation card (and that it names the server IP and is valid now);
- probes the gateway from this monoblock with that pinned certificate: health, and that the
  server gave this IP the profile of -Mode (display for the board, kitchen for the rest);
- writes %APPDATA%\PickChickKitchen\config.json (previous file kept as config.json.bak-<UTC>).
It never enables autostart (off until 19.11; use -Autostart On on the cutover day), never
touches iiko, its files, services, autostart, printers or firewall, and needs no elevation. #>
[CmdletBinding(DefaultParameterSetName='Install')]
param(
    [Parameter(Mandatory=$true,ParameterSetName='Install')][string]$PublicConfig,
    [Parameter(Mandatory=$true,ParameterSetName='Install')][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$CertificateSha256,
    [Parameter(Mandatory=$true,ParameterSetName='Install')][ValidateSet('prep','assembly','display','staff')][string]$Mode,
    [Parameter(ParameterSetName='Install')][guid]$TerminalId=[guid]::Empty,
    [Parameter(ParameterSetName='Install')][switch]$Replace,
    [Parameter(Mandatory=$true,ParameterSetName='Autostart')][ValidateSet('On','Off')][string]$Autostart,
    [datetime]$CutoverDate=[datetime]'2026-11-19',
    [string]$AppPath=(Join-Path $env:LOCALAPPDATA 'Programs\PickChick Kitchen\PickChickKitchen.exe')
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

# ---- Shared LAN client helpers (byte-identical in install-pos-client.ps1; a test compares) ----
function Test-LanIPv4([string]$Value) {
    $address=$null
    if(-not [Net.IPAddress]::TryParse($Value,[ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $address.ToString() -cne $Value) {return $false}
    $b=$address.GetAddressBytes()
    return $b[0] -eq 10 -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or ($b[0] -eq 192 -and $b[1] -eq 168)
}
function Test-LanText($Value,[int]$Max) {
    return $Value -is [string] -and $Value.Length -ge 1 -and $Value.Length -le $Max -and $Value -notmatch '[\x00-\x1f\x7f]'
}
function ConvertFrom-LanJsonObject([byte[]]$Bytes,[int]$Limit) {
    if($null -eq $Bytes -or $Bytes.Length -eq 0 -or $Bytes.Length -gt $Limit) {throw 'LAN_JSON_INVALID: empty or too large.'}
    $offset=0
    if($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {$offset=3}
    try {$text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes,$offset,$Bytes.Length-$offset).Trim()} catch {throw 'LAN_JSON_INVALID: not UTF-8.'}
    if(-not $text.StartsWith('{') -or -not $text.EndsWith('}')) {throw 'LAN_JSON_INVALID: a JSON object is required.'}
    try {$value=ConvertFrom-Json -InputObject $text} catch {throw 'LAN_JSON_INVALID: not JSON.'}
    if($value -isnot [Management.Automation.PSCustomObject]) {throw 'LAN_JSON_INVALID: a JSON object is required.'}
    return $value
}
function Read-LanPublicConfig([byte[]]$Bytes) {
    $value=ConvertFrom-LanJsonObject $Bytes 16384
    $names=@($value.PSObject.Properties.Name)
    foreach($name in $names) {if($name -cnotin @('edgeHost','edgePort','edgeCertificatePem','branchLabel','terminalId')) {throw "LAN_PUBLIC_CONFIG_INVALID: unexpected key $name."}}
    foreach($name in @('edgeHost','edgePort','edgeCertificatePem')) {if($names -cnotcontains $name) {throw "LAN_PUBLIC_CONFIG_INVALID: $name is missing."}}
    if($value.edgeHost -isnot [string] -or -not (Test-LanIPv4 $value.edgeHost)) {throw 'LAN_PUBLIC_CONFIG_INVALID: edgeHost must be a private IPv4.'}
    if(($value.edgePort -isnot [int] -and $value.edgePort -isnot [long]) -or $value.edgePort -lt 1024 -or $value.edgePort -gt 65535) {throw 'LAN_PUBLIC_CONFIG_INVALID: edgePort.'}
    if($value.edgeCertificatePem -isnot [string]) {throw 'LAN_PUBLIC_CONFIG_INVALID: edgeCertificatePem.'}
    if($names -ccontains 'branchLabel' -and -not (Test-LanText $value.branchLabel 120)) {throw 'LAN_PUBLIC_CONFIG_INVALID: branchLabel.'}
    $result=[ordered]@{edgeHost=$value.edgeHost;edgePort=[int]$value.edgePort;edgeCertificatePem=$value.edgeCertificatePem.Trim()+"`n"}
    if($names -ccontains 'branchLabel') {$result.branchLabel=$value.branchLabel}
    return $result
}
function Read-LanDerLength([byte[]]$Raw,[int]$At) {
    if($At -ge $Raw.Length) {throw 'LAN_CERTIFICATE_INVALID: truncated DER.'}
    $first=[int]$Raw[$At]
    if($first -lt 0x80) {return @($first,($At+1))}
    $count=$first -band 0x7f
    if($count -lt 1 -or $count -gt 3 -or $At+$count -ge $Raw.Length) {throw 'LAN_CERTIFICATE_INVALID: DER length.'}
    $length=0
    for($i=1;$i -le $count;$i++) {$length=($length -shl 8) -bor [int]$Raw[$At+$i]}
    return @($length,($At+1+$count))
}
function Get-LanSanIPv4([byte[]]$Raw) {
    # subjectAltName = SEQUENCE OF GeneralName; iPAddress is [7] IMPLICIT OCTET STRING (tag 0x87).
    if($null -eq $Raw -or $Raw.Length -lt 2 -or $Raw[0] -ne 0x30) {throw 'LAN_CERTIFICATE_INVALID: subjectAltName.'}
    $outer=Read-LanDerLength $Raw 1
    $at=$outer[1]
    $end=$at+$outer[0]
    if($end -ne $Raw.Length) {throw 'LAN_CERTIFICATE_INVALID: subjectAltName length.'}
    $found=@()
    while($at -lt $end) {
        $tag=[int]$Raw[$at]
        $item=Read-LanDerLength $Raw ($at+1)
        $start=$item[1]
        $next=$start+$item[0]
        if($next -gt $end) {throw 'LAN_CERTIFICATE_INVALID: subjectAltName item.'}
        if($tag -eq 0x87 -and $item[0] -eq 4) {$found+=('{0}.{1}.{2}.{3}' -f $Raw[$start],$Raw[$start+1],$Raw[$start+2],$Raw[$start+3])}
        $at=$next
    }
    return $found
}
function Get-LanCertificate([string]$Pem) {
    if($null -eq $Pem -or $Pem.Length -gt 16384) {throw 'LAN_CERTIFICATE_INVALID: PEM.'}
    if($Pem.Trim() -cnotmatch '\A-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----\z') {throw 'LAN_CERTIFICATE_INVALID: exactly one PEM certificate is required.'}
    try {$der=[Convert]::FromBase64String(($Matches[1] -replace '\s',''))} catch {throw 'LAN_CERTIFICATE_INVALID: base64.'}
    try {$certificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new($der)} catch {throw 'LAN_CERTIFICATE_INVALID: X.509.'}
    $hash=[Security.Cryptography.SHA256]::Create()
    try {$sha=[BitConverter]::ToString($hash.ComputeHash($der)).Replace('-','').ToLowerInvariant()} finally {$hash.Dispose()}
    $ips=@()
    foreach($extension in $certificate.Extensions) {if($extension.Oid.Value -eq '2.5.29.17') {$ips+=@(Get-LanSanIPv4 $extension.RawData)}}
    return [pscustomobject]@{Sha256=$sha;NotBefore=$certificate.NotBefore.ToUniversalTime();NotAfter=$certificate.NotAfter.ToUniversalTime();IPv4=$ips}
}
function Assert-LanCertificate($Certificate,[string]$ExpectedSha256,[string]$EdgeHost,[datetime]$Now) {
    if($Certificate.Sha256 -cne $ExpectedSha256.ToLowerInvariant()) {throw 'LAN_CERTIFICATE_SHA256_MISMATCH: the public config does not hold the certificate of the installation card.'}
    if(@($Certificate.IPv4) -cnotcontains $EdgeHost) {throw 'LAN_CERTIFICATE_IP_MISMATCH: the certificate does not name edgeHost.'}
    $utc=$Now.ToUniversalTime()
    if($Certificate.NotBefore -gt $utc -or $Certificate.NotAfter -le $utc) {throw 'LAN_CERTIFICATE_NOT_VALID_NOW: check the clock of this monoblock or renew the certificate.'}
}
function Invoke-LanProbe([string]$EdgeHost,[int]$Port,[string]$PinnedSha256,[string]$Path,[string]$ConnectAddress='',[int]$TimeoutMs=5000) {
    # One GET over TLS 1.2 to the gateway. The certificate is compared with the pin before any
    # request byte is sent; probes carry no credential. ConnectAddress is for tests only.
    if(-not $ConnectAddress) {$ConnectAddress=$EdgeHost}
    $client=[Net.Sockets.TcpClient]::new()
    try {
        try {$connected=$client.ConnectAsync($ConnectAddress,$Port).Wait($TimeoutMs)} catch {$connected=$false}
        if(-not $connected) {throw 'LAN_PROBE_UNREACHABLE: no TCP connection to the gateway (server firewall, IP or cable).'}
        $client.ReceiveTimeout=$TimeoutMs
        $client.SendTimeout=$TimeoutMs
        $accept=[Net.Security.RemoteCertificateValidationCallback]{param($sender,$certificate,$chain,$errors) return $true}
        $tls=[Net.Security.SslStream]::new($client.GetStream(),$false,$accept)
        try {
            try {$tls.AuthenticateAsClient($EdgeHost,$null,[Security.Authentication.SslProtocols]::Tls12,$false)} catch {throw 'LAN_PROBE_TLS_FAILED: TLS handshake with the gateway failed.'}
            $hash=[Security.Cryptography.SHA256]::Create()
            try {$seen=[BitConverter]::ToString($hash.ComputeHash($tls.RemoteCertificate.GetRawCertData())).Replace('-','').ToLowerInvariant()} finally {$hash.Dispose()}
            if($seen -cne $PinnedSha256.ToLowerInvariant()) {throw 'LAN_PROBE_CERTIFICATE_MISMATCH: the gateway presented another certificate.'}
            $request=[Text.Encoding]::ASCII.GetBytes("GET $Path HTTP/1.1`r`nHost: ${EdgeHost}:$Port`r`nAccept: application/json`r`nConnection: close`r`n`r`n")
            $tls.Write($request,0,$request.Length)
            $tls.Flush()
            $buffer=[byte[]]::new(8192)
            $memory=[IO.MemoryStream]::new()
            try {
                for(;;) {
                    $read=$tls.Read($buffer,0,$buffer.Length)
                    if($read -le 0) {break}
                    $memory.Write($buffer,0,$read)
                    if($memory.Length -gt 65536) {throw 'LAN_PROBE_INVALID: answer too large.'}
                }
            } catch [IO.IOException] {
                if($memory.Length -eq 0) {throw 'LAN_PROBE_INVALID: the gateway closed the connection.'}
            }
            $text=[Text.Encoding]::UTF8.GetString($memory.ToArray())
            if($text -cnotmatch '\AHTTP/1\.1 (\d{3}) ') {throw 'LAN_PROBE_INVALID: not an HTTP answer.'}
            $status=[int]$Matches[1]
            $split=$text.IndexOf("`r`n`r`n")
            $body=''
            if($split -ge 0) {$body=$text.Substring($split+4)}
            return [pscustomobject]@{Status=$status;Body=$body}
        } finally {$tls.Dispose()}
    } finally {$client.Dispose()}
}
function Test-LanClientProfile([string]$EdgeHost,[int]$Port,[string]$PinnedSha256,[string]$Profile,[string]$ConnectAddress='',[int]$Attempts=20) {
    # healthz, then a route this profile must reach (the edge answers) and one it must not
    # (the gateway answers 404): proves the server gave this IP exactly this profile.
    $health=Invoke-LanProbe $EdgeHost $Port $PinnedSha256 '/healthz' $ConnectAddress
    if($health.Status -eq 403) {throw 'LAN_CLIENT_NOT_LISTED: list this IP on the server with update-kitchen-lan-clients.ps1 first.'}
    if($health.Status -ne 200 -or $health.Body -cnotmatch '"service":"pickchick-kitchen-lan"') {throw 'LAN_HEALTH_FAILED: the gateway health check did not answer.'}
    if($Profile -ceq 'display') {$reach='/edge/v1/fulfillment/config';$reachStatus=200;$blocked='/edge/v1/session'}
    elseif($Profile -ceq 'pos') {$reach='/edge/v1/session';$reachStatus=401;$blocked='/edge/v1/fulfillment/stations'}
    elseif($Profile -ceq 'kitchen') {$reach='/edge/v1/session';$reachStatus=401;$blocked='/edge/v1/cash-shifts/current'}
    else {throw 'LAN_PROFILE_INVALID'}
    $answer=$null
    for($attempt=1;$attempt -le $Attempts;$attempt++) {
        $answer=Invoke-LanProbe $EdgeHost $Port $PinnedSha256 $reach $ConnectAddress
        if($answer.Status -notin @(502,503,504)) {break}
        Start-Sleep -Milliseconds 500
    }
    if($answer.Status -ne $reachStatus) {throw "LAN_PROFILE_MISMATCH: $reach answered $($answer.Status); this IP does not have the $Profile profile or the server edge is not ready."}
    $other=Invoke-LanProbe $EdgeHost $Port $PinnedSha256 $blocked $ConnectAddress
    if($other.Status -ne 404) {throw "LAN_PROFILE_MISMATCH: $blocked answered $($other.Status); this IP has a wider profile than $Profile."}
    return [pscustomobject]@{Profile=$Profile;Health=$health.Status;Reached=$answer.Status;Blocked=$other.Status}
}
function Write-LanJsonFile([string]$Path,[string]$Json,[string]$Stamp) {
    # UTF-8 without BOM (JSON.parse in the app rejects a BOM). The new file is complete on disk
    # before it replaces the old one, which stays next to it as <name>.bak-<UTC>.
    $directory=[IO.Path]::GetDirectoryName($Path)
    if(-not [IO.Directory]::Exists($directory)) {$null=[IO.Directory]::CreateDirectory($directory)}
    $temporary="$Path.new-$Stamp"
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Json)
    $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
    if([IO.File]::Exists($Path)) {[IO.File]::Replace($temporary,$Path,"$Path.bak-$Stamp")}
    else {[IO.File]::Move($temporary,$Path)}
}
function Get-LanAppVersion([string]$Path) {
    if(-not [IO.File]::Exists($Path)) {throw "LAN_APP_MISSING: install the PickChick app for this user first ($Path)."}
    $raw=[Diagnostics.FileVersionInfo]::GetVersionInfo($Path).FileVersion
    if($raw -cnotmatch '\A(\d+)\.(\d+)\.(\d+)') {throw 'LAN_APP_VERSION_UNKNOWN'}
    return [version]::new([int]$Matches[1],[int]$Matches[2],[int]$Matches[3])
}
function Set-LanAutostart([string]$Name,[string]$Exe,[string]$State,[datetime]$CutoverDate,[datetime]$Today) {
    # Per-user Run value of this PickChick app only; other values (iiko) are never read or changed.
    $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if($State -ceq 'On') {
        if($Today.Date -lt $CutoverDate.Date) {throw ('LAN_AUTOSTART_TOO_EARLY: PickChick autostart stays off until '+$CutoverDate.ToString('yyyy-MM-dd')+' (iiko keeps running until then).')}
        if(-not [IO.File]::Exists($Exe)) {throw 'LAN_APP_MISSING'}
        if(-not (Test-Path -LiteralPath $key)) {$null=New-Item -Path $key -Force}
        $null=New-ItemProperty -LiteralPath $key -Name $Name -Value ('"'+$Exe+'"') -PropertyType String -Force
    } elseif($State -ceq 'Off') {
        if((Test-Path -LiteralPath $key) -and $null -ne (Get-ItemProperty -LiteralPath $key -Name $Name -ErrorAction SilentlyContinue)) {Remove-ItemProperty -LiteralPath $key -Name $Name}
    } else {throw 'LAN_AUTOSTART_INVALID'}
}
function Get-LanAutostart([string]$Name) {
    $value=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $Name -ErrorAction SilentlyContinue
    return $null -ne $value
}
# ---- End of shared LAN client helpers ----

function New-KitchenClientConfig($Existing,$Public,[string]$Mode,[guid]$TerminalId,[switch]$Replace) {
    # Keys of apps/kitchen-desktop/security.mjs validateConfig. An existing terminal identity
    # (paired mode or staff-login terminal) changes only with -Replace: the screen must then be
    # paired again in Devices.
    $allowed=@('edgePort','branchLabel','edgeHost','edgeCertificatePem','terminalId','terminalMode')
    $config=[ordered]@{}
    if($null -ne $Existing) {
        foreach($property in $Existing.PSObject.Properties) {
            if($property.Name -cnotin $allowed) {throw "KITCHEN_CONFIG_INVALID: unexpected key $($property.Name) in the existing config."}
            $config[$property.Name]=$property.Value
        }
    }
    if($Mode -ceq 'staff') {
        if($TerminalId -eq [guid]::Empty) {
            if(-not $config.Contains('terminalId')) {throw 'KITCHEN_TERMINAL_REQUIRED: -Mode staff needs -TerminalId (the kitchen terminal UUID).'}
        } else {
            $id=$TerminalId.ToString()
            if($config.Contains('terminalId') -and $config.terminalId -cne $id -and -not $Replace) {throw 'KITCHEN_TERMINAL_CHANGE: the config has another terminalId; rerun with -Replace only if this screen really changes terminal.'}
            $config.terminalId=$id
        }
        if($config.Contains('terminalMode')) {
            if(-not $Replace) {throw 'KITCHEN_MODE_CHANGE: the screen is paired as a terminal; rerun with -Replace to switch to staff login.'}
            $config.Remove('terminalMode')
        }
    } else {
        if($TerminalId -ne [guid]::Empty) {throw 'KITCHEN_TERMINAL_UNUSED: a paired screen takes its terminal from pairing; omit -TerminalId.'}
        if($config.Contains('terminalMode') -and $config.terminalMode -cne $Mode -and -not $Replace) {throw 'KITCHEN_MODE_CHANGE: the screen is paired in another mode; rerun with -Replace and pair it again in Devices.'}
        if(-not $config.Contains('terminalMode') -and $config.Contains('terminalId') -and -not $Replace) {throw 'KITCHEN_MODE_CHANGE: the screen uses staff login on a fixed terminal; rerun with -Replace to pair it in Devices instead.'}
        $config.terminalMode=$Mode
        if($config.Contains('terminalId')) {$config.Remove('terminalId')}
    }
    $config.edgeHost=$Public.edgeHost
    $config.edgePort=$Public.edgePort
    $config.edgeCertificatePem=$Public.edgeCertificatePem
    if(-not $config.Contains('branchLabel') -and $Public.Contains('branchLabel')) {$config.branchLabel=$Public.branchLabel}
    if($config.Contains('branchLabel') -and -not (Test-LanText $config.branchLabel 120)) {throw 'KITCHEN_CONFIG_INVALID: branchLabel.'}
    if($config.edgePort -eq 4178) {throw 'KITCHEN_CONFIG_INVALID: edgePort cannot be the local app port 4178.'}
    return $config
}

if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $PSVersionTable.PSEdition -ne 'Desktop') {throw 'Use Windows PowerShell 5.1 on the kitchen monoblock.'}
$stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$profileDir=Join-Path $env:APPDATA 'PickChickKitchen'
$configPath=Join-Path $profileDir 'config.json'
if($PSCmdlet.ParameterSetName -ceq 'Autostart') {
    Set-LanAutostart 'PickChickKitchen' $AppPath $Autostart $CutoverDate (Get-Date)
    Write-Output ('KITCHEN_AUTOSTART='+$Autostart.ToUpperInvariant()+' user='+[Environment]::UserName)
    return
}
$version=Get-LanAppVersion $AppPath
if($version -lt [version]'0.4.0') {throw "KITCHEN_APP_TOO_OLD: PickChick Kitchen $version is installed; the KDS screens need 0.4.0 or later."}
$public=Read-LanPublicConfig ([IO.File]::ReadAllBytes($PublicConfig))
$certificate=Get-LanCertificate $public.edgeCertificatePem
Assert-LanCertificate $certificate $CertificateSha256 $public.edgeHost (Get-Date)
$expected='kitchen'
if($Mode -ceq 'display') {$expected='display'}
$probe=Test-LanClientProfile $public.edgeHost $public.edgePort $certificate.Sha256 $expected
$existing=$null
if([IO.File]::Exists($configPath)) {$existing=ConvertFrom-LanJsonObject ([IO.File]::ReadAllBytes($configPath)) 64000}
$config=New-KitchenClientConfig $existing $public $Mode $TerminalId -Replace:$Replace
Write-LanJsonFile $configPath ($config | ConvertTo-Json -Depth 5 -Compress) $stamp
$written=ConvertFrom-LanJsonObject ([IO.File]::ReadAllBytes($configPath)) 64000
if($written.edgeHost -cne $public.edgeHost -or $written.edgePort -ne $public.edgePort -or $written.edgeCertificatePem -cne $public.edgeCertificatePem) {throw 'KITCHEN_CONFIG_WRITE_FAILED'}
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort 4178 -ErrorAction SilentlyContinue)
foreach($listener in $listeners) {
    $owner=Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if($null -eq $owner -or $owner.ProcessName -cne 'PickChickKitchen') {Write-Warning 'Local port 4178 is used by another program; PickChick Kitchen cannot start until it is free.'}
}
if(@(Get-Process -Name 'iiko*' -ErrorAction SilentlyContinue).Count) {Write-Output 'iiko is running on this monoblock; it was not changed.'}
Write-Output ('KITCHEN_CLIENT_CONFIGURED mode='+$Mode+' profile='+$probe.Profile+' app='+$version+' certificateSha256='+$certificate.Sha256)
Write-Output ('Config: '+$configPath+'. Restart PickChick Kitchen to apply it.')
Write-Output ('Autostart: '+$(if(Get-LanAutostart 'PickChickKitchen'){'ON'}else{'OFF'})+' (stays off until '+$CutoverDate.ToString('yyyy-MM-dd')+').')
