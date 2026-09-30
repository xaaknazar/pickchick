#Requires -Version 5.1
<# Add a dedicated pinned-TLS KDS boundary to the existing cashier server.
No PostgreSQL binding, Edge binding, ordering switch or staff credential is changed. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$CashierAddress,
    [Parameter(Mandatory=$true)][string]$KitchenAddress,
    [Parameter(Mandatory=$true)][guid]$KitchenTerminalId,
    [Parameter(Mandatory=$true)][ValidateLength(1,120)][string]$BranchLabel,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$GatewaySha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$CheckSha256,
    [string]$FoundationScript=(Join-Path $PSScriptRoot 'install-native-foundation.ps1'),
    [string]$GatewayScript=(Join-Path $PSScriptRoot 'kitchen-lan-gateway.mjs'),
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

function Write-LanFile([string]$Path,[string]$Content) {
    $null=Assert-LocalNtfsPath $Path
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Content)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
}
function Copy-LanVerified([IO.Stream]$Source,[string]$Destination) {
    $null=Assert-LocalNtfsPath $Destination
    $stream=[IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$Source.Position=0;$Source.CopyTo($stream);$stream.Flush($true)} finally {$stream.Dispose()}
}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') {throw 'Use elevated x64 Windows PowerShell5.1.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
if(-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Administrator elevation required.'}
if(-not (Test-LanIPv4 $CashierAddress) -or -not (Test-LanIPv4 $KitchenAddress) -or $CashierAddress -eq $KitchenAddress -or $KitchenTerminalId -eq [guid]::Empty -or $BranchLabel -match '[\x00-\x1f\x7f]') {throw 'Assigned private addresses and terminal are required.'}
if(-not @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -eq $CashierAddress -and $_.AddressState -eq 'Preferred'}).Count) {throw 'Cashier address is not assigned to this Windows computer.'}
$program=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PickChick'
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PickChick'
$oldRoot=Join-Path $program 'Edge\edge-0186902'
$oldTools=Join-Path $data 'EdgeTools\edge-0186902'
$serviceRoot=Join-Path $program 'KitchenLAN'
$dataRoot=Join-Path $data 'KitchenLAN'
$privateRoot=Join-Path $dataRoot 'private'
$logs=Join-Path $dataRoot 'logs'
$node=Join-Path $oldRoot 'node\node.exe'
$winsw=Join-Path $oldRoot 'PickChickEdge.exe'
$serviceExe=Join-Path $serviceRoot 'PickChickKitchenLAN.exe'
$serviceXml=Join-Path $serviceRoot 'PickChickKitchenLAN.xml'
$gatewayTarget=Join-Path $serviceRoot 'kitchen-lan-gateway.mjs'
$checkTarget=Join-Path $serviceRoot 'kitchen-lan-check.mjs'
$configPath=Join-Path $privateRoot 'gateway.json'
$pfxPath=Join-Path $privateRoot 'server.pfx'
$publicPath=Join-Path $dataRoot 'public-kitchen-config.json'
if((Get-Service -Name PickChickKitchenLAN -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $serviceRoot) -or (Test-Path -LiteralPath $dataRoot) -or (Get-NetFirewallRule -Name PickChickKitchenLAN -ErrorAction SilentlyContinue)) {throw 'Kitchen LAN setup already exists. Preserve it and inspect; this command never overwrites an installation.'}
if(@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object {$_.Port -eq 3443}).Count) {throw 'The dedicated kitchen port is occupied.'}
if((Get-Service -Name PickChickEdge).Status -ne 'Running') {throw 'Existing edge must be running.'}
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
Assert-ProtectedDirectory $program
Assert-ProtectedDirectory $data
Assert-ProtectedDirectory $oldTools
Assert-LanAcl $oldRoot 'ReadAndExecute' -Protected
Assert-LanAcl (Join-Path $oldRoot 'node') 'ReadAndExecute' -Protected
Assert-LanAcl $node 'ReadAndExecute'
Assert-LanAcl $winsw 'ReadAndExecute'
Assert-LanAcl (Join-Path $oldTools 'foundation-stage1.json')
$edgeService=Get-CimInstance Win32_Service -Filter "Name='PickChickEdge'"
if(-not $edgeService -or $edgeService.PathName -cne ('"'+$winsw+'"') -or $edgeService.StartName -ne 'NT AUTHORITY\LocalService' -or $edgeService.StartMode -ne 'Auto' -or $edgeService.State -ne 'Running') {throw 'Existing Edge service binding differs.'}
$edgeListeners=@(Get-NetTCPConnection -State Listen -LocalPort 3101)
if($edgeListeners.Count -ne 1 -or $edgeListeners[0].LocalAddress -ne '127.0.0.1') {throw 'Existing Edge listener differs.'}
$edgeProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($edgeListeners[0].OwningProcess)"
if(-not $edgeProcess -or $edgeProcess.ExecutablePath -cne $node -or $edgeProcess.ParentProcessId -ne $edgeService.ProcessId) {throw 'Existing Edge listener ownership differs.'}
$stage=Get-Content -LiteralPath (Join-Path $oldTools 'foundation-stage1.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($stage.sourceCommit -cne '0186902b30b995ba49ab69346a2bcc1088bb3fa6' -or $stage.winSwSha256 -notmatch '^[a-f0-9]{64}$' -or $stage.nodeVersionVerified -ne $true) {throw 'Verified foundation record required.'}
$handles=[Collections.Generic.List[IDisposable]]::new()
try {
    $gatewaySource=Open-VerifiedFile $GatewayScript $GatewaySha256;$handles.Add($gatewaySource)
    $checkSource=Open-VerifiedFile $CheckScript $CheckSha256;$handles.Add($checkSource)
    $winswSource=Open-VerifiedFile $winsw $stage.winSwSha256;$handles.Add($winswSource)
    if((& $node --version).Trim() -cne 'v24.21.0' -or $LASTEXITCODE -ne 0) {throw 'Pinned Node executable differs.'}
    New-ProtectedDirectory $serviceRoot 'ReadAndExecute'
    New-ProtectedDirectory $dataRoot
    New-ProtectedDirectory $privateRoot 'ReadAndExecute'
    New-ProtectedDirectory $logs 'Modify'
    Copy-LanVerified $gatewaySource $gatewayTarget
    Copy-LanVerified $checkSource $checkTarget
    Copy-LanVerified $winswSource $serviceExe
    $random=[byte[]]::new(48);$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try {$rng.GetBytes($random)} finally {$rng.Dispose()}
    $passphrase=[Convert]::ToBase64String($random);[Array]::Clear($random,0,$random.Length)
    $secure=ConvertTo-SecureString $passphrase -AsPlainText -Force
    $cert=New-SelfSignedCertificate -Type SSLServerAuthentication -Subject 'CN=PickChick Kitchen LAN' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\LocalMachine\My' -NotAfter (Get-Date).AddYears(1) -TextExtension @("2.5.29.17={text}IPAddress=$CashierAddress")
    $null=Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure -CryptoAlgorithmOption AES256_SHA256 -ChainOption EndEntityCertOnly -NoProperties
    $pem="-----BEGIN CERTIFICATE-----`n"+[Convert]::ToBase64String($cert.RawData,[Base64FormattingOptions]::InsertLineBreaks).Replace("`r`n","`n")+"`n-----END CERTIFICATE-----`n"
    Write-LanFile $configPath ([ordered]@{bindAddress=$CashierAddress;port=3443;clientAddresses=@($KitchenAddress);edgePort=3101;pfxPath=$pfxPath;passphrase=$passphrase} | ConvertTo-Json)
    $passphrase=$null;$secure.Dispose()
    Write-LanFile $publicPath ([ordered]@{edgeHost=$CashierAddress;edgePort=3443;edgeCertificatePem=$pem;terminalId=$KitchenTerminalId.ToString();branchLabel=$BranchLabel} | ConvertTo-Json)
    $esc={param([string]$v) [Security.SecurityElement]::Escape($v)}
    $xml=@"
<service>
  <id>PickChickKitchenLAN</id><name>PickChick Kitchen LAN</name>
  <description>Authenticated kitchen access through pinned TLS on the restaurant network.</description>
  <executable>$(& $esc $node)</executable>
  <arguments>&quot;$(& $esc $gatewayTarget)&quot; &quot;$(& $esc $configPath)&quot;</arguments>
  <workingdirectory>$(& $esc $serviceRoot)</workingdirectory>
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <startmode>Automatic</startmode><delayedAutoStart>true</delayedAutoStart>
  <depend>PickChickEdge</depend><stoptimeout>15 sec</stoptimeout>
  <onfailure action="restart" delay="5 sec"/><onfailure action="restart" delay="15 sec"/><onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure><logpath>$(& $esc $logs)</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>
</service>
"@
    Write-LanFile $serviceXml $xml
    & $serviceExe install
    if($LASTEXITCODE -ne 0) {throw 'Kitchen service registration failed.'}
    $null=New-NetFirewallRule -Name PickChickKitchenLAN -DisplayName 'PickChick kitchen TLS only' -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -LocalAddress $CashierAddress -LocalPort 3443 -RemoteAddress $KitchenAddress -Program $node
    Start-Service PickChickKitchenLAN
    (Get-Service PickChickKitchenLAN).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
    & $node $checkTarget $publicPath
    if($LASTEXITCODE -ne 0) {throw 'Pinned TLS/authorization check failed. Preserve protected files and inspect the service.'}
    $svc=Get-CimInstance Win32_Service -Filter "Name='PickChickKitchenLAN'"
    if($svc.StartName -ne 'NT AUTHORITY\LocalService' -or $svc.StartMode -ne 'Auto') {throw 'Unexpected kitchen service identity.'}
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 3443)
    if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne $CashierAddress) {throw 'Kitchen listener binding differs.'}
    $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$($listeners[0].OwningProcess)"
    if($proc.ExecutablePath -cne $node -or $proc.ParentProcessId -ne $svc.ProcessId) {throw 'Kitchen listener ownership differs.'}
    $hasher=[Security.Cryptography.SHA256]::Create()
    try {$certHash=[BitConverter]::ToString($hasher.ComputeHash($cert.RawData)).Replace('-','').ToLowerInvariant()} finally {$hasher.Dispose()}
    Write-LanFile (Join-Path $dataRoot 'installation.json') ([ordered]@{format='pickchick-kitchen-lan-v1';completed=$true;cashierAddress=$CashierAddress;kitchenAddress=$KitchenAddress;terminalId=$KitchenTerminalId.ToString();certificateSha256=$certHash;certificateExpiresAt=$cert.NotAfter.ToUniversalTime().ToString('o');gatewaySha256=$GatewaySha256;checkSha256=$CheckSha256;checkedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json)
    Write-Output ('KITCHEN_LAN_VERIFIED certificateSha256='+$certHash)
    Write-Output ('Public kitchen config: '+$publicPath)
} catch {
    Write-Warning 'Kitchen LAN setup is incomplete. Protected files are retained. Do not rerun over them or assume the kitchen is connected.'
    throw
} finally {foreach($handle in $handles) {$handle.Dispose()}}
