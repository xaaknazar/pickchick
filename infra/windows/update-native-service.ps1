#Requires -Version 5.1
<# One guarded upgrade from unused edge-0186902/schema009 preview to schema014.
Keeps PostgreSQL data, credentials, Node and both SCM identities. No auto rollback. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$ReleaseName,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
    [Parameter(Mandatory=$true)][guid]$BranchId,
    [Parameter(Mandatory=$true)][string]$RuntimeArchive,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$RuntimeSha256,
    [Parameter(Mandatory=$true)][string]$BackupManifest,
    [string]$FoundationScript=(Join-Path $PSScriptRoot 'install-native-foundation.ps1'),
    [string]$DatabaseHelper=(Join-Path $PSScriptRoot 'native-service-upgrade-db.mjs'),
    [switch]$Resume,
    [switch]$VerifyOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$foundationSha='6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5'
$databaseHelperSha='8fa8a829371b34daaf8df9167bc10d1db3915477e9bb23f41a095089efc012ef'

function Assert-BackupRecord($Record,[string]$Branch,[string]$SystemId) {
    if ($Record.format -ne 'pickchick-native-backup-v1' -or $Record.branchId -ne $Branch -or $Record.systemIdentifier -ne $SystemId -or
        $Record.sourceDatabase -ne 'pickchick_edge' -or $Record.backupVerified -ne $true -or $Record.restoreVerified -ne $true -or
        $Record.rehearsalDropped -ne $true -or $Record.completed -ne $true -or $Record.sha256 -notmatch '^[a-f0-9]{64}$' -or
        $Record.archiveBytes -lt 1 -or @($Record.tableCounts.PSObject.Properties).Count -ne 30 -or
        $Record.tableCounts.local_orders -ne '0' -or $Record.tableCounts.checkout_quotes -ne '0' -or $Record.tableCounts.schema_migrations -ne '9') { throw 'Matching completed preview backup and restore proof required.' }
    foreach ($count in $Record.tableCounts.PSObject.Properties.Value) { if ("$count" -notmatch '^\d+$') { throw 'Invalid backup table count.' } }
}

function Quote-UpdateArgument([string]$Value) {
    if ($Value.Contains([char]0) -or $Value.Contains("`n") -or $Value.Contains("`r")) { throw 'Invalid process argument.' }
    $escaped=[regex]::Replace($Value,'(\\*)"','$1$1\"')
    $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
    return '"'+$escaped+'"'
}

function Read-UpdateXml([string]$Text,[string]$Node,[string]$EnvFile,[string]$App,[string]$Logs) {
    $settings=[Xml.XmlReaderSettings]::new(); $settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit; $settings.XmlResolver=$null; $settings.MaxCharactersInDocument=20000
    $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($Text),$settings)
    $doc=[Xml.XmlDocument]::new(); $doc.XmlResolver=$null
    try { $doc.Load($reader) } finally { $reader.Dispose() }
    $service=$doc.service
    $expected=@{id='PickChickEdge';name='PickChick Edge';description='Local PickChick foundation. Restaurant provisioning is separate.';executable=$Node;arguments=('--env-file="'+$EnvFile+'" "'+(Join-Path $App 'dist\main.js')+'"');workingdirectory=$App;startmode='Automatic';delayedAutoStart='true';depend='PickChickPostgres';stoptimeout='30 sec';resetfailure='1 hour';logpath=$Logs}
    foreach($key in $expected.Keys) { if (@($service.SelectNodes($key)).Count -ne 1 -or $service.SelectSingleNode($key).InnerText -cne $expected[$key]) { throw "Unexpected WinSW field: $key" } }
    if ($service.serviceaccount.domain -cne 'NT AUTHORITY' -or $service.serviceaccount.user -cne 'LocalService' -or @($service.serviceaccount.ChildNodes).Count -ne 2) { throw 'Unexpected WinSW account.' }
    if (@($service.SelectNodes('onfailure')).Count -ne 3 -or $service.onfailure[0].action -cne 'restart' -or $service.onfailure[0].delay -cne '5 sec' -or $service.onfailure[1].action -cne 'restart' -or $service.onfailure[1].delay -cne '15 sec' -or $service.onfailure[2].action -cne 'restart' -or $service.onfailure[2].delay -cne '60 sec') { throw 'Unexpected WinSW recovery.' }
    if ($service.log.mode -cne 'roll-by-size' -or $service.log.sizeThreshold -ne '10240' -or $service.log.keepFiles -ne '5') { throw 'Unexpected WinSW logging.' }
    if (@($service.ChildNodes).Count -ne ($expected.Count+5)) { throw 'Unexpected WinSW extension.' }
    return ,$doc
}

