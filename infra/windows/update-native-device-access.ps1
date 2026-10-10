#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Exact019->020 continuation. Every mutation requires Apply and the shared lease.
Stage is immutable; Prepare never retries a committed migration. Switch changes only Edge XML.
Existing POS, fulfillment/menu worker binaries, env, identities, PostgreSQL and tunnel remain.
Feature activation and enrolled-terminal rollback are separate explicit operations. #>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('Inspect','Stage','Prepare','Switch','Verify','Rollback')][string]$Mode,
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
function Assert-DeviceMigrationSet($Files,$Installed) {
 $names=@($Files.Keys | Where-Object {$_ -like 'db/edge/migrations/*.sql'} | Sort-Object)
 if($names.Count -ne 20 -or $Installed.Count -ne 19) {throw 'Exact019 baseline and020 candidate required.'}
 $ledger=@();for($i=0;$i -lt 20;$i++) {
  $name=$names[$i];$version=$name.Substring('db/edge/migrations/'.Length)
  if(-not $version.StartsWith(('{0:D3}_' -f ($i+1)),[StringComparison]::Ordinal)) {throw 'Non-contiguous ledger.'}
  if($i -lt 19 -and (-not $Installed.ContainsKey($name) -or $Installed[$name] -cne $Files[$name].sha256)) {throw 'Historical migration differs.'}
  $ledger+=@{scope='edge';version=$version;checksum=$Files[$name].sha256}
 }
 if($ledger[19].version -cne '020_terminal_access.sql' -or $ledger[19].checksum -cne 'afeffbdd49c9dfaa5a3fea4be32b97aa99c45e6897f4ff0c220f9b89d02a24b6') {throw 'Unreviewed020 migration.'}
 return $ledger
}
function Assert-DevicePrepared($Record,[string]$Sha,[string]$Archive,[string]$Branch,[string]$Device) {
 if($Record.sourceCommit -cne $Sha -or $Record.archiveSha256 -cne $Archive -or $Record.branchId -cne $Branch -or $Record.deviceId -cne $Device -or $Record.result.migrations -ne 20 -or $Record.result.grantsVerified -ne $true -or $Record.result.loginVerified -ne $true -or $Record.result.existingDataPreserved -ne $true) {throw 'Actual020 preparation proof required.'}
}
function Assert-DeviceFeatureOff([string]$Text) {
 $matches=@([regex]::Matches($Text,'(?im)^\s*(?:export\s+)?EDGE_DEVICE_ACCESS_ENABLED\s*=[^\r\n]*\r?$'))
 if($matches.Count -gt 1 -or ($matches.Count -eq 1 -and $matches[0].Value.TrimEnd([char]13) -cne 'EDGE_DEVICE_ACCESS_ENABLED=false')) {throw 'Keep device access off during binary maintenance.'}
}
function Assert-DeviceBinding([string]$Mode,[string]$Actual,[string]$Old,[string]$New) {
 if($Mode -ceq 'Rollback') {if($Actual -cne $Old -and $Actual -cne $New) {throw 'Foreign binding during rollback.'}}
 elseif($Actual -cne $Old) {throw 'Switch baseline changed.'}
}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop') {throw 'Use elevated x64 Windows PowerShell 5.1.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$base=Join-Path $PSScriptRoot 'install-native-foundation.ps1'
foreach($definition in (Import-UnifiedFunctions $base '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5' @('Assert-LocalNtfsPath','Open-VerifiedFile','Assert-ArchiveName','Get-ArchivePlan','New-ProtectedDirectory','Assert-ProtectedDirectory'))) {. ([scriptblock]::Create($definition))}
$upgrade=Join-Path $PSScriptRoot 'update-native-service.ps1'
foreach($definition in (Import-UnifiedFunctions $upgrade '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Assert-UpdateAcl','Write-UpdateText','Read-UpdateXml','New-UpdateServiceXml','Read-UpdateHttp','Quote-UpdateArgument','Invoke-UpdateProcess'))) {. ([scriptblock]::Create($definition))}
$shared=Join-Path $PSScriptRoot 'update-native-unified-menu.ps1'
foreach($definition in (Import-UnifiedFunctions $shared 'b764a8733224f951ad1543d9d1b18bf7ac269b1e034a1fbadbefbba488f903ef' @('Assert-UnifiedCi','Assert-UnifiedBackup','Invoke-UnifiedQuiesced','Replace-UnifiedXml','Restore-UnifiedBindings','Enter-UnifiedMaintenanceLock','Wait-UnifiedReady','Save-UnifiedEvidence','Assert-UnifiedPreserved','Get-UnifiedEntryHash','Read-UnifiedEvidence'))) {. ([scriptblock]::Create($definition))}
$deviceInstaller=Join-Path $PSScriptRoot 'install-native-device-access.ps1'
$program='C:\Program Files\PickChick';$data='C:\ProgramData\PickChick'
$foundation=Join-Path $program 'Edge\edge-0186902';$node=Join-Path $foundation 'node\node.exe'
$oldApp=Join-Path $program 'Edge\edge-23fb39e\app'
$release='edge-'+$SourceCommit.Substring(0,7);$newRoot=Join-Path $program ('Edge\'+$release);$newApp=Join-Path $newRoot 'app'
if($newApp -ceq $oldApp) {throw 'A new source is required.'}
$script:stateRoot=Join-Path $data ('EdgeTools\device-access-'+$SourceCommit.Substring(0,7))
$script:toolsRoot=Join-Path $data 'EdgeTools\edge-0186902';$script:nodeExe=$node;$script:pgBin=Join-Path $program 'Postgres\18.6-3\bin'
$xmlPath=Join-Path $foundation 'PickChickEdge.xml';$envFile=Join-Path $data 'Edge\config\edge.env';$logs=Join-Path $data 'Edge\logs'
$workerXmlPath=Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.xml'
$workerEnv=Join-Path $data 'FulfillmentWorker\worker.env';$identityPath=Join-Path $data 'FulfillmentWorker\device-identity.json'
$ownerEnv=Join-Path $toolsRoot 'private\edge-owner.env'
$lease=$null;$archive=$null;$zip=$null
try {
if($Apply -and $Mode -in @('Stage','Prepare','Switch','Rollback')) {$lease=Enter-UnifiedMaintenanceLock (Join-Path $data 'EdgeTools\unified-menu-maintenance.lock')}
foreach($path in @($oldApp,$xmlPath,$envFile,$workerXmlPath,$workerEnv,$identityPath,$node)) {Assert-UpdateAcl $path 'ReadAndExecute'}
foreach($path in @($CiProof,$BackupManifest,$ownerEnv)) {Assert-UpdateAcl $path}
$ci=Get-Content $CiProof -Raw | ConvertFrom-Json;Assert-UnifiedCi $ci $SourceCommit
$foundationState=Get-Content (Join-Path $toolsRoot 'private\foundation-state.json') -Raw | ConvertFrom-Json
if($foundationState.complete -ne $true -or $foundationState.branchId -cne $BranchId.ToString() -or $foundationState.computerName -ine $env:COMPUTERNAME) {throw 'Foundation belongs to another machine or branch.'}
$oldManifest=Get-Content (Join-Path $oldApp 'runtime-manifest.json') -Raw | ConvertFrom-Json
if($oldManifest.sourceCommit -cne '23fb39e152fccaa97a32e9bf179c2d89a50dc1d5') {throw 'Installed source is not the reviewed23fb baseline.'}
Assert-DeviceFeatureOff ([IO.File]::ReadAllText($envFile))
if((Get-Service PickChickDeviceAccessWorker -ErrorAction SilentlyContinue) -and (Get-Service PickChickDeviceAccessWorker).Status -ne 'Stopped') {throw 'Mailbox worker must remain stopped during binary maintenance.'}
foreach($file in $oldManifest.files) {if($file.path -match '(^|/)\.\.?(/|$)|[:\\]' -or [IO.Path]::IsPathRooted($file.path)) {throw 'Unsafe installed manifest path.'};$p=Join-Path $oldApp $file.path;Assert-UpdateAcl $p 'ReadAndExecute';if((Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) {throw 'Installed baseline bytes differ.'}}
$script:preserved=@{};foreach($path in @($envFile,$workerEnv,$identityPath,$ownerEnv,$workerXmlPath,(Join-Path $data 'MenuSync\service\menu-sync.env'))) {$preserved[$path]=(Get-FileHash $path -Algorithm SHA256).Hash}
$script:neighbors=@{};foreach($name in @('PickChickPostgres','PickChickFulfillmentTunnel')) {
  $svc=Get-CimInstance Win32_Service -Filter "Name='$name'";if($svc.State -cne 'Running') {throw 'Postgres and fulfillment tunnel must be running.'};$neighbors[$name]=$svc.ProcessId
}
foreach($pair in @(@('PickChickEdge',(Join-Path $foundation 'PickChickEdge.exe')),@('PickChickFulfillmentWorker',(Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.exe')))) {
  $svc=Get-CimInstance Win32_Service -Filter "Name='$($pair[0])'"
  $allowedStates=if($Mode -eq 'Rollback') {@('Running','Stopped')} else {@('Running')}
  if($svc.State -cnotin $allowedStates -or $svc.StartName -ine 'NT AUTHORITY\LocalService' -or $svc.PathName -cne ('"'+$pair[1]+'"')) {throw 'Existing cashier service binding differs.'}
}

Add-Type -AssemblyName System.IO.Compression
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
  if(-not $files.ContainsKey('infra/windows/install-native-device-access.ps1') -or (Get-FileHash $deviceInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -cne $files['infra/windows/install-native-device-access.ps1'].sha256) {throw 'Installer bytes differ from verified runtime archive.'}
  $installed=@{};foreach($file in Get-ChildItem (Join-Path $oldApp 'db\edge\migrations') -Filter '*.sql') {$installed['db/edge/migrations/'+$file.Name]=(Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  $ledger=@(Assert-DeviceMigrationSet $files $installed)
  foreach($name in @('infra/windows/terminal-access-upgrade-db.mjs','infra/windows/terminal-access-grants.mjs','infra/windows/native-device-access-worker.mjs')) {if(-not $files.ContainsKey($name)) {throw 'Required helper absent from immutable runtime.'}}
  $backup=Get-Content $BackupManifest -Raw | ConvertFrom-Json
  $schema=switch($Mode) {'Stage' {19};'Prepare' {19};'Switch' {20};'Verify' {20};'Rollback' {20};default {[int]$backup.tableCounts.schema_migrations}}
  if($schema -notin @(19,20)) {throw 'Only reviewed schema019/020 backups accepted.'}
  Assert-UnifiedBackup $backup $BranchId.ToString() $foundationState.systemIdentifier $schema $ledger
  $dump=Join-Path (Split-Path $BackupManifest) 'pickchick_edge.dump'
  if((Get-Item $dump).Length -ne $backup.archiveBytes) {throw 'Backup size differs.'}
  $stream=Open-VerifiedFile $dump $backup.sha256;$stream.Dispose()

  $oldXml=[IO.File]::ReadAllText($xmlPath);$oldWorkerXml=[IO.File]::ReadAllText($workerXmlPath)
  if($Mode -in @('Inspect','Stage') -and -not (Test-Path $stateRoot)) {
    $doc=Read-UpdateXml $oldXml $node $envFile $oldApp $logs
    $newXml=New-UpdateServiceXml $doc $envFile $newApp
    $newWorkerXml=$oldWorkerXml
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
    Save-UnifiedEvidence 'inputs.json' @{sourceCommit=$SourceCommit;archiveSha256=$RuntimeSha256;runtimeManifestSha256=$manifestHash;branchId=$BranchId.ToString();deviceId=$DeviceId.ToString();ciRun=$ci.run.id;preserved=$preserved}
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
  $deviceEnv=Join-Path $data 'DeviceAccess\service\device-access.env'
  $dbArgs=@((Join-Path $newApp 'infra\windows\terminal-access-upgrade-db.mjs'),'inspect',$toolsRoot,$newApp,$BranchId.ToString(),$DeviceId.ToString(),$BackupManifest,$deviceEnv)
  if($Mode -eq 'Prepare') {
    if([IO.File]::ReadAllText($xmlPath) -cne $oldXml -or [IO.File]::ReadAllText($workerXmlPath) -cne $oldWorkerXml) {throw 'Database phase requires unchanged baseline bindings.'}
    if(Test-Path (Join-Path $stateRoot 'Prepare.json')) {throw 'Database phase already recorded; inspect without reapplying.'}
    $inspection=Invoke-UpdateProcess $node $dbArgs 'inspect-device-access' | ConvertFrom-Json
    if($inspection.migrations -ne 19 -or $inspection.migrationPending -ne $true) {throw 'Exact019 required before preparation.'}
    if(-not $Apply) {@{phase='Prepare';validated=$true;applied=$false;database=$inspection} | ConvertTo-Json -Depth 5 -Compress;return}
    $p=@{Mode='Prepare';ReleaseName=$release;SourceCommit=$SourceCommit;BranchId=$BranchId;DeviceId=$DeviceId;BackupManifest=$BackupManifest;CiProof=$CiProof;Apply=$true;MaintenanceLease=$lease}
    $result=Invoke-UnifiedQuiesced {& $deviceInstaller @p | Out-String | ConvertFrom-Json}
    if($result.migrations -ne 20 -or $result.grantsVerified -ne $true -or $result.loginVerified -ne $true -or $result.existingDataPreserved -ne $true) {throw 'Device database phase not verified.'}
    Wait-UnifiedReady $oldApp;Assert-UnifiedPreserved
    $scope.result=$result;Save-UnifiedEvidence 'Prepare.json' $scope
    @{phase='prepared';schema=20;sourceCommit=$SourceCommit;servicesRestored=$true} | ConvertTo-Json -Compress;return
  }
  $prepared=Read-UnifiedEvidence 'Prepare.json'
  Assert-DevicePrepared $prepared $SourceCommit $RuntimeSha256 $BranchId.ToString() $DeviceId.ToString()
  $db=Invoke-UpdateProcess $node $dbArgs 'verify-schema020' | ConvertFrom-Json
  if($db.migrations -ne 20 -or $db.grantsVerified -ne $true) {throw 'Fresh020 grant proof required.'}
  if($db.migrationPending) {throw 'Migration020 not completed.'}
  if($Mode -eq 'Rollback' -and $db.managedTerminals -ne 0) {throw 'Old runtime rollback forbidden after managed terminal enrollment; guarded deactivation/session revocation required first.'}
  if($Mode -eq 'Verify') {
    if([IO.File]::ReadAllText($xmlPath) -cne $newXml -or [IO.File]::ReadAllText($workerXmlPath) -cne $newWorkerXml) {throw 'Candidate service bindings differ.'}
    Wait-UnifiedReady $newApp;Assert-UnifiedPreserved
    @{phase='verified';sourceCommit=$SourceCommit;schema=20;grantsVerified=$true} | ConvertTo-Json -Compress;return
  }
  $fromEdge=$oldXml;$toEdge=$newXml;$fromWorker=$oldWorkerXml;$toWorker=$newWorkerXml;$targetApp=$newApp
  if($Mode -eq 'Rollback') {$fromEdge=$newXml;$toEdge=$oldXml;$fromWorker=$newWorkerXml;$toWorker=$oldWorkerXml;$targetApp=$oldApp}
  Assert-DeviceBinding $Mode ([IO.File]::ReadAllText($xmlPath)) $oldXml $newXml
  if([IO.File]::ReadAllText($workerXmlPath) -cne $oldWorkerXml) {throw 'Existing fulfillment worker changed.'}
  if(-not $Apply) {@{phase=$Mode;validated=$true;applied=$false;schema=20;grantsVerified=$true} | ConvertTo-Json -Compress;return}
  $resumeServices=@('PickChickEdge','PickChickFulfillmentWorker')
  foreach($name in @('PickChickKitchenLink','PickChickMenuSyncWorker','PickChickPosSync')) {if((Get-Service $name -ErrorAction SilentlyContinue) -and (Get-Service $name).Status -eq 'Running') {$resumeServices+= $name}}
  try {
    Invoke-UnifiedQuiesced {
      Assert-UnifiedPreserved
      if($Mode -eq 'Rollback') {Restore-UnifiedBindings @(@($xmlPath,$oldXml,$newXml))}
      else {
        Replace-UnifiedXml $xmlPath $fromEdge $toEdge
      }
    } $resumeServices
    Wait-UnifiedReady $targetApp;Assert-UnifiedPreserved
  } catch {
    # A known failure returns Edge to the original baseline. Only our two exact
    # XML states are accepted; unrelated changes stop recovery instead of being overwritten.
    Invoke-UnifiedQuiesced {
      Restore-UnifiedBindings @(@($xmlPath,$oldXml,$newXml))
    } $resumeServices
    Wait-UnifiedReady $oldApp;Assert-UnifiedPreserved
    throw
  }
  Save-UnifiedEvidence ($Mode+'-'+[guid]::NewGuid().ToString('N')+'.json') @{sourceCommit=$SourceCommit;schema=20;target=$targetApp;environmentChanged=$false;databaseChanged=$false;completedAt=[DateTime]::UtcNow.ToString('o')}
  @{phase=$Mode;sourceCommit=$SourceCommit;schema=20;environmentChanged=$false;databaseChanged=$false;ready=$true} | ConvertTo-Json -Compress
} finally {if($zip) {$zip.Dispose()};if($archive) {$archive.Dispose()};if($lease) {$lease.Dispose()}}
