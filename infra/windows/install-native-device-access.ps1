#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Prepare020 through owner transaction; install a separate mailbox as stopped LocalService.
Every mutation requires Apply. Existing worker/POS/env/identity are never replaced. #>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('Inspect','Prepare','Install','Verify','Activate','Ready')][string]$Mode,
 [Parameter(Mandatory=$true)][ValidatePattern('^edge-[a-f0-9]{7}$')][string]$ReleaseName,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
 [Parameter(Mandatory=$true)][guid]$BranchId,
 [Parameter(Mandatory=$true)][guid]$DeviceId,
 [Parameter(Mandatory=$true)][string]$CiProof,
 [string]$BackupManifest,
 [string]$LinkProof,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$LinkProofSha256,
 [string]$CloudProof,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$CloudProofSha256,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedEdgeEnvSha256,
 [switch]$Apply,
 [IO.FileStream]$MaintenanceLease
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Import-DeviceHelper([string]$File,[string]$Hash,[string[]]$Names) {
 if((Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) {throw 'Pinned helper differs.'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
 if($errors.Count) {throw 'Helper parse failure.'}
 foreach($name in $Names) {$f=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$false));if($f.Count -ne 1) {throw 'Missing helper.'};$f[0].Extent.Text}
}
function Assert-DevicePreserved($Files,$Services) {
 foreach($path in $Files.Keys) {if((Hash-File $path) -cne $Files[$path]) {throw 'An unrelated configuration/identity changed.'}}
 foreach($name in $Services.Keys) {$current=Get-CimInstance Win32_Service -Filter "Name='$name'";if($current.State -cne 'Running' -or $current.ProcessId -ne $Services[$name]) {throw 'PostgreSQL or tunnel restarted unexpectedly.'}}
}
function Assert-DeviceStage($Inputs,[string]$Sha,[string]$Branch,[string]$Device,[string]$Manifest,[long]$CiRun) {
 if($Inputs.sourceCommit -cne $Sha -or $Inputs.branchId -cne $Branch -or $Inputs.deviceId -cne $Device -or $Inputs.runtimeManifestSha256 -cne $Manifest -or $Inputs.ciRun -ne $CiRun -or $Inputs.archiveSha256 -cnotmatch '^[a-f0-9]{64}$') {throw 'Verified immutable stage proof differs.'}
}
function Assert-DeviceDisabledEnv([string]$Text,[string]$Branch,[string]$Device,[bool]$Enabled=$false) {
 $pattern='\AAPP_ENV=local\nEDGE_BRANCH_ID='+[regex]::Escape($Branch)+'\nEDGE_DEVICE_ID='+[regex]::Escape($Device)+'\nEDGE_FULFILLMENT_ENABLED=true\nEDGE_FULFILLMENT_CLOUD_ORIGIN=http://127\.0\.0\.1:43100\nDEVICE_ACCESS_WORKER_ENABLED=false\nEDGE_DATABASE_URL=postgresql://pickchick_device_access_sync:[a-f0-9]{64}@127\.0\.0\.1:55433/pickchick_edge\n\z'
 if($Enabled) {$pattern=$pattern.Replace('DEVICE_ACCESS_WORKER_ENABLED=false','DEVICE_ACCESS_WORKER_ENABLED=true')}
 if($Text -cnotmatch $pattern) {throw 'Worker must retain its exact generated disabled environment.'}
}
function Assert-DeviceEdgeFlag([string]$Text,[bool]$Enabled) {
 $matches=@([regex]::Matches($Text,'(?im)^\s*(?:export\s+)?EDGE_DEVICE_ACCESS_ENABLED\s*=[^\r\n]*\r?$'))
 $expected='EDGE_DEVICE_ACCESS_ENABLED='+$Enabled.ToString().ToLowerInvariant()
 if($matches.Count -gt 1 -or ($matches.Count -eq 1 -and $matches[0].Value.TrimEnd([char]13) -cne $expected) -or ($Enabled -and $matches.Count -ne 1)) {throw 'Edge device flag differs.'}
}
function Wait-DeviceChild($Service,[string]$Node,[string]$Script) {
 $deadline=[DateTime]::UtcNow.AddSeconds(20)
 do {
  $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($Service.ProcessId)" | Where-Object {$_.ExecutablePath -ieq $Node -and $_.CommandLine.Contains($Script)})
  if($children.Count -eq 1) {return}
  Start-Sleep -Milliseconds 250
 } while([DateTime]::UtcNow -lt $deadline)
 throw 'Actual mailbox child is not the pinned runtime.'
}
function Assert-DeviceCloudProof($Proof,[string]$Sha,[string]$Branch,[string]$Device,[long]$Now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) {
 if($Proof.format -cne 'pickchick-device-access-cloud-enabled-v1' -or $Proof.source_sha -cne $Sha -or $Proof.branch_id -cne $Branch -or $Proof.edge_device_id -cne $Device -or $Proof.device_access_enabled -ne $true -or $Proof.completed_epoch -gt $Now -or ($Now-$Proof.completed_epoch) -gt 21600) {throw 'Fresh actual cloud enable proof required.'}
}
function Assert-DeviceWorker([string]$Name,[string]$Image,[string[]]$Depends,[bool]$Automatic) {
 $service=Get-CimInstance Win32_Service -Filter "Name='$Name'"
 $expected=if($Automatic){'Auto'}else{'Manual'}
 if($null -eq $service -or $service.PathName -cne (Quote-WindowsArgument $Image) -or $service.StartName -ine 'NT AUTHORITY\LocalService' -or $service.StartMode -cne $expected) {throw 'Mailbox service binding differs.'}
 if((@((Get-Service $Name).ServicesDependedOn | ForEach-Object {$_.Name} | Sort-Object) -join ',') -cne (($Depends | Sort-Object) -join ',')) {throw 'Mailbox dependencies differ.'}
 return $service
}
function Write-DeviceCas([string]$Path,[byte[]]$Before,[byte[]]$After) {
 if([Convert]::ToBase64String([IO.File]::ReadAllBytes($Path)) -cne [Convert]::ToBase64String($Before)) {throw 'Concurrent environment/XML change.'}
 $temp=$Path+'.device-'+[guid]::NewGuid().ToString('N')+'.tmp'
 $h=[IO.File]::Open($temp,'CreateNew','Write','None');try{$h.Write($After,0,$After.Length);$h.Flush($true)}finally{$h.Dispose()}
 Set-ProtectedAcl $temp -ServiceRead
 [IO.File]::Replace($temp,$Path,[Management.Automation.Language.NullString]::Value)
}
function Assert-DeviceLinkProof($Proof,[string]$Sha,[string]$Root) {
 if($Proof.source_sha -cne $Sha -or $Proof.link.verified -ne $true -or $Proof.link.running -ne $true) {throw 'Actual updated KitchenLink proof required.'}
 $names=@('infra/kitchen-portal/agent.mjs','infra/kitchen-portal/link.mjs','apps/kitchen/server.mjs','apps/kitchen/terminal-cookie.mjs')
 if(@(Compare-Object ($names | Sort-Object) @($Proof.link.files.PSObject.Properties.Name | Sort-Object)).Count) {throw 'Incomplete link proof.'}
 foreach($p in $names) {Assert-Acl (Join-Path $Root $p) -Foundation -ServiceRead -InheritedAllowed;if((Hash-File (Join-Path $Root $p)) -cne $Proof.link.files.$p) {throw 'Live link bytes differ.'}}
 $config='C:\ProgramData\PickChick\KitchenLink\private\agent.json';$xml=Join-Path $Root 'PickChickKitchenLink.xml'
 Assert-Acl $config -Foundation -ServiceRead -InheritedAllowed;Assert-Acl $xml -Foundation -ServiceRead -InheritedAllowed
 if((Hash-File $config) -cne $Proof.link.config_sha256 -or (Hash-File $xml) -cne $Proof.link.xml_sha256) {throw 'Live link config/XML differs.'}
 if((Get-Service PickChickKitchenLink).Status -ne 'Running') {throw 'KitchenLink not running.'}
}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop') {throw 'Elevated Windows PowerShell5.1 required.'}
$script:operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($def in (Import-DeviceHelper (Join-Path $PSScriptRoot 'install-native-menu-sync.ps1') 'ff955a154aa4cfa8507474cef2ac37ae19b9b1d7e4fc46b8fe0f14a5a323831c' @('Assert-NtfsPath','Assert-Acl','Set-ProtectedAcl','Write-NewText','Ensure-Text','Quote-WindowsArgument','Run-Tool','Read-Json','Hash-File','Build-ServiceXml','Assert-WorkerService','Assert-Identity','Assert-Backup'))) {. ([scriptblock]::Create($def))}
foreach($def in (Import-DeviceHelper (Join-Path $PSScriptRoot 'update-native-unified-menu.ps1') 'b764a8733224f951ad1543d9d1b18bf7ac269b1e034a1fbadbefbba488f903ef' @('Assert-UnifiedCi','Invoke-UnifiedQuiesced','Wait-UnifiedReady'))) {. ([scriptblock]::Create($def))}
foreach($def in (Import-DeviceHelper (Join-Path $PSScriptRoot 'update-native-service.ps1') '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Read-UpdateHttp'))) {. ([scriptblock]::Create($def))}
$program='C:\Program Files\PickChick';$data='C:\ProgramData\PickChick';$branch=$BranchId.ToString();$device=$DeviceId.ToString()
$script:runtimeRoot=Join-Path $program ('Edge\'+$ReleaseName+'\app')
$foundationRoot=Join-Path $data 'EdgeTools\edge-0186902';$private=Join-Path $foundationRoot 'private'
$foundation=Read-Json (Join-Path $private 'foundation-state.json');$stage=Read-Json (Join-Path $foundationRoot 'foundation-stage1.json')
$script:nodeExe=Join-Path $program 'Edge\edge-0186902\node\node.exe';$wrapper=Join-Path $program 'Edge\edge-0186902\PickChickEdge.exe'
$root=Join-Path $data 'DeviceAccess';$serviceRoot=Join-Path $root 'service';$script:logRoot=Join-Path $root 'logs';$envPath=Join-Path $serviceRoot 'device-access.env'
$binRoot=Join-Path $program 'DeviceAccess';$serviceId='PickChickDeviceAccessWorker';$depends=@('PickChickPostgres','PickChickFulfillmentTunnel')
$identity=Join-Path $data 'FulfillmentWorker\device-identity.json';$fulfillmentXml=Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.xml'
$lockPath=Join-Path $data 'EdgeTools\unified-menu-maintenance.lock';$ownedLease=$null
foreach($path in @($runtimeRoot,$private,$nodeExe,$wrapper,$identity,$CiProof,$lockPath)) {Assert-NtfsPath $path}
try {
 if($Apply) {
  Assert-Acl (Split-Path $lockPath) -Foundation
  if($MaintenanceLease) {
   if($MaintenanceLease.Name -cne $lockPath -or -not $MaintenanceLease.CanWrite) {throw 'Foreign maintenance lease.'}
   $probe=$null;try {$probe=[IO.File]::Open($lockPath,'Open','ReadWrite','None')} catch [IO.IOException] {}
   if($probe) {$probe.Dispose();throw 'Supplied maintenance lease is not exclusive.'}
  } else {$ownedLease=[IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None')}
 }
 Assert-Acl $runtimeRoot -Foundation -ServiceRead;Assert-Acl $private -Foundation;Assert-Acl $nodeExe -Foundation -ServiceRead -InheritedAllowed;Assert-Acl $wrapper -Foundation -ServiceRead -InheritedAllowed
 Assert-Acl $CiProof -Foundation -InheritedAllowed;$ci=Read-Json $CiProof 1048576;Assert-UnifiedCi $ci $SourceCommit
 if($ReleaseName -cne ('edge-'+$SourceCommit.Substring(0,7)) -or $foundation.complete -ne $true -or $foundation.branchId -cne $branch -or $foundation.computerName -ine $env:COMPUTERNAME -or $stage.branchId -cne $branch) {throw 'Foundation/source binding differs.'}
 if((Hash-File $wrapper) -cne $stage.winSwSha256) {throw 'WinSW source differs.'}
 $stageProof=Join-Path $data ('EdgeTools\device-access-'+$SourceCommit.Substring(0,7)+'\inputs.json')
 Assert-Acl $stageProof -Foundation -InheritedAllowed
 Assert-DeviceStage (Read-Json $stageProof) $SourceCommit $branch $device (Hash-File (Join-Path $runtimeRoot 'runtime-manifest.json')) $ci.run.id
 $manifest=Read-Json (Join-Path $runtimeRoot 'runtime-manifest.json') 8388608
 if($manifest.sourceCommit -cne $SourceCommit -or $manifest.format -cne 'pickchick-edge-runtime-v1' -or $manifest.target -cne 'windows-x64') {throw 'Runtime source differs.'}
 $seen=@{};foreach($file in $manifest.files) {
  if($file.path -match '(^|/)\.\.?(/|$)|[:\\]' -or [IO.Path]::IsPathRooted($file.path) -or $seen.ContainsKey($file.path)) {throw 'Unsafe manifest path.'}
  $seen[$file.path]=$file.sha256;$p=Join-Path $runtimeRoot $file.path;Assert-Acl $p -Foundation -ServiceRead -InheritedAllowed
  if((Hash-File $p) -cne $file.sha256) {throw 'Runtime file differs.'}
 }
 foreach($p in @('infra/windows/native-device-access-worker.mjs','infra/windows/terminal-access-upgrade-db.mjs','infra/windows/terminal-access-grants.mjs','db/edge/migrations/020_terminal_access.sql')) {if(-not $seen.ContainsKey($p)) {throw 'Required helper missing.'}}
 Assert-Identity $identity $branch $device;Assert-Acl $fulfillmentXml -Foundation -ServiceRead -InheritedAllowed
 [xml]$workerXml=[IO.File]::ReadAllText($fulfillmentXml)
 if(-not ([string]$workerXml.service.arguments).EndsWith('"'+$identity+'" '+$branch+' '+$device,[StringComparison]::Ordinal)) {throw 'Fulfillment binding differs.'}
 $preservedServices=@{};foreach($name in $depends) {$service=Get-CimInstance Win32_Service -Filter "Name='$name'";if($service.State -cne 'Running') {throw 'Preserved dependency unavailable.'};$preservedServices[$name]=$service.ProcessId}
 $preservedFiles=@{}
 foreach($path in @($identity,$fulfillmentXml,(Join-Path $data 'FulfillmentWorker\worker.env'),(Join-Path $data 'MenuSync\service\menu-sync.env'),(Join-Path $program 'MenuSyncWorker\PickChickMenuSyncWorker.xml'),(Join-Path $program 'Edge\edge-0186902\PickChickEdge.xml'))) {Assert-Acl $path -Foundation -ServiceRead -InheritedAllowed;$preservedFiles[$path]=Hash-File $path}
 $edgeEnv=Join-Path $data 'Edge\config\edge.env';Assert-Acl $edgeEnv -Foundation -ServiceRead -InheritedAllowed
 if($Mode -ne 'Activate') {$preservedFiles[$edgeEnv]=Hash-File $edgeEnv}
 $existing=Get-Service $serviceId -ErrorAction SilentlyContinue
 if($existing -and $Mode -ne 'Ready' -and $existing.Status -ne 'Stopped') {throw 'Mailbox must be stopped for preparation/install verification.'}
 $dbArgs=@((Join-Path $runtimeRoot 'infra\windows\terminal-access-upgrade-db.mjs'),'inspect',$foundationRoot,$runtimeRoot,$branch,$device,$BackupManifest,$envPath)
 if($Mode -in @('Inspect','Prepare')) {
  Assert-Backup $BackupManifest $foundation $branch
  $before=Run-Tool $nodeExe $dbArgs 600 | ConvertFrom-Json
  if($Mode -eq 'Inspect' -or -not $Apply) {$before | ConvertTo-Json -Depth 8 -Compress;return}
  if($before.migrations -ne 19 -or -not $before.migrationPending) {throw '019 only; inspect partial state without replay.'}
  foreach($entry in @(@($root,'read'),@($serviceRoot,'read'),@($logRoot,'modify'))) {
   if(Test-Path $entry[0]) {Assert-Acl $entry[0] -ServiceRead:($entry[1] -ceq 'read') -ServiceModify:($entry[1] -ceq 'modify')}
   else {Set-ProtectedAcl $entry[0] -Directory -ServiceRead:($entry[1] -ceq 'read') -ServiceModify:($entry[1] -ceq 'modify')}
  }
  if(Test-Path $envPath) {Assert-Acl $envPath -ServiceRead;Assert-DeviceDisabledEnv ([IO.File]::ReadAllText($envPath)) $branch $device}
  $dbArgs[1]='apply'
  $result=Invoke-UnifiedQuiesced {Run-Tool $nodeExe $dbArgs 600 | ConvertFrom-Json}
  Set-ProtectedAcl $envPath -ServiceRead;Assert-DeviceDisabledEnv ([IO.File]::ReadAllText($envPath)) $branch $device
  if($result.migrations -ne 20 -or -not $result.grantsVerified -or -not $result.loginVerified -or -not $result.existingDataPreserved) {throw 'Actual database result not verified.'}
  Assert-DevicePreserved $preservedFiles $preservedServices
  $result | ConvertTo-Json -Depth 8 -Compress;return
 }
 foreach($p in @($root,$serviceRoot,$envPath)) {Assert-Acl $p -ServiceRead};Assert-Acl $logRoot -ServiceModify
 Assert-DeviceDisabledEnv ([IO.File]::ReadAllText($envPath)) $branch $device ($Mode -ceq 'Ready')
 Assert-Backup $BackupManifest $foundation $branch
 $db=Run-Tool $nodeExe $dbArgs 600 | ConvertFrom-Json
 if($db.migrations -ne 20 -or -not $db.grantsVerified) {throw 'Verified020 grants required.'}
 $arguments=@(('--env-file='+$envPath),(Join-Path $runtimeRoot 'infra\windows\native-device-access-worker.mjs'),$identity,$branch,$device)
 $xml=(Build-ServiceXml $serviceId $nodeExe $arguments $depends).Replace('PickChick menu publication worker (back-office menu to cashier)','PickChick device access mailbox')
 $xml=$xml.Replace('<delayedAutoStart>true</delayedAutoStart>','')
 if($Mode -ne 'Ready') {$xml=$xml.Replace('<startmode>Automatic</startmode>','<startmode>Manual</startmode>')}
 $image=Join-Path $binRoot ($serviceId+'.exe');$xmlPath=Join-Path $binRoot ($serviceId+'.xml')
 if($Mode -eq 'Install' -and -not $Apply) {@{phase='install-plan';sourceCommit=$SourceCommit;workerInstalled=[bool]$existing;workerStarts=$false} | ConvertTo-Json -Compress;return}
 if($Mode -eq 'Install') {
  if(Test-Path $binRoot) {Assert-Acl $binRoot -ServiceRead} else {Set-ProtectedAcl $binRoot -Directory -ServiceRead}
  if(-not (Test-Path $image)) {[IO.File]::Copy($wrapper,$image,$false);Set-ProtectedAcl $image -ServiceRead}
  Ensure-Text $xmlPath $xml -ServiceRead
 }
 Assert-Acl $binRoot -ServiceRead;Assert-Acl $image -ServiceRead;Assert-Acl $xmlPath -ServiceRead
 if((Hash-File $image) -cne $stage.winSwSha256 -or [IO.File]::ReadAllText($xmlPath) -cne $xml) {throw 'Worker image/XML differs.'}
 if(-not $existing) {if($Mode -ne 'Install' -or -not $Apply) {throw 'Worker missing.'};$null=Run-Tool $image @('install')}
 $installed=Assert-DeviceWorker $serviceId $image $depends ($Mode -ceq 'Ready')
 if($Mode -ne 'Ready' -and $installed.State -cne 'Stopped') {throw 'Disabled worker unexpectedly running.'}
 if($Mode -eq 'Install') {Assert-DevicePreserved $preservedFiles $preservedServices;@{phase='installed-stopped';sourceCommit=$SourceCommit;schema=20;grants_verified=$true;worker=@{installed=$true;enabled=$false;running=$false;script_sha256=$seen['infra/windows/native-device-access-worker.mjs']};cloudDeliveryVerified=$false} | ConvertTo-Json -Depth 6 -Compress;return}
 if(-not $LinkProof -or -not $LinkProofSha256 -or (Hash-File $LinkProof) -cne $LinkProofSha256) {throw 'Exact saved link proof required.'}
 $link=Read-Json $LinkProof 1048576;Assert-DeviceLinkProof $link $SourceCommit (Join-Path $program 'KitchenLink')
 Wait-UnifiedReady $runtimeRoot
 Assert-DeviceEdgeFlag ([IO.File]::ReadAllText($edgeEnv)) ($Mode -ceq 'Ready')
 if($Mode -in @('Activate','Ready')) {
  if(-not $CloudProof -or -not $CloudProofSha256 -or (Hash-File $CloudProof) -cne $CloudProofSha256) {throw 'Exact cloud enable proof required.'}
  Assert-DeviceCloudProof (Read-Json $CloudProof 1048576) $SourceCommit $branch $device
 }
 if($Mode -eq 'Activate') {
  if(-not $ExpectedEdgeEnvSha256 -or (Hash-File $edgeEnv) -cne $ExpectedEdgeEnvSha256) {throw 'Reviewed edge environment CAS hash required.'}
  foreach($def in (Import-DeviceHelper (Join-Path $PSScriptRoot 'reviewed-env-bytes.ps1') '00412db264f47a3b7c2996fb44115e46ae63a965710943f1b5c725e9156137c3' @('Update-ReviewedEnvBytes'))) {. ([scriptblock]::Create($def))}
  $edgeBefore=[IO.File]::ReadAllBytes($edgeEnv);$workerBefore=[IO.File]::ReadAllBytes($envPath);$xmlBefore=[IO.File]::ReadAllBytes($xmlPath)
  $edgeAfter=Update-ReviewedEnvBytes $edgeBefore 'EDGE_DEVICE_ACCESS_ENABLED' 'false' 'true' -AllowAbsent
  $workerAfter=Update-ReviewedEnvBytes $workerBefore 'DEVICE_ACCESS_WORKER_ENABLED' 'false' 'true'
  $xmlAfter=[Text.UTF8Encoding]::new($false).GetBytes($xml.Replace('<startmode>Manual</startmode>','<startmode>Automatic</startmode>'))
  if(-not $Apply) {@{phase='activate-plan';source_sha=$SourceCommit;edge_restart=$true;worker_start=$true;cloudDeliveryVerified=$false} | ConvertTo-Json -Compress;return}
  $activation=Join-Path $root ('activation-'+[guid]::NewGuid().ToString('N'));Set-ProtectedAcl $activation -Directory
  foreach($item in @(@('edge.env',$edgeBefore),@('worker.env',$workerBefore),@('worker.xml',$xmlBefore))) {[IO.File]::WriteAllBytes((Join-Path $activation $item[0]),$item[1]);Set-ProtectedAcl (Join-Path $activation $item[0])}
  Write-NewText (Join-Path $activation 'intent.json') (@{source_sha=$SourceCommit;cloud_proof_sha256=$CloudProofSha256;edge_env_before_sha256=$ExpectedEdgeEnvSha256;completed=$false} | ConvertTo-Json)
  try {
   Invoke-UnifiedQuiesced {Write-DeviceCas $edgeEnv $edgeBefore $edgeAfter;Write-DeviceCas $envPath $workerBefore $workerAfter;Write-DeviceCas $xmlPath $xmlBefore $xmlAfter;Set-Service $serviceId -StartupType Automatic}
   Wait-UnifiedReady $runtimeRoot
   Start-Service $serviceId;(Get-Service $serviceId).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
   $live=Assert-DeviceWorker $serviceId $image $depends $true
   Wait-DeviceChild $live $nodeExe (Join-Path $runtimeRoot 'infra\windows\native-device-access-worker.mjs')
  } catch {
   if((Get-Service $serviceId).Status -ne 'Stopped') {Stop-Service $serviceId;(Get-Service $serviceId).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}
   Invoke-UnifiedQuiesced {
    # Validate all three CAS states before restoring any one.
    foreach($item in @(@($edgeEnv,$edgeBefore,$edgeAfter),@($envPath,$workerBefore,$workerAfter),@($xmlPath,$xmlBefore,$xmlAfter))) {$actual=[Convert]::ToBase64String([IO.File]::ReadAllBytes($item[0]));if($actual -cne [Convert]::ToBase64String($item[1]) -and $actual -cne [Convert]::ToBase64String($item[2])) {throw 'Activation rollback has foreign bytes; inspect.'}}
    foreach($item in @(@($edgeEnv,$edgeBefore,$edgeAfter),@($envPath,$workerBefore,$workerAfter),@($xmlPath,$xmlBefore,$xmlAfter))) {if([Convert]::ToBase64String([IO.File]::ReadAllBytes($item[0])) -cne [Convert]::ToBase64String($item[1])) {Write-DeviceCas $item[0] $item[2] $item[1]}}
    Set-Service $serviceId -StartupType Manual
   }
   Wait-UnifiedReady $runtimeRoot
   throw
  }
 }
 $ready=$Mode -in @('Activate','Ready')
 $installed=Assert-DeviceWorker $serviceId $image $depends $ready
 if($ready) {
  Assert-DeviceDisabledEnv ([IO.File]::ReadAllText($envPath)) $branch $device $true
  if($installed.State -cne 'Running' -or [IO.File]::ReadAllText($edgeEnv) -cnotmatch '(?m)^EDGE_DEVICE_ACCESS_ENABLED=true\r?$') {throw 'Activated environment/service not verified.'}
  Wait-DeviceChild $installed $nodeExe (Join-Path $runtimeRoot 'infra\windows\native-device-access-worker.mjs')
 }
 Assert-DevicePreserved $preservedFiles $preservedServices
 $result=@{format=$(if($ready){'pickchick-device-access-ready-v1'}else{'pickchick-device-access-prepared-v1'});source_sha=$SourceCommit;branch_id=$branch;edge_device_id=$device;schema=20;migrationChecksum020=$seen['db/edge/migrations/020_terminal_access.sql'];runtime_verified=$true;grants_verified=$true;worker=@{installed=$true;enabled=$ready;running=$ready;script_sha256=$seen['infra/windows/native-device-access-worker.mjs']};link=$link.link;cloudDeliveryVerified=$false;completed_epoch=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}
 if($Mode -eq 'Activate') {Write-NewText (Join-Path $activation 'result.json') ($result | ConvertTo-Json -Depth 8)}
 $result | ConvertTo-Json -Depth 8 -Compress
} finally {if($ownedLease) {$ownedLease.Dispose()}}
