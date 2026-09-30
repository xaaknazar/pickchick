#Requires -Version 5.1
<#
.SYNOPSIS
Initialize the isolated PostgreSQL/edge foundation after stage 1.
.DESCRIPTION
Creates no restaurant/menu/order/staff data. Resume only a matching private setup
record; uncertain initdb results require inspection, never automatic deletion.
Use -VerifyOnly after provisioning, and -RequireBranchReady to require ready=200.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$ReleaseName,
    [Parameter(Mandatory = $true)][guid]$BranchId,
    [string]$DatabaseHelper = (Join-Path $PSScriptRoot 'native-foundation-db.mjs'),
    [switch]$Resume,
    [switch]$VerifyOnly,
    [switch]$RequireBranchReady
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceCommit = '0186902b30b995ba49ab69346a2bcc1088bb3fa6'
$helperSha256 = '4e32e1156754643200bd4f53ecdc1ad5851c23dcdef37f3a4cd5e0c0038fe0a2'

function Assert-NtfsPath([string]$Path) {
    if ($Path -notmatch '^[a-zA-Z]:\\' -or $Path.Substring(2).Contains(':')) { throw 'Absolute local NTFS paths are required.' }
    $full = [IO.Path]::GetFullPath($Path)
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full))
    if (-not $drive.IsReady -or $drive.DriveFormat -ne 'NTFS' -or $drive.DriveType -ne 'Fixed') { throw 'A fixed NTFS drive is required.' }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse paths are not accepted.' }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        $cursor = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
}

function Assert-Acl([string]$Path, [hashtable]$Extra = @{}, [switch]$InheritedAllowed) {
    Assert-NtfsPath $Path
    $acl = Get-Acl -LiteralPath $Path
    if (-not $InheritedAllowed -and -not $acl.AreAccessRulesProtected) { throw 'A protected ACL is required.' }
    $trusted = @($script:operatorSid.Value, 'S-1-5-18', 'S-1-5-32-544')
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Unexpected filesystem owner.' }
    foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = $ace.IdentityReference.Value
        if ($ace.AccessControlType -ne 'Allow') { throw 'Unexpected deny rule.' }
        if ($sid -in $trusted) { continue }
        if ($Extra.ContainsKey($sid)) {
            $limit = [Security.AccessControl.FileSystemRights]$Extra[$sid] -bor [Security.AccessControl.FileSystemRights]::Synchronize
            if (($ace.FileSystemRights -band (-bnot $limit)) -eq 0) { continue }
        }
        throw 'Filesystem access exceeds the reviewed principals.'
    }
}

function Set-KnownDirectoryAcl([string]$Path, [hashtable]$Extra = @{}, [switch]$Create) {
    Assert-NtfsPath $Path
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($script:operatorSid)
    $grants = @{ 'S-1-5-18' = 'FullControl'; 'S-1-5-32-544' = 'FullControl' }
    $grants[$script:operatorSid.Value] = 'FullControl'
    foreach ($sid in $Extra.Keys) { $grants[$sid] = $Extra[$sid] }
    foreach ($sid in $grants.Keys) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), $grants[$sid], 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    if ($Create) {
        if (Test-Path -LiteralPath $Path) { throw 'Fresh private directory already exists.' }
        [IO.Directory]::CreateDirectory($Path, $acl) | Out-Null
    } else { Set-Acl -LiteralPath $Path -AclObject $acl }
    Assert-Acl $Path $Extra
}

