# Execute only extracted functions with synthetic data and mocked SCM. No host mutation.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$tokens=$null;$parseErrors=$null
$source=Join-Path $PSScriptRoot '../../infra/windows/update-native-unified-menu.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count) {throw ($parseErrors | Out-String)}
$functions=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
. ([scriptblock]::Create(($functions.Extent.Text -join "`n")))
$script:cases=0
function Check([bool]$Condition,[string]$Message) {if(-not $Condition) {throw $Message};$script:cases++}
function Rejects([scriptblock]$Action,[string]$Message) {$caught=$false;try {& $Action | Out-Null} catch {$caught=$true};Check $caught $Message}
function Clone($Value) {return ($Value | ConvertTo-Json -Depth 20 | ConvertFrom-Json)}
$sha='a'*40;$branch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';$device='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$workflow=Get-Content (Join-Path $PSScriptRoot '../../.github/workflows/ci.yml') -Raw
$names=@([regex]::Matches($workflow,'(?m)^    name: (.+)$') | ForEach-Object {$_.Groups[1].Value.Trim()})
$proof=@{run=@{head_sha=$sha;status='completed';conclusion='success';head_repository=@{full_name='xaaknazar/pickchick'};path='.github/workflows/ci.yml'};jobs=@{total_count=$names.Count;jobs=@($names | ForEach-Object {@{name=$_;status='completed';conclusion='success';head_sha=$sha}})}}
Assert-UnifiedCi (Clone $proof) $sha;Check $true 'Valid CI'
foreach($bad in @('run-sha','repo','workflow','missing','duplicate','skipped','job-sha','pending','count')) {
  $p=Clone $proof
  switch($bad) {'run-sha' {$p.run.head_sha='b'*40};'repo' {$p.run.head_repository.full_name='other/repo'};'workflow' {$p.run.path='other.yml'};'missing' {$p.jobs.jobs=$p.jobs.jobs[1..10]};'duplicate' {$p.jobs.jobs[1].name=$p.jobs.jobs[0].name};'skipped' {$p.jobs.jobs[0].conclusion='skipped'};'job-sha' {$p.jobs.jobs[0].head_sha='b'*40};'pending' {$p.jobs.jobs[0].status='in_progress'};'count' {$p.jobs.total_count=12}}
  Rejects {Assert-UnifiedCi $p $sha} ('CI must reject '+$bad)
}
$files=@{};$installed=@{}
$migrationRoot=Join-Path $PSScriptRoot '../../db/edge/migrations'
# Historical release profile intentionally accepts only the schema019 candidate.
foreach($file in Get-ChildItem $migrationRoot -Filter '*.sql' | Where-Object {[int]$_.Name.Substring(0,3) -le 19} | Sort-Object Name) {
  $key='db/edge/migrations/'+$file.Name;$hash=(Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $files[$key]=@{sha256=$hash};if([int]$file.Name.Substring(0,3) -le 17) {$installed[$key]=$hash}
}
$ledger=@(Assert-UnifiedMigrationSet $files $installed);Check ($ledger.Count -eq 19) 'Candidate ledger'
$badFiles=$files.Clone();$badFiles['db/edge/migrations/020_terminal_access.sql']=@{sha256='0'*64};Rejects {Assert-UnifiedMigrationSet $badFiles $installed} 'Future schema020 must use its own release profile'
$badFiles=$files.Clone();$badFiles.Remove('db/edge/migrations/019_edge_remote_stops.sql');Rejects {Assert-UnifiedMigrationSet $badFiles $installed} 'Missing019'
$badFiles=$files.Clone();$badFiles['db/edge/migrations/019_edge_remote_stops.sql']=@{sha256='0'*64};Rejects {Assert-UnifiedMigrationSet $badFiles $installed} 'Changed019'
$badInstalled=$installed.Clone();$key=@($badInstalled.Keys)[0];$badInstalled[$key]='0'*64;Rejects {Assert-UnifiedMigrationSet $files $badInstalled} 'Changed baseline'
$now=[DateTime]::Parse('2026-10-09T12:00:00Z').ToUniversalTime()
$backup=@{format='pickchick-native-service-backup-v1';branchId=$branch;systemIdentifier='123456789012345';sourceDatabase='pickchick_edge';backupVerified=$true;restoreVerified=$true;rehearsalDropped=$true;completed=$true;sha256='b'*64;archiveBytes=100;tableCounts=@{schema_migrations='17'};ledger=$ledger[0..16];finishedAt='2026-10-09T11:00:00Z'}
Assert-UnifiedBackup (Clone $backup) $branch '123456789012345' 17 $ledger $now;Check $true 'Valid backup'
foreach($bad in @('old','future','restore','branch','system','ledger','checksum')) {
  $b=Clone $backup
  switch($bad) {'old' {$b.finishedAt='2026-10-09T05:59:59Z'};'future' {$b.finishedAt='2026-10-09T12:00:01Z'};'restore' {$b.restoreVerified=$false};'branch' {$b.branchId=$device};'system' {$b.systemIdentifier='other'};'ledger' {$b.ledger=$b.ledger[0..15]};'checksum' {$b.ledger[0].checksum='0'*64}}
  Rejects {Assert-UnifiedBackup $b $branch '123456789012345' 17 $ledger $now} ('Backup must reject '+$bad)
}
$node='C:\foundation\node.exe';$envPath='C:\private\worker.env';$identity='C:\private\identity.json';$old='C:\Edge\old\app';$new='C:\Edge\new\app'
$arguments='--env-file="'+$envPath+'" "'+$old+'\infra\windows\native-fulfillment-worker.mjs" "'+$identity+'" '+$branch+' '+$device
$xml='<service><id>PickChickFulfillmentWorker</id><executable>'+ $node +'</executable><workingdirectory>'+ $old +'</workingdirectory><arguments>'+ [Security.SecurityElement]::Escape($arguments) +'</arguments><serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount><depend>PickChickPostgres</depend><env name="NODE_OPTIONS" value=""/></service>'
[xml]$updated=New-UnifiedWorkerXml $xml $node $envPath $identity $old $new $branch $device
Check ($updated.service.arguments -ceq $arguments.Replace($old,$new)) 'Worker plan changes runtime only'
Check ($updated.service.depend -ceq 'PickChickPostgres' -and $updated.service.env.name -ceq 'NODE_OPTIONS') 'Worker plan preserves remaining nodes'
Rejects {New-UnifiedWorkerXml $xml $node $envPath $identity $old $new $device $branch} 'Foreign device'
Rejects {New-UnifiedWorkerXml ('<!DOCTYPE service [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+$xml) $node $envPath $identity $old $new $branch $device} 'DTD'
$menu=@{sourceCommit=$sha;archiveSha256='b'*64;branchId=$branch;deviceId=$device;result=@{phase='prepared';migrations=18}}
$stops=@{sourceCommit=$sha;archiveSha256='b'*64;branchId=$branch;deviceId=$device;menuInspect=@{migrations=18;grantsVerified=$true};before=@{fingerprint='c'*64};result=@{migrations=19;grantsVerified=$true;existingDataPreserved=$true;fingerprint='c'*64}}
Assert-UnifiedPhaseProof (Clone $menu) (Clone $stops) $sha ('b'*64) $branch $device;Check $true 'Valid phases'
foreach($bad in @('foreign','grants','data','fingerprint','menu-grants')) {
  $s=Clone $stops
  switch($bad) {'foreign' {$s.deviceId=$branch};'grants' {$s.result.grantsVerified=$false};'data' {$s.result.existingDataPreserved=$false};'fingerprint' {$s.result.fingerprint='d'*64};'menu-grants' {$s.menuInspect.grantsVerified=$false}}
  Rejects {Assert-UnifiedPhaseProof (Clone $menu) $s $sha ('b'*64) $branch $device} ('Phase must reject '+$bad)
}
# Mock SCM calls, including a partial Stop-Service failure and a restart failure.
function Reset-Services {
  $script:services=@{};$script:calls=@();$script:failStop='';$script:failStart=''
  foreach($name in @('PickChickEdge','PickChickKitchenLink','PickChickFulfillmentWorker','PickChickMenuSyncWorker','PickChickPosSync')) {
    $s=[pscustomobject]@{Name=$name;Status='Running';DependentServices=@()}
    $s | Add-Member ScriptMethod WaitForStatus {param($status,$timeout) if($this.Status -ne $status) {throw 'Mock service did not reach expected state.'}}
    $script:services[$name]=$s
  }
  $script:services.PickChickMenuSyncWorker.Status='Stopped'
  $script:services.PickChickEdge.DependentServices=@($script:services.PickChickKitchenLink)
}
function Get-Service {param($Name,$ErrorAction) return $script:services[$Name]}
function Stop-Service {param($Name) $script:calls+= 'stop:'+ $Name;$script:services[$Name].Status='Stopped';if($Name -ceq $script:failStop) {throw 'Injected partial stop failure.'}}
function Start-Service {param($Name) $script:calls+= 'start:'+ $Name;if($Name -ceq $script:failStart) {throw 'Injected restart failure.'};$script:services[$Name].Status='Running'}
Reset-Services
$result=Invoke-UnifiedQuiesced {'result'}
Check ($result -ceq 'result') 'Action result retained'
Check (($script:calls -join ',') -ceq 'stop:PickChickFulfillmentWorker,stop:PickChickPosSync,stop:PickChickKitchenLink,stop:PickChickEdge,start:PickChickEdge,start:PickChickKitchenLink,start:PickChickPosSync,start:PickChickFulfillmentWorker') 'Dependency order'
Check ($script:services.PickChickMenuSyncWorker.Status -ceq 'Stopped') 'Originally stopped worker remains stopped'
Reset-Services
Rejects {Invoke-UnifiedQuiesced {throw 'Database apply failed'}} 'Database failure propagated'
Check (@($script:services.Values | Where-Object {$_.Name -ne 'PickChickMenuSyncWorker' -and $_.Status -ne 'Running'}).Count -eq 0) 'Services restored after database failure'
Reset-Services;$script:failStop='PickChickKitchenLink'
Rejects {Invoke-UnifiedQuiesced {throw 'Must not run'}} 'Partial stop failure propagated'
Check (@($script:services.Values | Where-Object {$_.Name -ne 'PickChickMenuSyncWorker' -and $_.Status -ne 'Running'}).Count -eq 0) 'Partial stop restored'
Reset-Services;$script:failStart='PickChickEdge'
Rejects {Invoke-UnifiedQuiesced {}} 'Restart failure propagated'
Check ($script:calls -contains 'start:PickChickFulfillmentWorker') 'Recovery attempts remaining services'
Reset-Services;$script:services.PickChickEdge.Status='Stopped';$script:services.PickChickFulfillmentWorker.Status='Stopped'
Invoke-UnifiedQuiesced {} @('PickChickEdge','PickChickFulfillmentWorker')
Check ($script:services.PickChickEdge.Status -ceq 'Running' -and $script:services.PickChickFulfillmentWorker.Status -ceq 'Running') 'Rollback restarts services that failed during candidate start'
Reset-Services;$script:services.PickChickEdge.DependentServices=@([pscustomobject]@{Name='Unrelated';Status='Running'})
Rejects {Invoke-UnifiedQuiesced {}} 'Unknown dependent rejected'
Check ($script:calls.Count -eq 0) 'No mutation with unknown dependent'
# Exercise compare-and-swap and a partial two-file switch with real isolated temp files.
# Only ACL provisioning and the inherited helper's exclusive writer are substituted.
function Assert-UpdateAcl {param($Path,$ServiceRights,[switch]$Protected) }
function Write-UpdateText {param($Path,$Text) $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew);try {$bytes=[Text.Encoding]::UTF8.GetBytes($Text);$stream.Write($bytes,0,$bytes.Length)} finally {$stream.Dispose()}}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('unified-menu-test-'+[guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($temp)
try {
  $edge=Join-Path $temp 'edge.xml';$worker=Join-Path $temp 'worker.xml'
  [IO.File]::WriteAllText($edge,'old-edge');[IO.File]::WriteAllText($worker,'old-worker')
  foreach($edgeState in @('old-edge','new-edge')) {foreach($workerState in @('old-worker','new-worker')) {
    Assert-UnifiedModeBindings 'Rollback' $edgeState $workerState 'old-edge' 'new-edge' 'old-worker' 'new-worker'
    Check $true ('Rollback accepts exact states '+$edgeState+'/'+$workerState)
    [IO.File]::WriteAllText($edge,$edgeState);[IO.File]::WriteAllText($worker,$workerState)
    Restore-UnifiedBindings @(@($edge,'old-edge','new-edge'),@($worker,'old-worker','new-worker'))
    Check ([IO.File]::ReadAllText($edge) -ceq 'old-edge' -and [IO.File]::ReadAllText($worker) -ceq 'old-worker') 'Rollback converges from either interrupted switch'
  }}
  Assert-UnifiedModeBindings 'Switch' 'old-edge' 'old-worker' 'old-edge' 'new-edge' 'old-worker' 'new-worker'
  Check $true 'Switch accepts original bindings'
  Rejects {Assert-UnifiedModeBindings 'Switch' 'new-edge' 'old-worker' 'old-edge' 'new-edge' 'old-worker' 'new-worker'} 'Switch rejects partial candidate'
  Rejects {Assert-UnifiedModeBindings 'Rollback' 'new-edge' 'foreign-worker' 'old-edge' 'new-edge' 'old-worker' 'new-worker'} 'Rollback mode decision rejects foreign XML'
  Rejects {Assert-UnifiedModeBindings 'Rollback' 'foreign-edge' 'old-worker' 'old-edge' 'new-edge' 'old-worker' 'new-worker'} 'Rollback mode decision rejects foreign edge XML'
  $lockPath=Join-Path $temp 'maintenance.lock'
  $lease=Enter-UnifiedMaintenanceLock $lockPath
  try {Rejects {Enter-UnifiedMaintenanceLock $lockPath} 'Concurrent phase cannot acquire maintenance lease'} finally {$lease.Dispose()}
  $lease=Enter-UnifiedMaintenanceLock $lockPath;$lease.Dispose();Check $true 'Released maintenance lease can be acquired again'
  Replace-UnifiedXml $edge 'old-edge' 'new-edge'
  Check ([IO.File]::ReadAllText($edge) -ceq 'new-edge') 'Atomic switch'
  Restore-UnifiedBindings @(@($edge,'old-edge','new-edge'),@($worker,'old-worker','new-worker'))
  Check ([IO.File]::ReadAllText($edge) -ceq 'old-edge' -and [IO.File]::ReadAllText($worker) -ceq 'old-worker') 'Partial switch restored'
  [IO.File]::WriteAllText($edge,'new-edge');[IO.File]::WriteAllText($worker,'foreign-worker')
  Rejects {Restore-UnifiedBindings @(@($edge,'old-edge','new-edge'),@($worker,'old-worker','new-worker'))} 'Foreign XML preserved'
  Check ([IO.File]::ReadAllText($edge) -ceq 'new-edge' -and [IO.File]::ReadAllText($worker) -ceq 'foreign-worker') 'Foreign XML rejects before either write'
  Rejects {Replace-UnifiedXml $worker 'old-worker' 'new-worker'} 'Stale CAS rejected'
  Check ([IO.File]::ReadAllText($worker) -ceq 'foreign-worker') 'CAS retains concurrent change'
} finally {[IO.Directory]::Delete($temp,$true)}
Write-Output ('windows-unified-menu: '+$script:cases+' checks passed (pure functions and mocked SCM; no installation performed)')
