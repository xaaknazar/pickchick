#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Automatic Webkassa receipts on the point server (docs/integrations/webkassa-api.md, 25.11.2026).
Default is inspection: it validates the staged private account file and prints the plan without
its contents. -Apply places that file as Edge\config\webkassa.json (service-readable, protected),
adds EDGE_WEBKASSA_ACCOUNT_FILE and EDGE_WEBKASSA_ENVIRONMENT (live for kkm.webkassa.kz, test for
devkkm.webkassa.kz, derived from the account file host and shown in the plan; owner 28.11.2026: the
point issues receipts only with an explicit mode equal to the host) to edge.env under the expected-hash CAS and restarts only
KitchenLink, KitchenLAN, PosSync and Edge. An account file left by an
earlier attempt is validated and reused (run without -AccountFile). Nothing in the database, identity, runtime, prices or other services
changes. A failed activation restores the previous edge.env and restarts Edge again.
-Mode Disable empties the account key (the account file stays for inspection; delete it by hand; EDGE_WEBKASSA_ENVIRONMENT stays in edge.env, it is harmless without the file).
On a point that is already enabled, Enable is idempotent: it adds only the missing EDGE_WEBKASSA_ENVIRONMENT (one restart); with nothing to change it does nothing.
Secrets are never printed, logged or copied anywhere else. #>
[CmdletBinding()]
param(
 [ValidateSet('Enable','Disable')][string]$Mode='Enable',
 [string]$AccountFile,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedEdgeEnvSha256,
 [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Import-WebkassaHelper([string]$File,[string]$Hash,[string[]]$Names) {
 if((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash){throw 'Pinned helper differs.'}
 $t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$t,[ref]$e)
 if($e.Count){throw 'Helper parse failed.'}
 foreach($name in $Names){$f=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$false));if($f.Count -ne 1){throw 'Helper missing.'};$f[0].Extent.Text}
}
function Get-WebkassaBytesHash([byte[]]$Bytes) {
 $h=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($h.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
}
function Assert-WebkassaAccount([byte[]]$Bytes) {
 # Same rules as readWebkassaAccount (packages/webkassa): only Webkassa hosts, a SWK cashbox and
 # five present string fields. Errors never quote a value.
 if($Bytes.Length -lt 2 -or $Bytes.Length -gt 4096){throw 'Account file size is wrong.'}
 $text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes).TrimStart([char]0xFEFF)
 try{$a=$text|ConvertFrom-Json}catch{throw 'Account file is not JSON.'}
 if($a -isnot [pscustomobject]){throw 'Account file is not a JSON object.'}
 $names=@($a.PSObject.Properties|ForEach-Object{$_.Name})
 foreach($key in @('baseUrl','apiKey','login','password','cashboxUniqueNumber')){
  if($names -cnotcontains $key -or $a.$key -isnot [string] -or $a.$key.Length -lt 1 -or $a.$key.Length -gt 500 -or $a.$key -match '[\x00-\x1f]'){throw ('Account field missing or invalid: '+$key)}
 }
 foreach($name in $names){if(@('baseUrl','apiKey','login','password','cashboxUniqueNumber') -cnotcontains $name){throw 'Unknown account field.'}}
 if($a.baseUrl -cnotmatch '^https://(devkkm|kkm)\.webkassa\.kz/?$'){throw 'Account baseUrl must be a Webkassa host.'}
 if($a.cashboxUniqueNumber -cnotmatch '^SWK\d{8}$'){throw 'Account cashbox must be SWK and 8 digits.'}
 return [ordered]@{host=([Uri]$a.baseUrl).Host;cashbox=$a.cashboxUniqueNumber}
}
function Get-WebkassaMode([string]$HostName) {
 # The mode the point server must be told explicitly (EDGE_WEBKASSA_ENVIRONMENT): kkm is live, devkkm is test.
 if($HostName -ceq 'kkm.webkassa.kz'){return 'live'}
 if($HostName -ceq 'devkkm.webkassa.kz'){return 'test'}
 throw 'Account host has no Webkassa mode.'
}
function Get-WebkassaEnvAssignment([byte[]]$Bytes,[string]$Key) {
 $text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes)
 $m=@([regex]::Matches($text,'(?m)^'+[regex]::Escape($Key)+'=(.*?)\r?$'))
 if($m.Count -gt 1){throw 'Ambiguous environment assignment'}
 if($m.Count -eq 0){return $null}
 return $m[0].Groups[1].Value
}
function Set-WebkassaEnvironmentBytes([byte[]]$Bytes,[string]$Mode) {
 # Never overwrites an explicit different value: that is an operator conflict to settle by hand.
 $current=Get-WebkassaEnvAssignment $Bytes 'EDGE_WEBKASSA_ENVIRONMENT'
 if($null -ne $current -and $current -ne '' -and $current -cne $Mode){throw 'EDGE_WEBKASSA_ENVIRONMENT differs from the account file host; settle it by hand.'}
 if($Mode -ceq 'test' -and (Get-WebkassaEnvAssignment $Bytes 'EDGE_WEBKASSA_REQUIRE_LIVE') -ceq 'true'){throw 'EDGE_WEBKASSA_REQUIRE_LIVE=true contradicts a test account file.'}
 if($current -ceq $Mode){return ,$Bytes}
 return ,(Update-ReviewedEnvBytes $Bytes 'EDGE_WEBKASSA_ENVIRONMENT' '' $Mode -AllowAbsent)
}
function Get-WebkassaEnableBytes([byte[]]$Before,[string]$Target,[string]$Mode) {
 # Idempotent Enable: a key already set to this very file is kept as is, so an already enabled
 # point only gets the missing mode line; the rest of edge.env stays byte for byte.
 $current=Get-WebkassaEnvAssignment $Before 'EDGE_WEBKASSA_ACCOUNT_FILE'
 if($null -ne $current -and $current -ne '' -and $current -cne $Target){throw 'EDGE_WEBKASSA_ACCOUNT_FILE points elsewhere; settle it by hand.'}
 $bytes=$Before
 if($current -cne $Target){$bytes=Update-ReviewedEnvBytes $Before 'EDGE_WEBKASSA_ACCOUNT_FILE' '' $Target -AllowAbsent}
 return ,(Set-WebkassaEnvironmentBytes $bytes $Mode)
}
function Wait-WebkassaEdgeReady([int]$Seconds=120) {
 $until=[DateTime]::UtcNow.AddSeconds($Seconds)
 while([DateTime]::UtcNow -lt $until){
  try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://127.0.0.1:3101/health/ready';if($r.StatusCode -eq 200){return}}catch{}
  Start-Sleep -Seconds 2
 }
 throw 'Edge did not become ready.'
}
function Invoke-WebkassaEdgeRestart([scriptblock]$Action,[switch]$ResumeStopped) {
 # Reviewed Edge dependents on a point server: KitchenLink, KitchenLAN and PosSync. Each is
 # stopped before Edge only when it runs, and started again after Edge in the same reverse order.
 $reviewed=@('PickChickPosSync','PickChickKitchenLAN','PickChickKitchenLink')
 $unknown=@((Get-Service PickChickEdge).DependentServices|Where-Object{$_.Status -ne 'Stopped' -and $reviewed -cnotcontains $_.Name})
 if($unknown.Count){throw 'Unreviewed Edge dependent; no service stopped.'}
 $edge=Get-Service PickChickEdge
 if($edge.Status -ne 'Running' -and -not ($ResumeStopped -and $edge.Status -eq 'Stopped')){throw 'Edge not initially running.'}
 $running=@()
 foreach($name in $reviewed){$s=Get-Service $name -ErrorAction SilentlyContinue;if($s -and ($s.Status -eq 'Running' -or ($ResumeStopped -and $s.Status -eq 'Stopped' -and $script:webkassaStarted -contains $name))){$running+=$name}}
 $running+='PickChickEdge'
 $script:webkassaStarted=@($running)
 try{
  foreach($name in $running){if((Get-Service $name).Status -ne 'Stopped'){Stop-Service $name};(Get-Service $name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(35))}
  & $Action
 }finally{
  $errors=@();$order=@($running);[array]::Reverse($order)
  foreach($name in $order){try{if((Get-Service $name).Status -ne 'Running'){Start-Service $name};(Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(35))}catch{$errors+=$name}}
  if($errors.Count){throw ('Service recovery needs inspection: '+($errors -join ', '))}
 }
}
function Write-WebkassaEnvCas([string]$Path,[byte[]]$Before,[byte[]]$After) {
 Assert-Acl $Path -Foundation -ServiceRead -InheritedAllowed
 if((Get-WebkassaBytesHash ([IO.File]::ReadAllBytes($Path))) -cne (Get-WebkassaBytesHash $Before)){throw 'Concurrent environment change.'}
 $temp=$Path+'.webkassa-'+[guid]::NewGuid().ToString('N')+'.tmp'
 $h=[IO.File]::Open($temp,'CreateNew','Write','None');try{$h.Write($After,0,$After.Length);$h.Flush($true)}finally{$h.Dispose()}
 Set-ProtectedAcl $temp -ServiceRead
 [IO.File]::Replace($temp,$Path,[Management.Automation.Language.NullString]::Value)
 Assert-Acl $Path -Foundation -ServiceRead -InheritedAllowed
 if((Hash-File $Path) -cne (Get-WebkassaBytesHash $After)){throw 'Replaced environment bytes differ.'}
}

