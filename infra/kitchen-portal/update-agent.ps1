#Requires -Version 5.1
#Requires -RunAsAdministrator
<# CAS update of an EXISTING KitchenLink; no enrollment, config/key/XML or Edge changes.
Inspect emits a plan for private capture. Apply/Rollback require that exact plan SHA.
Shared maintenance lease, full binary/config backup and restore byte drill are mandatory. #>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('Inspect','Update','Verify','Rollback')][string]$Mode,
 [Parameter(Mandatory=$true)][string]$PackageDirectory,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
 [Parameter(Mandatory=$true)][string]$CiProof,
 [Parameter(Mandatory=$true)][string]$HelpersDirectory,
 [string]$PlanFile,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$PlanSha256,
 [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Import-LinkHelper([string]$File,[string]$Hash,[string[]]$Names) {
 if((Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) {throw 'Pinned helper differs.'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
 if($errors.Count) {throw 'Helper parse failure.'}
 foreach($name in $Names) {$f=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$false));if($f.Count -ne 1) {throw 'Missing helper.'};$f[0].Extent.Text}
}
function Wait-LinkChild([string]$Node,[string]$Agent,[string]$Config) {
 $deadline=[DateTime]::UtcNow.AddSeconds(20)
 do {
  $service=Get-CimInstance Win32_Service -Filter "Name='PickChickKitchenLink'"
  $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($service.ProcessId)" | Where-Object {$_.ExecutablePath -ieq $Node -and $_.CommandLine.Contains('"'+$Agent+'" "'+$Config+'"')})
  if($service.State -ceq 'Running' -and $children.Count -eq 1) {return}
  Start-Sleep -Milliseconds 250
 } while([DateTime]::UtcNow -lt $deadline)
 throw 'KitchenLink actual Node child was not verified.'
}
function Get-LinkTree([string]$Root) {
 $files=[ordered]@{}
 foreach($f in Get-ChildItem -LiteralPath $Root -File -Recurse | Sort-Object FullName) {
  $null=Assert-LocalNtfsPath $f.FullName
  $relative=$f.FullName.Substring($Root.Length+1).Replace('\','/')
  $files[$relative]=(Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
 }
 return $files
}
function Assert-LinkSame($Actual,$Expected) {
 $a=@($Actual.Keys | Sort-Object);$e=@($Expected.PSObject.Properties.Name | Sort-Object)
 if(($a -join '|') -cne ($e -join '|')) {throw 'KitchenLink file set changed.'}
 foreach($key in $a) {if($Actual[$key] -cne $Expected.$key) {throw 'KitchenLink file bytes changed.'}}
}
function Assert-LinkPlan($Plan,[string]$Sha,[string]$Manifest,[string]$ConfigHash,[string]$XmlHash,[string]$Machine) {
 if($Plan.format -cne 'pickchick-kitchen-link-plan-v1' -or $Plan.source_sha -cne $Sha -or $Plan.manifest_sha256 -cne $Manifest -or $Plan.config_sha256 -cne $ConfigHash -or $Plan.xml_sha256 -cne $XmlHash -or $Plan.computer_name -ine $Machine) {throw 'Foreign or stale link plan.'}
}
function Write-LinkBytes([string]$Target,[byte[]]$Bytes,[string]$Expected) {
 $exists=Test-Path -LiteralPath $Target
 if(($Expected -ceq '') -ne (-not $exists)) {throw 'CAS file presence changed.'}
 if($exists -and (Get-FileHash $Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Expected) {throw 'CAS file bytes changed.'}
 $temp=$Target+'.device-'+[guid]::NewGuid().ToString('N')+'.tmp'
 $stream=[IO.File]::Open($temp,'CreateNew','Write','None');try {$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
 if($exists) {[IO.File]::Replace($temp,$Target,[Management.Automation.Language.NullString]::Value)} else {[IO.File]::Move($temp,$Target)}
 Assert-UpdateAcl $Target 'ReadAndExecute'
}
function Assert-LinkRollback($Current,$Before,$Candidate) {
 foreach($name in $Current.Keys) {
  $prior=$Before.PSObject.Properties[$name];$next=$Candidate.PSObject.Properties[$name]
  if($prior -and $Current[$name] -ceq $prior.Value) {continue}
  if($next -and $Current[$name] -ceq $next.Value) {continue}
  throw 'Foreign file prevents rollback.'
 }
 foreach($p in $Before.PSObject.Properties) {if(-not $Current.Contains($p.Name)) {throw 'Original file missing during rollback.'}}
}
function Restore-LinkFiles([string]$Root,[string]$State,$Before,$Candidate,[string[]]$Names) {
 Assert-LinkSame (Get-LinkTree (Join-Path $State 'before')) $Before
 Assert-LinkRollback (Get-LinkTree $Root) $Before $Candidate
 foreach($p in $Names) {
  $prior=$Before.PSObject.Properties[$p];$path=Join-Path $Root $p
  if($prior) {if((Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $prior.Value) {Write-LinkBytes $path ([IO.File]::ReadAllBytes((Join-Path (Join-Path $State 'before') $p))) $Candidate.$p}}
  elseif(Test-Path $path) {[IO.File]::Move($path,(Join-Path $State ('retained-'+[IO.Path]::GetFileName($path)+'-'+[guid]::NewGuid().ToString('N'))))}
 }
}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop') {throw 'Elevated Windows PowerShell5.1 required.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($d in (Import-LinkHelper (Join-Path $HelpersDirectory 'install-native-foundation.ps1') '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5' @('Assert-LocalNtfsPath','Open-VerifiedFile','New-ProtectedDirectory','Assert-ProtectedDirectory'))) {. ([scriptblock]::Create($d))}
foreach($d in (Import-LinkHelper (Join-Path $HelpersDirectory 'update-native-service.ps1') '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Assert-UpdateAcl','Write-UpdateText'))) {. ([scriptblock]::Create($d))}
foreach($d in (Import-LinkHelper (Join-Path $HelpersDirectory 'update-native-unified-menu.ps1') 'b764a8733224f951ad1543d9d1b18bf7ac269b1e034a1fbadbefbba488f903ef' @('Assert-UnifiedCi','Enter-UnifiedMaintenanceLock'))) {. ([scriptblock]::Create($d))}
$program='C:\Program Files\PickChick';$data='C:\ProgramData\PickChick';$root=Join-Path $program 'KitchenLink';$config=Join-Path $data 'KitchenLink\private\agent.json';$xml=Join-Path $root 'PickChickKitchenLink.xml';$image=Join-Path $root 'PickChickKitchenLink.exe';$node=Join-Path $program 'Edge\edge-0186902\node\node.exe'
$state=Join-Path $data ('EdgeTools\kitchen-link-'+$SourceCommit.Substring(0,12));$lease=$null;$handles=[Collections.Generic.List[IDisposable]]::new()
try {
 if($Apply) {$lease=Enter-UnifiedMaintenanceLock (Join-Path $data 'EdgeTools\unified-menu-maintenance.lock')}
 foreach($p in @($root,$config,$xml,$image,$node)) {Assert-UpdateAcl $p 'ReadAndExecute'}
 Assert-UpdateAcl $CiProof;Assert-UnifiedCi (Get-Content $CiProof -Raw -Encoding UTF8 | ConvertFrom-Json) $SourceCommit
 $h=Open-VerifiedFile (Join-Path $PackageDirectory 'agent-package.json') $ManifestSha256;$handles.Add($h);$reader=[IO.StreamReader]::new($h,[Text.Encoding]::UTF8,$true,4096,$true);try {$manifest=$reader.ReadToEnd() | ConvertFrom-Json}finally{$reader.Dispose()}
 if($manifest.source_sha -cne $SourceCommit) {throw 'Package source differs.'}
 $required=@('infra/kitchen-portal/agent.mjs','infra/kitchen-portal/link.mjs','apps/kitchen/server.mjs','apps/kitchen/terminal-cookie.mjs')
 if(@(Compare-Object ($required | Sort-Object) @($manifest.files.PSObject.Properties.Name | Sort-Object)).Count) {throw 'Unexpected link package entries.'}
 $sources=@{};foreach($p in $required) {$f=Open-VerifiedFile (Join-Path $PackageDirectory $p) $manifest.files.$p;$handles.Add($f);$memory=[IO.MemoryStream]::new();try {$f.CopyTo($memory);$sources[$p]=$memory.ToArray()}finally{$memory.Dispose()}}
 $svc=Get-CimInstance Win32_Service -Filter "Name='PickChickKitchenLink'"
 if($svc.StartName -ine 'NT AUTHORITY\LocalService' -or $svc.PathName -cne ('"'+$image+'"') -or $svc.StartMode -cne 'Auto' -or $svc.State -notin @('Running','Stopped')) {throw 'Existing link service differs.'}
 $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null;$xr=[Xml.XmlReader]::Create([IO.StringReader]::new([IO.File]::ReadAllText($xml)),$settings);try{$doc.Load($xr)}finally{$xr.Dispose()}
 if($doc.service.id -cne 'PickChickKitchenLink' -or $doc.service.executable -cne $node -or $doc.service.workingdirectory -cne $root -or $doc.service.arguments -cne ('"'+(Join-Path $root 'infra\kitchen-portal\agent.mjs')+'" "'+$config+'"') -or $doc.service.depend -cne 'PickChickEdge') {throw 'Existing agent runtime binding differs.'}
 $configHash=(Get-FileHash $config -Algorithm SHA256).Hash.ToLowerInvariant();$xmlHash=(Get-FileHash $xml -Algorithm SHA256).Hash.ToLowerInvariant()
 $current=Get-LinkTree $root
 $neighbors=@{};foreach($name in @('PickChickPostgres','PickChickEdge','PickChickFulfillmentWorker','PickChickFulfillmentTunnel','PickChickMenuSyncWorker')) {$n=Get-CimInstance Win32_Service -Filter "Name='$name'";if($n) {$neighbors[$name]=@{pid=$n.ProcessId;state=$n.State}}}
 if($Mode -eq 'Inspect') {
  if($svc.State -cne 'Running') {throw 'Inspect requires a running baseline.'}
  @{format='pickchick-kitchen-link-plan-v1';source_sha=$SourceCommit;manifest_sha256=$ManifestSha256;config_sha256=$configHash;xml_sha256=$xmlHash;computer_name=$env:COMPUTERNAME;files=$current;completed_epoch=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()} | ConvertTo-Json -Depth 8 -Compress;return
 }
 if(-not $PlanFile -or -not $PlanSha256) {throw 'Exact saved plan required.'}
 $h=Open-VerifiedFile $PlanFile $PlanSha256;$handles.Add($h);$r=[IO.StreamReader]::new($h,[Text.Encoding]::UTF8,$true,4096,$true);try{$plan=$r.ReadToEnd()|ConvertFrom-Json}finally{$r.Dispose()}
 Assert-LinkPlan $plan $SourceCommit $ManifestSha256 $configHash $xmlHash $env:COMPUTERNAME
 $target=[ordered]@{};foreach($p in $plan.files.PSObject.Properties) {$target[$p.Name]=$p.Value};foreach($p in $required) {$target[$p]=$manifest.files.$p};$targetObject=$target | ConvertTo-Json | ConvertFrom-Json
 if($Mode -eq 'Update') {Assert-LinkSame $current $plan.files;if($svc.State -cne 'Running') {throw 'Update requires the reviewed running baseline.'}}
 elseif($Mode -eq 'Verify') {Assert-LinkSame $current $targetObject;Wait-LinkChild $node (Join-Path $root 'infra\kitchen-portal\agent.mjs') $config;@{source_sha=$SourceCommit;link=@{verified=$true;manifest_sha256=$ManifestSha256;files=$manifest.files;config_sha256=$configHash;xml_sha256=$xmlHash;running=$true};configUnchanged=$true;completed_epoch=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()} | ConvertTo-Json -Depth 5 -Compress;return}
 else {Assert-LinkRollback $current $plan.files $manifest.files}
 if(-not $Apply) {@{phase=$Mode;validated=$true;applied=$false;service='PickChickKitchenLink'} | ConvertTo-Json -Compress;return}
 if($Mode -eq 'Update') {
  if(Test-Path $state) {throw 'Partial operation retained; inspect before replay.'};New-ProtectedDirectory $state
  Copy-Item -LiteralPath $root -Destination (Join-Path $state 'before') -Recurse
  [IO.File]::Copy($config,(Join-Path $state 'agent.config.backup'),$false)
  Copy-Item -LiteralPath (Join-Path $state 'before') -Destination (Join-Path $state 'restore-check') -Recurse
  Assert-LinkSame (Get-LinkTree (Join-Path $state 'restore-check')) $plan.files
  if((Get-FileHash (Join-Path $state 'agent.config.backup') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $configHash) {throw 'Config backup differs.'}
  Write-UpdateText (Join-Path $state 'plan.json') ($plan | ConvertTo-Json -Depth 8)
  Write-UpdateText (Join-Path $state 'restore-proof.json') (@{plan_sha256=$PlanSha256;source_sha=$SourceCommit;file_hashes_equal=$true;config_hash_equal=$true} | ConvertTo-Json)
 } else {
  Assert-UpdateAcl $state '' -Protected
  $saved=Get-Content (Join-Path $state 'restore-proof.json') -Raw | ConvertFrom-Json
  if($saved.plan_sha256 -cne $PlanSha256 -or $saved.source_sha -cne $SourceCommit -or $saved.file_hashes_equal -ne $true -or $saved.config_hash_equal -ne $true) {throw 'Actual restore proof required.'}
  Assert-LinkSame (Get-LinkTree (Join-Path $state 'before')) $plan.files
 }
 try {
  if($svc.State -ceq 'Running') {Stop-Service PickChickKitchenLink;(Get-Service PickChickKitchenLink).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}
  if((Get-Service PickChickKitchenLink).Status -ne 'Stopped') {throw 'Link must stop before file changes.'}
  if($Mode -eq 'Update') {foreach($p in $required) {$prior=$plan.files.PSObject.Properties[$p];Write-LinkBytes (Join-Path $root $p) $sources[$p] $(if($prior){$prior.Value}else{''})}}
  else {Restore-LinkFiles $root $state $plan.files $manifest.files $required}
  Assert-LinkSame (Get-LinkTree $root) $(if($Mode -eq 'Update'){$targetObject}else{$plan.files})
  Start-Service PickChickKitchenLink;(Get-Service PickChickKitchenLink).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
  Wait-LinkChild $node (Join-Path $root 'infra\kitchen-portal\agent.mjs') $config
 } catch {
  if($Mode -eq 'Update') {
   try {
    if((Get-Service PickChickKitchenLink).Status -ne 'Stopped') {Stop-Service PickChickKitchenLink;(Get-Service PickChickKitchenLink).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}
    Restore-LinkFiles $root $state $plan.files $manifest.files $required;Assert-LinkSame (Get-LinkTree $root) $plan.files
    Start-Service PickChickKitchenLink;(Get-Service PickChickKitchenLink).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
    Wait-LinkChild $node (Join-Path $root 'infra\kitchen-portal\agent.mjs') $config
   } catch {throw 'Rollback or original service readiness not verified; inspect retained state.'}
  }
  throw
 }
 # Known copy failures restore original files; unrecognized state stays stopped for inspection.
 Assert-LinkSame (Get-LinkTree $root) $(if($Mode -eq 'Update'){$targetObject}else{$plan.files})
 if((Get-FileHash $config -Algorithm SHA256).Hash.ToLowerInvariant() -cne $configHash -or (Get-FileHash $xml -Algorithm SHA256).Hash.ToLowerInvariant() -cne $xmlHash) {throw 'Private config or service XML changed.'}
 foreach($name in $neighbors.Keys) {$n=Get-CimInstance Win32_Service -Filter "Name='$name'";if($n.ProcessId -ne $neighbors[$name].pid -or $n.State -cne $neighbors[$name].state) {throw 'Unrelated service changed.'}}
 $result=if($Mode -eq 'Update') {@{phase=$Mode;source_sha=$SourceCommit;link=@{verified=$true;manifest_sha256=$ManifestSha256;files=$manifest.files;config_sha256=$configHash;xml_sha256=$xmlHash;running=$true};configUnchanged=$true;neighborsUnchanged=$true;completed_epoch=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}} else {@{phase='Rollback';restored_plan_sha256=$PlanSha256;original_files_verified=$true;running=$true;configUnchanged=$true;neighborsUnchanged=$true;completed_epoch=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}}
 Write-UpdateText (Join-Path $state ($Mode+'-'+[guid]::NewGuid().ToString('N')+'.json')) ($result | ConvertTo-Json -Depth 5)
 $result | ConvertTo-Json -Depth 5 -Compress
} finally {foreach($h in $handles) {$h.Dispose()};if($lease){$lease.Dispose()}}