function New-UpdateServiceXml([Xml.XmlDocument]$Document,[string]$EnvFile,[string]$App) {
    $Document.SelectSingleNode('/service/arguments').InnerText='--env-file="'+$EnvFile+'" "'+(Join-Path $App 'dist\main.js')+'"'
    $Document.SelectSingleNode('/service/workingdirectory').InnerText=$App
    return $Document.OuterXml
}

function Assert-UpdateAcl([string]$Path,[string]$ServiceRights='',[switch]$Protected) {
    $null=Assert-LocalNtfsPath $Path
    $acl=Get-Acl -LiteralPath $Path
    if ($Protected -and -not $acl.AreAccessRulesProtected) { throw 'Protected root ACL required.' }
    $trusted=@($script:OperatorSid.Value,'S-1-5-18','S-1-5-32-544')
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Unexpected file owner.' }
    [long]$effective=0
    foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        $sid=$ace.IdentityReference.Value
        if ($ace.AccessControlType -ne 'Allow') { throw 'Unexpected deny ACL.' }
        if ($sid -in $trusted) { continue }
        if ($sid -ne 'S-1-5-19' -or -not $ServiceRights) { throw 'Unexpected private/service principal.' }
        $limit=[long][Security.AccessControl.FileSystemRights]$ServiceRights -bor [long][Security.AccessControl.FileSystemRights]::Synchronize
        if (([long]$ace.FileSystemRights -band (-bnot $limit)) -ne 0) { throw 'Service rights exceed allowed access.' }
        if (($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) { $effective=$effective -bor [long]$ace.FileSystemRights }
    }
    if ($ServiceRights -and ($effective -band [long][Security.AccessControl.FileSystemRights]$ServiceRights) -ne [long][Security.AccessControl.FileSystemRights]$ServiceRights) { throw 'Required service access is missing.' }
}