function Write-PrivateText([string]$Path, [string]$Text, [switch]$Replace) {
    Assert-NtfsPath $Path
    $mode = if ($Replace) { [IO.FileMode]::Create } else { [IO.FileMode]::CreateNew }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
    $stream = [IO.File]::Open($Path, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Save-State {
    $script:state.updatedAt = [DateTime]::UtcNow.ToString('o')
    $temp = Join-Path $script:privateRoot ('state-' + [guid]::NewGuid().ToString() + '.tmp')
    Write-PrivateText $temp ($script:state | ConvertTo-Json -Depth 4)
    # PS5.1 converts ordinary $null to an empty string for this string overload.
    if (Test-Path -LiteralPath $script:statePath) { [IO.File]::Replace($temp, $script:statePath, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temp, $script:statePath) }
}

function New-Secret {
    $bytes = [byte[]]::new(32)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Quote-WindowsArgument([string]$Value) {
    if ($Value.Contains([char]0) -or $Value.Contains("`n") -or $Value.Contains("`r")) { throw 'Invalid process argument.' }
    # CommandLineToArgvW/CRT escaping, including backslashes before quotes/end.
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-SetupProcess([string]$Exe, [string[]]$Arguments, [string]$Step, [int]$TimeoutSeconds = 120) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Exe
    $start.Arguments = ($Arguments | ForEach-Object { Quote-WindowsArgument $_ }) -join ' '
    $start.WorkingDirectory = $script:toolsRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # Inherited PG*/EDGE*/NODE_OPTIONS must not override the private env files.
    $start.EnvironmentVariables.Clear()
    foreach ($key in @('SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'SystemDrive')) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if ($value) { $start.EnvironmentVariables[$key] = $value }
    }
    $start.EnvironmentVariables['PATH'] = ([IO.Path]::GetDirectoryName($script:nodeExe), $script:pgBin, (Join-Path $env:SystemRoot 'System32')) -join ';'
    $start.EnvironmentVariables['LC_ALL'] = 'C'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Could not start the reviewed operator process.' }
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            throw "Operator step timed out: $Step. Inspect its private state before recovery."
        }
        $output = $outputTask.GetAwaiter().GetResult()
        $errors = $errorTask.GetAwaiter().GetResult()
        $diagnostic = $output + "`n" + $errors
        foreach ($secret in $script:secrets) { $diagnostic = $diagnostic.Replace($secret, '[redacted]') }
        Write-PrivateText (Join-Path $script:privateRoot ($Step + '.log')) $diagnostic -Replace
        if ($process.ExitCode -ne 0) { throw "Operator step failed: $Step. Review its protected log; exit code $($process.ExitCode)." }
        return $output.Trim()
    } finally { $process.Dispose() }
}

function Assert-Service([string]$Name, [string]$Image, [string]$Account) {
    $service = Get-CimInstance Win32_Service -Filter "Name='$Name'"
    if (-not $service -or $service.PathName -ne $Image -or $service.StartName -ne $Account) { throw "Service identity/path differs: $Name" }
    return $service
}

function Assert-Listener([int]$Port, [string]$Service, [string]$Executable) {
    $serviceInfo = Get-CimInstance Win32_Service -Filter "Name='$Service'"
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
    if (-not $listeners.Count) { throw 'Expected service listener is absent.' }
    foreach ($listener in $listeners) {
        if ($listener.LocalAddress -ne '127.0.0.1') { throw 'A service port is exposed outside IPv4 loopback.' }
        $child = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if (-not $child -or $child.ExecutablePath -ne $Executable -or $child.ParentProcessId -ne $serviceInfo.ProcessId) { throw 'The listener does not belong to the expected service child.' }
    }
}

function Read-Health([string]$Path) {
    $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:3101' + $Path)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 3000
    $response = $null
    try { $response = $request.GetResponse() }
    catch [Net.WebException] { $response = $_.Exception.Response; if (-not $response) { throw 'Edge did not return an HTTP response.' } }
    try {
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { $body = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $body }
    } finally { $response.Dispose() }
}

function Verify-Foundation {
    $null = Assert-Service 'PickChickPostgres' $script:pgImage 'NT SERVICE\PickChickPostgres'
    $null = Assert-Service 'PickChickEdge' $script:edgeImage 'NT AUTHORITY\LocalService'
    Assert-Listener 55433 'PickChickPostgres' (Join-Path $script:pgBin 'postgres.exe')
    Assert-Listener 3101 'PickChickEdge' $script:nodeExe
    $db = Invoke-SetupProcess $script:nodeExe @($script:copiedHelper, 'verify', $script:toolsRoot, $script:branch, $script:pgData, $script:state.systemIdentifier) 'database-verify' | ConvertFrom-Json
    if ($db.systemIdentifier -ne $script:state.systemIdentifier) { throw 'PostgreSQL system identifier changed.' }
    $live = Read-Health '/health/live'
    $ready = Read-Health '/health/ready'
    if ($live.Status -ne 200 -or $live.Body.service -ne 'edge' -or -not $live.Body.alive) { throw 'Edge liveness verification failed.' }
    $expected = if ($db.branchBound) { 200 } else { 503 }
    if ($ready.Status -ne $expected -or $ready.Body.service -ne 'edge' -or
        $ready.Body.dependencies.database -ne 'up' -or $ready.Body.ready -ne $db.branchBound) { throw 'Edge readiness differs from the verified branch binding.' }
    $config = Read-Health '/edge/v1/fulfillment/config'
    if ($config.Status -ne 200 -or $config.Body.enabled) { throw 'Fulfillment must remain disabled during foundation setup.' }
    if ($RequireBranchReady -and -not $db.branchBound) { throw 'The assigned branch has not yet been provisioned.' }
    return $db.branchBound
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use elevated x64 Windows PowerShell 5.1.' }
$script:operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated administrator shell is required.' }
if ($BranchId -eq [guid]::Empty) { throw 'Use the reserved branch UUID from stage 1.' }
$script:branch = $BranchId.ToString()
$programRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PickChick'
$dataRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PickChick'
$serviceRoot = Join-Path $programRoot "Edge\$ReleaseName"
$script:toolsRoot = Join-Path $dataRoot "EdgeTools\$ReleaseName"
$script:privateRoot = Join-Path $toolsRoot 'private'
$script:statePath = Join-Path $privateRoot 'foundation-state.json'
$script:pgData = Join-Path $dataRoot 'Postgres\18\data'
$pgRoot = Join-Path $programRoot 'Postgres\18.6-3'
$script:pgBin = Join-Path $pgRoot 'bin'
$script:nodeExe = Join-Path $serviceRoot 'node\node.exe'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$edgeWrapper = Join-Path $serviceRoot 'PickChickEdge.exe'
$script:pgImage = '"' + $pgCtl + '" runservice -N "PickChickPostgres" -D "' + $pgData + '" -w -t 30'
$script:edgeImage = '"' + $edgeWrapper + '"'
$script:copiedHelper = Join-Path $toolsRoot 'native-foundation-db.mjs'
$ownerEnv = Join-Path $privateRoot 'edge-owner.env'
$runtimeEnv = Join-Path $dataRoot 'Edge\config\edge.env'
$pwFile = Join-Path $privateRoot 'initdb-password.tmp'
$credentialFile = Join-Path $privateRoot 'foundation-credentials.json'
$script:secrets = @()
$localRead = @{ 'S-1-5-19' = 'ReadAndExecute' }
foreach ($path in @($programRoot, $dataRoot, $toolsRoot, (Join-Path $dataRoot 'EdgeTools'))) { Assert-Acl $path }
Assert-Acl $serviceRoot $localRead
Assert-Acl (Join-Path $dataRoot 'Edge\config') $localRead
Assert-Acl (Join-Path $dataRoot 'Edge\logs') @{ 'S-1-5-19' = 'Modify' }
$stage1 = Get-Content -LiteralPath (Join-Path $toolsRoot 'foundation-stage1.json') -Raw | ConvertFrom-Json
if ($stage1.stage -ne 'files_prepared_only' -or $stage1.branchId -ne $branch -or $stage1.releaseName -ne $ReleaseName -or $stage1.sourceCommit -ne $sourceCommit) { throw 'The stage-1 record does not match these inputs.' }
Assert-NtfsPath ([IO.Path]::GetFullPath($DatabaseHelper))
if ((Get-FileHash -LiteralPath $DatabaseHelper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $helperSha256) { throw 'Database helper differs from the reviewed stage-2 source.' }

if (Test-Path -LiteralPath $privateRoot) {
    if (-not $Resume -and -not $VerifyOnly) { throw 'A setup record exists. Use explicit -Resume or -VerifyOnly after inspection.' }
    Assert-Acl $privateRoot
    Assert-Acl $statePath -InheritedAllowed
    $script:state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.format -ne 'pickchick-native-state-v1' -or $state.branchId -ne $branch -or $state.releaseName -ne $ReleaseName -or $state.sourceCommit -ne $sourceCommit -or $state.computerName -ne $env:COMPUTERNAME -or $state.operatorSid -ne $operatorSid.Value) { throw 'Foreign setup state; automatic recovery refused.' }
} else {
    if ($Resume -or $VerifyOnly) { throw 'No previous private setup record exists.' }
    Assert-Acl $pgData
    Assert-Acl $pgRoot $localRead
    if (@(Get-ChildItem -LiteralPath $pgData -Force).Count -or (Test-Path -LiteralPath $runtimeEnv) -or (Test-Path -LiteralPath $copiedHelper)) { throw 'Fresh stage-1 paths are required.' }
    if (@(Get-Service | Where-Object { $_.Name -in @('PickChickPostgres', 'PickChickEdge') }).Count) { throw 'Target service already exists.' }
    if (@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -in @(55433, 3101) }).Count) { throw 'Target service port is occupied.' }
    Set-KnownDirectoryAcl $privateRoot -Create
    $script:state = [pscustomobject][ordered]@{
        format = 'pickchick-native-state-v1'; installId = [guid]::NewGuid().ToString(); branchId = $branch
        releaseName = $ReleaseName; sourceCommit = $sourceCommit; computerName = $env:COMPUTERNAME; operatorSid = $operatorSid.Value
        credentialsReady = $false; clusterReady = $false; pgRegistered = $false; databaseReady = $false
        migrationsReady = $false; edgeRegistered = $false; complete = $false; branchReady = $false
        systemIdentifier = ''; updatedAt = ''; rebootVerified = $false; wanVerified = $false
    }
    Save-State
}
try {
    if (-not (Test-Path -LiteralPath $copiedHelper)) { [IO.File]::Copy($DatabaseHelper, $copiedHelper, $false) }
    Assert-Acl $copiedHelper -InheritedAllowed
    if ((Get-FileHash -LiteralPath $copiedHelper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $helperSha256) { throw 'Private helper differs from reviewed bytes.' }
    if (-not $state.credentialsReady) {
        if ($VerifyOnly) { throw 'Credential phase is incomplete.' }
        if (Test-Path -LiteralPath $credentialFile) { throw 'Credential creation has an uncertain result; inspect the record before recovery.' }
        $credential = [ordered]@{ format = 'pickchick-native-secrets-v1'; installId = $state.installId; branchId = $branch; passwords = [ordered]@{
            pickchick_bootstrap = New-Secret; pickchick_edge_owner = New-Secret; pickchick_edge_runtime = New-Secret
        } }
        Write-PrivateText $credentialFile ($credential | ConvertTo-Json -Depth 3)
        $state.credentialsReady = $true; Save-State
    }
    Assert-Acl $credentialFile -InheritedAllowed
    $credential = Get-Content -LiteralPath $credentialFile -Raw | ConvertFrom-Json
    if ($credential.format -ne 'pickchick-native-secrets-v1' -or $credential.installId -ne $state.installId -or $credential.branchId -ne $branch) { throw 'Private credential binding differs.' }
    $script:secrets = @($credential.passwords.PSObject.Properties.Value)
    if ($secrets.Count -ne 3 -or @($secrets | Where-Object { $_ -notmatch '^[a-f0-9]{64}$' }).Count) { throw 'Invalid private passwords.' }
    if ($VerifyOnly) {
        if (-not $state.complete) { throw 'Installation is not yet complete.' }
        $ready = Verify-Foundation
        Write-Output "Foundation verified. Branch ready: $ready. Fulfillment and ordering remain disabled."
        return
    }
    if ($state.complete) { throw 'Installation is complete. Use -VerifyOnly; no configuration is overwritten.' }
    if (-not $state.clusterReady) {
        if (@(Get-ChildItem -LiteralPath $pgData -Force).Count) { throw 'initdb has an uncertain partial result. Preserve this data and inspect; it will not be reinitialized.' }
        Write-PrivateText $pwFile ($credential.passwords.pickchick_bootstrap + "`n")
        try {
            $null = Invoke-SetupProcess (Join-Path $pgBin 'initdb.exe') @('-D', $pgData, '--username=pickchick_bootstrap', ('--pwfile=' + $pwFile), '--encoding=UTF8', '--locale=C', '--data-checksums', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--no-clean') 'initdb'
        } finally { if (Test-Path -LiteralPath $pwFile) { [IO.File]::Delete($pwFile) } }
        $pgConfig = @"
listen_addresses = '127.0.0.1'
port = 55433
password_encryption = 'scram-sha-256'
max_connections = 40
shared_buffers = '128MB'
timezone = 'Asia/Almaty'
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%a.log'
log_rotation_age = '1d'
log_rotation_size = '10MB'
log_truncate_on_rotation = on
log_statement = 'none'
log_min_error_statement = 'panic'
log_parameter_max_length_on_error = 0
"@
        # Before first server startup: no trust entries, replication or wildcard listener.
        Write-PrivateText (Join-Path $pgData 'postgresql.conf') ($pgConfig + "`n") -Replace
        Write-PrivateText (Join-Path $pgData 'pg_hba.conf') "host all all 127.0.0.1/32 scram-sha-256`nhost all all ::0/0 reject`nhost all all 0.0.0.0/0 reject`n" -Replace
        $state.clusterReady = $true; Save-State
    }
    if (-not $state.pgRegistered) {
        if (-not (Get-Service -Name PickChickPostgres -ErrorAction SilentlyContinue)) {
            $null = Invoke-SetupProcess $pgCtl @('register', '-D', $pgData, '-N', 'PickChickPostgres', '-U', 'NT SERVICE\PickChickPostgres', '-S', 'demand', '-t', '30') 'register-postgres'
        }
        $null = Assert-Service 'PickChickPostgres' $pgImage 'NT SERVICE\PickChickPostgres'
        $pgSid = ([Security.Principal.NTAccount]::new('NT SERVICE\PickChickPostgres')).Translate([Security.Principal.SecurityIdentifier]).Value
        # Previous partial ACL application is accepted only for this exact service SID.
        $pgRead = @{ 'S-1-5-19' = 'ReadAndExecute' }; $pgRead[$pgSid] = 'ReadAndExecute'
        $pgWrite = @{}; $pgWrite[$pgSid] = 'Modify'
        Assert-Acl $pgRoot $pgRead
        Assert-Acl $pgData $pgWrite
        Set-KnownDirectoryAcl $pgRoot @{ $pgSid = 'ReadAndExecute' }
        Set-KnownDirectoryAcl $pgData $pgWrite
        foreach ($item in Get-ChildItem -LiteralPath $pgData -Recurse -Force) { Assert-Acl $item.FullName $pgWrite -InheritedAllowed }
        $state.pgRegistered = $true; Save-State
    }
    $null = Assert-Service 'PickChickPostgres' $pgImage 'NT SERVICE\PickChickPostgres'
    Start-Service -Name PickChickPostgres
    (Get-Service PickChickPostgres).WaitForStatus('Running', [TimeSpan]::FromSeconds(40))
    Assert-Listener 55433 'PickChickPostgres' (Join-Path $pgBin 'postgres.exe')
    $configured = Invoke-SetupProcess $nodeExe @($copiedHelper, 'bootstrap', $toolsRoot, $branch, $pgData, $state.systemIdentifier) 'database-bootstrap' | ConvertFrom-Json
    if ($state.systemIdentifier -and $state.systemIdentifier -ne $configured.systemIdentifier) { throw 'The database cluster changed during recovery.' }
    $state.systemIdentifier = $configured.systemIdentifier
    $state.databaseReady = $true; Save-State
    $envCommon = "APP_ENV=local`nEDGE_BRANCH_ID=$branch`nEDGE_PORT=3101`nEDGE_FULFILLMENT_ENABLED=false`n"
    $ownerText = $envCommon + 'EDGE_DATABASE_URL=postgresql://pickchick_edge_owner:' + $credential.passwords.pickchick_edge_owner + "@127.0.0.1:55433/pickchick_edge`n"
    $runtimeText = $envCommon + 'EDGE_DATABASE_URL=postgresql://pickchick_edge_runtime:' + $credential.passwords.pickchick_edge_runtime + "@127.0.0.1:55433/pickchick_edge`n"
    foreach ($pair in @(@($ownerEnv, $ownerText), @($runtimeEnv, $runtimeText))) {
        if (Test-Path -LiteralPath $pair[0]) {
            if ([IO.File]::ReadAllText($pair[0]) -ne $pair[1]) { throw 'Existing environment file differs; automatic overwrite refused.' }
        } else { Write-PrivateText $pair[0] $pair[1] }
    }
    Assert-Acl $ownerEnv -InheritedAllowed
    Assert-Acl $runtimeEnv $localRead -InheritedAllowed
    $null = Invoke-SetupProcess $nodeExe @(('--env-file=' + $ownerEnv), (Join-Path $toolsRoot 'scripts\edge-migrate.mjs')) 'edge-migrations'
    $null = Invoke-SetupProcess $nodeExe @(('--env-file=' + $ownerEnv), (Join-Path $toolsRoot 'scripts\edge-runtime-grants.mjs'), 'pickchick_edge_runtime') 'runtime-grants'
    $state.migrationsReady = $true; Save-State
    $envXml = [Security.SecurityElement]::Escape($runtimeEnv)
    $mainXml = [Security.SecurityElement]::Escape((Join-Path $serviceRoot 'app\dist\main.js'))
    $nodeXml = [Security.SecurityElement]::Escape($nodeExe)
    $appXml = [Security.SecurityElement]::Escape((Join-Path $serviceRoot 'app'))
    $logsXml = [Security.SecurityElement]::Escape((Join-Path $dataRoot 'Edge\logs'))
    $xml = @"
<service>
  <id>PickChickEdge</id><name>PickChick Edge</name>
  <description>Local PickChick foundation. Restaurant provisioning is separate.</description>
  <executable>$nodeXml</executable><arguments>--env-file="$envXml" "$mainXml"</arguments>
  <workingdirectory>$appXml</workingdirectory>
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <startmode>Automatic</startmode><delayedAutoStart>true</delayedAutoStart>
  <depend>PickChickPostgres</depend><stoptimeout>30 sec</stoptimeout>
  <onfailure action="restart" delay="5 sec"/><onfailure action="restart" delay="15 sec"/><onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure><logpath>$logsXml</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>
</service>
"@
    $null = [xml]$xml
    $xmlPath = Join-Path $serviceRoot 'PickChickEdge.xml'
    if (Test-Path -LiteralPath $xmlPath) { if ([IO.File]::ReadAllText($xmlPath) -ne $xml) { throw 'Existing WinSW config differs.' } }
    else { Write-PrivateText $xmlPath $xml }
    if (-not $state.edgeRegistered) {
        if (-not (Get-Service -Name PickChickEdge -ErrorAction SilentlyContinue)) { $null = Invoke-SetupProcess $edgeWrapper @('install') 'register-edge' }
        $null = Assert-Service 'PickChickEdge' $edgeImage 'NT AUTHORITY\LocalService'
        $state.edgeRegistered = $true; Save-State
    }
    Start-Service PickChickEdge
    (Get-Service PickChickEdge).WaitForStatus('Running', [TimeSpan]::FromSeconds(40))
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    do {
        try { $state.branchReady = Verify-Foundation; $healthy = $true }
        catch { $healthy = $false; if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 500 }
    } while (-not $healthy)
    # Prove controlled service restart without rebooting the operator's machine.
    Stop-Service PickChickEdge
    (Get-Service PickChickEdge).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(40))
    Restart-Service PickChickPostgres
    (Get-Service PickChickPostgres).WaitForStatus('Running', [TimeSpan]::FromSeconds(40))
    Start-Service PickChickEdge
    (Get-Service PickChickEdge).WaitForStatus('Running', [TimeSpan]::FromSeconds(40))
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    do {
        try { $state.branchReady = Verify-Foundation; $healthy = $true }
        catch { $healthy = $false; if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 500 }
    } while (-not $healthy)
    Set-Service PickChickPostgres -StartupType Automatic
    $state.complete = $true; Save-State
    Write-Output "Native database and edge services verified, including controlled restart. Branch ready: $($state.branchReady). Restaurant provisioning, Windows reboot, backup and WAN acceptance remain separate."
} catch {
    Write-Warning 'Setup is incomplete. Private state and database are preserved. Inspect the failed phase, then use -Resume only for this recorded installation.'
    throw
} finally {
    if (Test-Path -LiteralPath $pwFile) { Assert-NtfsPath $pwFile; [IO.File]::Delete($pwFile) }
    $script:secrets = @()
}
