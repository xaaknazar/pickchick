#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Switch the four native runtimes from the installed step-025 runtime to the reviewed head
runtime, after the database already holds exactly schema028 (cutover step 3, action 9a).
Default is inspection. No SQL is executed: the migrations 026-028 are applied earlier by their
own guarded tools. No environment, identity, prices, catalog, flags or POS installation changes.
Runs only with every native writer stopped (cutover step 3, action 3) and the shared native
maintenance lease. Binary rollback is possible only before any new process starts; after
startup, retain the candidate and investigate forward.
#>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
 [Parameter(Mandatory=$true)][string]$RuntimeArchive,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$RuntimeSha256,
 [Parameter(Mandatory=$true)][string]$CiProof,
 [Parameter(Mandatory=$true)][guid]$BranchId,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$PredecessorCommit,
 [switch]$AllowSameDiskBackup,
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
function Get-TextSha256([string]$Text) {
 $h=[Security.Cryptography.SHA256]::Create()
 try{return [BitConverter]::ToString($h.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
}
function New-RuntimeBinding([string]$Text,[string]$ExpectedHash,[string]$Name,[string]$OldApp,[string]$NewApp) {
 if((Get-TextSha256 $Text) -cne $ExpectedHash){throw 'Installed XML differs from inspected baseline.'}
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
function Get-HeadBinding([string]$Current,[string]$Original,[string]$Name,[string]$PredecessorApp,[string]$NewApp) {
 # The installed XML must be exactly what operator 025 wrote from its saved original: the
 # original with only its application path replaced by the step-025 runtime. Anything else is
 # a foreign change and is never rebound.
 $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null
 $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($Original),$settings);$doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null
 try{$doc.Load($reader)}finally{$reader.Dispose()}
 if(@($doc.service.SelectNodes('workingdirectory')).Count -ne 1){throw 'Ambiguous service binding.'}
 $originalApp=[string]$doc.service.workingdirectory
 if($originalApp -ceq $PredecessorApp -or $originalApp -ceq $NewApp){throw 'Step 025 original binding required.'}
 $expected=New-RuntimeBinding $Original (Get-TextSha256 $Original) $Name $originalApp $PredecessorApp
 if($Current -cne $expected){throw 'Installed XML differs from the step 025 result.'}
 return New-RuntimeBinding $Current (Get-TextSha256 $Current) $Name $PredecessorApp $NewApp
}
function Read-RuntimeLedger {
 $code=@'
const{createRequire}=require('node:module');const{Client}=createRequire(process.argv[2]+'/package.json')('pg');(async()=>{const u=new URL(process.env.EDGE_DATABASE_URL??'');if(!['postgres:','postgresql:'].includes(u.protocol)||u.hostname!=='127.0.0.1'||u.port!=='55433'||u.pathname!=='/pickchick_edge'||u.username!=='pickchick_edge_owner'||u.search||u.hash)throw Error('Local owner required');const c=new Client({connectionString:u.href,connectionTimeoutMillis:3000,statement_timeout:30000});c.on('error',()=>{});await c.connect();try{await c.query('BEGIN READ ONLY');const ledger=(await c.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')).rows;const branch=(await c.query('SELECT id FROM branch_config')).rows;const systemIdentifier=(await c.query('SELECT system_identifier::text id FROM pg_control_system()')).rows[0].id;console.log(JSON.stringify({ledger,branch,systemIdentifier}));await c.query('ROLLBACK')}finally{await c.end()}})().catch(()=>{console.error('Read-only ledger check failed');process.exitCode=1})
'@
 $saved=$OutputEncoding;try{$OutputEncoding=[Text.UTF8Encoding]::new($false);$out=$code | & $script:node ('--env-file='+$script:ownerEnv) '-' $script:oldEdge}finally{$OutputEncoding=$saved}
 if($LASTEXITCODE -ne 0){throw 'Read-only ledger failed.'};return ($out|ConvertFrom-Json)
}
function Assert-RuntimeLedger($Actual,$Expected) {
 if(@($Actual).Count -ne @($Expected).Count){throw 'Ledger length differs.'}
 for($i=0;$i -lt @($Expected).Count;$i++){foreach($key in @('scope','version','checksum')){if($Actual[$i].$key -cne $Expected[$i].$key){throw 'Migration history differs.'}}}
}
function Assert-HeadMigrationSet($Ledger) {
 # The reviewed ledger file is pinned by SHA-256 (Assert-HeadToolPins). This step takes all of
 # it: exactly 28 rows ending with 028. The read is not wrapped in @(): Windows PowerShell 5.1
 # emits a JSON array as one object, and @() around the pipeline would hold it as one element.
 $reviewed=Get-Content (Join-Path $PSScriptRoot 'native-edge-backup-ledger.json') -Raw|ConvertFrom-Json
 if(@($reviewed).Count -ne 28){throw 'Reviewed schema028 ledger required.'}
 $expected=@($reviewed[0..27])
 if($expected[24].version -cne '025_edge_kitchen_restore_review.sql' -or $expected[24].checksum -cne 'ab73b1abff4850098c513d7b39bda5e86ff21ac6ea5c06a1420410dcb31ad18a' -or $expected[27].version -cne '028_edge_pos_desk_number.sql' -or $expected[27].checksum -cne '684ffa9c5265d32fd3c33e6190ca3126c83c5cb47974aa274cf198fc905d0abf'){throw 'Reviewed schema028 ledger required.'}
 Assert-RuntimeLedger $Ledger $expected
}
function Assert-HeadPredecessor($Completed,[string]$Predecessor) {
 # Operator 025 writes this record only after its runtime, schema and backup checks passed.
 if($null -eq $Completed -or $Completed.sourceCommit -cne $Predecessor -or $Completed.schema -ne 25 -or $Completed.databasePreserved -isnot [bool] -or $Completed.databasePreserved -ne $true -or $Completed.environmentChanged -isnot [bool] -or $Completed.environmentChanged -ne $false){throw 'Completed step 025 of the exact predecessor required.'}
}
function Assert-HeadBackupDisk([string]$Destination,[bool]$SameDiskAllowed=$false) {
 $null=Assert-LocalNtfsPath $Destination
 if($Destination -cnotmatch '^[A-Za-z]:\\'){throw 'A separate local backup disk is required.'}
 $system=@(Get-Partition -DriveLetter 'C');$backup=@(Get-Partition -DriveLetter $Destination.Substring(0,1))
 if($system.Count -ne 1 -or $backup.Count -ne 1){throw 'Backup must be on a different physical disk.'}
 # Owner decision 14.11.2026 (-AllowSameDiskBackup): another partition of the system disk, never C itself.
 if($system[0].DiskNumber -eq $backup[0].DiskNumber -and (-not $SameDiskAllowed -or $Destination.Substring(0,1) -ieq 'C')){throw 'Backup must be on a different physical disk.'}
 $disk=Get-Disk -Number $backup[0].DiskNumber
 if($disk.IsOffline -or $disk.IsReadOnly){throw 'Backup disk is not writable and online.'}
}
function Assert-HeadBackupHealth($Proof,[DateTime]$Since) {
 # Action 9 of step 3 installs the backup tool again and takes a verified schema028 copy.
 if($Proof.lastTaskResult -ne 0 -or $null -eq $Proof.health -or $Proof.health.state -cne 'ok' -or $Proof.health.stale -or $Proof.health.schema -cne 'schema028' -or $null -eq $Proof.health.lastSuccessAt -or [DateTime]$Proof.health.lastSuccessAt -lt $Since){throw 'Fresh encrypted schema028 backup not confirmed.'}
}
function Assert-HeadWritersStopped {
 # Cutover step 3 stops every writer before 026 and keeps them stopped through 028.
 foreach($name in $script:writers){
  $s=Get-Service $name
  if($s.Status -ne 'Stopped'){throw 'Native writers must stay stopped until the runtime switch.'}
  if(@($s.DependentServices|Where-Object {$_.Status -ne 'Stopped'}).Count){throw 'Unreviewed active service dependency.'}
 }
 if(Get-Service 'PickChickPosSync' -ErrorAction SilentlyContinue){throw 'POS-sync already installed; a separate reviewed transition is required.'}
}
function Register-RuntimeTunnel {
 # The cloud tunnel may restart on its own during a step (Assert-RuntimeNeighbor), but its wrapper,
 # account and configuration may not change: the configuration joins the preserved files.
 $s=Get-CimInstance Win32_Service -Filter "Name='PickChickFulfillmentTunnel'"
 $xml=[IO.Path]::ChangeExtension($s.PathName.Trim('"'),'.xml')
 if(-not(Test-Path -LiteralPath $xml -PathType Leaf)){throw 'Tunnel configuration absent.'}
 $script:tunnelImage=$s.PathName;$script:tunnelAccount=$s.StartName
 $script:preserved[$xml]=(Get-FileHash -LiteralPath $xml -Algorithm SHA256).Hash
}
function Assert-RuntimeNeighbor([string]$Name,[int]$Expected) {
 # Cashier window 14.11.2026: the cloud SSH tunnel is restarted by its service wrapper after
 # every network reset (6-19 times a day on that cashier), which stopped step 024 mid-way. Such a
 # restart is not a concurrent change of the edge: the same wrapper under the same account must be
 # running again within three minutes and its new process is then the expected one. Every other
 # neighbour, PostgreSQL first of all, must keep its process.
 $s=Get-CimInstance Win32_Service -Filter "Name='$Name'"
 if($s -and $s.State -ceq 'Running' -and $s.ProcessId -eq $Expected){return $Expected}
 if($Name -cne 'PickChickFulfillmentTunnel'){throw 'Unrelated service changed.'}
 for($i=0;$i -lt 60;$i++){
  if($s -and ($s.PathName -cne $script:tunnelImage -or $s.StartName -cne $script:tunnelAccount)){throw 'Unrelated service changed.'}
  if($s -and $s.State -ceq 'Running' -and $s.ProcessId -gt 0){return [int]$s.ProcessId}
  Start-Sleep -Seconds 3
  $s=Get-CimInstance Win32_Service -Filter "Name='$Name'"
 }
 throw 'Cloud tunnel did not return within three minutes.'
}
function Assert-RuntimePreserved {
 foreach($path in $script:preserved.Keys){if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $script:preserved[$path]){throw 'Configuration or identity changed.'}}
 foreach($name in @($script:neighbors.Keys)){$script:neighbors[$name]=Assert-RuntimeNeighbor $name $script:neighbors[$name]}
}
function Assert-HeadBindings($Bindings) {
 $old=$true;$new=$true
 foreach($binding in $Bindings){
  $actual=[IO.File]::ReadAllText($binding[0])
  $old=$old -and ($actual -ceq $binding[1]);$new=$new -and ($actual -ceq $binding[2])
 }
 if(@($Bindings).Count -ne 4 -or (-not $old -and -not $new)){throw 'Mixed or foreign bindings retained; services left stopped for inspection.'}
 if($old){return 'old'}else{return 'candidate'}
}
function Invoke-HeadRuntimeSwitch($Bindings,$Ledger) {
 # Nothing starts unless all four XML hold the candidate and the database still holds the
 # reviewed schema028. A failed switch restores every original binding and leaves the writers
 # stopped, exactly as action 9 left them.
 Assert-HeadWritersStopped;Assert-RuntimePreserved;Assert-RuntimeLedger (Read-RuntimeLedger).ledger $Ledger
 try{foreach($b in $Bindings){Replace-UnifiedXml $b[0] $b[1] $b[2]}}catch{Restore-UnifiedBindings $Bindings;throw}
 if((Assert-HeadBindings $Bindings) -cne 'candidate'){throw 'Candidate bindings not in place; services left stopped.'}
 Assert-RuntimePreserved;Assert-RuntimeLedger (Read-RuntimeLedger).ledger $Ledger
 # From the first start on, the candidate may write; old binaries are never restored automatically.
 $failed=@()
 foreach($name in $script:startOrder){try{if((Get-Service $name).Status -ne 'Running'){Start-Service $name};(Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(35))}catch{$failed+=$name}}
 if($failed.Count){throw ('Candidate service start needs inspection: '+($failed -join ', '))}
}
function Assert-HeadToolPins {
 foreach($pin in $script:headPins.GetEnumerator()){
  if((Get-FileHash (Join-Path $PSScriptRoot $pin.Key) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.Value){throw 'Head runtime delivery tool drift.'}
 }
}

$script:headPins=@{
 'native-edge-backup-ledger.json'='66b798a6fe264dcaf266959fc42a0876998a8b0412a147fd9264273ddbdfc27f'
 'install-edge-backup.ps1'='60a937cfb9e702ba9f1039633561d5ae9a9f09bf6e67fb101d482fec105a91d0'
}
$script:writers=@('PickChickFulfillmentWorker','PickChickMenuSyncWorker','PickChickDeviceAccessWorker','PickChickKitchenLink','PickChickEdge')
$script:startOrder=@('PickChickEdge','PickChickKitchenLink','PickChickDeviceAccessWorker','PickChickMenuSyncWorker','PickChickFulfillmentWorker')

if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop'){throw 'Elevated x64 Windows PowerShell 5.1 required.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($d in (Import-RuntimeFunctions (Join-Path $PSScriptRoot 'install-native-foundation.ps1') '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5' @('Assert-LocalNtfsPath','Open-VerifiedFile','Assert-ArchiveName','Get-ArchivePlan','New-ProtectedDirectory','Assert-ProtectedDirectory'))){. ([scriptblock]::Create($d))}
foreach($d in (Import-RuntimeFunctions (Join-Path $PSScriptRoot 'update-native-service.ps1') '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Assert-UpdateAcl','Write-UpdateText','Read-UpdateHttp'))){. ([scriptblock]::Create($d))}
foreach($d in (Import-RuntimeFunctions (Join-Path $PSScriptRoot 'update-native-unified-menu.ps1') 'b764a8733224f951ad1543d9d1b18bf7ac269b1e034a1fbadbefbba488f903ef' @('Assert-UnifiedCi','Enter-UnifiedMaintenanceLock','Replace-UnifiedXml','Restore-UnifiedBindings','Get-UnifiedEntryHash','Wait-UnifiedReady'))){. ([scriptblock]::Create($d))}
$program='C:\Program Files\PickChick';$data='C:\ProgramData\PickChick'
$script:node=Join-Path $program 'Edge\edge-0186902\node\node.exe'
$script:toolsRoot=Join-Path $data 'EdgeTools\edge-0186902';$script:ownerEnv=Join-Path $toolsRoot 'private\edge-owner.env'
if($PredecessorCommit -ceq $SourceCommit){throw 'Exact distinct reviewed predecessor required.'}
$script:oldEdge=Join-Path $program ('Edge\edge-'+$PredecessorCommit.Substring(0,7)+'\app')
$step025=Join-Path $data ('EdgeTools\runtime-queue-recovery-025-'+$PredecessorCommit.Substring(0,7))
$newRoot=Join-Path $program ('Edge\edge-'+$SourceCommit.Substring(0,7));$script:newApp=Join-Path $newRoot 'app'
$stateRoot=Join-Path $data ('EdgeTools\runtime-head-028-'+$SourceCommit.Substring(0,7))
if((Test-Path $newRoot) -or (Test-Path $stateRoot)){throw 'Existing attempt retained; inspect outcome, no replay.'}
Assert-ProtectedDirectory $step025
foreach($p in @($CiProof,$script:ownerEnv,(Join-Path $step025 'completed.json'))){Assert-UpdateAcl $p}
Assert-HeadPredecessor (Get-Content (Join-Path $step025 'completed.json') -Raw|ConvertFrom-Json) $PredecessorCommit
$ci=Get-Content $CiProof -Raw|ConvertFrom-Json;Assert-UnifiedCi $ci $SourceCommit
$foundation=Get-Content (Join-Path $toolsRoot 'private\foundation-state.json') -Raw|ConvertFrom-Json
if(!$foundation.complete -or $foundation.branchId -cne $BranchId.ToString() -or $foundation.computerName -ine $env:COMPUTERNAME){throw 'Foreign foundation.'}
Assert-HeadWritersStopped
# Same four services and order as operator 025, whose original-<i>.xml files are read here.
$specs=@(
 @('PickChickEdge','Edge\edge-0186902\PickChickEdge.xml'),
 @('PickChickFulfillmentWorker','FulfillmentWorker\PickChickFulfillmentWorker.xml'),
 @('PickChickMenuSyncWorker','MenuSyncWorker\PickChickMenuSyncWorker.xml'),
 @('PickChickDeviceAccessWorker','DeviceAccess\PickChickDeviceAccessWorker.xml')
)
$bindings=@();$script:preserved=@{};$script:neighbors=@{}
for($i=0;$i -lt $specs.Count;$i++){$spec=$specs[$i];$path=Join-Path $program $spec[1];Assert-UpdateAcl $path 'ReadAndExecute'
 $original=Join-Path $step025 ('original-'+$i+'.xml');Assert-UpdateAcl $original
 $text=[IO.File]::ReadAllText($path);$next=Get-HeadBinding $text ([IO.File]::ReadAllText($original)) $spec[0] $script:oldEdge $script:newApp;$bindings+=,@($path,$text,$next)
 $s=Get-CimInstance Win32_Service -Filter "Name='$($spec[0])'";if($s.State -cne 'Stopped' -or $s.StartName -ine 'NT AUTHORITY\LocalService' -or $s.PathName.Trim('"') -cne [IO.Path]::ChangeExtension($path,'.exe')){throw 'Service binding changed.'}
 foreach($m in [regex]::Matches(([xml]$text).service.arguments,'[A-Za-z]:\\[^"<>\r\n]+\.(?:env|json)')){$p=$m.Value;if(-not(Test-Path $p)){throw 'Bound configuration absent.'};$preserved[$p]=(Get-FileHash $p -Algorithm SHA256).Hash}
}
$preserved[$ownerEnv]=(Get-FileHash $ownerEnv -Algorithm SHA256).Hash
foreach($s in Get-CimInstance Win32_Service -Filter "Name LIKE 'PickChick%'"|Where-Object {$_.State -ceq 'Running'}){$neighbors[$s.Name]=$s.ProcessId}
foreach($name in @('PickChickPostgres','PickChickFulfillmentTunnel')){if(-not $neighbors.ContainsKey($name)){throw 'Required stable infrastructure missing.'}}
Register-RuntimeTunnel
$installed=@{};$m=Get-Content (Join-Path $script:oldEdge 'runtime-manifest.json') -Raw|ConvertFrom-Json;if($m.sourceCommit -cne $PredecessorCommit){throw 'Installed runtime source differs.'}
foreach($f in $m.files){$null=Assert-ArchiveName $f.path;if((Get-FileHash (Join-Path $script:oldEdge $f.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'Installed runtime drift.'};$installed[$f.path]=$f.sha256}
Add-Type -AssemblyName System.IO.Compression
$lease=$null;$archive=Open-VerifiedFile $RuntimeArchive $RuntimeSha256;$zip=[IO.Compression.ZipArchive]::new($archive,[IO.Compression.ZipArchiveMode]::Read,$true)
try{
 $plan=Get-ArchivePlan $zip 'runtime' $script:newApp;$entry=$zip.GetEntry('runtime-manifest.json');if(!$entry -or $entry.Length -gt 8MB){throw 'Missing manifest.'}
 $reader=[IO.StreamReader]::new($entry.Open());try{$manifest=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
 if($manifest.sourceCommit -cne $SourceCommit -or $manifest.format -cne 'pickchick-edge-runtime-v1' -or $manifest.target -cne 'windows-x64' -or $manifest.symlinks -ne 0 -or $manifest.nativeAddons -ne 0){throw 'Candidate provenance differs.'}
 $files=@{};foreach($f in $manifest.files){if($files.ContainsKey($f.path)){throw 'Duplicate file.'};$files[$f.path]=$f};if($files.Count+1 -ne $plan.Count){throw 'Manifest file set differs.'}
 foreach($item in $plan){if($item.Relative -ceq 'runtime-manifest.json'){continue};if(!$files.ContainsKey($item.Relative) -or $files[$item.Relative].bytes -ne $item.Entry.Length -or (Get-UnifiedEntryHash $item.Entry) -cne $files[$item.Relative].sha256){throw 'Archive bytes differ.'}}
 $names=@($files.Keys|Where-Object {$_ -like 'db/edge/migrations/*.sql'}|Sort-Object);if($names.Count -ne 28){throw 'Exact schema028 required.'};$ledger=@()
 for($i=0;$i -lt 28;$i++){$p=$names[$i];$v=$p.Substring('db/edge/migrations/'.Length);if(-not $v.StartsWith(('{0:D3}_' -f ($i+1)))){throw 'Non-contiguous migrations.'};if($i -lt 25 -and (!$installed.ContainsKey($p) -or $installed[$p] -cne $files[$p].sha256)){throw 'Historical migration changed.'};$ledger+=@{scope='edge';version=$v;checksum=$files[$p].sha256}}
 Assert-HeadMigrationSet $ledger
 $db=Read-RuntimeLedger;if($db.systemIdentifier -cne $foundation.systemIdentifier){throw 'Database cluster identity changed.'};Assert-RuntimeLedger $db.ledger $ledger;if(@($db.branch).Count -ne 1 -or $db.branch[0].id -cne $BranchId.ToString()){throw 'Branch changed.'}
 Assert-HeadToolPins
 $backupConfig=Join-Path $data 'EdgeBackup\private\edge-backup.json';Assert-UpdateAcl $backupConfig
 Assert-HeadBackupDisk (Get-Content $backupConfig -Raw|ConvertFrom-Json).destination ([bool]$AllowSameDiskBackup)
 Assert-HeadBackupHealth ((& (Join-Path $PSScriptRoot 'install-edge-backup.ps1') -Mode Inspect)|ConvertFrom-Json) ([DateTime]::UtcNow.AddHours(-2))
 Assert-RuntimePreserved
 if(!$Apply){Write-Output 'VERIFIED: head runtime, CI, step 025, schema028, stopped writers and schema028 backup; no persistent change.';return}

 $lease=Enter-UnifiedMaintenanceLock (Join-Path $data 'EdgeTools\unified-menu-maintenance.lock')
 Assert-HeadWritersStopped;Assert-RuntimePreserved
 foreach($b in $bindings){if([IO.File]::ReadAllText($b[0]) -cne $b[1]){throw 'Concurrent service change.'}}
 New-ProtectedDirectory $stateRoot;Write-UpdateText (Join-Path $stateRoot 'inputs.json') (@{sourceCommit=$SourceCommit;predecessorCommit=$PredecessorCommit;archiveSha256=$RuntimeSha256;ciRun=$ci.run.id}|ConvertTo-Json)
 New-ProtectedDirectory $newRoot 'ReadAndExecute';New-ProtectedDirectory $script:newApp 'ReadAndExecute'
 foreach($item in $plan){$null=Assert-LocalNtfsPath $item.Target;$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target));$input=$item.Entry.Open();try{$output=[IO.File]::Open($item.Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$input.CopyTo($output);$output.Flush($true)}finally{$output.Dispose()}}finally{$input.Dispose()};Assert-UpdateAcl $item.Target 'ReadAndExecute';if($item.Relative -cne 'runtime-manifest.json' -and (Get-FileHash $item.Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $files[$item.Relative].sha256){throw 'Extracted bytes differ.'}}
 for($i=0;$i -lt $bindings.Count;$i++){Write-UpdateText (Join-Path $stateRoot ('original-'+$i+'.xml')) $bindings[$i][1]}
 Invoke-HeadRuntimeSwitch $bindings $ledger
 Wait-UnifiedReady $script:newApp;Start-Sleep -Seconds 10
 foreach($spec in $specs){$s=Get-CimInstance Win32_Service -Filter "Name='$($spec[0])'";$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($s.ProcessId)"|Where-Object {$_.Name -ieq 'node.exe' -and $_.CommandLine.Contains($script:newApp)});if($s.State -cne 'Running' -or $children.Count -ne 1){throw 'Candidate service process verification failed.'}}
 if((Get-Service 'PickChickKitchenLink').Status -ne 'Running'){throw 'KitchenLink did not resume.'}
 Assert-RuntimePreserved;Assert-RuntimeLedger (Read-RuntimeLedger).ledger $ledger
 Write-UpdateText (Join-Path $stateRoot 'completed.json') (@{sourceCommit=$SourceCommit;predecessorCommit=$PredecessorCommit;schema=28;completedAt=[DateTime]::UtcNow.ToString('o');environmentChanged=$false;databasePreserved=$true}|ConvertTo-Json)
 Write-Output 'READY: schema028 and four native runtimes on the head runtime verified; credentials and optional flags unchanged.'
}finally{$zip.Dispose();$archive.Dispose();if($lease){$lease.Dispose()}}
