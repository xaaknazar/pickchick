# Pure guards and temporary-file CAS only. No host service/DB access.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
foreach($relative in @('infra/windows/update-native-device-access.ps1','infra/windows/install-native-device-access.ps1','infra/kitchen-portal/update-agent.ps1')) {
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot ('../../'+$relative)),[ref]$tokens,[ref]$errors)
 if($errors.Count) {throw ($errors|Out-String)}
 foreach($f in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) {. ([scriptblock]::Create($f.Extent.Text))}
}
$count=0
function Check($x,$m){if(-not $x){throw $m};$script:count++}
function Rejects([scriptblock]$x,$m){$caught=$false;try{& $x|Out-Null}catch{$caught=$true};Check $caught $m}
function Clone($x){$x|ConvertTo-Json -Depth 15|ConvertFrom-Json}
$sha='a'*40;$archive='b'*64;$branch='11111111-1111-4111-8111-111111111111';$device='22222222-2222-4222-8222-222222222222'
$files=@{};$installed=@{}
foreach($f in Get-ChildItem (Join-Path $PSScriptRoot '../../db/edge/migrations') -Filter '*.sql'|Sort-Object Name){$key='db/edge/migrations/'+$f.Name;$hash=(Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant();$files[$key]=@{sha256=$hash};if($f.Name -lt '020'){$installed[$key]=$hash}}
Check (@(Assert-DeviceMigrationSet $files $installed).Count -eq 20) 'Exact020 accepted'
$bad=$files.Clone();$bad['db/edge/migrations/020_terminal_access.sql']=@{sha256='0'*64};Rejects {Assert-DeviceMigrationSet $bad $installed} 'Changed020 rejected'
$bad=$files.Clone();$bad['db/edge/migrations/021_future.sql']=@{sha256='0'*64};Rejects {Assert-DeviceMigrationSet $bad $installed} 'Future schema rejected'
$prior=$installed.Clone();$prior[@($prior.Keys)[0]]='0'*64;Rejects {Assert-DeviceMigrationSet $files $prior} 'Changed old migration rejected'
$stage=@{sourceCommit=$sha;archiveSha256=$archive;branchId=$branch;deviceId=$device;runtimeManifestSha256='c'*64;ciRun=42}
Assert-DeviceStage (Clone $stage) $sha $branch $device ('c'*64) 42;Check $true 'Immutable stage provenance'
foreach($field in @('sourceCommit','branchId','deviceId','runtimeManifestSha256','ciRun','archiveSha256')) {$bad=Clone $stage;$bad.$field=$false;Rejects {Assert-DeviceStage $bad $sha $branch $device ('c'*64) 42} ('Stage binding '+$field)}
$proof=@{sourceCommit=$sha;archiveSha256=$archive;branchId=$branch;deviceId=$device;result=@{migrations=20;grantsVerified=$true;loginVerified=$true;existingDataPreserved=$true}}
Assert-DevicePrepared (Clone $proof) $sha $archive $branch $device;Check $true 'Prepared accepted'
foreach($field in @('migrations','grantsVerified','loginVerified','existingDataPreserved')){$p=Clone $proof;$p.result.$field=$false;Rejects {Assert-DevicePrepared $p $sha $archive $branch $device} ('Missing actual proof '+$field)}
Rejects {Assert-DevicePrepared (Clone $proof) $sha $archive $device $branch} 'Wrong binding'
foreach($text in @("A=x`n","A=x`r`nEDGE_DEVICE_ACCESS_ENABLED=false`n")){Assert-DeviceFeatureOff $text;Assert-DeviceEdgeFlag $text $false;Check $true 'Off preserves historical env'}
foreach($text in @("EDGE_DEVICE_ACCESS_ENABLED=true`n","EDGE_DEVICE_ACCESS_ENABLED=false`nEDGE_DEVICE_ACCESS_ENABLED=false`n","export EDGE_DEVICE_ACCESS_ENABLED=false`n","edge_device_access_enabled=false`n","EDGE_DEVICE_ACCESS_ENABLED =false`n")){Rejects {Assert-DeviceFeatureOff $text} 'Ambiguous flag rejected';Rejects {Assert-DeviceEdgeFlag $text $false} 'Installer ambiguous flag rejected'}
Assert-DeviceEdgeFlag "A=x`r`nEDGE_DEVICE_ACCESS_ENABLED=true`n" $true;Check $true 'Enabled exact flag'
Rejects {Assert-DeviceEdgeFlag "A=x`n" $true} 'Missing enabled flag'
foreach($state in @('old','new')){Assert-DeviceBinding Rollback $state old new;Check $true 'Partial binding rollback'}
Rejects {Assert-DeviceBinding Rollback foreign old new} 'Foreign rollback rejected'
Rejects {Assert-DeviceBinding Switch new old new} 'No replay switch'
$cloud=@{format='pickchick-device-access-cloud-enabled-v1';source_sha=$sha;branch_id=$branch;edge_device_id=$device;device_access_enabled=$true;completed_epoch=1000}
Assert-DeviceCloudProof (Clone $cloud) $sha $branch $device 1001;Check $true 'Real cloud shape'
foreach($field in @('format','source_sha','branch_id','edge_device_id','device_access_enabled','completed_epoch')){$c=Clone $cloud;if($field -eq 'completed_epoch'){$c.$field=50000}else{$c.$field=$false};Rejects {Assert-DeviceCloudProof $c $sha $branch $device 1001} ('Cloud fence '+$field)}
Rejects {Assert-DeviceCloudProof (Clone $cloud) $sha $branch $device 25000} 'Old cloud proof'
# Use real temp files to exercise the actual CAS and partial/full rollback path.
function Assert-UpdateAcl {param($Path,$Rights)}
function Set-ProtectedAcl {param($Path,[switch]$ServiceRead)}
function Assert-LocalNtfsPath {param($Path)}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('device-cas-'+[guid]::NewGuid().ToString('N'))
$root=Join-Path $temp 'live';$state=Join-Path $temp 'state';$backup=Join-Path $state 'before'
$null=[IO.Directory]::CreateDirectory($root);$null=[IO.Directory]::CreateDirectory($backup)
try {
 [IO.File]::WriteAllText((Join-Path $root 'a.mjs'),'original',[Text.UTF8Encoding]::new($false));[IO.File]::Copy((Join-Path $root 'a.mjs'),(Join-Path $backup 'a.mjs'))
 $before=Clone (Get-LinkTree $root)
 $candidate=@{'a.mjs'=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes('next'))).Replace('-','').ToLowerInvariant());'b.mjs'=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes('added'))).Replace('-','').ToLowerInvariant())}|ConvertTo-Json|ConvertFrom-Json
 Write-LinkBytes (Join-Path $root 'a.mjs') ([Text.Encoding]::UTF8.GetBytes('next')) $before.'a.mjs'
 Rejects {Write-LinkBytes (Join-Path $root 'a.mjs') ([Text.Encoding]::UTF8.GetBytes('bad')) $before.'a.mjs'} 'Stale CAS refuses overwrite'
 Write-LinkBytes (Join-Path $root 'b.mjs') ([Text.Encoding]::UTF8.GetBytes('added')) ''
 Restore-LinkFiles $root $state $before $candidate @('a.mjs','b.mjs');Assert-LinkSame (Get-LinkTree $root) $before;Check $true 'Actual rollback restores original and retains newly added file privately'
 Check (@(Get-ChildItem $state -Filter 'retained-*').Count -eq 1) 'Added bytes retained'
 $envPath=Join-Path $temp 'test.env';$old=[Text.Encoding]::UTF8.GetBytes("A=unchanged`r`nFLAG=false`n");$next=[Text.Encoding]::UTF8.GetBytes("A=unchanged`r`nFLAG=true`n")
 [IO.File]::WriteAllBytes($envPath,$old);Write-DeviceCas $envPath $old $next
 Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($envPath)) -ceq [Convert]::ToBase64String($next)) 'Activation CAS preserves mixed delimiters'
 Rejects {Write-DeviceCas $envPath $old $next} 'Activation stale CAS rejected'
 Write-DeviceCas $envPath $next $old
 Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($envPath)) -ceq [Convert]::ToBase64String($old)) 'Activation exact rollback bytes'
 [IO.File]::WriteAllText((Join-Path $root 'a.mjs'),'foreign')
 Rejects {Restore-LinkFiles $root $state $before $candidate @('a.mjs','b.mjs')} 'Foreign bytes never overwritten'
 Check ([IO.File]::ReadAllText((Join-Path $root 'a.mjs')) -ceq 'foreign') 'Foreign file preserved'
} finally {Remove-Item $temp -Recurse -Force}
Write-Output "$count device guard checks passed"
