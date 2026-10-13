#Requires -Version 5.1
#Requires -RunAsAdministrator
<# App-only fulfillment worker update over 23fb39e with installed schema020.
Default is inspection. No price/menu/payment/config/SQL mutation. Requires exact
CI, backup/restore, immutable runtime, current ledger, shared maintenance lock and
byte-pinned two-file runtime delta. Only the fulfillment worker is restarted.
Old-reader rollback is forbidden after a >200-line reservation has been stored.
#>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
 [Parameter(Mandatory=$true)][string]$RuntimeArchive,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$RuntimeSha256,
 [Parameter(Mandatory=$true)][string]$BackupManifest,
 [Parameter(Mandatory=$true)][string]$CiProof,
 [Parameter(Mandatory=$true)][guid]$BranchId,
 [Parameter(Mandatory=$true)][guid]$DeviceId,
 [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Import-KioskFunctions([string]$File,[string]$Hash,[string[]]$Names) {
 if((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash){throw 'Reviewed helper bytes differ.'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'Helper parse failure.'}
 foreach($name in $Names){$found=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$false));if($found.Count -ne 1){throw 'Missing helper function.'};$found[0].Extent.Text}
}
function Assert-KioskRuntimeDelta($Old,$New) {
 $expectedBefore=@{'node_modules/@pickchick/edge-fulfillment/dist/model.js'='3e15e2f4125f625c46abe65da229396fbd8f684277c2d6870986c03246a8dcea';'node_modules/@pickchick/edge-fulfillment/dist/model.js.map'='2075b865c086b5c64b1c17e4b265292f8a6cebe9c3c0cc22bea414beab520b77'}
 $expectedAfter=@{'node_modules/@pickchick/edge-fulfillment/dist/model.js'='ee226fe2add3545919d2101305471955b1f98f710c85b76ecfc276bc44aefffc';'node_modules/@pickchick/edge-fulfillment/dist/model.js.map'='6c62d88d80c71e00a4f6c6ab8500b6c2deac4353e628c8d7ea5c49ceab23fc4e'}
 if($Old.Count -ne $New.Count){throw 'Runtime file set changed.'}
 foreach($path in $Old.Keys){
  if(-not $New.ContainsKey($path)){throw 'Runtime file removed.'}
  if($expectedBefore.ContainsKey($path)){
   if($Old[$path].sha256 -cne $expectedBefore[$path] -or $New[$path].sha256 -cne $expectedAfter[$path]){throw 'Reviewed model bytes differ.'}
  } elseif($Old[$path].sha256 -cne $New[$path].sha256){throw 'Unrelated runtime change.'}
 }
 foreach($path in $expectedBefore.Keys){if(-not $Old.ContainsKey($path)){throw 'Reviewed model missing.'}}
}
function Read-KioskDatabaseState {
 # Single-quoted here-string keeps JS quoting exact in Windows PowerShell 5.1.
 $code=@'
import{createRequire}from'node:module';const req=createRequire(process.argv[2]+'/package.json');const{Pool}=req('pg');const p=new Pool({connectionString:process.env.EDGE_DATABASE_URL});try{const c=await p.connect();try{await c.query('BEGIN READ ONLY');const ledger=(await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')).rows;const n=(await c.query("SELECT count(*)::int n FROM fulfillment_reservations WHERE jsonb_array_length(snapshot->'lines')>200")).rows[0].n;console.log(JSON.stringify({ledger,large:n}));await c.query('ROLLBACK');}finally{c.release();}}catch{console.error('Read-only database verification failed');process.exitCode=1;}finally{await p.end();}
'@
 $savedEncoding=$OutputEncoding
 try{$OutputEncoding=[Text.UTF8Encoding]::new($false);$output=$code | & $node ('--env-file='+$ownerEnv) '--input-type=module' '-' $oldApp}finally{$OutputEncoding=$savedEncoding}
 if($LASTEXITCODE -ne 0){throw 'Read-only database check failed.'}
 return ($output|ConvertFrom-Json)
}
function Assert-KioskLedger($Actual,$Expected){
 if(@($Actual).Count -ne @($Expected).Count){throw 'Installed ledger count changed.'}
 for($i=0;$i -lt @($Expected).Count;$i++){foreach($key in @('version','checksum','scope')){if($Actual[$i].$key -cne $Expected[$i].$key){throw 'Installed ledger changed.'}}}
}
function Assert-KioskRollback($State){if($State.large -ne 0){throw 'Large orders require a compatible forward fix; never erase data.'}}
function Assert-KioskPreserved {
 foreach($path in $preserved.Keys){if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $preserved[$path]){throw 'Preserved settings changed.'}}
 foreach($name in $neighbors.Keys){$actual=Get-CimInstance Win32_Service -Filter "Name='$name'";if($actual.ProcessId -ne $neighbors[$name] -or $actual.State -cne 'Running'){throw 'Neighbor service changed.'}}
 Assert-KioskLedger (Read-KioskDatabaseState).ledger $ledger
}
function Wait-KioskWorker([string]$App){
 $svc=Get-Service PickChickFulfillmentWorker;$svc.WaitForStatus('Running',[TimeSpan]::FromSeconds(35))
 $deadline=[DateTime]::UtcNow.AddSeconds(30)
 do{$svc=Get-CimInstance Win32_Service -Filter "Name='PickChickFulfillmentWorker'";$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId)"|Where-Object {$_.Name -ieq 'node.exe' -and $_.CommandLine.Contains($App+'\infra\windows\native-fulfillment-worker.mjs')});if($children.Count -eq 1 -and $svc.State -ceq 'Running'){Start-Sleep -Seconds 3;if((Get-Service PickChickFulfillmentWorker).Status -ceq 'Running'){return}};Start-Sleep -Milliseconds 500}while([DateTime]::UtcNow -lt $deadline)
 throw 'Worker process failed verification.'
}
function Read-KioskWorkerXml([string]$Path){return [IO.File]::ReadAllText($Path)}
function Stop-KioskWorker {Stop-Service PickChickFulfillmentWorker;(Get-Service PickChickFulfillmentWorker).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(35))}
function Start-KioskWorker([string]$App){if((Get-Service PickChickFulfillmentWorker).Status -ne 'Running'){Start-Service PickChickFulfillmentWorker};Wait-KioskWorker $App}
function Invoke-KioskWorkerSwitch([string]$Path,[string]$Before,[string]$After,[string]$OldApp,[string]$NewApp){
 try{
  Stop-KioskWorker
  Replace-UnifiedXml $Path $Before $After
  Start-KioskWorker $NewApp
  Assert-KioskPreserved
 }catch{
  $failure=$_
  # A partial stop or partial XML replacement is recoverable. Never overwrite a
  # concurrent binding, nor restore an old reader without a positive DB proof.
  Stop-KioskWorker
  $current=Read-KioskWorkerXml $Path
  $resume=$OldApp
  if($current -ceq $After){
   $compatible=$false
   try{$db=Read-KioskDatabaseState;Assert-KioskLedger $db.ledger $ledger;Assert-KioskRollback $db;$compatible=$true}catch{$compatible=$false}
   if($compatible){Replace-UnifiedXml $Path $After $Before}else{$resume=$NewApp}
  }elseif($current -cne $Before){throw 'Concurrent worker binding retained; inspect before restarting.'}
  Start-KioskWorker $resume
  throw $failure
 }
}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop'){throw 'Elevated x64 Windows PowerShell 5.1 required.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($definition in (Import-KioskFunctions (Join-Path $PSScriptRoot 'install-native-foundation.ps1') '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5' @('Assert-LocalNtfsPath','Open-VerifiedFile','Assert-ArchiveName','Get-ArchivePlan','New-ProtectedDirectory','Assert-ProtectedDirectory'))){. ([scriptblock]::Create($definition))}
foreach($definition in (Import-KioskFunctions (Join-Path $PSScriptRoot 'update-native-service.ps1') '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Assert-UpdateAcl','Write-UpdateText'))){. ([scriptblock]::Create($definition))}
foreach($definition in (Import-KioskFunctions (Join-Path $PSScriptRoot 'update-native-unified-menu.ps1') 'b764a8733224f951ad1543d9d1b18bf7ac269b1e034a1fbadbefbba488f903ef' @('Assert-UnifiedCi','Assert-UnifiedBackup','New-UnifiedWorkerXml','Enter-UnifiedMaintenanceLock','Replace-UnifiedXml'))){. ([scriptblock]::Create($definition))}
$program='C:\Program Files\PickChick';$data='C:\ProgramData\PickChick'
$oldApp=Join-Path $program 'Edge\edge-23fb39e\app'
$newRoot=Join-Path $program ('Edge\edge-'+$SourceCommit.Substring(0,7));$newApp=Join-Path $newRoot 'app'
$node=Join-Path $program 'Edge\edge-0186902\node\node.exe'
$stateRoot=Join-Path $data ('EdgeTools\kiosk-cart-lines-'+$SourceCommit.Substring(0,7))
$xmlPath=Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.xml'
$envFile=Join-Path $data 'FulfillmentWorker\worker.env';$identity=Join-Path $data 'FulfillmentWorker\device-identity.json'
$ownerEnv=Join-Path $data 'EdgeTools\edge-0186902\private\edge-owner.env'
foreach($path in @($oldApp,$node,$xmlPath,$envFile,$identity)){Assert-UpdateAcl $path 'ReadAndExecute'}
foreach($path in @($ownerEnv,$BackupManifest,$CiProof)){Assert-UpdateAcl $path}
if(Test-Path $newRoot){throw 'Existing release: inspect original outcome, no replay.'}
if(Test-Path $stateRoot){throw 'Existing operation: inspect original outcome, no replay.'}
$old=Get-Content (Join-Path $oldApp 'runtime-manifest.json') -Raw|ConvertFrom-Json
if($old.sourceCommit -cne '23fb39e152fccaa97a32e9bf179c2d89a50dc1d5'){throw 'Installed baseline differs.'}
$proof=Get-Content $CiProof -Raw|ConvertFrom-Json;Assert-UnifiedCi $proof $SourceCommit
$foundation=Get-Content (Join-Path $data 'EdgeTools\edge-0186902\private\foundation-state.json') -Raw|ConvertFrom-Json
if(!$foundation.complete -or $foundation.branchId -cne $BranchId.ToString() -or $foundation.computerName -ine $env:COMPUTERNAME){throw 'Foreign foundation.'}
$oldFiles=@{};foreach($f in $old.files){if($oldFiles.ContainsKey($f.path)){throw 'Duplicate installed path.'};$oldFiles[$f.path]=$f}
$ledger=@(foreach($path in ($oldFiles.Keys|Where-Object {$_ -like 'db/edge/migrations/*.sql'}|Sort-Object)){@{version=$path.Substring('db/edge/migrations/'.Length);checksum=$oldFiles[$path].sha256;scope='edge'}})
if($ledger.Count -ne 19){throw 'Exact baseline runtime migrations required.'}
# Device-center already installed this additive migration separately. Preserve it;
# no migration is applied by this worker-only release.
$ledger+=@{version='020_terminal_access.sql';checksum='afeffbdd49c9dfaa5a3fea4be32b97aa99c45e6897f4ff0c220f9b89d02a24b6';scope='edge'}
$backup=Get-Content $BackupManifest -Raw|ConvertFrom-Json
Assert-UnifiedBackup $backup $BranchId.ToString() $foundation.systemIdentifier 20 $ledger
$stream=Open-VerifiedFile (Join-Path (Split-Path $BackupManifest) 'pickchick_edge.dump') $backup.sha256;$stream.Dispose()
Assert-KioskLedger (Read-KioskDatabaseState).ledger $ledger
$xml=[IO.File]::ReadAllText($xmlPath)
$newXml=New-UnifiedWorkerXml $xml $node $envFile $identity $oldApp $newApp $BranchId.ToString() $DeviceId.ToString()
$worker=Get-CimInstance Win32_Service -Filter "Name='PickChickFulfillmentWorker'"
if($worker.State -cne 'Running' -or $worker.StartName -ine 'NT AUTHORITY\LocalService' -or $worker.PathName.Trim('"') -cne (Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.exe')){throw 'Worker binding differs.'}
if(@((Get-Service PickChickFulfillmentWorker).DependentServices|Where-Object {$_.Status -ne 'Stopped'}).Count){throw 'Worker has active dependents; no restart allowed.'}
$neighbors=@{};foreach($svc in Get-CimInstance Win32_Service -Filter "Name LIKE 'PickChick%'"|Where-Object {$_.Name -ne 'PickChickFulfillmentWorker' -and $_.State -ceq 'Running'}){$neighbors[$svc.Name]=$svc.ProcessId}
$preserved=@{};foreach($path in @($envFile,$identity,$ownerEnv,(Join-Path $program 'Edge\edge-0186902\PickChickEdge.xml'))){$preserved[$path]=(Get-FileHash $path -Algorithm SHA256).Hash}
Add-Type -AssemblyName System.IO.Compression
$lease=$null;$archive=Open-VerifiedFile $RuntimeArchive $RuntimeSha256
$zip=[IO.Compression.ZipArchive]::new($archive,[IO.Compression.ZipArchiveMode]::Read,$true)
try{
 $plan=Get-ArchivePlan $zip 'runtime' $newApp;$entry=$zip.GetEntry('runtime-manifest.json')
 if(!$entry -or $entry.Length -gt 8MB){throw 'Missing runtime manifest.'}
 $reader=[IO.StreamReader]::new($entry.Open());try{$manifest=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
 if($manifest.sourceCommit -cne $SourceCommit -or $manifest.format -cne 'pickchick-edge-runtime-v1' -or $manifest.target -cne 'windows-x64' -or $manifest.symlinks -ne 0 -or $manifest.nativeAddons -ne 0){throw 'Runtime provenance differs.'}
 $files=@{};foreach($f in $manifest.files){if($files.ContainsKey($f.path)) {throw 'Duplicate runtime path.'};$files[$f.path]=$f}
 Assert-KioskRuntimeDelta $oldFiles $files
 if($files.Count+1 -ne $plan.Count){throw 'Runtime archive file set differs.'}
 foreach($item in $plan){if($item.Relative -ceq 'runtime-manifest.json'){continue};if(!$files.ContainsKey($item.Relative) -or $files[$item.Relative].bytes -ne $item.Entry.Length){throw 'Archive file differs.'};$stream=$item.Entry.Open();$h=[Security.Cryptography.SHA256]::Create();try{$actual=[BitConverter]::ToString($h.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose();$stream.Dispose()};if($actual -cne $files[$item.Relative].sha256){throw 'Archive hash differs.'}}
 # Verify the actual installed bytes, not just its old manifest.
 foreach($f in $old.files){if((Get-FileHash -LiteralPath (Join-Path $oldApp $f.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'Installed runtime drift.'}}
 Assert-KioskPreserved
 if(!$Apply){Write-Output 'VERIFIED: worker-only candidate; no changes made.';return}
 $lease=Enter-UnifiedMaintenanceLock (Join-Path $data 'EdgeTools\unified-menu-maintenance.lock')
 Assert-KioskPreserved
 if([IO.File]::ReadAllText($xmlPath) -cne $xml){throw 'Worker XML changed.'}
 New-ProtectedDirectory $stateRoot
 Write-UpdateText (Join-Path $stateRoot 'original-worker.xml') $xml
 Write-UpdateText (Join-Path $stateRoot 'inputs.json') (@{sourceCommit=$SourceCommit;archiveSha256=$RuntimeSha256;backupSha256=$backup.sha256;ciRun=$proof.run.id}|ConvertTo-Json)
 New-ProtectedDirectory $newRoot 'ReadAndExecute';New-ProtectedDirectory $newApp 'ReadAndExecute'
 foreach($item in $plan){$null=Assert-LocalNtfsPath $item.Target;$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target));$input=$item.Entry.Open();try{$output=[IO.File]::Open($item.Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$input.CopyTo($output);$output.Flush($true)}finally{$output.Dispose()}}finally{$input.Dispose()};Assert-UpdateAcl $item.Target 'ReadAndExecute';if($item.Relative -cne 'runtime-manifest.json' -and (Get-FileHash $item.Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $files[$item.Relative].sha256){throw 'Extracted bytes differ.'}}
 Invoke-KioskWorkerSwitch $xmlPath $xml $newXml $oldApp $newApp
 Write-UpdateText (Join-Path $stateRoot 'completed.json') (@{sourceCommit=$SourceCommit;completedAt=[DateTime]::UtcNow.ToString('o');workerOnly=$true;schema=20;databaseChanged=$false;environmentChanged=$false;otherServicesRestarted=$false}|ConvertTo-Json)
 Write-Output 'READY: fulfillment worker updated; cashier app, Edge, database and other services preserved.'
}finally{$zip.Dispose();$archive.Dispose();if($lease){$lease.Dispose()}}
