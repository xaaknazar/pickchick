#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Schema015 -> 017 kiosk admission. Cloud schema045 is already installed.
   Exact CI, backup/restore and preserved row/ACL/sequence fingerprints are mandatory.
   After migration never roll back to the old binary automatically; retain all financial data. #>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
  [Parameter(Mandatory=$true)][ValidatePattern('^edge-[a-f0-9]{7}$')][string]$PreviousRelease,
  [Parameter(Mandatory=$true)][string]$RuntimeArchive,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$RuntimeSha256,
  [Parameter(Mandatory=$true)][string]$BackupManifest,
  [Parameter(Mandatory=$true)][string]$CiProof,
  [Parameter(Mandatory=$true)][guid]$BranchId,
  [Parameter(Mandatory=$true)][string]$DatabaseHelper,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$DatabaseHelperSha256,
  [Parameter(Mandatory=$true)][guid]$DeviceId,
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
function Import-ReviewedFunctions([string]$File,[string]$Hash,[string[]]$Names) {
  if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) {throw 'Reviewed maintenance helper differs.'}
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
  if($errors.Count) {throw 'Maintenance helper parse failure.'}
  foreach($name in $Names) {
    $found=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false))
    if($found.Count -ne 1) {throw 'Reviewed function missing.'}
    # Return function declarations; caller dot-sources in script scope, never helper main.
    $found[0].Extent.Text
  }
}
$base=Join-Path $PSScriptRoot 'install-native-foundation.ps1'
foreach($definition in (Import-ReviewedFunctions $base '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5' @('Assert-LocalNtfsPath','Open-VerifiedFile','Assert-ArchiveName','Get-ArchivePlan','New-ProtectedDirectory','Assert-ProtectedDirectory'))) {. ([scriptblock]::Create($definition))}
$upgrade=Join-Path $PSScriptRoot 'update-native-service.ps1'
foreach($definition in (Import-ReviewedFunctions $upgrade '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Assert-UpdateAcl','Write-UpdateText','Read-UpdateXml','New-UpdateServiceXml','Read-UpdateHttp','Quote-UpdateArgument','Invoke-UpdateProcess'))) {. ([scriptblock]::Create($definition))}
function Assert-KioskCiProof($proof,[string]$SourceCommit) {
$required=@('Local kitchen UI and recovery','iPad kiosk state, bundles and browser recovery','Design screens and interaction smoke','Private staging image and restricted database role','Cloud-edge fulfillment transport and recovery','Build, contracts and PostgreSQL integration','Foundation static checks and transaction invariants','Foundation POS and backoffice integration','Foundation server account and Kaspi fixtures','Foundation simulator browser regressions','Foundation mobile bundles and checkout recovery')
if($proof.run.head_sha -cne $SourceCommit -or $proof.run.status -ne 'completed' -or $proof.run.conclusion -ne 'success' -or $proof.run.head_repository.full_name -cne 'xaaknazar/pickchick' -or $proof.run.path -cne '.github/workflows/ci.yml' -or $proof.jobs.total_count -ne $required.Count -or $proof.jobs.jobs.Count -ne $required.Count) {throw 'Complete exact-source CI proof required.'}
foreach($name in $required) { $job=@($proof.jobs.jobs | Where-Object {$_.name -ceq $name});if($job.Count -ne 1 -or $job[0].conclusion -ne 'success' -or $job[0].status -ne 'completed' -or $job[0].head_sha -cne $SourceCommit) {throw 'Required CI job did not pass.'} }
}
$program='C:\Program Files\PickChick';$data='C:\ProgramData\PickChick'
$foundation=Join-Path $program 'Edge\edge-0186902'
$node=Join-Path $foundation 'node\node.exe'
$xmlPath=Join-Path $foundation 'PickChickEdge.xml'
$envFile=Join-Path $data 'Edge\config\edge.env'
$logs=Join-Path $data 'Edge\logs'
$oldApp=Join-Path $program ('Edge\'+$PreviousRelease+'\app')
$release='edge-'+$SourceCommit.Substring(0,7)
$newRoot=Join-Path $program ('Edge\'+$release);$newApp=Join-Path $newRoot 'app'
$stateRoot=Join-Path $data ('EdgeTools\'+'kiosk-update-'+$SourceCommit.Substring(0,7))
Assert-UpdateAcl $DatabaseHelper
if((Get-FileHash $DatabaseHelper).Hash.ToLowerInvariant() -cne $DatabaseHelperSha256) {throw 'Database helper differs.'}
$script:toolsRoot=Join-Path $data 'EdgeTools\edge-0186902'
$ownerEnv=Join-Path $toolsRoot 'private\edge-owner.env';Assert-UpdateAcl $ownerEnv
$ownerHash=(Get-FileHash $ownerEnv).Hash
$script:nodeExe=$node;$script:pgBin=Join-Path $program 'Postgres\18.6-3\bin'
$script:migrationAttempted=$false
foreach($path in @($foundation,$oldApp,$xmlPath,$envFile,$BackupManifest,$CiProof)) {Assert-UpdateAcl $path $(if($path -in @($foundation,$oldApp,$xmlPath,$envFile)) {'ReadAndExecute'} else {''})}
if($PreviousRelease -eq $release -or (Test-Path $newRoot) -or (Test-Path $stateRoot)) {throw 'Existing/partial target requires inspection.'}
$proof=Get-Content $CiProof -Raw | ConvertFrom-Json
Assert-KioskCiProof $proof $SourceCommit
$backup=Get-Content $BackupManifest -Raw | ConvertFrom-Json
$foundationState=Get-Content (Join-Path $data 'EdgeTools\edge-0186902\private\foundation-state.json') -Raw | ConvertFrom-Json
if($backup.format -ne 'pickchick-native-service-backup-v1' -or $backup.branchId -ne $BranchId.ToString() -or $backup.systemIdentifier -ne $foundationState.systemIdentifier -or -not $backup.backupVerified -or -not $backup.restoreVerified -or -not $backup.rehearsalDropped -or -not $backup.completed -or $backup.tableCounts.schema_migrations -ne '15') {throw 'Matching schema015 backup/restore proof required.'}
if(([DateTime]::UtcNow-[DateTime]::Parse($backup.finishedAt).ToUniversalTime()).TotalMinutes -gt 30 -or [DateTime]::Parse($backup.finishedAt).ToUniversalTime() -gt [DateTime]::UtcNow) {throw 'Fresh backup within 30 minutes required.'}
$dump=Join-Path (Split-Path $BackupManifest) 'pickchick_edge.dump'
$stream=Open-VerifiedFile $dump $backup.sha256;$stream.Dispose()
$xml=[IO.File]::ReadAllText($xmlPath)
$document=Read-UpdateXml $xml $node $envFile $oldApp $logs
$newXml=New-UpdateServiceXml $document $envFile $newApp
$workerXmlPath=Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.xml'
$workerEnv=Join-Path $data 'FulfillmentWorker\worker.env'
$workerIdentity=Join-Path $data 'FulfillmentWorker\device-identity.json'
foreach($path in @($workerXmlPath,$workerEnv,$workerIdentity)) {Assert-UpdateAcl $path 'ReadAndExecute'}
$workerXml=[IO.File]::ReadAllText($workerXmlPath);[xml]$workerDocument=$workerXml
$oldWorkerApp=Join-Path $program 'Edge\worker-f83794c\app'
Assert-UpdateAcl $oldWorkerApp 'ReadAndExecute'
$oldManifest=Get-Content (Join-Path $oldApp 'runtime-manifest.json') -Raw | ConvertFrom-Json
$oldWorkerManifest=Get-Content (Join-Path $oldWorkerApp 'runtime-manifest.json') -Raw | ConvertFrom-Json
if($oldManifest.sourceCommit -cne 'e47702add67dff3d2d37462ae51adc693ff81449' -or $oldWorkerManifest.sourceCommit -cne 'f83794ce68c10906d2924a3a04351f7550d62b40') {throw 'Installed runtime provenance differs.'}
$expectedArguments='--env-file="'+$workerEnv+'" "'+$oldWorkerApp+'\infra\windows\native-fulfillment-worker.mjs" "'+$workerIdentity+'" '+$BranchId.ToString()+' '+$DeviceId.ToString()
if($workerDocument.service.executable -cne $node -or $workerDocument.service.workingdirectory -cne $oldWorkerApp -or $workerDocument.service.arguments -cne $expectedArguments) {throw 'Unexpected transport worker binding.'}
$workerService=Get-CimInstance Win32_Service -Filter "Name='PickChickFulfillmentWorker'"
if($workerService.State -ne 'Running' -or $workerService.StartName -ne 'NT AUTHORITY\LocalService' -or $workerService.PathName -cne ('"'+$program+'\FulfillmentWorker\PickChickFulfillmentWorker.exe"')) {throw 'Unexpected transport service.'}
$workerDocument.SelectSingleNode('/service/workingdirectory').InnerText=[string]$newApp
$workerDocument.SelectSingleNode('/service/arguments').InnerText=$expectedArguments.Replace($oldWorkerApp,$newApp)
$newWorkerXml=$workerDocument.OuterXml
$workerEnvHash=(Get-FileHash $workerEnv).Hash;$identityHash=(Get-FileHash $workerIdentity).Hash
$envHash=(Get-FileHash $envFile).Hash
$otherServices=@{}
foreach($name in @('PickChickPostgres','PickChickKitchenLink','PickChickFulfillmentTunnel')) {
  $svc=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($svc.State -ne 'Running') {throw 'Required existing service is not running.'};$otherServices[$name]=$svc.ProcessId
}
$edge=Get-CimInstance Win32_Service -Filter "Name='PickChickEdge'"
if($edge.State -ne 'Running' -or $edge.StartName -ne 'NT AUTHORITY\LocalService' -or $edge.PathName -cne ('"'+$foundation+'\PickChickEdge.exe"')) {throw 'Unexpected Edge service.'}
Add-Type -AssemblyName System.IO.Compression
$archive=Open-VerifiedFile $RuntimeArchive $RuntimeSha256
$zip=[IO.Compression.ZipArchive]::new($archive,[IO.Compression.ZipArchiveMode]::Read,$true)
try {
  $plan=Get-ArchivePlan $zip 'runtime' $newApp
  $entry=$zip.GetEntry('runtime-manifest.json');if(-not $entry -or $entry.Length -gt 4MB) {throw 'Runtime manifest missing.'}
  $reader=[IO.StreamReader]::new($entry.Open());try {$manifest=$reader.ReadToEnd() | ConvertFrom-Json} finally {$reader.Dispose()}
  if($manifest.sourceCommit -cne $SourceCommit -or $manifest.format -ne 'pickchick-edge-runtime-v1' -or $manifest.target -ne 'windows-x64' -or $manifest.symlinks -ne 0 -or $manifest.nativeAddons -ne 0) {throw 'Runtime provenance differs.'}
  $files=@{};foreach($file in $manifest.files) {if($files.ContainsKey($file.path) -or $file.sha256 -notmatch '^[a-f0-9]{64}$') {throw 'Invalid file manifest.'};$files[$file.path]=$file}
  if($files.Count+1 -ne $plan.Count) {throw 'Runtime manifest file set differs.'}
  foreach($item in $plan) {
    if($item.Relative -eq 'runtime-manifest.json') {continue}
    if(-not $files.ContainsKey($item.Relative) -or $files[$item.Relative].bytes -ne $item.Entry.Length) {throw 'Archive file differs.'}
    $input=$item.Entry.Open();$sha=[Security.Cryptography.SHA256]::Create()
    try {$actual=[BitConverter]::ToString($sha.ComputeHash($input)).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose();$input.Dispose()}
    if($actual -cne $files[$item.Relative].sha256) {throw 'Archive file checksum differs.'}
  }
  # Only migrations016/017 are new; every existing migration must match.
  $migrationNames=@($files.Keys | Where-Object {$_ -like 'db/edge/migrations/*.sql'})
  if($migrationNames.Count -ne 17 -or 'db/edge/migrations/016_edge_cashier_reports.sql' -notin $migrationNames -or 'db/edge/migrations/017_edge_kiosk_prepaid.sql' -notin $migrationNames) {throw 'Expected schema017 runtime.'}
  foreach($name in $migrationNames | Where-Object {$_ -lt 'db/edge/migrations/016'}) {
    if((Get-FileHash (Join-Path $oldApp $name)).Hash.ToLowerInvariant() -cne $files[$name].sha256) {throw 'Existing migration checksum changed.'}
  }
  foreach($pair in @(@('db/edge/migrations/016_edge_cashier_reports.sql','c9e54fe86a72d2a0fe48952395c74c71613f034cbe67df5b7a83a27a46efa497'),@('db/edge/migrations/017_edge_kiosk_prepaid.sql','7ef5ef704702f469dd6807ab2057c5aa1dfd2820164333f0ec5d01f563320fdd'))) {if($files[$pair[0]].sha256 -cne $pair[1]) {throw 'Unreviewed migration bytes.'}}
  if(-not $Apply) {Write-Output 'VERIFIED: exact-source CI, backup, runtime, services and reviewed migrations016/017; no changes made.';return}
  New-ProtectedDirectory $stateRoot
  Write-UpdateText (Join-Path $stateRoot 'original-edge.xml') $xml
  Write-UpdateText (Join-Path $stateRoot 'candidate-edge.xml') $newXml
  Write-UpdateText (Join-Path $stateRoot 'original-worker.xml') $workerXml
  Write-UpdateText (Join-Path $stateRoot 'candidate-worker.xml') $newWorkerXml
  Write-UpdateText (Join-Path $stateRoot 'inputs.json') (@{sourceCommit=$SourceCommit;archiveSha256=$RuntimeSha256;backupSha256=$backup.sha256;ciRun=$proof.run.id;environmentHash=$envHash} | ConvertTo-Json)
  New-ProtectedDirectory $newRoot 'ReadAndExecute';New-ProtectedDirectory $newApp 'ReadAndExecute'
  foreach($item in $plan) {
    $null=Assert-LocalNtfsPath $item.Target
    $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target))
    $input=$item.Entry.Open();try {$output=[IO.File]::Open($item.Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try {$input.CopyTo($output);$output.Flush($true)} finally {$output.Dispose()}} finally {$input.Dispose()}
    Assert-UpdateAcl $item.Target 'ReadAndExecute'
    if($item.Relative -ne 'runtime-manifest.json' -and (Get-FileHash $item.Target).Hash.ToLowerInvariant() -cne $files[$item.Relative].sha256) {throw 'Extracted runtime differs.'}
  }
  if([IO.File]::ReadAllText($xmlPath) -cne $xml -or (Get-FileHash $envFile).Hash -cne $envHash) {throw 'Concurrent configuration change.'}
  $deps=@((Get-Service PickChickEdge).DependentServices | ForEach-Object {$_.Name})
  if($deps.Count -ne 1 -or $deps[0] -ne 'PickChickKitchenLink') {throw 'Unreviewed service dependency.'}
  if([IO.File]::ReadAllText($workerXmlPath) -cne $workerXml -or (Get-FileHash $workerEnv).Hash -cne $workerEnvHash -or (Get-FileHash $workerIdentity).Hash -cne $identityHash) {throw 'Transport configuration changed.'}
  Stop-Service PickChickFulfillmentWorker;(Get-Service PickChickFulfillmentWorker).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(35))
  Stop-Service PickChickKitchenLink;(Get-Service PickChickKitchenLink).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(35))
  Stop-Service PickChickEdge;(Get-Service PickChickEdge).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(35))
  try {
    if(@(Get-NetTCPConnection -LocalPort 3101 -State Listen -ErrorAction SilentlyContinue).Count) {throw 'Old listener still active.'}
    if((Get-FileHash $ownerEnv).Hash -cne $ownerHash) {throw 'Owner environment changed.'}
    $helper=Join-Path $stateRoot 'kiosk-prepaid-upgrade-db.mjs'
    Copy-Item -LiteralPath $DatabaseHelper -Destination $helper;Assert-UpdateAcl $helper
    if((Get-FileHash $helper).Hash.ToLowerInvariant() -cne $DatabaseHelperSha256) {throw 'Copied helper differs.'}
    $dbArgs=@(('--env-file='+$ownerEnv),$helper,'inspect',$toolsRoot,$newApp,$BranchId.ToString())
    $before=Invoke-UpdateProcess $node $dbArgs 'inspect-kiosk'
    Write-UpdateText (Join-Path $stateRoot 'database-before.json') $before
    # A lost COMMIT response is uncertain: preserve stopped services for forward recovery.
    $script:migrationAttempted=$true
    $dbArgs[2]='apply'
    $after=Invoke-UpdateProcess $node $dbArgs 'migrate-kiosk'
    Write-UpdateText (Join-Path $stateRoot 'database-after.json') $after
    $temp=$xmlPath+'.app-update.tmp';Write-UpdateText $temp $newXml
    [IO.File]::Replace($temp,$xmlPath,[Management.Automation.Language.NullString]::Value)
    Assert-UpdateAcl $xmlPath 'ReadAndExecute'
    $workerTemp=$workerXmlPath+'.number-update.tmp';Write-UpdateText $workerTemp $newWorkerXml
    [IO.File]::Replace($workerTemp,$workerXmlPath,[Management.Automation.Language.NullString]::Value)
    Assert-UpdateAcl $workerXmlPath 'ReadAndExecute'
    Start-Service PickChickEdge
    $deadline=[DateTime]::UtcNow.AddSeconds(30);$healthy=$false
    do {try {$r=Read-UpdateHttp '/health/ready';$healthy=$r.service -eq 'edge' -and $r.ready -eq $true} catch {$healthy=$false};if(-not $healthy) {Start-Sleep -Milliseconds 500}} while(-not $healthy -and [DateTime]::UtcNow -lt $deadline)
    if(-not $healthy) {throw 'Candidate did not become ready.'}
    $listener=@(Get-NetTCPConnection -LocalPort 3101 -State Listen)
    $child=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
    if($listener.Count -ne 1 -or $listener[0].LocalAddress -ne '127.0.0.1' -or -not $child.CommandLine.Contains($newApp+'\dist\main.js')) {throw 'Unexpected runtime process.'}
    if((Get-FileHash $envFile).Hash -cne $envHash) {throw 'Environment changed.'}
    Start-Service PickChickKitchenLink;(Get-Service PickChickKitchenLink).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
    if((Get-FileHash $workerEnv).Hash -cne $workerEnvHash -or (Get-FileHash $workerIdentity).Hash -cne $identityHash) {throw 'Transport credentials changed.'}
    Start-Service PickChickFulfillmentWorker;(Get-Service PickChickFulfillmentWorker).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
    foreach($name in $otherServices.Keys | Where-Object {$_ -ne 'PickChickKitchenLink'}) {if((Get-CimInstance Win32_Service -Filter "Name='$name'").ProcessId -ne $otherServices[$name]) {throw 'Other service restarted.'}}
    Write-UpdateText (Join-Path $stateRoot 'completed.json') (@{sourceCommit=$SourceCommit;completedAt=[DateTime]::UtcNow.ToString('o');schema=17;dataPreserved=$true;environmentChanged=$false;dependentKitchenLinkRestarted=$true;transportWorkerUpdated=$true} | ConvertTo-Json)
    Write-Output 'READY: schema017 and application updated; rows, sequences, credentials, Postgres and tunnel preserved.'
  } catch {
    if($script:migrationAttempted) {
      if((Get-Service PickChickFulfillmentWorker).Status -ne 'Stopped') {Stop-Service PickChickFulfillmentWorker}
      if((Get-Service PickChickKitchenLink).Status -ne 'Stopped') {Stop-Service PickChickKitchenLink}
      if((Get-Service PickChickEdge).Status -ne 'Stopped') {Stop-Service PickChickEdge}
      Write-UpdateText (Join-Path $stateRoot 'forward-recovery-required.txt') 'Inspect schema and candidate runtime; do not restart the previous binary without inspecting retained schema017.'
    } else {
      if([IO.File]::ReadAllText($xmlPath) -cne $xml) {throw 'Unexpected configuration; preserve for inspection.'}
      Start-Service PickChickEdge;Start-Service PickChickKitchenLink;Start-Service PickChickFulfillmentWorker
    }
    throw
  }
} finally {$zip.Dispose();$archive.Dispose()}
