#Requires -Version 5.1
<# Sets DB_POOL_MAX in the point server's edge.env (the edge runtime's PostgreSQL pool).
Default is a read-only plan. -Apply needs the plan's env hash (-ExpectedEdgeEnvSha256).
Only the one DB_POOL_MAX line of edge.env changes; every other byte, the file ACL, the
service XML, the database, owner/worker environments and identities stay as they are.
PickChickEdge restarts together with its known dependents (PickChickKitchenLink,
PickChickKitchenLAN); an unknown running dependent stops the command before any change.
The previous bytes stay in EdgeTools\db-pool-<UTC>\before.env. If the edge does not get
ready, the previous bytes are restored and the services restarted. The script never prints
the environment, only the DB_POOL_MAX value and hashes. Run it from the operator folder
next to reviewed-env-bytes.ps1 in an elevated Windows PowerShell 5.1. #>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateRange(1,64)][int]$PoolMax,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedEdgeEnvSha256,
 [string]$HelperFolder='',
 [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:ReviewedEnvBytesSha256='00412db264f47a3b7c2996fb44115e46ae63a965710943f1b5c725e9156137c3'
$script:KnownEdgeDependents=@('PickChickKitchenLink','PickChickKitchenLAN')

function Get-PoolBytesHash([byte[]]$Bytes) {
 $h=[Security.Cryptography.SHA256]::Create();try {return [BitConverter]::ToString($h.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()} finally {$h.Dispose()}
}
function Get-DbPoolPrior([byte[]]$Bytes) {
 # Returns the current DB_POOL_MAX value or $null. The full-file validation (UTF8, line
 # endings, duplicate keys) belongs to Update-ReviewedEnvBytes in Get-DbPoolAfter.
 $text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes)
 $found=[regex]::Matches($text,'(?m)^DB_POOL_MAX=([^\r\n]*)\r?$')
 if($found.Count -gt 1) {throw 'DB_POOL_MAX is set more than once.'}
 if($found.Count -eq 0) {return $null}
 $value=$found[0].Groups[1].Value
 if($value -cnotmatch '^[1-9][0-9]?$' -or [int]$value -gt 64) {throw 'The present DB_POOL_MAX is not a whole number 1-64.'}
 return $value
}
function Get-DbPoolAfter([byte[]]$Bytes,[int]$Pool) {
 $prior=Get-DbPoolPrior $Bytes
 $next=[string]$Pool
 if($null -eq $prior) {return ,(Update-ReviewedEnvBytes $Bytes 'DB_POOL_MAX' '' $next -AllowAbsent)}
 # Same value: still run the transformer so a malformed file is refused, then keep bytes.
 $after=Update-ReviewedEnvBytes $Bytes 'DB_POOL_MAX' $prior $next
 if($prior -ceq $next -and (Get-PoolBytesHash $after) -cne (Get-PoolBytesHash $Bytes)) {throw 'Unchanged value changed bytes.'}
 return ,$after
}
function Get-PgMaxConnections([string]$DataDir) {
 # postgresql.auto.conf (ALTER SYSTEM) overrides postgresql.conf; the last line wins.
 $value=$null
 foreach($name in @('postgresql.conf','postgresql.auto.conf')) {
  $path=Join-Path $DataDir $name
  if(-not (Test-Path -LiteralPath $path)) {continue}
  foreach($line in [IO.File]::ReadAllLines($path)) {
   $m=[regex]::Match($line,'^\s*max_connections\s*=\s*''?([0-9]+)''?\s*(#.*)?$')
   if($m.Success) {$value=[int]$m.Groups[1].Value}
  }
 }
 if($null -eq $value) {throw 'max_connections is not set in the PostgreSQL configuration.'}
 return $value
}
function Assert-PoolBudget([int]$Pool,[int]$MaxConnections) {
 # The edge pool may take at most half of the connections left after the 3 reserved ones;
 # the rest stays for the workers, KitchenLink, menu sync, device access, backups and tools.
 $limit=[math]::Floor(($MaxConnections-3)/2)
 if($Pool -gt $limit) {throw "DB_POOL_MAX $Pool is above $limit for max_connections $MaxConnections."}
}
function Get-EdgeRestartPlan {
 $edge=Get-Service PickChickEdge
 if([string]$edge.Status -ne 'Running') {throw 'PickChickEdge is not running; nothing was stopped.'}
 $running=@($edge.DependentServices | Where-Object {[string]$_.Status -ne 'Stopped'})
 $unknown=@($running | Where-Object {$_.Name -notin $script:KnownEdgeDependents})
 if($unknown.Count) {throw ('Unreviewed running Edge dependent: '+(($unknown | ForEach-Object {$_.Name}) -join ', ')+'; nothing was stopped.')}
 foreach($service in $running) {if([string]$service.Status -ne 'Running') {throw ($service.Name+' is '+$service.Status+'; nothing was stopped.')}}
 return ,@($running | ForEach-Object {[string]$_.Name})
}
function Invoke-EdgeRestart([string[]]$Dependents,[scriptblock]$Action,[int]$TimeoutSeconds=60) {
 $stopped=[Collections.Generic.List[string]]::new()
 try {
  foreach($name in @($Dependents)+@('PickChickEdge')) {
   $stopped.Add($name)
   if([string](Get-Service $name).Status -ne 'Stopped') {Stop-Service $name}
   (Get-Service $name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds($TimeoutSeconds))
  }
  & $Action
 } finally {
  $errors=@()
  $order=@($stopped);[array]::Reverse($order)
  foreach($name in $order) {
   try {if([string](Get-Service $name).Status -ne 'Running') {Start-Service $name};(Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds($TimeoutSeconds))} catch {$errors+=$name}
  }
  if($errors.Count) {throw ('Service start needs inspection: '+($errors -join ', '))}
 }
}
function Get-EnvSddl([string]$Path) {return (Get-Acl -LiteralPath $Path).Sddl}
function Set-EnvSddl([string]$Path,[string]$Sddl) {$acl=Get-Acl -LiteralPath $Path;$acl.SetSecurityDescriptorSddlForm($Sddl);Set-Acl -LiteralPath $Path -AclObject $acl}
function Write-EnvCas([string]$Path,[byte[]]$Before,[byte[]]$After) {
 if((Get-PoolBytesHash ([IO.File]::ReadAllBytes($Path))) -cne (Get-PoolBytesHash $Before)) {throw 'edge.env changed meanwhile; nothing written.'}
 $sddl=Get-EnvSddl $Path
 $temp=$Path+'.db-pool-'+[guid]::NewGuid().ToString('N')+'.tmp'
 $h=[IO.File]::Open($temp,'CreateNew','Write','None');try {$h.Write($After,0,$After.Length);$h.Flush($true)} finally {$h.Dispose()}
 try {[IO.File]::Replace($temp,$Path,[Management.Automation.Language.NullString]::Value)} finally {if(Test-Path -LiteralPath $temp) {[IO.File]::Delete($temp)}}
 # ReplaceFile keeps the replaced file's ACL; check it and put it back if it did not.
 if((Get-EnvSddl $Path) -cne $sddl) {Set-EnvSddl $Path $sddl;if((Get-EnvSddl $Path) -cne $sddl) {throw 'edge.env ACL differs after the write.'}}
 if((Get-PoolBytesHash ([IO.File]::ReadAllBytes($Path))) -cne (Get-PoolBytesHash $After)) {throw 'Written edge.env bytes differ.'}
}
function Restore-EnvCas([string]$Path,[byte[]]$Before,[byte[]]$After) {
 $now=Get-PoolBytesHash ([IO.File]::ReadAllBytes($Path))
 if($now -ceq (Get-PoolBytesHash $Before)) {return}
 if($now -cne (Get-PoolBytesHash $After)) {throw 'edge.env holds foreign bytes; not overwritten.'}
 Write-EnvCas $Path $After $Before
}
function Wait-EdgeReady([string]$Url='http://127.0.0.1:3101/health/ready',[int]$TimeoutSeconds=120) {
 $deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
 while([DateTime]::UtcNow -lt $deadline) {
  try {
   $request=[Net.HttpWebRequest]::Create($Url);$request.Timeout=5000;$request.Proxy=$null
   $response=$request.GetResponse()
   try {
    $reader=[IO.StreamReader]::new($response.GetResponseStream());try {$body=$reader.ReadToEnd() | ConvertFrom-Json} finally {$reader.Dispose()}
    if([int]$response.StatusCode -eq 200 -and $body.service -ceq 'edge' -and $body.ready -eq $true) {return}
   } finally {$response.Close()}
  } catch {}
  Start-Sleep -Seconds 2
 }
 throw 'The edge did not become ready.'
}
function Import-ReviewedEnvBytes([string]$File) {
 if((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:ReviewedEnvBytesSha256) {throw 'reviewed-env-bytes.ps1 differs from the pinned file.'}
 $t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$t,[ref]$e)
 if($e.Count) {throw 'reviewed-env-bytes.ps1 does not parse.'}
 $f=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Update-ReviewedEnvBytes'},$false))
 if($f.Count -ne 1) {throw 'Update-ReviewedEnvBytes is missing.'}
 return $f[0].Extent.Text
}

if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop') {throw 'Run in 64-bit Windows PowerShell 5.1.'}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Run elevated.'}
if($Apply -and -not $ExpectedEdgeEnvSha256) {throw '-Apply needs -ExpectedEdgeEnvSha256 from the plan.'}
$folder=$HelperFolder
if(-not $folder) {$folder=$PSScriptRoot}
if(-not $folder -and $MyInvocation.MyCommand.Path) {$folder=Split-Path -Parent $MyInvocation.MyCommand.Path}
if(-not $folder) {throw 'The folder of this script is unknown. Pass -HelperFolder.'}
. ([scriptblock]::Create((Import-ReviewedEnvBytes (Join-Path $folder 'reviewed-env-bytes.ps1'))))

