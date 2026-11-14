# Executes the functions of set-native-edge-db-pool.ps1 on temp files and a mocked service
# manager. Never reads a real edge.env and never touches real services.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
foreach($file in @('set-native-edge-db-pool.ps1','reviewed-env-bytes.ps1')) {
 $t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot ('../../infra/windows/'+$file)),[ref]$t,[ref]$e)
 if($e.Count) {throw ($e | Out-String)}
 foreach($f in $a.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) {. ([scriptblock]::Create($f.Extent.Text))}
}
$script:KnownEdgeDependents=@('PickChickKitchenLink','PickChickKitchenLAN')
$count=0
function Check($x,$m) {if(-not $x) {throw $m};$script:count++}
function Rejects([scriptblock]$x,$m) {$caught=$false;try {& $x | Out-Null} catch {$caught=$true};Check $caught $m}
function Bytes([string]$s) {return ,[Text.UTF8Encoding]::new($false).GetBytes($s)}
function Text([byte[]]$b) {return [Text.UTF8Encoding]::new($false).GetString($b)}

# Value parsing and the one-line change.
$base="APP_ENV=local`r`nEDGE_BRANCH_ID=b`nEDGE_DATABASE_URL=postgresql://u:p@127.0.0.1:55433/x`r`n# note`n"
Check ($null -eq (Get-DbPoolPrior (Bytes $base))) 'Absent pool reads as default'
Check ((Text (Get-DbPoolAfter (Bytes $base) 12)) -ceq ($base+"DB_POOL_MAX=12`n")) 'Absent pool appended with the last line ending, prefix untouched'
$crlf="APP_ENV=local`r`nDB_POOL_MAX=5`r`nEDGE_PORT=3101`n"
Check ((Get-DbPoolPrior (Bytes $crlf)) -ceq '5') 'Present pool read through CRLF'
Check ((Text (Get-DbPoolAfter (Bytes $crlf) 12)) -ceq "APP_ENV=local`r`nDB_POOL_MAX=12`r`nEDGE_PORT=3101`n") 'Only the value changes'
$same=Get-DbPoolAfter (Bytes $crlf) 5
Check ((Get-PoolBytesHash $same) -ceq (Get-PoolBytesHash (Bytes $crlf))) 'Same value keeps bytes'
Rejects {Get-DbPoolPrior (Bytes "DB_POOL_MAX=5`nDB_POOL_MAX=6`n")} 'Duplicate pool refused'
Rejects {Get-DbPoolPrior (Bytes "DB_POOL_MAX=five`n")} 'Non-numeric pool refused'
Rejects {Get-DbPoolPrior (Bytes "DB_POOL_MAX=65`n")} 'Pool above 64 refused'
Rejects {Get-DbPoolPrior (Bytes "DB_POOL_MAX=0`n")} 'Zero pool refused'
Rejects {Get-DbPoolAfter (Bytes "APP_ENV=a`nAPP_ENV=b`n") 12} 'Ambiguous unrelated key refused by the reviewed transformer'
Rejects {Get-DbPoolAfter (Bytes "APP_ENV=a") 12} 'Unterminated file refused'
Rejects {Get-DbPoolAfter ([byte[]](@(239,187,191)+[Text.Encoding]::ASCII.GetBytes("APP_ENV=a`n"))) 12} 'BOM refused'

