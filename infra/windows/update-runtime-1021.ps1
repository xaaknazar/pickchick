#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Exact installed020 -> reviewed023 and four native runtimes. Default is inspection.
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
 $out=& $script:node ('--env-file='+$script:ownerEnv) (Join-Path $PSScriptRoot 'runtime-schema-1021.mjs') $Mode $script:toolsRoot $script:newApp $BranchId.ToString()
 if($LASTEXITCODE -ne 0){throw 'Atomic runtime migration stopped.'};return ($out|ConvertFrom-Json)
}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop'){throw 'Elevated x64 Windows PowerShell 5.1 required.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($d in (Import-RuntimeFunctions (Join-Path $PSScriptRoot 'install-native-foundation.ps1') '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5' @('Assert-LocalNtfsPath','Open-VerifiedFile','Assert-ArchiveName','Get-ArchivePlan','New-ProtectedDirectory','Assert-ProtectedDirectory'))){. ([scriptblock]::Create($d))}
foreach($d in (Import-RuntimeFunctions (Join-Path $PSScriptRoot 'update-native-service.ps1') '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Assert-UpdateAcl','Write-UpdateText','Read-UpdateHttp'))){. ([scriptblock]::Create($d))}
foreach($d in (Import-RuntimeFunctions (Join-Path $PSScriptRoot 'update-native-unified-menu.ps1') 'b764a8733224f951ad1543d9d1b18bf7ac269b1e034a1fbadbefbba488f903ef' @('Assert-UnifiedCi','Assert-UnifiedBackup','Enter-UnifiedMaintenanceLock','Replace-UnifiedXml','Restore-UnifiedBindings','Get-UnifiedEntryHash','Wait-UnifiedReady'))){. ([scriptblock]::Create($d))}
$program='C:\Program Files\PickChick';$data='C:\ProgramData\PickChick'
$script:node=Join-Path $program 'Edge\edge-0186902\node\node.exe'
$script:toolsRoot=Join-Path $data 'EdgeTools\edge-0186902';$script:ownerEnv=Join-Path $toolsRoot 'private\edge-owner.env'
$script:oldEdge=Join-Path $program 'Edge\edge-5b6f846\app';$oldWorker=Join-Path $program 'Edge\edge-23fb39e\app'
$newRoot=Join-Path $program ('Edge\edge-'+$SourceCommit.Substring(0,7));$script:newApp=Join-Path $newRoot 'app'
$stateRoot=Join-Path $data ('EdgeTools\runtime-1021-'+$SourceCommit.Substring(0,7))
if((Test-Path $newRoot) -or (Test-Path $stateRoot)){throw 'Existing attempt retained; inspect outcome, no replay.'}
foreach($p in @($CiProof,$BackupManifest,$script:ownerEnv)){Assert-UpdateAcl $p}
$ci=Get-Content $CiProof -Raw|ConvertFrom-Json;Assert-UnifiedCi $ci $SourceCommit
$foundation=Get-Content (Join-Path $toolsRoot 'private\foundation-state.json') -Raw|ConvertFrom-Json
if(!$foundation.complete -or $foundation.branchId -cne $BranchId.ToString() -or $foundation.computerName -ine $env:COMPUTERNAME){throw 'Foreign foundation.'}
$specs=@(
 @('PickChickEdge','Edge\edge-0186902\PickChickEdge.xml',$oldEdge,'44f7d3cfb05d9a5eafa0bfd2504403cf898488d7864aa62ffd9fb1407af5d557'),
 @('PickChickFulfillmentWorker','FulfillmentWorker\PickChickFulfillmentWorker.xml',$oldWorker,'f09141e5c129c5b5a1eebeac10907de1254583b21557f22251bfbfcf1724d264'),
 @('PickChickMenuSyncWorker','MenuSyncWorker\PickChickMenuSyncWorker.xml',$oldWorker,'8e45a6e48e81e2c0689d74a3861ffe2db99a8e878e66b266d3d51deb52acc0e7'),
 @('PickChickDeviceAccessWorker','DeviceAccess\PickChickDeviceAccessWorker.xml',$oldEdge,'62783e7346e1f37ed6a374622397ce05bcdee55f9e853ee0938e5d4287198226')
)
$bindings=@();$script:preserved=@{};$script:neighbors=@{}
foreach($spec in $specs){$path=Join-Path $program $spec[1];Assert-UpdateAcl $path 'ReadAndExecute';$text=[IO.File]::ReadAllText($path);$next=New-RuntimeBinding $text $spec[3] $spec[0] $spec[2] $newApp;$bindings+=,@($path,$text,$next)
 $s=Get-CimInstance Win32_Service -Filter "Name='$($spec[0])'";if($s.State -cne 'Running' -or $s.StartName -ine 'NT AUTHORITY\LocalService' -or $s.PathName.Trim('"') -cne [IO.Path]::ChangeExtension($path,'.exe')){throw 'Service binding changed.'}
 foreach($m in [regex]::Matches(([xml]$text).service.arguments,'[A-Za-z]:\\[^"<>\r\n]+\.(?:env|json)')){$p=$m.Value;if(-not(Test-Path $p)){throw 'Bound configuration absent.'};$preserved[$p]=(Get-FileHash $p -Algorithm SHA256).Hash}
}
$preserved[$ownerEnv]=(Get-FileHash $ownerEnv -Algorithm SHA256).Hash
foreach($s in Get-CimInstance Win32_Service -Filter "Name LIKE 'PickChick%'"|Where-Object {$_.State -ceq 'Running' -and $_.Name -notin @('PickChickEdge','PickChickFulfillmentWorker','PickChickMenuSyncWorker','PickChickDeviceAccessWorker','PickChickKitchenLink')}){$neighbors[$s.Name]=$s.ProcessId}
foreach($name in @('PickChickPostgres','PickChickFulfillmentTunnel')){if(-not $neighbors.ContainsKey($name)){throw 'Required stable infrastructure missing.'}}
$installed=@{};foreach($pair in @(@($oldEdge,'5b6f846b80785f915e9f8dd7d45fa72fd4bc13ee'),@($oldWorker,'23fb39e152fccaa97a32e9bf179c2d89a50dc1d5'))){$m=Get-Content (Join-Path $pair[0] 'runtime-manifest.json') -Raw|ConvertFrom-Json;if($m.sourceCommit -cne $pair[1]){throw 'Installed runtime source differs.'};foreach($f in $m.files){$null=Assert-ArchiveName $f.path;if((Get-FileHash (Join-Path $pair[0] $f.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'Installed runtime drift.'};if($pair[0] -ceq $oldEdge){$installed[$f.path]=$f.sha256}}}
Add-Type -AssemblyName System.IO.Compression
$lease=$null;$archive=Open-VerifiedFile $RuntimeArchive $RuntimeSha256;$zip=[IO.Compression.ZipArchive]::new($archive,[IO.Compression.ZipArchiveMode]::Read,$true)
try{
 $plan=Get-ArchivePlan $zip 'runtime' $newApp;$entry=$zip.GetEntry('runtime-manifest.json');if(!$entry -or $entry.Length -gt 8MB){throw 'Missing manifest.'}
 $reader=[IO.StreamReader]::new($entry.Open());try{$manifest=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
 if($manifest.sourceCommit -cne $SourceCommit -or $manifest.format -cne 'pickchick-edge-runtime-v1' -or $manifest.target -cne 'windows-x64' -or $manifest.symlinks -ne 0 -or $manifest.nativeAddons -ne 0){throw 'Candidate provenance differs.'}
 $files=@{};foreach($f in $manifest.files){if($files.ContainsKey($f.path)){throw 'Duplicate file.'};$files[$f.path]=$f};if($files.Count+1 -ne $plan.Count){throw 'Manifest file set differs.'}
 foreach($item in $plan){if($item.Relative -ceq 'runtime-manifest.json'){continue};if(!$files.ContainsKey($item.Relative) -or $files[$item.Relative].bytes -ne $item.Entry.Length -or (Get-UnifiedEntryHash $item.Entry) -cne $files[$item.Relative].sha256){throw 'Archive bytes differ.'}}
 $names=@($files.Keys|Where-Object {$_ -like 'db/edge/migrations/*.sql'}|Sort-Object);if($names.Count -ne 23){throw 'Exact schema023 required.'};$ledger=@()
 for($i=0;$i -lt 23;$i++){$p=$names[$i];$v=$p.Substring('db/edge/migrations/'.Length);if(-not $v.StartsWith(('{0:D3}_' -f ($i+1)))){throw 'Non-contiguous migrations.'};if($i -lt 20 -and (!$installed.ContainsKey($p) -or $installed[$p] -cne $files[$p].sha256)){throw 'Historical migration changed.'};$ledger+=@{scope='edge';version=$v;checksum=$files[$p].sha256}}
 $baseline=@($ledger[0..19]);$db=Read-RuntimeLedger;Assert-RuntimeLedger $db.ledger $baseline;if(@($db.branch).Count -ne 1 -or $db.branch[0].id -cne $BranchId.ToString()){throw 'Branch changed.'}
 $backup=Get-Content $BackupManifest -Raw|ConvertFrom-Json;Assert-UnifiedBackup $backup $BranchId.ToString() $foundation.systemIdentifier 20 $baseline
 $dump=Join-Path (Split-Path $BackupManifest) 'pickchick_edge.dump';if((Get-Item $dump).Length -ne $backup.archiveBytes){throw 'Backup size differs.'};$stream=Open-VerifiedFile $dump $backup.sha256;$stream.Dispose()
 Assert-RuntimePreserved
 if(!$Apply){Write-Output 'VERIFIED: exact runtime, CI, backup and schema020; no change.';return}
 $lease=Enter-UnifiedMaintenanceLock (Join-Path $data 'EdgeTools\unified-menu-maintenance.lock');Assert-RuntimePreserved
 foreach($b in $bindings){if([IO.File]::ReadAllText($b[0]) -cne $b[1]){throw 'Concurrent service change.'}}
 New-ProtectedDirectory $stateRoot;Write-UpdateText (Join-Path $stateRoot 'inputs.json') (@{sourceCommit=$SourceCommit;archiveSha256=$RuntimeSha256;ciRun=$ci.run.id;backupSha256=$backup.sha256}|ConvertTo-Json)
 New-ProtectedDirectory $newRoot 'ReadAndExecute';New-ProtectedDirectory $newApp 'ReadAndExecute'
 foreach($item in $plan){$null=Assert-LocalNtfsPath $item.Target;$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target));$input=$item.Entry.Open();try{$output=[IO.File]::Open($item.Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$input.CopyTo($output);$output.Flush($true)}finally{$output.Dispose()}}finally{$input.Dispose()};Assert-UpdateAcl $item.Target 'ReadAndExecute';if($item.Relative -cne 'runtime-manifest.json' -and (Get-FileHash $item.Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $files[$item.Relative].sha256){throw 'Extracted bytes differ.'}}
 for($i=0;$i -lt $bindings.Count;$i++){Write-UpdateText (Join-Path $stateRoot ('original-'+$i+'.xml')) $bindings[$i][1]}
 Invoke-RuntimeQuiesced {
  Assert-RuntimePreserved;$before=Invoke-RuntimeSchema 'inspect';$after=Invoke-RuntimeSchema 'apply'
  Write-UpdateText (Join-Path $stateRoot 'migration.json') ($after|ConvertTo-Json -Depth 8)
  if($after.migrations -ne 23 -or $after.fingerprint -cne $before.fingerprint -or !$after.dataPreserved -or !$after.existingPrivilegesPreserved){throw 'Migration proof failed.'}
  try{foreach($b in $bindings){Replace-UnifiedXml $b[0] $b[1] $b[2]}}catch{Restore-UnifiedBindings $bindings;throw}
 } -BeforeResume {foreach($b in $bindings){$actual=[IO.File]::ReadAllText($b[0]);if($actual -cne $b[1] -and $actual -cne $b[2]){throw 'Foreign binding retained; services left stopped for inspection.'}}}
 # New processes may now write valid new-format data. Never restart old readers automatically.
 Wait-UnifiedReady $newApp;Start-Sleep -Seconds 10
 foreach($spec in $specs){$s=Get-CimInstance Win32_Service -Filter "Name='$($spec[0])'";$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($s.ProcessId)"|Where-Object {$_.Name -ieq 'node.exe' -and $_.CommandLine.Contains($newApp)});if($s.State -cne 'Running' -or $children.Count -ne 1){throw 'Candidate service process verification failed.'}}
 Assert-RuntimePreserved;Assert-RuntimeLedger (Read-RuntimeLedger).ledger $ledger
 Write-UpdateText (Join-Path $stateRoot 'completed.json') (@{sourceCommit=$SourceCommit;schema=23;completedAt=[DateTime]::UtcNow.ToString('o');environmentChanged=$false;databasePreserved=$true}|ConvertTo-Json)
 Write-Output 'READY: schema023 and four native runtimes verified; credentials and optional flags unchanged.'
}finally{$zip.Dispose();$archive.Dispose();if($lease){$lease.Dispose()}}