$data='C:\ProgramData\PickChick'
$edgeEnv=Join-Path $data 'Edge\config\edge.env'
$pgData=Join-Path $data 'Postgres\18\data'
$lockPath=Join-Path $data 'EdgeTools\unified-menu-maintenance.lock'
$lease=$null
try {
 # The shared maintenance lock keeps other operators out while edge.env changes.
 if(Test-Path -LiteralPath $lockPath) {$lease=[IO.File]::Open($lockPath,'Open',$(if($Apply){'ReadWrite'}else{'Read'}),'None')}
 $before=[IO.File]::ReadAllBytes($edgeEnv)
 $beforeHash=Get-PoolBytesHash $before
 $prior=Get-DbPoolPrior $before
 $after=Get-DbPoolAfter $before $PoolMax
 $maxConnections=Get-PgMaxConnections $pgData
 Assert-PoolBudget $PoolMax $maxConnections
 $dependents=Get-EdgeRestartPlan
 $changed=(Get-PoolBytesHash $after) -cne $beforeHash
 $plan=[ordered]@{format='pickchick-edge-db-pool-plan-v1';env_sha256=$beforeHash;current_pool=$(if($null -eq $prior){'default 5 (absent)'}else{$prior});target_pool=$PoolMax;max_connections=$maxConnections;change_needed=$changed;restart=@($dependents)+@('PickChickEdge');lock_held=($null -ne $lease)}
 if(-not $Apply) {$plan | ConvertTo-Json -Compress;return}
 if($beforeHash -cne $ExpectedEdgeEnvSha256) {throw 'edge.env differs from the reviewed plan; nothing changed.'}
 if(-not $changed) {[ordered]@{format='pickchick-edge-db-pool-result-v1';completed=$true;changed=$false;pool=$PoolMax;env_sha256=$beforeHash} | ConvertTo-Json -Compress;return}
 $attempt=Join-Path $data ('EdgeTools\db-pool-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
 if(Test-Path -LiteralPath $attempt) {throw 'Attempt folder exists; inspect it first.'}
 $null=[IO.Directory]::CreateDirectory($attempt)
 $copy=Join-Path $attempt 'before.env'
 $h=[IO.File]::Open($copy,'CreateNew','Write','None');try {$h.Write($before,0,$before.Length);$h.Flush($true)} finally {$h.Dispose()}
 if((Get-PoolBytesHash ([IO.File]::ReadAllBytes($copy))) -cne $beforeHash) {throw 'The private copy of edge.env differs; nothing changed.'}
 [IO.File]::WriteAllText((Join-Path $attempt 'plan.json'),($plan | ConvertTo-Json))
 try {
  Invoke-EdgeRestart $dependents {Write-EnvCas $edgeEnv $before $after}
  Wait-EdgeReady
  foreach($name in @($dependents)+@('PickChickEdge')) {if([string](Get-Service $name).Status -ne 'Running') {throw ($name+' is not running.')}}
 } catch {
  $reason=$_.Exception.Message;$restored=$false
  try {Invoke-EdgeRestart $dependents {Restore-EnvCas $edgeEnv $before $after};Wait-EdgeReady;$restored=((Get-PoolBytesHash ([IO.File]::ReadAllBytes($edgeEnv))) -ceq $beforeHash)} catch {}
  [IO.File]::WriteAllText((Join-Path $attempt 'failed.json'),([ordered]@{completed=$false;reason=$reason;restored=$restored} | ConvertTo-Json))
  throw ('DB_POOL_MAX change did not complete ('+$reason+'); previous edge.env restored: '+$restored+'. Inspect '+$attempt+'.')
 }
 $result=[ordered]@{format='pickchick-edge-db-pool-result-v1';completed=$true;changed=$true;previous_pool=$plan.current_pool;pool=$PoolMax;env_before_sha256=$beforeHash;env_after_sha256=(Get-PoolBytesHash ([IO.File]::ReadAllBytes($edgeEnv)));restarted=$plan.restart;attempt=$attempt}
 [IO.File]::WriteAllText((Join-Path $attempt 'result.json'),($result | ConvertTo-Json))
 $result | ConvertTo-Json -Compress
} finally {if($lease) {$lease.Dispose()}}
