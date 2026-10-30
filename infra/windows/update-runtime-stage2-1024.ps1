#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Exact installed023 -> reviewed024 and four native runtimes. Default is inspection.
No environment, identity, prices, catalog or POS installation changes. Requires a
verified restore, exact-source complete CI and the shared native maintenance lease.
The migration is atomic. Binary rollback is possible only before any new process
starts; after startup, retain the compatible candidate and investigate forward.
#>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
 [Parameter(Mandatory=$true)][string]$RuntimeArchive,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$RuntimeSha256,
 [Parameter(Mandatory=$true)][string]$BackupManifest,
 [Parameter(Mandatory=$true)][string]$CiProof,
 [Parameter(Mandatory=$true)][guid]$BranchId,
 [Parameter(Mandatory=$true)][string]$BaselineReceipt,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$BaselineSha256,
 [Parameter(Mandatory=$true)][string]$BackupDestination,
 [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Import-RuntimeFunctions([string]$File,[string]$Hash,[string[]]$Names) {
 if((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash){throw 'Reviewed helper bytes differ.'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'Helper parse failure.'}
 foreach($name in $Names){$found=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$false));if($found.Count -ne 1){throw 'Missing reviewed function.'};$found[0].Extent.Text}
}
function New-RuntimeBinding([string]$Text,[string]$ExpectedHash,[string]$Name,[string]$OldApp,[string]$NewApp) {
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text);$h=[Security.Cryptography.SHA256]::Create()
 try{$hash=[BitConverter]::ToString($h.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
 if($hash -cne $ExpectedHash){throw 'Installed XML differs from inspected baseline.'}
 $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null
 $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($Text),$settings);$doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null
 try{$doc.Load($reader)}finally{$reader.Dispose()}
 foreach($key in @('id','executable','workingdirectory','arguments','serviceaccount')){if(@($doc.service.SelectNodes($key)).Count -ne 1){throw 'Ambiguous service binding.'}}
 if($doc.service.id -cne $Name -or $doc.service.executable -cne $script:node -or $doc.service.workingdirectory -cne $OldApp -or $doc.service.serviceaccount.user -cne 'LocalService' -or $doc.service.serviceaccount.domain -cne 'NT AUTHORITY'){throw 'Service identity differs.'}
 if(-not $doc.service.arguments.Contains($OldApp)){throw 'Runtime argument missing.'}
 # Only immutable application paths change; all flags, identity and config paths remain exact.
 $doc.SelectSingleNode('/service/workingdirectory').InnerText=$NewApp
 $doc.SelectSingleNode('/service/arguments').InnerText=$doc.service.arguments.Replace($OldApp,$NewApp)
 return $doc.OuterXml
}
function Read-RuntimeLedger {
 $code=@'
const{createRequire}=require('node:module');const{Client}=createRequire(process.argv[2]+'/package.json')('pg');(async()=>{const c=new Client({connectionString:process.env.EDGE_DATABASE_URL});await c.connect();try{await c.query('BEGIN READ ONLY');const ledger=(await c.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')).rows;const branch=(await c.query('SELECT id FROM branch_config')).rows;console.log(JSON.stringify({ledger,branch}));await c.query('ROLLBACK')}finally{await c.end()}})().catch(()=>{console.error('Read-only ledger check failed');process.exitCode=1})
'@
 $saved=$OutputEncoding;try{$OutputEncoding=[Text.UTF8Encoding]::new($false);$out=$code | & $script:node ('--env-file='+$script:ownerEnv) '-' $script:oldEdge}finally{$OutputEncoding=$saved}
 if($LASTEXITCODE -ne 0){throw 'Read-only ledger failed.'};return ($out|ConvertFrom-Json)
}
function Assert-RuntimeLedger($Actual,$Expected) {
 if(@($Actual).Count -ne @($Expected).Count){throw 'Ledger length differs.'}
 for($i=0;$i -lt @($Expected).Count;$i++){foreach($key in @('scope','version','checksum')){if($Actual[$i].$key -cne $Expected[$i].$key){throw 'Migration history differs.'}}}
}
function Assert-Stage2Predecessor([string]$Commit) {
 # The 020->023 bridge is built from PR270, never from a tree containing 024.
 # Refresh this pin only after a separately reviewed and tested schema023 bridge.
 if($Commit -cne '0fb95c9f09031d93e38e3af2a0c4a1bcc81f591c'){throw 'Unreviewed schema023 predecessor; replan the cashier window.'}
}
function Assert-RuntimePreserved {
 foreach($path in $script:preserved.Keys){if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $script:preserved[$path]){throw 'Configuration or identity changed.'}}
 foreach($name in $script:neighbors.Keys){$s=Get-CimInstance Win32_Service -Filter "Name='$name'";if($s.State -cne 'Running' -or $s.ProcessId -ne $script:neighbors[$name]){throw 'Unrelated service changed.'}}
}
function Invoke-RuntimeQuiesced([scriptblock]$Action,[scriptblock]$BeforeResume={}) {
 $order=@('PickChickFulfillmentWorker','PickChickMenuSyncWorker','PickChickDeviceAccessWorker','PickChickKitchenLink','PickChickEdge')
 $running=@();foreach($name in $order){$s=Get-Service $name;if($s.Status -ne 'Running'){throw 'Expected running native service.'};$running+=$name}
 foreach($name in $order){if(@((Get-Service $name).DependentServices|Where-Object {$_.Status -ne 'Stopped' -and $_.Name -notin $order}).Count){throw 'Unreviewed active service dependency.'}}
 try{foreach($name in $order){Stop-Service $name;(Get-Service $name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(35))};& $Action}
 finally{
  & $BeforeResume
  [array]::Reverse($running);$failed=@()
  foreach($name in $running){try{if((Get-Service $name).Status -ne 'Running'){Start-Service $name};(Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(35))}catch{$failed+=$name}}
  if($failed.Count){throw ('Native service recovery needs inspection: '+($failed -join ', '))}
 }
}
function Invoke-RuntimeSchema([string]$Mode) {
 $out=& $script:node ('--env-file='+$script:ownerEnv) (Join-Path $PSScriptRoot 'station-plan-upgrade-db.mjs') $Mode $script:toolsRoot $script:newApp $BranchId.ToString()
 if($LASTEXITCODE -ne 0){throw 'Atomic runtime migration stopped.'};return ($out|ConvertFrom-Json)
}

function Assert-Stage2ToolPins {
 foreach($pin in $script:stage2Pins.GetEnumerator()){
  if((Get-FileHash (Join-Path $PSScriptRoot $pin.Key) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.Value){throw 'Stage2 delivery tool drift.'}
 }
}
function Get-Stage2BackupArguments([string]$Data,[guid]$Branch,[string]$Destination) {
 $args=@{Mode='Install';BranchId=$Branch;Destination=$Destination;HourlyCopies=48;DailyCopies=14;MaxAgeMinutes=120;ReportInHeartbeat=$false}
 $path=Join-Path $Data 'EdgeBackup\private\edge-backup.json'
 if(Test-Path $path){
  Assert-UpdateAcl $path
  $config=Get-Content $path -Raw|ConvertFrom-Json
  if($config.destination -cne $Destination){throw 'Backup destination changed; separate owner action required.'}
  $args.HourlyCopies=$config.retention.hourly;$args.DailyCopies=$config.retention.daily
  $args.MaxAgeMinutes=$config.maxAgeMinutes;$args.ReportInHeartbeat=$config.reportInHeartbeat
 }
 return $args
}
function Assert-Stage2BackupHealth($Proof,[int]$Schema,[DateTime]$Since) {
 if($Proof.lastTaskResult -ne 0 -or $null -eq $Proof.health -or $Proof.health.state -cne 'ok' -or $Proof.health.stale -or $Proof.health.schema -cne ('schema{0:D3}' -f $Schema) -or $null -eq $Proof.health.lastSuccessAt -or [DateTime]$Proof.health.lastSuccessAt -lt $Since){throw 'Fresh encrypted backup with exact schema not confirmed.'}
}
function Suspend-Stage2Backup {
 $script:backupPaused=$true
 $null=Disable-ScheduledTask -TaskPath '\PickChick\' -TaskName 'PickChickEdgeBackup'
 $deadline=[DateTime]::UtcNow.AddMinutes(20)
 while((Get-ScheduledTask -TaskPath '\PickChick\' -TaskName 'PickChickEdgeBackup').State -eq 'Running'){
  if([DateTime]::UtcNow -ge $deadline){throw 'Backup still running; maintenance not started.'}
  Start-Sleep -Seconds 3
 }
}
function Resume-Stage2Backup {
 $null=Enable-ScheduledTask -TaskPath '\PickChick\' -TaskName 'PickChickEdgeBackup'
 $script:backupPaused=$false
}
function Wait-Stage2Backup([DateTime]$Since) {
 $deadline=[DateTime]::UtcNow.AddMinutes(20)
 do {
  Start-Sleep -Seconds 3
  $proof=(& (Join-Path $PSScriptRoot 'install-edge-backup.ps1') -Mode Inspect)|ConvertFrom-Json
  if($proof.taskState -ne 'Running' -and $null -ne $proof.health -and $null -ne $proof.health.lastSuccessAt -and [DateTime]$proof.health.lastSuccessAt -ge $Since){return $proof}
 } while([DateTime]::UtcNow -lt $deadline)
 throw 'New schema024 backup did not complete; inspect private receipt.'
}

$script:stage2Pins=@{
 'menu-sync-worker-grants.mjs'='d3073cabfb5fad023bc2af179214f91791d568f38daf38d40518634ca8040fc7'
 'native-edge-backup-ledger.json'='5405e162febd4207c4b2a4907d78bf61dfc82ce57edf0d14c6fdcf4a3064bb1c'
 'install-edge-backup.ps1'='44e16a305368056211b19c1d7a3c1aface4f42f2857598d7b850a4f586b1184f'
 'station-plan-upgrade-db.mjs'='817cf7d71c7fdca7d311a5d31fb139826ee67ce2d9eff12686754235bf5e607c'
 'cloud-link-grant.mjs'='5b3038025cbf15d5e052aa72c56b77d6f6c08f15f6026609df1a066df0dcc108'
}

if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop'){throw 'Elevated x64 Windows PowerShell 5.1 required.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($d in (Import-RuntimeFunctions (Join-Path $PSScriptRoot 'install-native-foundation.ps1') '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5' @('Assert-LocalNtfsPath','Open-VerifiedFile','Assert-ArchiveName','Get-ArchivePlan','New-ProtectedDirectory','Assert-ProtectedDirectory'))){. ([scriptblock]::Create($d))}
foreach($d in (Import-RuntimeFunctions (Join-Path $PSScriptRoot 'update-native-service.ps1') '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Assert-UpdateAcl','Write-UpdateText','Read-UpdateHttp'))){. ([scriptblock]::Create($d))}
foreach($d in (Import-RuntimeFunctions (Join-Path $PSScriptRoot 'update-native-unified-menu.ps1') 'b764a8733224f951ad1543d9d1b18bf7ac269b1e034a1fbadbefbba488f903ef' @('Assert-UnifiedCi','Assert-UnifiedBackup','Enter-UnifiedMaintenanceLock','Replace-UnifiedXml','Restore-UnifiedBindings','Get-UnifiedEntryHash','Wait-UnifiedReady'))){. ([scriptblock]::Create($d))}
$program='C:\Program Files\PickChick';$data='C:\ProgramData\PickChick'
$script:node=Join-Path $program 'Edge\edge-0186902\node\node.exe'
$script:toolsRoot=Join-Path $data 'EdgeTools\edge-0186902';$script:ownerEnv=Join-Path $toolsRoot 'private\edge-owner.env'
Assert-UpdateAcl $BaselineReceipt
if((Get-FileHash $BaselineReceipt -Algorithm SHA256).Hash.ToLowerInvariant() -cne $BaselineSha256){throw 'Baseline receipt changed.'}
$baselineProof=Get-Content $BaselineReceipt -Raw|ConvertFrom-Json
if($baselineProof.format -cne 'pickchick-stage2-baseline-v1' -or $baselineProof.schema -ne 23 -or $baselineProof.branchId -cne $BranchId.ToString() -or $baselineProof.computerName -ine $env:COMPUTERNAME -or $baselineProof.sourceCommit -cnotmatch '^[a-f0-9]{40}$'){throw 'Reviewed schema023 baseline receipt required.'}
if(@($baselineProof.xmlHashes).Count -ne 4 -or @($baselineProof.xmlHashes|Where-Object {$_ -cnotmatch '^[a-f0-9]{64}$'}).Count){throw 'Four reviewed XML hashes required.'}
$oldSha=$baselineProof.sourceCommit
Assert-Stage2Predecessor $oldSha
$script:oldEdge=Join-Path $program ('Edge\edge-'+$oldSha.Substring(0,7)+'\app');$oldWorker=$oldEdge
$newRoot=Join-Path $program ('Edge\edge-'+$SourceCommit.Substring(0,7));$script:newApp=Join-Path $newRoot 'app'
$stateRoot=Join-Path $data ('EdgeTools\runtime-stage2-1024-'+$SourceCommit.Substring(0,7))
if((Test-Path $newRoot) -or (Test-Path $stateRoot)){throw 'Existing attempt retained; inspect outcome, no replay.'}
foreach($p in @($CiProof,$BackupManifest,$script:ownerEnv)){Assert-UpdateAcl $p}
$ci=Get-Content $CiProof -Raw|ConvertFrom-Json;Assert-UnifiedCi $ci $SourceCommit
$foundation=Get-Content (Join-Path $toolsRoot 'private\foundation-state.json') -Raw|ConvertFrom-Json
if(!$foundation.complete -or $foundation.branchId -cne $BranchId.ToString() -or $foundation.computerName -ine $env:COMPUTERNAME){throw 'Foreign foundation.'}
$specs=@(
 @('PickChickEdge','Edge\edge-0186902\PickChickEdge.xml',$oldEdge,$baselineProof.xmlHashes[0]),
 @('PickChickFulfillmentWorker','FulfillmentWorker\PickChickFulfillmentWorker.xml',$oldWorker,$baselineProof.xmlHashes[1]),
 @('PickChickMenuSyncWorker','MenuSyncWorker\PickChickMenuSyncWorker.xml',$oldWorker,$baselineProof.xmlHashes[2]),
 @('PickChickDeviceAccessWorker','DeviceAccess\PickChickDeviceAccessWorker.xml',$oldEdge,$baselineProof.xmlHashes[3])
)
$bindings=@();$script:preserved=@{};$script:neighbors=@{}
foreach($spec in $specs){$path=Join-Path $program $spec[1];Assert-UpdateAcl $path 'ReadAndExecute';$text=[IO.File]::ReadAllText($path);$next=New-RuntimeBinding $text $spec[3] $spec[0] $spec[2] $newApp;$bindings+=,@($path,$text,$next)
 $s=Get-CimInstance Win32_Service -Filter "Name='$($spec[0])'";if($s.State -cne 'Running' -or $s.StartName -ine 'NT AUTHORITY\LocalService' -or $s.PathName.Trim('"') -cne [IO.Path]::ChangeExtension($path,'.exe')){throw 'Service binding changed.'}
 foreach($m in [regex]::Matches(([xml]$text).service.arguments,'[A-Za-z]:\\[^"<>\r\n]+\.(?:env|json)')){$p=$m.Value;if(-not(Test-Path $p)){throw 'Bound configuration absent.'};$preserved[$p]=(Get-FileHash $p -Algorithm SHA256).Hash}
}
$preserved[$ownerEnv]=(Get-FileHash $ownerEnv -Algorithm SHA256).Hash
foreach($s in Get-CimInstance Win32_Service -Filter "Name LIKE 'PickChick%'"|Where-Object {$_.State -ceq 'Running' -and $_.Name -notin @('PickChickEdge','PickChickFulfillmentWorker','PickChickMenuSyncWorker','PickChickDeviceAccessWorker','PickChickKitchenLink')}){$neighbors[$s.Name]=$s.ProcessId}
foreach($name in @('PickChickPostgres','PickChickFulfillmentTunnel')){if(-not $neighbors.ContainsKey($name)){throw 'Required stable infrastructure missing.'}}
$installed=@{};foreach($app in @($oldEdge)){$pair=@($app,$oldSha);$m=Get-Content (Join-Path $pair[0] 'runtime-manifest.json') -Raw|ConvertFrom-Json;if($m.sourceCommit -cne $pair[1]){throw 'Installed runtime source differs.'};foreach($f in $m.files){$null=Assert-ArchiveName $f.path;if((Get-FileHash (Join-Path $pair[0] $f.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'Installed runtime drift.'};if($pair[0] -ceq $oldEdge){$installed[$f.path]=$f.sha256}}}
Add-Type -AssemblyName System.IO.Compression
$script:backupPaused=$false;$lease=$null;$archive=Open-VerifiedFile $RuntimeArchive $RuntimeSha256;$zip=[IO.Compression.ZipArchive]::new($archive,[IO.Compression.ZipArchiveMode]::Read,$true)
try{
 $plan=Get-ArchivePlan $zip 'runtime' $newApp;$entry=$zip.GetEntry('runtime-manifest.json');if(!$entry -or $entry.Length -gt 8MB){throw 'Missing manifest.'}
 $reader=[IO.StreamReader]::new($entry.Open());try{$manifest=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
 if($manifest.sourceCommit -cne $SourceCommit -or $manifest.format -cne 'pickchick-edge-runtime-v1' -or $manifest.target -cne 'windows-x64' -or $manifest.symlinks -ne 0 -or $manifest.nativeAddons -ne 0){throw 'Candidate provenance differs.'}
 $files=@{};foreach($f in $manifest.files){if($files.ContainsKey($f.path)){throw 'Duplicate file.'};$files[$f.path]=$f};if($files.Count+1 -ne $plan.Count){throw 'Manifest file set differs.'}
 foreach($item in $plan){if($item.Relative -ceq 'runtime-manifest.json'){continue};if(!$files.ContainsKey($item.Relative) -or $files[$item.Relative].bytes -ne $item.Entry.Length -or (Get-UnifiedEntryHash $item.Entry) -cne $files[$item.Relative].sha256){throw 'Archive bytes differ.'}}
 $names=@($files.Keys|Where-Object {$_ -like 'db/edge/migrations/*.sql'}|Sort-Object);if($names.Count -ne 24){throw 'Exact schema024 required.'};$ledger=@()
 for($i=0;$i -lt 24;$i++){$p=$names[$i];$v=$p.Substring('db/edge/migrations/'.Length);if(-not $v.StartsWith(('{0:D3}_' -f ($i+1)))){throw 'Non-contiguous migrations.'};if($i -lt 23 -and (!$installed.ContainsKey($p) -or $installed[$p] -cne $files[$p].sha256)){throw 'Historical migration changed.'};$ledger+=@{scope='edge';version=$v;checksum=$files[$p].sha256}}
 $baseline=@($ledger[0..22]);$db=Read-RuntimeLedger;Assert-RuntimeLedger $db.ledger $baseline;if(@($db.branch).Count -ne 1 -or $db.branch[0].id -cne $BranchId.ToString()){throw 'Branch changed.'}
 $backup=Get-Content $BackupManifest -Raw|ConvertFrom-Json;Assert-UnifiedBackup $backup $BranchId.ToString() $foundation.systemIdentifier 23 $baseline
 $dump=Join-Path (Split-Path $BackupManifest) 'pickchick_edge.dump';if((Get-Item $dump).Length -ne $backup.archiveBytes){throw 'Backup size differs.'};$stream=Open-VerifiedFile $dump $backup.sha256;$stream.Dispose()
 Assert-RuntimePreserved
 Assert-Stage2ToolPins
 $backupArgs=Get-Stage2BackupArguments $data $BranchId $BackupDestination
 $null=& (Join-Path $PSScriptRoot 'install-edge-backup.ps1') @backupArgs -DryRun
 if(!$Apply){Write-Output 'VERIFIED: runtime, CI, restored backup, backup installer and schema023; no persistent change.';return}
 # Upgrade the backup tool while schema023 still works. This run must finish before pausing it.
 $backupStarted=[DateTime]::UtcNow
 $installedBackup=(& (Join-Path $PSScriptRoot 'install-edge-backup.ps1') @backupArgs)|ConvertFrom-Json
 Assert-Stage2BackupHealth $installedBackup 23 $backupStarted
 $script:backupPaused=$false
 Suspend-Stage2Backup

 $lease=Enter-UnifiedMaintenanceLock (Join-Path $data 'EdgeTools\unified-menu-maintenance.lock');Assert-RuntimePreserved
 foreach($b in $bindings){if([IO.File]::ReadAllText($b[0]) -cne $b[1]){throw 'Concurrent service change.'}}
 New-ProtectedDirectory $stateRoot;Write-UpdateText (Join-Path $stateRoot 'inputs.json') (@{sourceCommit=$SourceCommit;archiveSha256=$RuntimeSha256;ciRun=$ci.run.id;backupSha256=$backup.sha256}|ConvertTo-Json)
 New-ProtectedDirectory $newRoot 'ReadAndExecute';New-ProtectedDirectory $newApp 'ReadAndExecute'
 foreach($item in $plan){$null=Assert-LocalNtfsPath $item.Target;$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target));$input=$item.Entry.Open();try{$output=[IO.File]::Open($item.Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$input.CopyTo($output);$output.Flush($true)}finally{$output.Dispose()}}finally{$input.Dispose()};Assert-UpdateAcl $item.Target 'ReadAndExecute';if($item.Relative -cne 'runtime-manifest.json' -and (Get-FileHash $item.Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $files[$item.Relative].sha256){throw 'Extracted bytes differ.'}}
 for($i=0;$i -lt $bindings.Count;$i++){Write-UpdateText (Join-Path $stateRoot ('original-'+$i+'.xml')) $bindings[$i][1]}
 Invoke-RuntimeQuiesced {
  Assert-RuntimePreserved;Assert-RuntimeLedger (Read-RuntimeLedger).ledger $baseline
  $before=Invoke-RuntimeSchema 'inspect';$after=Invoke-RuntimeSchema 'apply'
  Write-UpdateText (Join-Path $stateRoot 'migration.json') ($after|ConvertTo-Json -Depth 8)
  if($after.migrations -ne 24 -or $after.fingerprint -cne $before.fingerprint -or !$after.dataPreserved){throw 'Migration proof failed.'}
  foreach($mode in @('inspect','apply')){
   $out=& $script:node ('--env-file='+$script:ownerEnv) (Join-Path $PSScriptRoot 'cloud-link-grant.mjs') $mode $script:toolsRoot $BranchId.ToString()
   if($LASTEXITCODE -ne 0){throw 'Guarded cloud-link grant stopped.'}
   $grant=$out|ConvertFrom-Json
   if($mode -ceq 'apply' -and !$grant.cloudLink){throw 'Cloud-link grant not confirmed.'}
  }
  Write-UpdateText (Join-Path $stateRoot 'cloud-link.json') ($grant|ConvertTo-Json -Depth 8)
  try{foreach($b in $bindings){Replace-UnifiedXml $b[0] $b[1] $b[2]}}catch{Restore-UnifiedBindings $bindings;throw}
 } -BeforeResume {foreach($b in $bindings){$actual=[IO.File]::ReadAllText($b[0]);if($actual -cne $b[1] -and $actual -cne $b[2]){throw 'Foreign binding retained; services left stopped for inspection.'}}}
 # New processes may now write valid new-format data. Never restart old readers automatically.
 Wait-UnifiedReady $newApp;Start-Sleep -Seconds 10
 foreach($spec in $specs){$s=Get-CimInstance Win32_Service -Filter "Name='$($spec[0])'";$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($s.ProcessId)"|Where-Object {$_.Name -ieq 'node.exe' -and $_.CommandLine.Contains($newApp)});if($s.State -cne 'Running' -or $children.Count -ne 1){throw 'Candidate service process verification failed.'}}
 Assert-RuntimePreserved;Assert-RuntimeLedger (Read-RuntimeLedger).ledger $ledger
 # The backup task shares this lease; release it only after runtime and schema checks pass.
 $lease.Dispose();$lease=$null
 Resume-Stage2Backup
 $started=[DateTime]::UtcNow
 Start-ScheduledTask -TaskPath '\PickChick\' -TaskName 'PickChickEdgeBackup'
 $proof=Wait-Stage2Backup $started
 Assert-Stage2BackupHealth $proof 24 $started
 Write-UpdateText (Join-Path $stateRoot 'backup024.json') ($proof|ConvertTo-Json -Depth 8)
 Write-UpdateText (Join-Path $stateRoot 'completed.json') (@{sourceCommit=$SourceCommit;schema=24;completedAt=[DateTime]::UtcNow.ToString('o');environmentChanged=$false;databasePreserved=$true}|ConvertTo-Json)
 Write-Output 'READY: schema024 and four native runtimes verified; credentials and optional flags unchanged.'
}finally{$zip.Dispose();$archive.Dispose();if($lease){$lease.Dispose()};if($script:backupPaused){Resume-Stage2Backup}}