# PostgreSQL budget.
$temp=Join-Path ([IO.Path]::GetTempPath()) ('db-pool-'+[guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($temp)
try {
 [IO.File]::WriteAllText((Join-Path $temp 'postgresql.conf'),"listen_addresses = '127.0.0.1'`nmax_connections = 40`nshared_buffers = '128MB'`n")
 Check ((Get-PgMaxConnections $temp) -eq 40) 'max_connections read'
 [IO.File]::WriteAllText((Join-Path $temp 'postgresql.auto.conf'),"# ALTER SYSTEM`nmax_connections = '60'`n")
 Check ((Get-PgMaxConnections $temp) -eq 60) 'ALTER SYSTEM value wins'
 Remove-Item (Join-Path $temp 'postgresql.auto.conf')
 [IO.File]::WriteAllText((Join-Path $temp 'postgresql.conf'),"#max_connections = 100`n")
 Rejects {Get-PgMaxConnections $temp} 'Commented max_connections is not a value'
 Assert-PoolBudget 12 40;Check $true 'Pool 12 fits max_connections 40'
 Assert-PoolBudget 18 40;Check $true 'Pool 18 is the limit for 40'
 Rejects {Assert-PoolBudget 19 40} 'Pool above half of the free connections refused'

 # Byte CAS on a real temp file; ACL calls are mocked (Get-Acl is Windows-only).
 $script:sddl='O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;LS)'
 function Get-EnvSddl([string]$Path) {return $script:sddl}
 function Set-EnvSddl([string]$Path,[string]$Sddl) {$script:sddl=$Sddl}
 $path=Join-Path $temp 'edge.env';$before=Bytes $crlf;$after=Get-DbPoolAfter $before 12
 [IO.File]::WriteAllBytes($path,$before)
 Write-EnvCas $path $before $after
 Check ((Get-PoolBytesHash ([IO.File]::ReadAllBytes($path))) -ceq (Get-PoolBytesHash $after)) 'Pool written'
 Check (@(Get-ChildItem $temp -Filter '*.tmp').Count -eq 0) 'No temp file left'
 Rejects {Write-EnvCas $path $before $after} 'Stale CAS refused'
 Restore-EnvCas $path $before $after
 Check ((Get-PoolBytesHash ([IO.File]::ReadAllBytes($path))) -ceq (Get-PoolBytesHash $before)) 'Previous bytes restored exactly'
 Restore-EnvCas $path $before $after;Check $true 'Restore of already previous bytes is a no-op'
 [IO.File]::WriteAllText($path,"FOREIGN=1`n")
 Rejects {Restore-EnvCas $path $before $after} 'Foreign bytes kept'
 Check ([IO.File]::ReadAllText($path) -ceq "FOREIGN=1`n") 'Foreign bytes not overwritten'
 # ACL drift after the write is put back.
 [IO.File]::WriteAllBytes($path,$before)
 $script:drift=$true
 function Get-EnvSddl([string]$Path) {if($script:drift) {$script:drift=$false;return $script:sddl};return 'O:BAG:SYD:(A;;FA;;;WD)'}
 $script:set=''
 function Set-EnvSddl([string]$Path,[string]$Sddl) {$script:set=$Sddl}
 Rejects {Write-EnvCas $path $before $after} 'ACL that cannot be put back fails the write'
 Check ($script:set -ceq 'O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;LS)') 'Original ACL was put back'
} finally {Remove-Item $temp -Recurse -Force}

# Mocked service manager.
$script:states=@{};$script:events=[Collections.Generic.List[string]]::new();$script:extra=$null;$script:startFailure=''
function Reset-Scm {$script:states=@{PickChickEdge='Running';PickChickKitchenLink='Running';PickChickKitchenLAN='Running'};$script:events.Clear();$script:extra=$null;$script:startFailure=''}
function Get-Service($Name) {
 $s=[pscustomobject]@{Name=$Name;Status=$script:states[$Name];DependentServices=@()}
 if($Name -eq 'PickChickEdge') {
  $deps=@([pscustomobject]@{Name='PickChickKitchenLink';Status=$script:states.PickChickKitchenLink},[pscustomobject]@{Name='PickChickKitchenLAN';Status=$script:states.PickChickKitchenLAN})
  if($script:extra) {$deps+=[pscustomobject]@{Name=$script:extra;Status='Running'}}
  $s.DependentServices=$deps
 }
 $s | Add-Member ScriptMethod WaitForStatus {param($status,$timeout) if($script:states[$this.Name] -ne [string]$status) {throw 'SCM wait failed'}}
 return $s
}
function Stop-Service($Name) {$script:events.Add('stop:'+$Name);$script:states[$Name]='Stopped'}
function Start-Service($Name) {$script:events.Add('start:'+$Name);if($script:startFailure -eq $Name) {throw 'Start failed'};$script:states[$Name]='Running'}

Reset-Scm
$deps=Get-EdgeRestartPlan
Check (($deps -join ',') -ceq 'PickChickKitchenLink,PickChickKitchenLAN') 'Known dependents planned'
$script:acted=$false
Invoke-EdgeRestart $deps {$script:acted=$true;Check ($script:states.PickChickEdge -eq 'Stopped' -and $script:states.PickChickKitchenLAN -eq 'Stopped') 'Action runs with all stopped'}
Check $script:acted 'Action ran'
Check (($script:events -join ',') -ceq 'stop:PickChickKitchenLink,stop:PickChickKitchenLAN,stop:PickChickEdge,start:PickChickEdge,start:PickChickKitchenLAN,start:PickChickKitchenLink') 'Dependents stop first and start last'
Reset-Scm;$script:states.PickChickKitchenLAN='Stopped'
Check (((Get-EdgeRestartPlan) -join ',') -ceq 'PickChickKitchenLink') 'A stopped dependent stays stopped'
Reset-Scm;$script:extra='Foreign'
Rejects {Get-EdgeRestartPlan} 'Unknown dependent refused'
Check ($script:events.Count -eq 0) 'Nothing stopped for an unknown dependent'
Reset-Scm;$script:states.PickChickEdge='Stopped'
Rejects {Get-EdgeRestartPlan} 'Stopped edge refused'
Reset-Scm
Rejects {Invoke-EdgeRestart @('PickChickKitchenLink') {throw 'write failed'}} 'Action failure surfaces'
Check ($script:states.PickChickEdge -eq 'Running' -and $script:states.PickChickKitchenLink -eq 'Running') 'Services started again after a failed action'
Reset-Scm;$script:startFailure='PickChickKitchenLink'
$message='';try {Invoke-EdgeRestart @('PickChickKitchenLink') {}} catch {$message=$_.Exception.Message}
Check ($message -like '*PickChickKitchenLink*') 'Start failure names the service'
Check ($script:states.PickChickEdge -eq 'Running') 'Edge started although a dependent failed'

Write-Output "edge db pool checks passed: $count"
