#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Enable existing edge019 STOP processing without upgrading the runtime or Devices.
Default is read-only. Separate operator/edge CI and exact runtime hashes are mandatory.
Only edge.env changes under the shared maintenance lock, with private restore rehearsal.
Edge/KitchenLink restart; all other services and configuration are compared afterwards. #>
[CmdletBinding()]
param(
 [ValidateSet('Enable','Verify')][string]$Mode='Enable',
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
 [Parameter(Mandatory=$true)][guid]$BranchId,
 [Parameter(Mandatory=$true)][guid]$DeviceId,
 [Parameter(Mandatory=$true)][string]$CiProof,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$OperatorCommit,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ApiSourceCommit,
 [Parameter(Mandatory=$true)][string]$OperatorCiProof,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$OperatorScriptSha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ReadinessSha256,
 [Parameter(Mandatory=$true)][string]$MenuHeadProof,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$MenuHeadProofSha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedEdgeEnvSha256,
 [string]$ReviewedPlan,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ReviewedPlanSha256,
 [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Import-StopHelper([string]$File,[string]$Hash,[string[]]$Names) {
 if((Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) {throw 'Pinned helper differs.'}
 $t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$t,[ref]$e)
 if($e.Count) {throw 'Helper parse failed.'}
 foreach($name in $Names) {$f=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$false));if($f.Count -ne 1) {throw 'Helper missing.'};$f[0].Extent.Text}
}
function Stop-BytesHash([byte[]]$Bytes) {
 $h=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($h.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
}
function Assert-StopFlag([byte[]]$Bytes,[string]$Key,[string]$Value,[switch]$AllowAbsent) {
 # The pure transformer validates the whole environment, including duplicate aliases/newlines.
 $null=Update-ReviewedEnvBytes $Bytes $Key $Value $Value -AllowAbsent:$AllowAbsent
}
function Assert-StopHead($Head,$Menu,[string]$Source,[string]$Branch,[string]$Device,[long]$Now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) {
 if($Head.format -cne 'pickchick-unified-menu-head-v1' -or $Head.source_sha -cne $Source -or $Head.branch_id -cne $Branch -or $Head.edge_device_id -cne $Device -or $Head.completed_epoch -gt $Now -or ($Now-$Head.completed_epoch) -gt 900 -or $Head.catalog_version -lt 1) {throw 'Fresh same-source cloud menu head required.'}
 if($Menu.branch_id -cne $Branch -or $Menu.edge_device_id -cne $Device -or $Menu.schema -ne 19 -or $Menu.runtime_verified -ne $true -or $Menu.grants_verified -ne $true -or $Menu.read_only -ne $true -or $Menu.pending_menu_acks -ne 0 -or $Menu.pending_stop_commands -ne 0) {throw 'Local menu/stop readiness differs.'}
 foreach($key in @('menu_release_id','menu_version','menu_hash')) {if($Head.$key -cne $Menu.$key) {throw 'Cloud/local applied menu differs.'}}
 if($Head.menu_release_id -cnotmatch '^[a-f0-9-]{36}$' -or $Head.menu_hash -cnotmatch '^[a-f0-9]{64}$' -or $Head.menu_version -lt 1) {throw 'Invalid applied menu head.'}
}
function Assert-StopReviewedPlan($Plan,$Actual) {
 if(($Plan | ConvertTo-Json -Depth 12 -Compress) -cne ($Actual | ConvertTo-Json -Depth 12 -Compress)) {throw 'Reviewed plan no longer matches actual state.'}
}
function New-StopAttemptMarker([string]$Path,$Plan,[string]$Attempt) {
 # Write-NewText uses CreateNew. A failed/unknown attempt is never silently superseded.
 Write-NewText $Path (@{format='pickchick-remote-stops-attempt-v1';plan=$Plan;attempt=$Attempt;completed=$false} | ConvertTo-Json -Depth 14)
}
function Get-StopAclFingerprint([string]$Path) {
 $acl=Get-Acl -LiteralPath $Path
 # ReplaceFile can add SE_DACL_AUTO_INHERITED without changing any permission.
 # Compare owner, group, protection and every ordered ACE, not that bookkeeping bit.
 $state=[ordered]@{owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;group=$acl.GetGroup([Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [ordered]@{sid=$_.IdentityReference.Value;rights=[long]$_.FileSystemRights;type=[string]$_.AccessControlType;inheritance=[string]$_.InheritanceFlags;propagation=[string]$_.PropagationFlags;inherited=$_.IsInherited}
 })}
 return Stop-BytesHash ([Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Depth 5 -Compress)))
}
function Write-StopCas([string]$Path,[byte[]]$Before,[byte[]]$After) {
 Assert-Acl $Path -Foundation -ServiceRead -InheritedAllowed
 $aclBefore=Get-StopAclFingerprint $Path
 if((Stop-BytesHash ([IO.File]::ReadAllBytes($Path))) -cne (Stop-BytesHash $Before)) {throw 'Concurrent environment change.'}
 $temp=$Path+'.remote-stop-'+[guid]::NewGuid().ToString('N')+'.tmp'
 $h=[IO.File]::Open($temp,'CreateNew','Write','None');try{$h.Write($After,0,$After.Length);$h.Flush($true)}finally{$h.Dispose()}
 Set-ProtectedAcl $temp -ServiceRead
 [IO.File]::Replace($temp,$Path,[Management.Automation.Language.NullString]::Value)
 # ReplaceFile preserves the destination ACL, including reviewed foundation inheritance.
 Assert-Acl $Path -Foundation -ServiceRead -InheritedAllowed
 if((Get-StopAclFingerprint $Path) -cne $aclBefore) {throw 'Environment permissions changed during replacement.'}
 if((Hash-File $Path) -cne (Stop-BytesHash $After)) {throw 'Replaced environment bytes differ.'}
}
function Restore-StopCas([string]$Path,[byte[]]$Before,[byte[]]$After) {
 $hash=Hash-File $Path
 if($hash -ceq (Stop-BytesHash $Before)) {return}
 if($hash -cne (Stop-BytesHash $After)) {throw 'Foreign partial state retained; no automatic overwrite.'}
 Write-StopCas $Path $After $Before
}
function Invoke-StopEdgeRestart([scriptblock]$Action,[switch]$ResumeStopped) {
 $order=@('PickChickKitchenLink','PickChickEdge')
 $unknown=@((Get-Service PickChickEdge).DependentServices | Where-Object {$_.Status -ne 'Stopped' -and $_.Name -cne 'PickChickKitchenLink'})
 if($unknown.Count) {throw 'Unreviewed Edge dependent; no service stopped.'}
 $running=@();foreach($name in $order) {$s=Get-Service $name;if($s.Status -ne 'Running' -and -not ($ResumeStopped -and $s.Status -eq 'Stopped')) {throw 'Edge/Link not initially running.'};$running+=$name}
 try {
  foreach($name in $running) {if((Get-Service $name).Status -ne 'Stopped') {Stop-Service $name};(Get-Service $name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(35))}
  & $Action
 } finally {
  $errors=@();[array]::Reverse($running)
  foreach($name in $running) {try {if((Get-Service $name).Status -ne 'Running') {Start-Service $name};(Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(35))}catch{$errors+=$name}}
  if($errors.Count) {throw ('Service recovery needs inspection: '+($errors -join ', '))}
 }
}
function Get-StopServiceBinding([string]$Name,[string]$Xml,[string]$Node,[string]$WrapperHash) {
 Assert-Acl $Xml -Foundation -ServiceRead -InheritedAllowed
 [xml]$x=[IO.File]::ReadAllText($Xml);$image=[IO.Path]::ChangeExtension($Xml,'.exe')
 Assert-Acl $image -Foundation -ServiceRead -InheritedAllowed
 $s=Get-CimInstance Win32_Service -Filter "Name='$Name'"
 if($s.State -cne 'Running' -or $s.StartName -ine 'NT AUTHORITY\LocalService' -or $s.StartMode -cne 'Auto' -or $s.PathName -cne (Quote-WindowsArgument $image) -or (Hash-File $image) -cne $WrapperHash -or [string]$x.service.executable -ine $Node) {throw 'Runtime service/image binding differs.'}
 $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($s.ProcessId)" | Where-Object {$_.ExecutablePath -ieq $Node -and $_.CommandLine.EndsWith([string]$x.service.arguments,[StringComparison]::Ordinal)})
 if($children.Count -ne 1) {throw 'Actual child differs from service XML.'}
 return [ordered]@{wrapper_pid=$s.ProcessId;child_pid=$children[0].ProcessId;image_sha256=(Hash-File $image);xml_sha256=(Hash-File $Xml)}
}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop') {throw 'Elevated Windows PowerShell5.1 required.'}
if($Apply -and $Mode -ne 'Enable') {throw 'Verify never mutates.'}
$script:operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($d in (Import-StopHelper (Join-Path $PSScriptRoot 'install-native-menu-sync.ps1') 'ff955a154aa4cfa8507474cef2ac37ae19b9b1d7e4fc46b8fe0f14a5a323831c' @('Assert-NtfsPath','Assert-Acl','Set-ProtectedAcl','Read-Json','Hash-File','Run-Tool','Write-NewText','Quote-WindowsArgument'))) {. ([scriptblock]::Create($d))}
foreach($d in (Import-StopHelper (Join-Path $PSScriptRoot 'update-native-unified-menu.ps1') 'b764a8733224f951ad1543d9d1b18bf7ac269b1e034a1fbadbefbba488f903ef' @('Assert-UnifiedCi','Wait-UnifiedReady'))) {. ([scriptblock]::Create($d))}
foreach($d in (Import-StopHelper (Join-Path $PSScriptRoot 'update-native-service.ps1') '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Read-UpdateHttp'))) {. ([scriptblock]::Create($d))}
foreach($d in (Import-StopHelper (Join-Path $PSScriptRoot 'reviewed-env-bytes.ps1') '00412db264f47a3b7c2996fb44115e46ae63a965710943f1b5c725e9156137c3' @('Update-ReviewedEnvBytes'))) {. ([scriptblock]::Create($d))}
$program='C:\Program Files\PickChick';$data='C:\ProgramData\PickChick';$branch=$BranchId.ToString();$device=$DeviceId.ToString()
$release='edge-'+$SourceCommit.Substring(0,7);$app=Join-Path $program ('Edge\'+$release+'\app')
$foundationRoot=Join-Path $data 'EdgeTools\edge-0186902';$node=Join-Path $program 'Edge\edge-0186902\node\node.exe'
$script:runtimeRoot=$app;$script:nodeExe=$node
$attemptMarker=Join-Path $data ('EdgeTools\existing-stops-'+$OperatorCommit+'-attempt.json')
$edgeEnv=Join-Path $data 'Edge\config\edge.env';$lockPath=Join-Path $data 'EdgeTools\unified-menu-maintenance.lock';$lease=$null
try {
 Assert-Acl $lockPath -Foundation -InheritedAllowed
 # Existing lock only: the read-only plan does not create a lock or evidence file.
 $lease=[IO.File]::Open($lockPath,'Open',$(if($Apply){'ReadWrite'}else{'Read'}),'None')
 if($Apply -and (Test-Path -LiteralPath $attemptMarker)) {throw 'An attempt exists; inspect actual state. No automatic replay.'}
 foreach($p in @($CiProof,$OperatorCiProof,$MenuHeadProof)) {Assert-NtfsPath $p;Assert-Acl $p -Foundation -InheritedAllowed}
 Assert-Acl $edgeEnv -Foundation -ServiceRead -InheritedAllowed
 $ci=Read-Json $CiProof 1048576;Assert-UnifiedCi $ci $SourceCommit
 $operatorCi=Read-Json $OperatorCiProof 1048576;Assert-UnifiedCi $operatorCi $OperatorCommit
 if($SourceCommit -cne '23fb39e152fccaa97a32e9bf179c2d89a50dc1d5' -or (Hash-File $PSCommandPath) -cne $OperatorScriptSha256) {throw 'Reviewed existing runtime/operator required.'}
 if((Hash-File $MenuHeadProof) -cne $MenuHeadProofSha256 -or (Hash-File $edgeEnv) -cne $ExpectedEdgeEnvSha256) {throw 'Menu proof/environment CAS differs.'}
 $head=Read-Json $MenuHeadProof
 $manifestPath=Join-Path $app 'runtime-manifest.json';Assert-Acl $manifestPath -Foundation -ServiceRead -InheritedAllowed
 $manifest=Read-Json $manifestPath 8388608
 if($manifest.sourceCommit -cne $SourceCommit -or $manifest.format -cne 'pickchick-edge-runtime-v1' -or $manifest.target -cne 'windows-x64') {throw 'Runtime source differs.'}
 [xml]$edgeBinding=[IO.File]::ReadAllText((Join-Path $program 'Edge\edge-0186902\PickChickEdge.xml'))
 if([string]$edgeBinding.service.workingdirectory -cne $app -or -not ([string]$edgeBinding.service.arguments).Contains($app+'\dist\main.js')) {throw 'Edge service does not run the pinned runtime.'}
 [xml]$workerBinding=[IO.File]::ReadAllText((Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.xml'))
 if([string]$workerBinding.service.workingdirectory -cne $app -or -not ([string]$workerBinding.service.arguments).Contains($app+'\infra\windows\native-fulfillment-worker.mjs')) {throw 'Worker service does not run the pinned runtime.'}
 $before=[IO.File]::ReadAllBytes($edgeEnv)
 if((Stop-BytesHash $before) -cne $ExpectedEdgeEnvSha256) {throw 'Environment changed during Ready validation.'}
 $enabled=$Mode -ceq 'Verify';$old=$(if($enabled){'true'}else{'false'})
 Assert-StopFlag $before 'EDGE_REMOTE_STOPS_ENABLED' $old -AllowAbsent:(!$enabled)
 $workerEnv=Join-Path $data 'FulfillmentWorker\worker.env';$menuEnv=Join-Path $data 'MenuSync\service\menu-sync.env'
 Assert-StopFlag ([IO.File]::ReadAllBytes($workerEnv)) 'FULFILLMENT_TRANSPORT_PROTOCOL' '4'
 Assert-StopFlag ([IO.File]::ReadAllBytes($menuEnv)) 'EDGE_MENU_SYNC_MODE' 'apply'
 $after=if($enabled){$before}else{Update-ReviewedEnvBytes $before 'EDGE_REMOTE_STOPS_ENABLED' 'false' 'true' -AllowAbsent}
 $preserved=@{}
 foreach($p in @($workerEnv,$menuEnv,(Join-Path $data 'FulfillmentWorker\device-identity.json'),(Join-Path $foundationRoot 'private\edge-owner.env'),(Join-Path $foundationRoot 'private\foundation-credentials.json'))) {
  Assert-NtfsPath $p
  $preserved[$p]=Hash-File $p
 }
 $services=[ordered]@{};$stage=Read-Json (Join-Path $foundationRoot 'foundation-stage1.json')
 foreach($pair in @(@('PickChickEdge','Edge\edge-0186902\PickChickEdge.xml'),@('PickChickFulfillmentWorker','FulfillmentWorker\PickChickFulfillmentWorker.xml'),@('PickChickMenuSyncWorker','MenuSyncWorker\PickChickMenuSyncWorker.xml'),@('PickChickKitchenLink','KitchenLink\PickChickKitchenLink.xml'))) {
  $p=Join-Path $program $pair[1];$services[$pair[0]]=Get-StopServiceBinding $pair[0] $p $node $stage.winSwSha256;$preserved[$p]=Hash-File $p
 }
 foreach($name in @('PickChickPostgres','PickChickFulfillmentTunnel')) {$s=Get-CimInstance Win32_Service -Filter "Name='$name'";if($s.State -cne 'Running') {throw 'Dependency unavailable.'};$services[$name]=[ordered]@{wrapper_pid=$s.ProcessId}}
 $probe=Join-Path $PSScriptRoot 'existing-stops-readiness.mjs'
 if((Hash-File $probe) -cne $ReadinessSha256) {throw 'Read-only probe differs.'}
 $readMenu={Run-Tool $node @($probe,$foundationRoot,$app,$branch,$device) 120 | ConvertFrom-Json}
 $menu=& $readMenu;Assert-StopHead $head $menu $ApiSourceCommit $branch $device
 $plan=[ordered]@{format='pickchick-existing-stops-plan-v1';source_sha=$SourceCommit;branch_id=$branch;edge_device_id=$device;ci_run=$ci.run.id;menu_head_proof_sha256=$MenuHeadProofSha256;operator_sha=$OperatorCommit;api_source_sha=$ApiSourceCommit;operator_script_sha256=$OperatorScriptSha256;readiness_sha256=$ReadinessSha256;runtime_manifest_sha256=(Hash-File $manifestPath);env_acl_sha256=(Get-StopAclFingerprint $edgeEnv);env_before_sha256=(Stop-BytesHash $before);env_after_sha256=(Stop-BytesHash $after);menu=$menu;services=$services;restart=@('PickChickKitchenLink','PickChickEdge')}
 $attempt=$null
 if($Mode -eq 'Enable' -and -not $Apply) {$plan | ConvertTo-Json -Depth 12 -Compress;return}
 if($Apply) {
  if(-not $ReviewedPlan -or -not $ReviewedPlanSha256 -or (Hash-File $ReviewedPlan) -cne $ReviewedPlanSha256) {throw 'Exact reviewed plan required.'}
  Assert-Acl $ReviewedPlan -Foundation -InheritedAllowed;Assert-StopReviewedPlan (Read-Json $ReviewedPlan 1048576) $plan
  $attempt=Join-Path $data ('EdgeTools\remote-stops-'+[guid]::NewGuid().ToString('N'))
  New-StopAttemptMarker $attemptMarker $plan $attempt
  Set-ProtectedAcl $attempt -Directory
  foreach($pair in @(@('before.env',$before),@('after.env',$after))) {$p=Join-Path $attempt $pair[0];$h=[IO.File]::Open($p,'CreateNew','Write','None');try{$h.Write($pair[1],0,$pair[1].Length);$h.Flush($true)}finally{$h.Dispose()};Set-ProtectedAcl $p}
  # Restore rehearsal compares private copied bytes before any running process stops.
  $restore=Join-Path $attempt 'restore-rehearsal.env';[IO.File]::Copy((Join-Path $attempt 'before.env'),$restore,$false);Set-ProtectedAcl $restore
  if((Hash-File $restore) -cne $ExpectedEdgeEnvSha256) {throw 'Private environment restore rehearsal failed.'}
  Write-NewText (Join-Path $attempt 'intent.json') ($plan | ConvertTo-Json -Depth 12)
  $phase='replace-and-restart'
  try {
   Invoke-StopEdgeRestart {Write-StopCas $edgeEnv $before $after}
   $phase='edge-readiness';Wait-UnifiedReady $app
   $phase='service-bindings'
   $null=Get-StopServiceBinding 'PickChickEdge' (Join-Path $program 'Edge\edge-0186902\PickChickEdge.xml') $node $stage.winSwSha256
   $null=Get-StopServiceBinding 'PickChickKitchenLink' (Join-Path $program 'KitchenLink\PickChickKitchenLink.xml') $node $stage.winSwSha256
   $phase='menu-readiness';$menu=& $readMenu;Assert-StopHead $head $menu $ApiSourceCommit $branch $device
   $phase='preservation'
   foreach($p in $preserved.Keys) {if((Hash-File $p) -cne $preserved[$p]) {throw 'Unrelated configuration changed.'}}
   foreach($name in $services.Keys) {
    $s=Get-CimInstance Win32_Service -Filter "Name='$name'"
    if($s.State -cne 'Running' -or ($name -notin @('PickChickEdge','PickChickKitchenLink') -and $s.ProcessId -ne $services[$name].wrapper_pid)) {throw 'Unrelated service restarted or failed.'}
   }
   if((Hash-File $edgeEnv) -cne (Stop-BytesHash $after)) {throw 'Final environment differs.'}
  } catch {
   $failureLine=$_.InvocationInfo.ScriptLineNumber
   $restored=$false;$rollbackLine=$null
   try {Invoke-StopEdgeRestart {Restore-StopCas $edgeEnv $before $after} -ResumeStopped;Wait-UnifiedReady $app;$restored=((Hash-File $edgeEnv) -ceq (Stop-BytesHash $before))} catch {$rollbackLine=$_.InvocationInfo.ScriptLineNumber}
   Write-NewText (Join-Path $attempt 'failed.json') (@{completed=$false;phase=$phase;failure_line=$failureLine;rollback_failure_line=$rollbackLine;rollback_verified=$restored;inspect_required=$true} | ConvertTo-Json)
   throw 'Activation did not complete; inspect retained attempt and service state before another command.'
  }
 }
 if((Hash-File $edgeEnv) -cne (Stop-BytesHash $after)) {throw 'Final environment changed.'}
 $result=[ordered]@{format='pickchick-existing-stops-windows-ready-v1';source_sha=$ApiSourceCommit;edge_source_sha=$SourceCommit;operator_sha=$OperatorCommit;branch_id=$branch;edge_device_id=$device;schema=19;remote_stops_enabled=$true;protocol=4;menu_sync_mode='apply';menu_release_id=$menu.menu_release_id;menu_version=$menu.menu_version;menu_hash=$menu.menu_hash;catalog_version=$head.catalog_version;runtime_verified=$true;grants_verified=$true;env_before_sha256=$ExpectedEdgeEnvSha256;env_after_sha256=(Hash-File $edgeEnv);runtime_manifest_sha256=(Hash-File $manifestPath);completed_epoch=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}
 if($attempt) {Write-NewText (Join-Path $attempt 'verified.json') ($result | ConvertTo-Json -Depth 8)}
 $result | ConvertTo-Json -Depth 8 -Compress
} finally {if($lease) {$lease.Dispose()}}
