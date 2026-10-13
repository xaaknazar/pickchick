#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Recover a missing Prepare receipt from current, read-only020 evidence.
This does not reconstruct the lost migration output or replay the migration.
Only a new protected receipt is written; existing services/config/data are preserved. #>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$OperatorDirectory,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$OperatorCommit,
 [Parameter(Mandatory=$true)][string]$OperatorCiProof,
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
function Import-RecoveryFunctions([string]$Path,[string]$Hash,[string[]]$Names) {
 if((Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) {throw 'Recovery dependency differs.'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
 if($errors.Count) {throw 'Dependency parse error.'}
 foreach($name in $Names) {$found=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$false));if($found.Count -ne 1) {throw 'Missing recovery dependency.'};$found[0].Extent.Text}
}
function Assert-RecoveredInspection($Result) {
 if($Result.mode -cne 'inspect' -or $Result.migrations -ne 20 -or $Result.migrationApplied -ne $false -or $Result.migrationPending -ne $false -or $Result.grantsVerified -ne $true -or $Result.loginVerified -ne $true -or $Result.roleExists -ne $true -or $Result.mailboxEmpty -ne $true -or $Result.managedTerminals -ne 0 -or $Result.existingDataPreserved -ne $true -or $Result.recoveryVerification -cne 'read-only-current-state' -or $Result.originalPreparationReceiptAvailable -ne $false) {throw 'Fresh current-state recovery proof required.'}
}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $PSVersionTable.PSEdition -cne 'Desktop' -or -not [Environment]::Is64BitProcess) {throw 'Elevated x64 Windows PowerShell5.1 required.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($def in (Import-RecoveryFunctions (Join-Path $OperatorDirectory 'install-native-foundation.ps1') '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5' @('Assert-LocalNtfsPath'))) {. ([scriptblock]::Create($def))}
foreach($def in (Import-RecoveryFunctions (Join-Path $OperatorDirectory 'update-native-service.ps1') '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Assert-UpdateAcl','Write-UpdateText','Quote-UpdateArgument','Invoke-UpdateProcess','Read-UpdateHttp'))) {. ([scriptblock]::Create($def))}
foreach($def in (Import-RecoveryFunctions (Join-Path $OperatorDirectory 'update-native-unified-menu.ps1') 'b764a8733224f951ad1543d9d1b18bf7ac269b1e034a1fbadbefbba488f903ef' @('Assert-UnifiedCi','Enter-UnifiedMaintenanceLock','Wait-UnifiedReady','Save-UnifiedEvidence','Read-UnifiedEvidence','Assert-UnifiedPreserved'))) {. ([scriptblock]::Create($def))}
$updater=Join-Path $OperatorDirectory 'update-native-device-access.ps1'
if((Get-FileHash $updater -Algorithm SHA256).Hash.ToLowerInvariant() -cne '01073736cb48731758799b3911184cb02b2929953c76a0511b7ec31bcaedd9a2') {throw 'Reviewed updater differs.'}
$helper=Join-Path $PSScriptRoot 'device-access-recovery.mjs'
if((Get-FileHash $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'b5d1c98dc78fd62732effd85c94ecc4397fdfeae70a1ab3cb2d0f67692cd6bb2') {throw 'Read-only recovery helper differs.'}
$data='C:\ProgramData\PickChick';$program='C:\Program Files\PickChick'
$script:toolsRoot=Join-Path $data 'EdgeTools\edge-0186902'
$script:stateRoot=Join-Path $data ('EdgeTools\device-access-'+$SourceCommit.Substring(0,7))
$node=Join-Path $program 'Edge\edge-0186902\node\node.exe'
$script:nodeExe=$node;$script:pgBin=Join-Path $program 'Postgres\18.6-3\bin'
$app=Join-Path $program ('Edge\edge-'+$SourceCommit.Substring(0,7)+'\app')
$oldApp=Join-Path $program 'Edge\edge-23fb39e\app'
$xml=Join-Path $program 'Edge\edge-0186902\PickChickEdge.xml'
$workerXml=Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.xml'
$deviceEnv=Join-Path $data 'DeviceAccess\service\device-access.env'
$lease=$null
try {
 $lease=Enter-UnifiedMaintenanceLock (Join-Path $data 'EdgeTools\unified-menu-maintenance.lock')
 foreach($p in @($PSScriptRoot,$PSCommandPath,$helper,$OperatorDirectory,$OperatorCiProof,$stateRoot)) {Assert-UpdateAcl $p}
 Assert-UnifiedCi (Get-Content $OperatorCiProof -Raw | ConvertFrom-Json) $OperatorCommit
 if(Test-Path (Join-Path $stateRoot 'Prepare.json')) {throw 'Preparation receipt exists; do not overwrite or replay.'}
 $p=@{Mode='Inspect';SourceCommit=$SourceCommit;RuntimeArchive=$RuntimeArchive;RuntimeSha256=$RuntimeSha256;BackupManifest=$BackupManifest;CiProof=$CiProof;BranchId=$BranchId;DeviceId=$DeviceId}
 # The exact published updater proves archive bytes, installed/staged runtime, CI,
 # backup/restore, protected paths, foundation, feature-off and saved configuration.
 $inspected=& $updater @p | Out-String | ConvertFrom-Json
 if($inspected.validated -ne $true -or $inspected.schema -ne 20) {throw 'Actual staged020 inspection required.'}
 $script:preserved=@{};$inputProof=Read-UnifiedEvidence 'inputs.json'
 foreach($prop in $inputProof.preserved.PSObject.Properties) {$preserved[$prop.Name]=$prop.Value}
 foreach($p in @($xml,$workerXml,$deviceEnv)) {Assert-UpdateAcl $p 'ReadAndExecute';$preserved[$p]=(Get-FileHash $p -Algorithm SHA256).Hash}
 if([IO.File]::ReadAllText($xml) -cne [IO.File]::ReadAllText((Join-Path $stateRoot 'original-edge.xml')) -or [IO.File]::ReadAllText($workerXml) -cne [IO.File]::ReadAllText((Join-Path $stateRoot 'original-worker.xml'))) {throw 'Only the original running bindings may be recovered.'}
 $script:neighbors=@{}
 foreach($name in @('PickChickPostgres','PickChickFulfillmentTunnel','PickChickEdge','PickChickFulfillmentWorker','PickChickMenuSyncWorker','PickChickKitchenLink')) {$svc=Get-CimInstance Win32_Service -Filter "Name='$name'";if($svc.State -cne 'Running') {throw 'Existing services must be restored first.'};$neighbors[$name]=$svc.ProcessId}
 $result=Invoke-UpdateProcess $node @($helper,$toolsRoot,$app,$BranchId.ToString(),$DeviceId.ToString(),$BackupManifest,$deviceEnv) 'read-only-device-recovery' | ConvertFrom-Json
 Assert-RecoveredInspection $result
 Wait-UnifiedReady $oldApp;Assert-UnifiedPreserved
 $record=@{format='pickchick-device-preparation-recovered-v1';sourceCommit=$SourceCommit;archiveSha256=$RuntimeSha256;branchId=$BranchId.ToString();deviceId=$DeviceId.ToString();operatorCommit=$OperatorCommit;operatorCiRun=(Get-Content $OperatorCiProof -Raw | ConvertFrom-Json).run.id;result=$result;originalPreparationReceiptAvailable=$false;databaseChanged=$false;servicesChanged=$false;completedAt=[DateTime]::UtcNow.ToString('o')}
 if($Apply) {Save-UnifiedEvidence 'Prepare.json' $record}
 @{phase='recovery-verified';receiptWritten=[bool]$Apply;record=$record} | ConvertTo-Json -Depth 12 -Compress
} finally {if($lease) {$lease.Dispose()}}