$script:webkassaStarted=@()
if($MyInvocation.InvocationName -eq '.'){return}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop'){throw 'Elevated Windows PowerShell 5.1 required.'}
$script:operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($d in (Import-WebkassaHelper (Join-Path $PSScriptRoot 'install-native-menu-sync.ps1') 'ff955a154aa4cfa8507474cef2ac37ae19b9b1d7e4fc46b8fe0f14a5a323831c' @('Assert-NtfsPath','Assert-Acl','Set-ProtectedAcl','Hash-File','Write-NewText'))){. ([scriptblock]::Create($d))}
foreach($d in (Import-WebkassaHelper (Join-Path $PSScriptRoot 'reviewed-env-bytes.ps1') '00412db264f47a3b7c2996fb44115e46ae63a965710943f1b5c725e9156137c3' @('Update-ReviewedEnvBytes'))){. ([scriptblock]::Create($d))}
$data='C:\ProgramData\PickChick'
$edgeEnv=Join-Path $data 'Edge\config\edge.env';$target=Join-Path $data 'Edge\config\webkassa.json'
$lockPath=Join-Path $data 'EdgeTools\unified-menu-maintenance.lock';$lease=$null
try{
 Assert-Acl $lockPath -Foundation -InheritedAllowed
 $lease=[IO.File]::Open($lockPath,'Open',$(if($Apply){'ReadWrite'}else{'Read'}),'None')
 Assert-Acl $edgeEnv -Foundation -ServiceRead -InheritedAllowed
 $before=[IO.File]::ReadAllBytes($edgeEnv)
 if((Get-WebkassaBytesHash $before) -cne $ExpectedEdgeEnvSha256){throw 'edge.env differs from the inspected hash.'}
 if($Mode -ceq 'Disable'){
  $after=Update-ReviewedEnvBytes $before 'EDGE_WEBKASSA_ACCOUNT_FILE' $target ''
  $account=$null;$reuse=$false
 }else{
  $reuse=Test-Path -LiteralPath $target
  if($reuse){
   # A file this operator placed earlier (protected, service-read) is validated and reused;
   # it is never overwritten. A new staged file is refused while one is in place.
   if($AccountFile){throw 'An account file is already in place; run without -AccountFile to reuse it, never overwrite.'}
   Assert-NtfsPath $target;Assert-Acl $target -ServiceRead
   $bytes=[IO.File]::ReadAllBytes($target)
  }else{
   if(-not $AccountFile){throw 'Staged account file required.'}
   Assert-NtfsPath $AccountFile;Assert-Acl $AccountFile -Foundation -InheritedAllowed
   $bytes=[IO.File]::ReadAllBytes($AccountFile)
  }
  $account=Assert-WebkassaAccount $bytes;$account['reused_file']=$reuse
  $account['environment']=Get-WebkassaMode $account.host
  $after=Get-WebkassaEnableBytes $before $target $account.environment
 }
 $plan=[ordered]@{format='pickchick-webkassa-edge-plan-v1';mode=$Mode;account=$account;target=$target;env_before_sha256=(Get-WebkassaBytesHash $before);env_after_sha256=(Get-WebkassaBytesHash $after);changed=((Get-WebkassaBytesHash $after) -cne (Get-WebkassaBytesHash $before));restart=@('PickChickPosSync','PickChickKitchenLAN','PickChickKitchenLink','PickChickEdge')}
 if(-not $Apply){$plan|ConvertTo-Json -Depth 6 -Compress;return}
 if($Mode -cne 'Disable' -and $reuse -and -not $plan.changed){$plan['completed']=$true;$plan|ConvertTo-Json -Depth 6 -Compress;return}
 $attempt=Join-Path $data ('EdgeTools\webkassa-'+[guid]::NewGuid().ToString('N'))
 Set-ProtectedAcl $attempt -Directory
 $saved=Join-Path $attempt 'before.env';$h=[IO.File]::Open($saved,'CreateNew','Write','None');try{$h.Write($before,0,$before.Length);$h.Flush($true)}finally{$h.Dispose()};Set-ProtectedAcl $saved
 if((Hash-File $saved) -cne $ExpectedEdgeEnvSha256){throw 'Private environment copy failed.'}
 Write-NewText (Join-Path $attempt 'intent.json') ($plan|ConvertTo-Json -Depth 6)
 if($Mode -cne 'Disable' -and -not $reuse){
  $h=[IO.File]::Open($target,'CreateNew','Write','None');try{$h.Write($bytes,0,$bytes.Length);$h.Flush($true)}finally{$h.Dispose()}
  Set-ProtectedAcl $target -ServiceRead
  if((Hash-File $target) -cne (Get-WebkassaBytesHash $bytes)){throw 'Placed account bytes differ.'}
 }
 try{
  Invoke-WebkassaEdgeRestart {Write-WebkassaEnvCas $edgeEnv $before $after}
  Wait-WebkassaEdgeReady
  if((Hash-File $edgeEnv) -cne (Get-WebkassaBytesHash $after)){throw 'Final environment differs.'}
 }catch{
  $restored=$false
  try{Invoke-WebkassaEdgeRestart {if((Hash-File $edgeEnv) -cne $ExpectedEdgeEnvSha256){Write-WebkassaEnvCas $edgeEnv $after $before}} -ResumeStopped;Wait-WebkassaEdgeReady;$restored=((Hash-File $edgeEnv) -ceq $ExpectedEdgeEnvSha256)}catch{}
  Write-NewText (Join-Path $attempt 'failed.json') (@{completed=$false;rollback_verified=$restored;inspect_required=$true}|ConvertTo-Json)
  throw 'Webkassa activation did not complete; inspect the retained attempt before another command.'
 }
 $result=[ordered]@{format='pickchick-webkassa-edge-ready-v1';mode=$Mode;account=$account;env_after_sha256=(Hash-File $edgeEnv);completed_epoch=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}
 Write-NewText (Join-Path $attempt 'verified.json') ($result|ConvertTo-Json -Depth 6)
 $result|ConvertTo-Json -Depth 6 -Compress
}finally{if($lease){$lease.Dispose()}}