function Write-UpdateText([string]$Path,[string]$Text) {
    $null=Assert-LocalNtfsPath $Path
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Save-UpdateState {
    $script:state.updatedAt=[DateTime]::UtcNow.ToString('o')
    $temp=Join-Path $script:privateRoot ('update-'+[guid]::NewGuid().ToString()+'.tmp')
    Write-UpdateText $temp ($script:state | ConvertTo-Json -Depth 8)
    if(Test-Path -LiteralPath $script:statePath) { [IO.File]::Replace($temp,$script:statePath,[Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temp,$script:statePath) }
}
function Invoke-UpdateProcess([string]$Exe,[string[]]$Arguments,[string]$Step) {
    $info=[Diagnostics.ProcessStartInfo]::new(); $info.FileName=$Exe; $info.Arguments=($Arguments | ForEach-Object {Quote-UpdateArgument $_}) -join ' '
    $info.WorkingDirectory=$script:toolsRoot; $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.EnvironmentVariables.Clear()
    foreach($key in @('SystemRoot','WINDIR','ComSpec','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','ProgramData','SystemDrive')) { $value=[Environment]::GetEnvironmentVariable($key); if($value) {$info.EnvironmentVariables[$key]=$value} }
    $info.EnvironmentVariables['PATH']=([IO.Path]::GetDirectoryName($script:nodeExe),$script:pgBin,(Join-Path $env:SystemRoot 'System32')) -join ';'
    $info.EnvironmentVariables['LC_ALL']='C'
    $process=[Diagnostics.Process]::new();$process.StartInfo=$info
    try {
        if(-not $process.Start()) {throw "Cannot start step: $Step"}
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(120000)) {$process.Kill();throw "Timed out step: $Step. Preserve state and inspect."}
        $output=$stdout.GetAwaiter().GetResult();$null=$stderr.GetAwaiter().GetResult()
        if($process.ExitCode -ne 0) {throw "Failed step: $Step. No diagnostic credentials are printed."}
        return $output.Trim()
    } finally {$process.Dispose()}
}
function Read-UpdateDatabase([string]$Phase) {
    $envPath=if($Phase -eq 'runtime') {$script:runtimeEnv} else {$script:ownerEnv}
    return (Invoke-UpdateProcess $script:nodeExe @(('--env-file='+$envPath),$script:copiedHelper,$Phase,$script:toolsRoot,$script:branch) ('database-'+$Phase)) | ConvertFrom-Json
}
function Assert-UpdateService([string]$Name,[string]$Path,[string]$Account,[string]$Status) {
    $service=Get-CimInstance Win32_Service -Filter "Name='$Name'"
    if(-not $service -or $service.PathName -cne $Path -or $service.StartName -ne $Account -or $service.StartMode -ne 'Auto' -or ($Status -and $service.State -ne $Status)) {throw "Service binding/state differs: $Name"}
    return $service
}
function Assert-UpdateListener([int]$Port,[string]$Service,[string]$Exe) {
    $svc=Get-CimInstance Win32_Service -Filter "Name='$Service'"
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
    if(-not $listeners.Count) {throw 'Required listener is absent.'}
    foreach($listener in $listeners) {
        $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if($listener.LocalAddress -ne '127.0.0.1' -or -not $process -or $process.ExecutablePath -cne $Exe -or $process.ParentProcessId -ne $svc.ProcessId) {throw 'Unexpected listener ownership.'}
    }
}
function Read-UpdateHttp([string]$Path) {
    $request=[Net.HttpWebRequest]::Create('http://127.0.0.1:3101'+$Path);$request.Proxy=$null;$request.AllowAutoRedirect=$false;$request.Timeout=3000
    $response=$request.GetResponse()
    try {if([int]$response.StatusCode -ne 200) {throw 'Expected HTTP200.'};$reader=[IO.StreamReader]::new($response.GetResponseStream());try {return ($reader.ReadToEnd() | ConvertFrom-Json)} finally {$reader.Dispose()}} finally {$response.Dispose()}
}
function Assert-PreservedData($Actual,[switch]$Partial) {
    $versionValid=if($Partial) {$Actual.migrations -ge 9 -and $Actual.migrations -le 14} else {$Actual.migrations -eq 14}
    if($Actual.branchId -ne $script:branch -or -not $versionValid -or $Actual.serviceMode -ne 'payment_required' -or $Actual.orderingEnabled -ne $false -or
        ($Actual.fingerprints | ConvertTo-Json -Compress -Depth 4) -cne ($script:state.before.fingerprints | ConvertTo-Json -Compress -Depth 4)) {throw 'Existing preview data changed across upgrade.'}
}
function Assert-UpdateFiles([string]$Root,[hashtable]$Expected,[string]$Rights,[switch]$OperatorTree) {
    $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($Root)
    while($pending.Count) {
        $path=$pending.Pop();Assert-UpdateAcl $path $Rights
        $item=Get-Item -LiteralPath $path -Force
        if($item.PSIsContainer) {foreach($child in Get-ChildItem -LiteralPath $path -Force) {$pending.Push($child.FullName)}}
        else {
            $relative=$path.Substring($Root.Length+1).Replace('\','/')
            if($OperatorTree -and ($relative.StartsWith('private/') -or $relative.StartsWith('.local/'))) {continue}
            if($relative -ne 'runtime-manifest.json' -and -not $Expected.ContainsKey($relative)) {throw 'Unexpected staged release file.'}
        }
    }
}

if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') {throw 'Use elevated x64 Windows PowerShell5.1.'}
$script:OperatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
if(-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Administrator elevation required.'}
if($BranchId -eq [guid]::Empty -or $ReleaseName -eq 'edge-0186902') {throw 'Distinct new release and assigned branch required.'}
$sourceFile=[IO.File]::Open($FoundationScript,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {$hasher=[Security.Cryptography.SHA256]::Create();try {$actual=[BitConverter]::ToString($hasher.ComputeHash($sourceFile)).Replace('-','').ToLowerInvariant()} finally {$hasher.Dispose()};if($actual -ne $foundationSha) {throw 'Reviewed archive/NTFS helpers differ.'};$sourceFile.Position=0;$sourceReader=[IO.StreamReader]::new($sourceFile);try {$sourceText=$sourceReader.ReadToEnd()} finally {$sourceReader.Dispose()}} finally {$sourceFile.Dispose()}
$tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($sourceText,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count) {throw 'Invalid helper source.'}
foreach($name in @('Assert-LocalNtfsPath','Open-VerifiedFile','Assert-ArchiveName','Get-ArchivePlan','New-ProtectedDirectory','Assert-ProtectedDirectory')) {
    $found=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false)
    if(@($found).Count -ne 1) {throw 'Reviewed helper function missing.'};. ([scriptblock]::Create($found[0].Extent.Text))
}
$program=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PickChick';$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PickChick'
$oldRoot=Join-Path $program 'Edge\edge-0186902';$oldTools=Join-Path $data 'EdgeTools\edge-0186902';$oldPrivate=Join-Path $oldTools 'private'
$newRoot=Join-Path $program "Edge\$ReleaseName";$appRoot=Join-Path $newRoot 'app';$script:toolsRoot=Join-Path $data "EdgeTools\$ReleaseName";$script:privateRoot=Join-Path $toolsRoot 'private';$script:statePath=Join-Path $privateRoot 'service-upgrade-state.json'
$script:nodeExe=Join-Path $oldRoot 'node\node.exe';$script:pgBin=Join-Path $program 'Postgres\18.6-3\bin';$pgData=Join-Path $data 'Postgres\18\data'
$script:ownerEnv=Join-Path $oldPrivate 'edge-owner.env';$script:runtimeEnv=Join-Path $data 'Edge\config\edge.env';$script:copiedHelper=Join-Path $privateRoot 'native-service-upgrade-db.mjs';$script:branch=$BranchId.ToString()
$xmlPath=Join-Path $oldRoot 'PickChickEdge.xml';$logs=Join-Path $data 'Edge\logs'
$edgeImage='"'+(Join-Path $oldRoot 'PickChickEdge.exe')+'"';$pgImage='"'+(Join-Path $pgBin 'pg_ctl.exe')+'" runservice -N "PickChickPostgres" -D "'+$pgData+'" -w -t 30'
foreach($path in @($program,$data,(Join-Path $data 'EdgeTools'),$oldTools,$oldPrivate)) {Assert-UpdateAcl $path -Protected}
foreach($path in @((Join-Path $program 'Edge'),$oldRoot,(Join-Path $data 'Edge\config'))) {Assert-UpdateAcl $path 'ReadAndExecute' -Protected}
Assert-UpdateAcl $ownerEnv;Assert-UpdateAcl $runtimeEnv 'ReadAndExecute';Assert-UpdateAcl $nodeExe 'ReadAndExecute';Assert-UpdateAcl $xmlPath 'ReadAndExecute'
$oldStatePath=Join-Path $oldPrivate 'foundation-state.json';Assert-UpdateAcl $oldStatePath
$oldState=Get-Content -LiteralPath $oldStatePath -Raw | ConvertFrom-Json
if($oldState.format -ne 'pickchick-native-state-v1' -or -not $oldState.complete -or $oldState.branchId -ne $branch -or $oldState.releaseName -ne 'edge-0186902' -or $oldState.sourceCommit -ne '0186902b30b995ba49ab69346a2bcc1088bb3fa6' -or $oldState.computerName -ne $env:COMPUTERNAME -or $oldState.operatorSid -ne $OperatorSid.Value -or $oldState.systemIdentifier -notmatch '^\d{10,20}$') {throw 'Existing completed foundation binding differs.'}
$BackupManifest=[IO.Path]::GetFullPath($BackupManifest)
if(-not $BackupManifest.StartsWith((Join-Path $data 'Backups')+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'Use the protected PickChick backup directory.'}
Assert-UpdateAcl ([IO.Path]::GetDirectoryName($BackupManifest)) -Protected;Assert-UpdateAcl $BackupManifest
$backup=Get-Content -LiteralPath $BackupManifest -Raw | ConvertFrom-Json;Assert-BackupRecord $backup $branch $oldState.systemIdentifier
$dump=Join-Path ([IO.Path]::GetDirectoryName($BackupManifest)) 'pickchick_edge.dump';Assert-UpdateAcl $dump
if((Get-Item -LiteralPath $dump).Length -ne $backup.archiveBytes -or (Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash.ToLowerInvariant() -ne $backup.sha256) {throw 'Verified backup dump bytes differ.'}
$null=Assert-UpdateService 'PickChickPostgres' $pgImage 'NT SERVICE\PickChickPostgres' 'Running';Assert-UpdateListener 55433 'PickChickPostgres' (Join-Path $pgBin 'postgres.exe')
$edge=Assert-UpdateService 'PickChickEdge' $edgeImage 'NT AUTHORITY\LocalService' ''
if($edge.State -notin @('Running','Stopped')) {throw 'Edge is transitioning; inspect before update.'}
$null=Assert-LocalNtfsPath ([IO.Path]::GetFullPath($DatabaseHelper))
if((Get-FileHash -LiteralPath $DatabaseHelper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $databaseHelperSha) {throw 'Reviewed database helper differs.'}
Add-Type -AssemblyName System.IO.Compression
$archiveFile=Open-VerifiedFile $RuntimeArchive $RuntimeSha256
$zip=[IO.Compression.ZipArchive]::new($archiveFile,[IO.Compression.ZipArchiveMode]::Read,$true)
try {
    $appPlan=Get-ArchivePlan $zip 'runtime' $appRoot;$toolsPlan=Get-ArchivePlan $zip 'runtime' $toolsRoot
    $entry=$zip.GetEntry('runtime-manifest.json');if(-not $entry -or $entry.Length -gt 4MB) {throw 'Missing/oversized runtime manifest.'}
    $reader=[IO.StreamReader]::new($entry.Open());try {$manifest=$reader.ReadToEnd() | ConvertFrom-Json} finally {$reader.Dispose()}
    if($manifest.format -ne 'pickchick-edge-runtime-v1' -or $manifest.target -ne 'windows-x64' -or $manifest.sourceCommit -cne $SourceCommit -or $manifest.symlinks -ne 0 -or $manifest.nativeAddons -ne 0) {throw 'Unexpected runtime manifest.'}
    $files=@{};foreach($file in $manifest.files) {if($files.ContainsKey($file.path) -or $file.sha256 -notmatch '^[a-f0-9]{64}$') {throw 'Invalid manifest file.'};$files[$file.path]=$file}
    if($files.Count+1 -ne $appPlan.Count) {throw 'Manifest file set differs from archive.'}
    foreach($item in $appPlan) {if($item.Relative -match '^(private|\.local)/' -or ($item.Relative -ne 'runtime-manifest.json' -and (-not $files.ContainsKey($item.Relative) -or $files[$item.Relative].bytes -ne $item.Entry.Length))) {throw 'Manifest file size/set differs.'}}
    $migrationNames=@($files.Keys | Where-Object {$_ -match '^db/edge/migrations/\d{3}_[a-z_]+\.sql$'} | Sort-Object)
    if($migrationNames.Count -ne 14 -or (($migrationNames | ForEach-Object {$_.Substring(19,3)}) -join ',') -ne '001,002,003,004,005,006,007,008,009,010,011,012,013,014') {throw 'Expected schema001-014 archive.'}
    if(Test-Path -LiteralPath $statePath) {
        if(-not $Resume -and -not $VerifyOnly) {throw 'Upgrade state exists. Use explicit -Resume or -VerifyOnly.'}
        Assert-UpdateAcl $privateRoot -Protected;Assert-UpdateAcl $statePath
        $script:state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if($state.format -ne 'pickchick-native-service-upgrade-v1' -or $state.branchId -ne $branch -or $state.installId -ne $oldState.installId -or $state.releaseName -ne $ReleaseName -or $state.sourceCommit -ne $SourceCommit -or $state.archiveSha256 -ne $RuntimeSha256 -or $state.backupSha256 -ne $backup.sha256 -or $state.computerName -ne $env:COMPUTERNAME -or $state.operatorSid -ne $OperatorSid.Value) {throw 'Upgrade recovery binding differs.'}
    } else {
        if($Resume -or $VerifyOnly -or (Test-Path -LiteralPath $newRoot) -or (Test-Path -LiteralPath $toolsRoot)) {throw 'Fresh staging roots are required; do not overwrite partial unowned files.'}
        $oldXml=[IO.File]::ReadAllText($xmlPath);$null=Read-UpdateXml $oldXml $nodeExe $runtimeEnv (Join-Path $oldRoot 'app') $logs
        $requiredBytes=2*($appPlan | ForEach-Object {$_.Entry.Length} | Measure-Object -Sum).Sum+1GB
        if([IO.DriveInfo]::new([IO.Path]::GetPathRoot($appRoot)).AvailableFreeSpace -lt $requiredBytes) {throw 'Insufficient space for both staged runtime copies and reserve.'}
        New-ProtectedDirectory $newRoot 'ReadAndExecute';New-ProtectedDirectory $appRoot 'ReadAndExecute';New-ProtectedDirectory $toolsRoot;New-ProtectedDirectory $privateRoot;New-ProtectedDirectory (Join-Path $toolsRoot '.local')
        Write-UpdateText (Join-Path $privateRoot 'original-edge.xml') $oldXml
        $script:state=[pscustomobject][ordered]@{format='pickchick-native-service-upgrade-v1';installId=$oldState.installId;branchId=$branch;releaseName=$ReleaseName;sourceCommit=$SourceCommit;archiveSha256=$RuntimeSha256;backupSha256=$backup.sha256;computerName=$env:COMPUTERNAME;operatorSid=$OperatorSid.Value;ownerEnvSha256=(Get-FileHash -LiteralPath $ownerEnv -Algorithm SHA256).Hash;runtimeEnvSha256=(Get-FileHash -LiteralPath $runtimeEnv -Algorithm SHA256).Hash;before=$null;staged=$false;migrated=$false;switched=$false;complete=$false;updatedAt='';rebootVerified=$false}
        Save-UpdateState
    }
    if($VerifyOnly -and -not $state.complete) {throw 'Upgrade not completed.'}
    if($state.complete -and -not $VerifyOnly) {throw 'Upgrade already completed. Use -VerifyOnly before subsequent catalog or restaurant changes.'}
    Assert-UpdateAcl $newRoot 'ReadAndExecute' -Protected;Assert-UpdateAcl $appRoot 'ReadAndExecute' -Protected;Assert-UpdateAcl $toolsRoot -Protected
    foreach($pair in @(@($appPlan,'ReadAndExecute'),@($toolsPlan,''))) {
        foreach($item in $pair[0]) {
            if(-not (Test-Path -LiteralPath $item.Target)) {
                if($VerifyOnly -or $state.staged) {throw 'A verified release file is missing.'}
                $null=Assert-LocalNtfsPath $item.Target;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target)) | Out-Null
                $source=$item.Entry.Open();try {$dest=[IO.File]::Open($item.Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try {$source.CopyTo($dest);$dest.Flush($true)} finally {$dest.Dispose()}} finally {$source.Dispose()}
            }
            Assert-UpdateAcl $item.Target $pair[1]
            $wanted=if($item.Relative -eq 'runtime-manifest.json') {$null} else {$files[$item.Relative]}
            if($wanted) {if((Get-Item -LiteralPath $item.Target).Length -ne $wanted.bytes -or (Get-FileHash -LiteralPath $item.Target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $wanted.sha256) {throw 'Staged file bytes differ.'}}
            else {$src=$item.Entry.Open();$sha=[Security.Cryptography.SHA256]::Create();try {$expected=[BitConverter]::ToString($sha.ComputeHash($src)).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose();$src.Dispose()};if((Get-FileHash -LiteralPath $item.Target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {throw 'Manifest bytes differ.'}}
        }
    }
    Assert-UpdateFiles $appRoot $files 'ReadAndExecute';Assert-UpdateFiles $toolsRoot $files '' -OperatorTree
    if(-not(Test-Path -LiteralPath $copiedHelper)) {[IO.File]::Copy($DatabaseHelper,$copiedHelper,$false)}
    Assert-UpdateAcl $copiedHelper;if((Get-FileHash -LiteralPath $copiedHelper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $databaseHelperSha) {throw 'Private upgrade helper differs.'}
    if((Get-FileHash -LiteralPath $ownerEnv -Algorithm SHA256).Hash -ne $state.ownerEnvSha256 -or (Get-FileHash -LiteralPath $runtimeEnv -Algorithm SHA256).Hash -ne $state.runtimeEnvSha256) {throw 'Existing protected environment changed.'}
    if((Invoke-UpdateProcess $nodeExe @('--version') 'node-version') -ne 'v24.21.0') {throw 'Existing Node version differs.'}
    $control=Invoke-UpdateProcess (Join-Path $pgBin 'pg_controldata.exe') @('-D',$pgData) 'cluster-identity'
    if($control -notmatch ('(?m)^Database system identifier:\s+'+[regex]::Escape($oldState.systemIdentifier)+'\s*$')) {throw 'Existing PostgreSQL cluster identifier differs.'}
    $state.staged=$true
    if(-not $state.before) {$state.before=Read-UpdateDatabase 'before';Save-UpdateState}
    $original=Join-Path $privateRoot 'original-edge.xml';Assert-UpdateAcl $original
    $newXml=Read-UpdateXml ([IO.File]::ReadAllText($original)) $nodeExe $runtimeEnv (Join-Path $oldRoot 'app') $logs
    $newText=New-UpdateServiceXml $newXml $runtimeEnv $appRoot
    $actualXml=[IO.File]::ReadAllText($xmlPath)
    if($actualXml -cne [IO.File]::ReadAllText($original) -and $actualXml -cne $newText) {throw 'Existing WinSW XML was changed by another operation.'}
    if($VerifyOnly -and ($actualXml -cne $newText -or -not $state.migrated -or -not $state.switched)) {throw 'Recorded upgraded service is not selected.'}
    if(-not $VerifyOnly) {
        if((Get-Service PickChickEdge).Status -ne 'Stopped') {Stop-Service PickChickEdge;(Get-Service PickChickEdge).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(40))}
        if(@(Get-NetTCPConnection -State Listen -LocalPort 3101 -ErrorAction SilentlyContinue).Count) {throw 'Edge listener did not stop.'}
        if(-not $state.migrated) {
            $progress=Read-UpdateDatabase 'progress';Assert-PreservedData $progress -Partial
            $needsMigration=$progress.migrations -lt 14
            if($needsMigration) {$null=Invoke-UpdateProcess $nodeExe @(('--env-file='+$ownerEnv),(Join-Path $toolsRoot 'scripts\edge-migrate.mjs')) 'migrate-014'}
            Assert-PreservedData (Read-UpdateDatabase 'after');$state.migrated=$true;Save-UpdateState
        }
        # A resumed completed migration still verifies data before any grants/XML switch.
        Assert-PreservedData (Read-UpdateDatabase 'after')
        $null=Invoke-UpdateProcess $nodeExe @(('--env-file='+$ownerEnv),(Join-Path $toolsRoot 'scripts\edge-runtime-grants.mjs'),'pickchick_edge_runtime') 'runtime-grants'
        $null=Read-UpdateDatabase 'runtime'
        if($actualXml -cne $newText) {$temp=Join-Path $oldRoot ('edge-update-'+[guid]::NewGuid().ToString()+'.tmp');Write-UpdateText $temp $newText;[IO.File]::Replace($temp,$xmlPath,[Management.Automation.Language.NullString]::Value)}
        Assert-UpdateAcl $xmlPath 'ReadAndExecute';$state.switched=$true;Save-UpdateState
        Start-Service PickChickEdge;(Get-Service PickChickEdge).WaitForStatus('Running',[TimeSpan]::FromSeconds(40))
    }
    $deadline=[DateTime]::UtcNow.AddSeconds(40)
    do {try {$ready=Read-UpdateHttp '/health/ready';$healthy=$ready.service -eq 'edge' -and $ready.ready -eq $true -and $ready.dependencies.database -eq 'up' -and $ready.dependencies.schema -eq 'up'} catch {$healthy=$false};if(-not $healthy -and [DateTime]::UtcNow -lt $deadline) {Start-Sleep -Milliseconds 500}} while(-not $healthy -and [DateTime]::UtcNow -lt $deadline)
    if(-not $healthy) {throw 'New edge readiness verification failed.'}
    $live=Read-UpdateHttp '/health/live';if($live.service -ne 'edge' -or $live.alive -ne $true) {throw 'New edge liveness verification failed.'}
    $null=Assert-UpdateService 'PickChickEdge' $edgeImage 'NT AUTHORITY\LocalService' 'Running';$null=Assert-UpdateService 'PickChickPostgres' $pgImage 'NT SERVICE\PickChickPostgres' 'Running'
    Assert-UpdateListener 3101 'PickChickEdge' $nodeExe;Assert-UpdateListener 55433 'PickChickPostgres' (Join-Path $pgBin 'postgres.exe')
    $edgeChild=Get-CimInstance Win32_Process -Filter "ProcessId=$((Get-NetTCPConnection -State Listen -LocalPort 3101 | Select-Object -First 1).OwningProcess)"
    if(-not $edgeChild.CommandLine.Contains('"'+(Join-Path $appRoot 'dist\main.js')+'"')) {throw 'Running Node entry point is not the new release.'}
    if((Read-UpdateHttp '/edge/v1/fulfillment/config').enabled -ne $false) {throw 'Fulfillment was enabled unexpectedly.'}
    $servedMenu=Read-UpdateHttp '/edge/v1/menu';if($servedMenu.branch_id -ne $branch -or $servedMenu.release_id -ne $state.before.activeMenu.release_id -or $servedMenu.version -ne $state.before.activeMenu.version) {throw 'Served preview menu differs.'}
    Assert-PreservedData (Read-UpdateDatabase 'after');$null=Read-UpdateDatabase 'runtime'
    if((Get-FileHash -LiteralPath $ownerEnv -Algorithm SHA256).Hash -ne $state.ownerEnvSha256 -or (Get-FileHash -LiteralPath $runtimeEnv -Algorithm SHA256).Hash -ne $state.runtimeEnvSha256) {throw 'Protected environment changed.'}
    if(-not $VerifyOnly) {$state.complete=$true;Save-UpdateState}
    [pscustomobject]@{stage='native_service_upgrade_verified';releaseName=$ReleaseName;sourceCommit=$SourceCommit;migrations=14;serviceMode='payment_required';dataPreserved=$true;credentialsChanged=$false;postgresRestartRequested=$false;orderingEnabled=$false;fulfillmentEnabled=$false;rebootVerified=$false} | ConvertTo-Json
} catch {Write-Warning 'Upgrade incomplete. Existing data and protected recovery state are preserved. Inspect before explicit -Resume; do not rerun the old foundation installer.';throw}
finally {$zip.Dispose();$archiveFile.Dispose()}
