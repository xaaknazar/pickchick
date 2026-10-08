#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Guarded continuation from the installed 6ac409f/schema017 cashier.
Inspect is read-only. Stage extracts an immutable, exact-CI runtime without changing services.
PrepareMenu and PrepareStops run the existing reviewed database phases, with a fresh backup
at 017 and 018 respectively. Switch requires a NEW schema019 backup and the saved proofs.
All mutations require -Apply. Flags, passwords, identities and POS installation are separate.
Failures restart the services that were running; a failed binary switch restores only XML.
Schema018/019 and business data are NEVER rolled back or removed. Partial state is retained.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Inspect','Stage','PrepareMenu','PrepareStops','Switch','Verify','Rollback')][string]$Mode,
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

function Import-UnifiedFunctions([string]$File,[string]$Hash,[string[]]$Names) {
  if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) {throw 'Reviewed maintenance helper differs.'}
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
  if($errors.Count) {throw 'Maintenance helper parse failure.'}
  foreach($name in $Names) {
    $found=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false))
    if($found.Count -ne 1) {throw 'Reviewed function missing.'}
    $found[0].Extent.Text
  }
}
function Assert-UnifiedCi($Proof,[string]$Sha) {
  $required=@('Local kitchen UI and recovery','iPad kiosk state, bundles and browser recovery','Design screens and interaction smoke','Private staging image and restricted database role','Cloud-edge fulfillment transport and recovery','Build, contracts and PostgreSQL integration','Foundation static checks and transaction invariants','Foundation POS and backoffice integration','Foundation server account and Kaspi fixtures','Foundation simulator browser regressions','Foundation mobile bundles and checkout recovery')
  if($Proof.run.head_sha -cne $Sha -or $Proof.run.status -cne 'completed' -or $Proof.run.conclusion -cne 'success' -or $Proof.run.head_repository.full_name -cne 'xaaknazar/pickchick' -or $Proof.run.path -cne '.github/workflows/ci.yml' -or $Proof.jobs.total_count -ne $required.Count -or @($Proof.jobs.jobs).Count -ne $required.Count) {throw 'Complete canonical exact-source CI required.'}
  foreach($name in $required) {
    $job=@($Proof.jobs.jobs | Where-Object {$_.name -ceq $name})
    if($job.Count -ne 1 -or $job[0].status -cne 'completed' -or $job[0].conclusion -cne 'success' -or $job[0].head_sha -cne $Sha) {throw 'CI job missing, duplicated, stale or not successful.'}
  }
}
function Assert-UnifiedBackup($Record,[string]$Branch,[string]$SystemId,[int]$Schema,$ExpectedLedger,[DateTime]$Now=[DateTime]::UtcNow) {
  if($Record.format -cne 'pickchick-native-service-backup-v1' -or $Record.branchId -cne $Branch -or $Record.systemIdentifier -cne $SystemId -or $Record.sourceDatabase -cne 'pickchick_edge' -or $Record.backupVerified -ne $true -or $Record.restoreVerified -ne $true -or $Record.rehearsalDropped -ne $true -or $Record.completed -ne $true -or $Record.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $Record.archiveBytes -lt 1 -or [int]$Record.tableCounts.schema_migrations -ne $Schema -or @($Record.ledger).Count -ne $Schema) {throw 'Matching completed backup/restore and exact ledger required.'}
  $finished=if($Record.finishedAt -is [DateTime]) {$Record.finishedAt.ToUniversalTime()} else {[DateTimeOffset]::Parse($Record.finishedAt,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime}
  if($finished -gt $Now -or ($Now-$finished).TotalHours -gt 6) {throw 'Backup must be from the last six hours.'}
  for($i=0;$i -lt $Schema;$i++) {
    $row=$Record.ledger[$i];$expected=$ExpectedLedger[$i]
    if($row.scope -cne 'edge' -or $row.version -cne $expected.version -or $row.checksum -cne $expected.checksum) {throw 'Backup migration checksum differs.'}
  }
}
function Assert-UnifiedMigrationSet($Files,$Installed) {
  $names=@($Files.Keys | Where-Object {$_ -like 'db/edge/migrations/*.sql'} | Sort-Object)
  if($names.Count -ne 19 -or $Installed.Count -ne 17) {throw 'Exactly schema017 baseline and schema019 candidate required.'}
  $ledger=@();for($i=0;$i -lt 19;$i++) {
    $name=$names[$i];$version=$name.Substring('db/edge/migrations/'.Length)
    if(-not $version.StartsWith(('{0:D3}_' -f ($i+1)),[StringComparison]::Ordinal)) {throw 'Non-contiguous migration files.'}
    if($i -lt 17 -and (-not $Installed.ContainsKey($name) -or $Installed[$name] -cne $Files[$name].sha256)) {throw 'Installed migration changed.'}
    $ledger+= @{scope='edge';version=$version;checksum=$Files[$name].sha256}
  }
  foreach($pair in @(@('db/edge/migrations/018_edge_menu_publication.sql','28939e72f3a8d7f691b305aa6452af280e7d2dc0f110734e20c8034138d97740'),@('db/edge/migrations/019_edge_remote_stops.sql','3aa628b93a642f62f50b551510a1c39c14ff278e9c47f7ba288c93ddc409f98d'))) {if(-not $Files.ContainsKey($pair[0]) -or $Files[$pair[0]].sha256 -cne $pair[1]) {throw 'Unreviewed migration018/019 bytes.'}}
  return $ledger
}
function New-UnifiedWorkerXml([string]$Text,[string]$Node,[string]$EnvFile,[string]$Identity,[string]$OldApp,[string]$NewApp,[string]$Branch,[string]$Device) {
  $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$settings.MaxCharactersInDocument=20000
  $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($Text),$settings)
  $doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null
  try {$doc.Load($reader)} finally {$reader.Dispose()}
  $arguments='--env-file="'+$EnvFile+'" "'+$OldApp+'\infra\windows\native-fulfillment-worker.mjs" "'+$Identity+'" '+$Branch+' '+$Device
  foreach($key in @('id','executable','workingdirectory','arguments','serviceaccount')) {if(@($doc.service.SelectNodes($key)).Count -ne 1) {throw 'Ambiguous fulfillment XML.'}}
  if($doc.service.id -cne 'PickChickFulfillmentWorker' -or $doc.service.executable -cne $Node -or $doc.service.workingdirectory -cne $OldApp -or $doc.service.arguments -cne $arguments -or $doc.service.serviceaccount.user -cne 'LocalService' -or $doc.service.serviceaccount.domain -cne 'NT AUTHORITY') {throw 'Fulfillment runtime or identity binding differs.'}
  $doc.SelectSingleNode('/service/workingdirectory').InnerText=$NewApp
  $doc.SelectSingleNode('/service/arguments').InnerText=$arguments.Replace($OldApp,$NewApp)
  return $doc.OuterXml
}
function Assert-UnifiedPhaseProof($Menu,$Stops,[string]$Sha,[string]$ArchiveHash,[string]$Branch,[string]$Device) {
  foreach($record in @($Menu,$Stops)) {
    if($record.sourceCommit -cne $Sha -or $record.archiveSha256 -cne $ArchiveHash -or $record.branchId -cne $Branch -or $record.deviceId -cne $Device) {throw 'Foreign database phase evidence.'}
  }
  if($Menu.result.phase -cne 'prepared' -or $Menu.result.migrations -ne 18 -or $Stops.menuInspect.migrations -ne 18 -or $Stops.menuInspect.grantsVerified -ne $true -or $Stops.result.migrations -ne 19 -or $Stops.result.grantsVerified -ne $true -or $Stops.result.existingDataPreserved -ne $true -or $Stops.result.fingerprint -cne $Stops.before.fingerprint) {throw 'Database phases did not prove schema018/019 and preserved data/grants.'}
}
function Invoke-UnifiedQuiesced([scriptblock]$Action,[string[]]$ResumeServices=@()) {
  # Record every originally running service BEFORE any stop. Finally attempts every restart,
  # including a service whose Stop-Service failed after stopping its process.
  $stopOrder=@('PickChickFulfillmentWorker','PickChickMenuSyncWorker','PickChickPosSync','PickChickKitchenLink','PickChickEdge')
  if(@($ResumeServices | Where-Object {$_ -notin $stopOrder}).Count) {throw 'Unreviewed recovery service.'}
  $running=@();foreach($name in $stopOrder) {
    $service=Get-Service $name -ErrorAction SilentlyContinue
    if($service -and $service.Status -notin @('Running','Stopped')) {throw 'Service is already transitioning.'}
    if($service -and $service.Status -eq 'Running') {$running+= $name}
  }
  $unexpected=@((Get-Service PickChickEdge).DependentServices | Where-Object {$_.Name -notin $stopOrder -and $_.Status -ne 'Stopped'})
  if($unexpected.Count) {throw 'Unreviewed Edge service dependent.'}
  try {
    foreach($name in $running) {Stop-Service $name;(Get-Service $name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(35))}
    & $Action
  } finally {
    $failures=@();$restart=@($stopOrder | Where-Object {$_ -in $running -or $_ -in $ResumeServices});[array]::Reverse($restart)
    foreach($name in $restart) {
      try {if((Get-Service $name).Status -ne 'Running') {Start-Service $name};(Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(35))}
      catch {$failures+= $name}
    }
    if($failures.Count) {throw ('Service recovery needs inspection: '+($failures -join ', '))}
  }
}
function Replace-UnifiedXml([string]$Path,[string]$Expected,[string]$Next) {
  if([IO.File]::ReadAllText($Path) -cne $Expected) {throw 'Concurrent service XML change; not overwritten.'}
  $temp=$Path+'.unified-'+[guid]::NewGuid().ToString('N')+'.tmp'
  Write-UpdateText $temp $Next
  [IO.File]::Replace($temp,$Path,[Management.Automation.Language.NullString]::Value)
  Assert-UpdateAcl $Path 'ReadAndExecute'
}
function Restore-UnifiedBindings($Bindings) {
  # Validate every current state before writing either file. A third-party change is
  # retained for inspection, never silently replaced by our historical snapshot.
  foreach($pair in $Bindings) {
    $current=[IO.File]::ReadAllText($pair[0])
    if($current -cne $pair[1] -and $current -cne $pair[2]) {throw 'Unrecognized XML during rollback; retained for inspection.'}
  }
  foreach($pair in $Bindings) {if([IO.File]::ReadAllText($pair[0]) -ceq $pair[2]) {Replace-UnifiedXml $pair[0] $pair[2] $pair[1]}}
}
function Assert-UnifiedModeBindings([string]$Mode,[string]$Edge,[string]$Worker,[string]$OldEdge,[string]$NewEdge,[string]$OldWorker,[string]$NewWorker) {
  if($Mode -ceq 'Rollback') {
    # A killed switch can leave either exact original/candidate combination. Both
    # original files are also a valid retry after a rollback whose result was lost.
    if(($Edge -cne $OldEdge -and $Edge -cne $NewEdge) -or ($Worker -cne $OldWorker -and $Worker -cne $NewWorker)) {throw 'Unrecognized XML during rollback; retained for inspection.'}
  } elseif($Mode -cne 'Switch' -or $Edge -cne $OldEdge -or $Worker -cne $OldWorker) {throw 'Switch baseline changed; inspect actual service bindings.'}
}
function Enter-UnifiedMaintenanceLock([string]$Path) {
  Assert-UpdateAcl ([IO.Path]::GetDirectoryName($Path)) '' -Protected
  if(Test-Path -LiteralPath $Path) {Assert-UpdateAcl $Path}
  # One lease across source revisions and phases. The empty file remains private;
  # Windows releases the exclusive handle even if this operator process dies.
  return [IO.File]::Open($Path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}
function Wait-UnifiedReady([string]$App) {
  $deadline=[DateTime]::UtcNow.AddSeconds(40);$healthy=$false
  do {try {$r=Read-UpdateHttp '/health/ready';$healthy=$r.service -ceq 'edge' -and $r.ready -eq $true} catch {$healthy=$false};if(-not $healthy) {Start-Sleep -Milliseconds 500}} while(-not $healthy -and [DateTime]::UtcNow -lt $deadline)
  if(-not $healthy) {throw 'Edge readiness did not recover.'}
  $listeners=@(Get-NetTCPConnection -LocalPort 3101 -State Listen)
  if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -cne '127.0.0.1') {throw 'Unexpected Edge listener.'}
  $child=Get-CimInstance Win32_Process -Filter "ProcessId=$($listeners[0].OwningProcess)"
  if(-not $child.CommandLine.Contains('"'+$App+'\dist\main.js"')) {throw 'Edge process is not the expected immutable runtime.'}
}
function Save-UnifiedEvidence([string]$Name,$Record) {
  $path=Join-Path $script:stateRoot $Name
  Write-UpdateText $path ($Record | ConvertTo-Json -Depth 12)
  Assert-UpdateAcl $path
}
function Assert-UnifiedPreserved {
  foreach($path in $script:preserved.Keys) {if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $script:preserved[$path]) {throw 'A credential or environment changed.'}}
  foreach($name in $script:neighbors.Keys) {if((Get-CimInstance Win32_Service -Filter "Name='$name'").ProcessId -ne $script:neighbors[$name]) {throw 'Postgres or tunnel restarted unexpectedly.'}}
}
function Get-UnifiedEntryHash($Entry) {
  $input=$Entry.Open();$hasher=[Security.Cryptography.SHA256]::Create()
  try {return [BitConverter]::ToString($hasher.ComputeHash($input)).Replace('-','').ToLowerInvariant()} finally {$hasher.Dispose();$input.Dispose()}
}
function Read-UnifiedEvidence([string]$Name) {
  $path=Join-Path $script:stateRoot $Name;Assert-UpdateAcl $path
  return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop') {throw 'Use elevated x64 Windows PowerShell 5.1.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$base=Join-Path $PSScriptRoot 'install-native-foundation.ps1'
foreach($definition in (Import-UnifiedFunctions $base '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5' @('Assert-LocalNtfsPath','Open-VerifiedFile','Assert-ArchiveName','Get-ArchivePlan','New-ProtectedDirectory','Assert-ProtectedDirectory'))) {. ([scriptblock]::Create($definition))}
$upgrade=Join-Path $PSScriptRoot 'update-native-service.ps1'
foreach($definition in (Import-UnifiedFunctions $upgrade '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Assert-UpdateAcl','Write-UpdateText','Read-UpdateXml','New-UpdateServiceXml','Read-UpdateHttp','Quote-UpdateArgument','Invoke-UpdateProcess'))) {. ([scriptblock]::Create($definition))}
$menuInstaller=Join-Path $PSScriptRoot 'install-native-menu-sync.ps1'
if((Get-FileHash $menuInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'ff955a154aa4cfa8507474cef2ac37ae19b9b1d7e4fc46b8fe0f14a5a323831c') {throw 'Reviewed menu installer differs.'}
$program='C:\Program Files\PickChick';$data='C:\ProgramData\PickChick'
$foundation=Join-Path $program 'Edge\edge-0186902';$node=Join-Path $foundation 'node\node.exe'
$oldApp=Join-Path $program 'Edge\edge-6ac409f\app'
$release='edge-'+$SourceCommit.Substring(0,7);$newRoot=Join-Path $program ('Edge\'+$release);$newApp=Join-Path $newRoot 'app'
if($newApp -ceq $oldApp) {throw 'A new source is required.'}
$script:stateRoot=Join-Path $data ('EdgeTools\unified-menu-'+$SourceCommit.Substring(0,7))
$script:toolsRoot=Join-Path $data 'EdgeTools\edge-0186902';$script:nodeExe=$node;$script:pgBin=Join-Path $program 'Postgres\18.6-3\bin'
$xmlPath=Join-Path $foundation 'PickChickEdge.xml';$envFile=Join-Path $data 'Edge\config\edge.env';$logs=Join-Path $data 'Edge\logs'
$workerXmlPath=Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.xml'
$workerEnv=Join-Path $data 'FulfillmentWorker\worker.env';$identityPath=Join-Path $data 'FulfillmentWorker\device-identity.json'
$ownerEnv=Join-Path $toolsRoot 'private\edge-owner.env'
foreach($path in @($oldApp,$xmlPath,$envFile,$workerXmlPath,$workerEnv,$identityPath,$node)) {Assert-UpdateAcl $path 'ReadAndExecute'}
foreach($path in @($CiProof,$BackupManifest,$ownerEnv)) {Assert-UpdateAcl $path}
$ci=Get-Content $CiProof -Raw | ConvertFrom-Json;Assert-UnifiedCi $ci $SourceCommit
$foundationState=Get-Content (Join-Path $toolsRoot 'private\foundation-state.json') -Raw | ConvertFrom-Json
if($foundationState.complete -ne $true -or $foundationState.branchId -cne $BranchId.ToString() -or $foundationState.computerName -ine $env:COMPUTERNAME) {throw 'Foundation belongs to another machine or branch.'}
$oldManifest=Get-Content (Join-Path $oldApp 'runtime-manifest.json') -Raw | ConvertFrom-Json
if($oldManifest.sourceCommit -cne '6ac409f710f96e5247e8423963e2ef511a9e4d4a') {throw 'Installed source is not the reviewed 6ac409f baseline.'}
$script:preserved=@{};foreach($path in @($envFile,$workerEnv,$identityPath,$ownerEnv)) {$preserved[$path]=(Get-FileHash $path -Algorithm SHA256).Hash}
$script:neighbors=@{};foreach($name in @('PickChickPostgres','PickChickFulfillmentTunnel')) {
  $svc=Get-CimInstance Win32_Service -Filter "Name='$name'";if($svc.State -cne 'Running') {throw 'Postgres and fulfillment tunnel must be running.'};$neighbors[$name]=$svc.ProcessId
}
foreach($pair in @(@('PickChickEdge',(Join-Path $foundation 'PickChickEdge.exe')),@('PickChickFulfillmentWorker',(Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.exe')))) {
  $svc=Get-CimInstance Win32_Service -Filter "Name='$($pair[0])'"
  $allowedStates=if($Mode -eq 'Rollback') {@('Running','Stopped')} else {@('Running')}
  if($svc.State -cnotin $allowedStates -or $svc.StartName -ine 'NT AUTHORITY\LocalService' -or $svc.PathName -cne ('"'+$pair[1]+'"')) {throw 'Existing cashier service binding differs.'}
}

Add-Type -AssemblyName System.IO.Compression
$lease=$null;$archive=$null;$zip=$null
try {
  if($Apply -and $Mode -in @('Stage','PrepareMenu','PrepareStops','Switch','Rollback')) {$lease=Enter-UnifiedMaintenanceLock (Join-Path $data 'EdgeTools\unified-menu-maintenance.lock')}
  $archive=Open-VerifiedFile $RuntimeArchive $RuntimeSha256
  $zip=[IO.Compression.ZipArchive]::new($archive,[IO.Compression.ZipArchiveMode]::Read,$true)
  $plan=Get-ArchivePlan $zip 'runtime' $newApp
  $entry=$zip.GetEntry('runtime-manifest.json');if(-not $entry -or $entry.Length -gt 8MB) {throw 'Runtime manifest missing.'}
  $manifestHash=Get-UnifiedEntryHash $entry
  $reader=[IO.StreamReader]::new($entry.Open());try {$manifest=$reader.ReadToEnd() | ConvertFrom-Json} finally {$reader.Dispose()}
  if($manifest.sourceCommit -cne $SourceCommit -or $manifest.format -cne 'pickchick-edge-runtime-v1' -or $manifest.target -cne 'windows-x64' -or $manifest.symlinks -ne 0 -or $manifest.nativeAddons -ne 0) {throw 'Runtime provenance differs.'}
  $files=@{};foreach($file in $manifest.files) {if($files.ContainsKey($file.path) -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$') {throw 'Invalid file manifest.'};$files[$file.path]=$file}
  if($files.Count+1 -ne $plan.Count) {throw 'Runtime manifest file set differs.'}
  foreach($item in $plan) {
    if($item.Relative -ceq 'runtime-manifest.json') {continue}
    if(-not $files.ContainsKey($item.Relative) -or $files[$item.Relative].bytes -ne $item.Entry.Length) {throw 'Archive file differs.'}
    $actual=Get-UnifiedEntryHash $item.Entry
    if($actual -cne $files[$item.Relative].sha256) {throw 'Archive file checksum differs.'}
  }
  $installed=@{};foreach($file in Get-ChildItem (Join-Path $oldApp 'db\edge\migrations') -Filter '*.sql') {$installed['db/edge/migrations/'+$file.Name]=(Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  $ledger=@(Assert-UnifiedMigrationSet $files $installed)
  foreach($name in @('infra/windows/menu-sync-upgrade-db.mjs','infra/windows/remote-stops-upgrade-db.mjs','infra/windows/native-fulfillment-worker.mjs','infra/windows/native-menu-sync-worker.mjs')) {if(-not $files.ContainsKey($name)) {throw 'Required helper absent from immutable runtime.'}}
  $backup=Get-Content $BackupManifest -Raw | ConvertFrom-Json
  $schema=switch($Mode) {'Stage' {17};'PrepareMenu' {17};'PrepareStops' {18};'Switch' {19};'Verify' {19};'Rollback' {19};default {[int]$backup.tableCounts.schema_migrations}}
  if($schema -notin @(17,18,19)) {throw 'Only reviewed schema017/018/019 backups accepted.'}
  Assert-UnifiedBackup $backup $BranchId.ToString() $foundationState.systemIdentifier $schema $ledger
  $dump=Join-Path (Split-Path $BackupManifest) 'pickchick_edge.dump'
  if((Get-Item $dump).Length -ne $backup.archiveBytes) {throw 'Backup size differs.'}
  $stream=Open-VerifiedFile $dump $backup.sha256;$stream.Dispose()

  $oldXml=[IO.File]::ReadAllText($xmlPath);$oldWorkerXml=[IO.File]::ReadAllText($workerXmlPath)
  if($Mode -in @('Inspect','Stage') -and -not (Test-Path $stateRoot)) {
    $doc=Read-UpdateXml $oldXml $node $envFile $oldApp $logs
    $newXml=New-UpdateServiceXml $doc $envFile $newApp
    $newWorkerXml=New-UnifiedWorkerXml $oldWorkerXml $node $workerEnv $identityPath $oldApp $newApp $BranchId.ToString() $DeviceId.ToString()
    if(Test-Path $newRoot) {throw 'Partial target runtime requires inspection.'}
  } else {
    Assert-UpdateAcl $stateRoot '' -Protected
    $inputs=Read-UnifiedEvidence 'inputs.json'
    if($inputs.sourceCommit -cne $SourceCommit -or $inputs.archiveSha256 -cne $RuntimeSha256 -or $inputs.branchId -cne $BranchId.ToString() -or $inputs.deviceId -cne $DeviceId.ToString()) {throw 'Foreign staged release.'}
    foreach($path in $preserved.Keys) {if($inputs.preserved.$path -cne $preserved[$path]) {throw 'A staged environment/identity changed.'}}
    $oldXml=[IO.File]::ReadAllText((Join-Path $stateRoot 'original-edge.xml'));$newXml=[IO.File]::ReadAllText((Join-Path $stateRoot 'candidate-edge.xml'))
    $oldWorkerXml=[IO.File]::ReadAllText((Join-Path $stateRoot 'original-worker.xml'));$newWorkerXml=[IO.File]::ReadAllText((Join-Path $stateRoot 'candidate-worker.xml'))
    foreach($item in $plan) {Assert-UpdateAcl $item.Target 'ReadAndExecute';$expected=if($item.Relative -ceq 'runtime-manifest.json') {$manifestHash} else {$files[$item.Relative].sha256};if((Get-FileHash $item.Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) {throw 'Staged runtime bytes differ.'}}
  }
  if($Mode -eq 'Inspect' -or (-not $Apply -and $Mode -eq 'Stage')) {
    @{phase=$Mode;validated=$true;applied=$false;schema=$schema;sourceCommit=$SourceCommit;runtimeSha256=$RuntimeSha256} | ConvertTo-Json -Compress;return
  }
  if($Mode -eq 'Stage') {
    if(Test-Path $stateRoot) {throw 'Release already staged; use subsequent phase.'}
    New-ProtectedDirectory $stateRoot
    Save-UnifiedEvidence 'inputs.json' @{sourceCommit=$SourceCommit;archiveSha256=$RuntimeSha256;branchId=$BranchId.ToString();deviceId=$DeviceId.ToString();ciRun=$ci.run.id;preserved=$preserved}
    foreach($pair in @(@('original-edge.xml',$oldXml),@('candidate-edge.xml',$newXml),@('original-worker.xml',$oldWorkerXml),@('candidate-worker.xml',$newWorkerXml))) {Write-UpdateText (Join-Path $stateRoot $pair[0]) $pair[1]}
    New-ProtectedDirectory $newRoot 'ReadAndExecute';New-ProtectedDirectory $newApp 'ReadAndExecute'
    foreach($item in $plan) {
      $null=Assert-LocalNtfsPath $item.Target;$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target))
      $input=$item.Entry.Open();try {$output=[IO.File]::Open($item.Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try {$input.CopyTo($output);$output.Flush($true)} finally {$output.Dispose()}} finally {$input.Dispose()}
      Assert-UpdateAcl $item.Target 'ReadAndExecute'
      $expected=if($item.Relative -ceq 'runtime-manifest.json') {$manifestHash} else {$files[$item.Relative].sha256}
      if((Get-FileHash $item.Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) {throw 'Extracted runtime differs.'}
    }
    Assert-UnifiedPreserved
    Save-UnifiedEvidence 'staged.json' @{sourceCommit=$SourceCommit;databaseChanged=$false;servicesChanged=$false}
    @{phase='staged';sourceCommit=$SourceCommit;databaseChanged=$false;servicesChanged=$false} | ConvertTo-Json -Compress;return
  }
  $scope=@{sourceCommit=$SourceCommit;archiveSha256=$RuntimeSha256;branchId=$BranchId.ToString();deviceId=$DeviceId.ToString()}
  if($Mode -in @('PrepareMenu','PrepareStops')) {
    if([IO.File]::ReadAllText($xmlPath) -cne $oldXml -or [IO.File]::ReadAllText($workerXmlPath) -cne $oldWorkerXml) {throw 'Database phases require the unchanged baseline binaries.'}
    if(Test-Path (Join-Path $stateRoot ($Mode+'.json'))) {throw 'Database phase already recorded; inspect before retry.'}
    if($Mode -eq 'PrepareMenu') {
      $p=@{ReleaseName=$release;SourceCommit=$SourceCommit;BranchId=$BranchId;DeviceId=$DeviceId;BackupManifest=$BackupManifest}
      $before=(& $menuInstaller -Mode Inspect @p | Out-String | ConvertFrom-Json)
      if(-not $Apply) {@{phase=$Mode;validated=$true;applied=$false;database=$before} | ConvertTo-Json -Depth 5 -Compress;return}
      $result=Invoke-UnifiedQuiesced {& $menuInstaller -Mode Prepare @p | Out-String | ConvertFrom-Json}
      if($result.phase -cne 'prepared' -or $result.migrations -ne 18) {throw 'Menu preparation did not finish.'}
      $scope.before=$before;$scope.result=$result
    } else {
      $menuEnv=Join-Path $data 'MenuSync\service\menu-sync.env'
      $menuArgs=@((Join-Path $newApp 'infra\windows\menu-sync-upgrade-db.mjs'),'inspect',$toolsRoot,$newApp,$BranchId.ToString(),$DeviceId.ToString(),$BackupManifest,$menuEnv)
      $menuInspect=Invoke-UpdateProcess $node $menuArgs 'inspect-menu-grants' | ConvertFrom-Json
      if($menuInspect.migrations -ne 18 -or $menuInspect.grantsVerified -ne $true) {throw 'Menu grants at schema018 are not verified.'}
      $dbArgs=@((Join-Path $newApp 'infra\windows\remote-stops-upgrade-db.mjs'),'inspect',$toolsRoot,$newApp,$BranchId.ToString(),$BackupManifest)
      if(-not $Apply) {$inspection=Invoke-UpdateProcess $node $dbArgs 'inspect-stops' | ConvertFrom-Json;@{phase=$Mode;validated=$true;applied=$false;database=$inspection} | ConvertTo-Json -Depth 5 -Compress;return}
      # Both fingerprints come from the quiesced interval; a live POS write between them
      # would otherwise make an intact migration appear to have changed business data.
      $pair=Invoke-UnifiedQuiesced {
        $prior=Invoke-UpdateProcess $node $dbArgs 'inspect-stops' | ConvertFrom-Json
        $dbArgs[1]='apply';$after=Invoke-UpdateProcess $node $dbArgs 'prepare-stops' | ConvertFrom-Json
        [pscustomobject]@{before=$prior;result=$after}
      }
      if($pair.result.migrations -ne 19 -or $pair.result.grantsVerified -ne $true -or $pair.result.existingDataPreserved -ne $true -or $pair.result.fingerprint -cne $pair.before.fingerprint) {throw 'Remote stops proof differs.'}
      $scope.menuInspect=$menuInspect;$scope.before=$pair.before;$scope.result=$pair.result
    }
    Wait-UnifiedReady $oldApp;Assert-UnifiedPreserved
    Save-UnifiedEvidence ($Mode+'.json') $scope
    @{phase=$Mode;completed=$true;schema=$scope.result.migrations;servicesRestored=$true;sourceCommit=$SourceCommit} | ConvertTo-Json -Compress;return
  }
  $menuProof=Read-UnifiedEvidence 'PrepareMenu.json';$stopsProof=Read-UnifiedEvidence 'PrepareStops.json'
  Assert-UnifiedPhaseProof $menuProof $stopsProof $SourceCommit $RuntimeSha256 $BranchId.ToString() $DeviceId.ToString()
  $dbArgs=@((Join-Path $newApp 'infra\windows\remote-stops-upgrade-db.mjs'),'inspect',$toolsRoot,$newApp,$BranchId.ToString(),$BackupManifest)
  $db=Invoke-UpdateProcess $node $dbArgs 'verify-schema019' | ConvertFrom-Json
  if($db.migrations -ne 19 -or $db.grantsVerified -ne $true -or $db.migrationPending -ne $false) {throw 'Fresh schema019 grants proof required.'}
  if($Mode -eq 'Verify') {
    if([IO.File]::ReadAllText($xmlPath) -cne $newXml -or [IO.File]::ReadAllText($workerXmlPath) -cne $newWorkerXml) {throw 'Candidate service bindings differ.'}
    Wait-UnifiedReady $newApp;Assert-UnifiedPreserved
    @{phase='verified';sourceCommit=$SourceCommit;schema=19;grantsVerified=$true} | ConvertTo-Json -Compress;return
  }
  $fromEdge=$oldXml;$toEdge=$newXml;$fromWorker=$oldWorkerXml;$toWorker=$newWorkerXml;$targetApp=$newApp
  if($Mode -eq 'Rollback') {$fromEdge=$newXml;$toEdge=$oldXml;$fromWorker=$newWorkerXml;$toWorker=$oldWorkerXml;$targetApp=$oldApp}
  Assert-UnifiedModeBindings $Mode ([IO.File]::ReadAllText($xmlPath)) ([IO.File]::ReadAllText($workerXmlPath)) $oldXml $newXml $oldWorkerXml $newWorkerXml
  if(-not $Apply) {@{phase=$Mode;validated=$true;applied=$false;schema=19;grantsVerified=$true} | ConvertTo-Json -Compress;return}
  $resumeServices=@('PickChickEdge','PickChickFulfillmentWorker')
  foreach($name in @('PickChickKitchenLink','PickChickMenuSyncWorker','PickChickPosSync')) {if((Get-Service $name -ErrorAction SilentlyContinue) -and (Get-Service $name).Status -eq 'Running') {$resumeServices+= $name}}
  try {
    Invoke-UnifiedQuiesced {
      Assert-UnifiedPreserved
      if($Mode -eq 'Rollback') {Restore-UnifiedBindings @(@($xmlPath,$oldXml,$newXml),@($workerXmlPath,$oldWorkerXml,$newWorkerXml))}
      else {
        Replace-UnifiedXml $xmlPath $fromEdge $toEdge
        Replace-UnifiedXml $workerXmlPath $fromWorker $toWorker
      }
    } $resumeServices
    Wait-UnifiedReady $targetApp;Assert-UnifiedPreserved
  } catch {
    # A known failure returns both binaries to the original baseline. Only our two exact
    # XML states are accepted; unrelated changes stop recovery instead of being overwritten.
    Invoke-UnifiedQuiesced {
      Restore-UnifiedBindings @(@($xmlPath,$oldXml,$newXml),@($workerXmlPath,$oldWorkerXml,$newWorkerXml))
    } $resumeServices
    Wait-UnifiedReady $oldApp;Assert-UnifiedPreserved
    throw
  }
  Save-UnifiedEvidence ($Mode+'-'+[guid]::NewGuid().ToString('N')+'.json') @{sourceCommit=$SourceCommit;schema=19;target=$targetApp;environmentChanged=$false;databaseChanged=$false;completedAt=[DateTime]::UtcNow.ToString('o')}
  @{phase=$Mode;sourceCommit=$SourceCommit;schema=19;environmentChanged=$false;databaseChanged=$false;ready=$true} | ConvertTo-Json -Compress
} finally {if($zip) {$zip.Dispose()};if($archive) {$archive.Dispose()};if($lease) {$lease.Dispose()}}
