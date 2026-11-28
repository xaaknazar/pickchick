# Executable guards for enable-webkassa-edge.ps1: account validation, byte CAS and mocked SCM.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
foreach($file in @('enable-webkassa-edge.ps1','reviewed-env-bytes.ps1')) {
 $t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot ('../../infra/windows/'+$file)),[ref]$t,[ref]$e)
 if($e.Count){throw ($e|Out-String)}
 foreach($f in $a.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([scriptblock]::Create($f.Extent.Text))}
}
$count=0
function Check($x,$m){if(-not $x){throw $m};$script:count++}
function Rejects([scriptblock]$x,$m){$caught=$false;try{& $x|Out-Null}catch{$caught=$true;if($_.Exception.Message -match 'synthetic-secret'){throw ('Secret leaked: '+$m)}};Check $caught $m}
function Bytes($o){[Text.Encoding]::UTF8.GetBytes(($o|ConvertTo-Json -Compress))}
function Copy-Account {$c=[ordered]@{};foreach($k in $good.Keys){$c[$k]=$good[$k]};return $c}
$good=[ordered]@{baseUrl='https://devkkm.webkassa.kz';apiKey='synthetic-secret-key';login='synthetic-secret@example.test';password='synthetic-secret-pass';cashboxUniqueNumber='SWK00000001'}
$r=Assert-WebkassaAccount (Bytes $good)
Check ($r.host -ceq 'devkkm.webkassa.kz' -and $r.cashbox -ceq 'SWK00000001') 'Valid account summarised'
Check (-not (($r|ConvertTo-Json) -match 'synthetic-secret')) 'Summary carries no secret'
# Owner 28.11.2026: the explicit mode is derived from the account host: devkkm is test, kkm is live.
Check ((Get-WebkassaMode 'devkkm.webkassa.kz') -ceq 'test') 'devkkm host means the test mode'
Check ((Get-WebkassaMode 'kkm.webkassa.kz') -ceq 'live') 'kkm host means the live mode'
Rejects {Get-WebkassaMode 'evil.example'} 'Foreign host has no mode'
$prod=(Copy-Account);$prod.baseUrl='https://kkm.webkassa.kz/';Check ((Assert-WebkassaAccount (Bytes $prod)).host -ceq 'kkm.webkassa.kz') 'Production host accepted'
foreach($field in @('baseUrl','apiKey','login','password','cashboxUniqueNumber')){
 $bad=(Copy-Account);$bad.Remove($field);Rejects {Assert-WebkassaAccount (Bytes $bad)} ('Missing '+$field)
 $bad=(Copy-Account);$bad[$field]='';Rejects {Assert-WebkassaAccount (Bytes $bad)} ('Empty '+$field)
 $bad=(Copy-Account);$bad[$field]=5;Rejects {Assert-WebkassaAccount (Bytes $bad)} ('Number '+$field)
}
$bad=(Copy-Account);$bad.baseUrl='https://evil.example/';Rejects {Assert-WebkassaAccount (Bytes $bad)} 'Foreign host'
$bad=(Copy-Account);$bad.baseUrl='http://devkkm.webkassa.kz';Rejects {Assert-WebkassaAccount (Bytes $bad)} 'Plain http'
$bad=(Copy-Account);$bad.cashboxUniqueNumber='ABC1';Rejects {Assert-WebkassaAccount (Bytes $bad)} 'Cashbox shape'
$bad=(Copy-Account);$bad.extra='x';Rejects {Assert-WebkassaAccount (Bytes $bad)} 'Unknown field'
$bad=(Copy-Account);$bad.password="synthetic-secret`n";Rejects {Assert-WebkassaAccount (Bytes $bad)} 'Control character'
Rejects {Assert-WebkassaAccount ([Text.Encoding]::UTF8.GetBytes('[1,2]'))} 'Array'
Rejects {Assert-WebkassaAccount ([Text.Encoding]::UTF8.GetBytes('synthetic-secret'))} 'Not JSON'
Rejects {Assert-WebkassaAccount ([byte[]]::new(5000))} 'Too large'
$bom=[byte[]](@(239,187,191)+(Bytes $good));Check ((Assert-WebkassaAccount $bom).cashbox -ceq 'SWK00000001') 'BOM tolerated'
# Byte CAS on a real temp file with ACL helpers mocked.
function Assert-Acl {param($Path,[switch]$Foundation,[switch]$ServiceRead,[switch]$InheritedAllowed)}
function Set-ProtectedAcl {param($Path,[switch]$ServiceRead)}
function Assert-NtfsPath {param($Path)}
function Hash-File($Path){(Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('webkassa-cas-'+[guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($temp)
try{
 $path=Join-Path $temp 'edge.env';$target='C:\ProgramData\PickChick\Edge\config\webkassa.json'
 $before=[Text.Encoding]::UTF8.GetBytes("UNCHANGED=one`r`nEDGE_REMOTE_STOPS_ENABLED=true`n# untouched`r`n")
 $after=Update-ReviewedEnvBytes $before 'EDGE_WEBKASSA_ACCOUNT_FILE' '' $target -AllowAbsent
 Check ([Text.Encoding]::UTF8.GetString($after) -ceq ([Text.Encoding]::UTF8.GetString($before)+'EDGE_WEBKASSA_ACCOUNT_FILE='+$target+"`r`n")) 'Key appended, prefix preserved'
 [IO.File]::WriteAllBytes($path,$before);Write-WebkassaEnvCas $path $before $after
 Check ((Hash-File $path) -ceq (Get-WebkassaBytesHash $after)) 'Enabled bytes written'
 Rejects {Write-WebkassaEnvCas $path $before $after} 'Stale CAS'
 Write-WebkassaEnvCas $path $after $before;Check ((Hash-File $path) -ceq (Get-WebkassaBytesHash $before)) 'Rollback restores exact bytes'
 $modeOn=Set-WebkassaEnvironmentBytes $after 'test'
 Check ([Text.Encoding]::UTF8.GetString($modeOn) -ceq ([Text.Encoding]::UTF8.GetString($after)+"EDGE_WEBKASSA_ENVIRONMENT=test`r`n")) 'Mode key appended, prefix preserved'
 Check ((Get-WebkassaEnvAssignment $modeOn 'EDGE_WEBKASSA_ENVIRONMENT') -ceq 'test') 'Mode value read back'
 Check ($null -eq (Get-WebkassaEnvAssignment $after 'EDGE_WEBKASSA_ENVIRONMENT')) 'Absent mode key reads as null'
 $again=Set-WebkassaEnvironmentBytes $modeOn 'test'
 Check ((Get-WebkassaBytesHash $again) -ceq (Get-WebkassaBytesHash $modeOn)) 'A matching mode already in edge.env is kept as is'
 Rejects {Set-WebkassaEnvironmentBytes $modeOn 'live'} 'A different explicit mode is a conflict, never overwritten'
 $legacyLive=[Text.Encoding]::UTF8.GetBytes("EDGE_WEBKASSA_REQUIRE_LIVE=true`r`n")
 Rejects {Set-WebkassaEnvironmentBytes $legacyLive 'test'} 'The old live flag contradicts a test file'
 Check ([Text.Encoding]::UTF8.GetString((Set-WebkassaEnvironmentBytes $legacyLive 'live')) -match 'EDGE_WEBKASSA_ENVIRONMENT=live') 'The old live flag agrees with a live file'
 # Already enabled point without a mode: only the mode line is added, the rest stays byte for byte.
 $enabled=[Text.Encoding]::UTF8.GetBytes("UNCHANGED=one`r`nEDGE_WEBKASSA_ACCOUNT_FILE=$target`r`n# tail`n")
 $added=Get-WebkassaEnableBytes $enabled $target 'test'
 Check ([Text.Encoding]::UTF8.GetString($added) -ceq ([Text.Encoding]::UTF8.GetString($enabled)+"EDGE_WEBKASSA_ENVIRONMENT=test`n")) 'Enabled point gets only the mode line'
 $rerun=Get-WebkassaEnableBytes $added $target 'test'
 Check ((Get-WebkassaBytesHash $rerun) -ceq (Get-WebkassaBytesHash $added)) 'A second Enable changes nothing'
 Check ((Get-WebkassaBytesHash (Get-WebkassaEnableBytes $enabled $target 'test')) -cne (Get-WebkassaBytesHash $enabled)) 'The missing mode is a change to apply'
 Rejects {Get-WebkassaEnableBytes $enabled 'C:\other\webkassa.json' 'test'} 'A key pointing at another file is never overwritten'
 $fresh=Get-WebkassaEnableBytes $before $target 'live'
 Check ([Text.Encoding]::UTF8.GetString($fresh) -ceq ([Text.Encoding]::UTF8.GetString($before)+'EDGE_WEBKASSA_ACCOUNT_FILE='+$target+"`r`nEDGE_WEBKASSA_ENVIRONMENT=live`r`n")) 'A new point gets both keys'
 Rejects {Get-WebkassaEnableBytes $added $target 'live'} 'Enabled test point is not silently switched to live'
 $off=Update-ReviewedEnvBytes $after 'EDGE_WEBKASSA_ACCOUNT_FILE' $target ''
 Check ([Text.Encoding]::UTF8.GetString($off) -match 'EDGE_WEBKASSA_ACCOUNT_FILE=\r\n$') 'Disable empties the key'
 Rejects {Update-ReviewedEnvBytes $before 'EDGE_WEBKASSA_ACCOUNT_FILE' $target ''} 'Disable needs the reviewed key'
 $dup=[Text.Encoding]::UTF8.GetBytes("EDGE_WEBKASSA_ACCOUNT_FILE=a`nEDGE_WEBKASSA_ACCOUNT_FILE=a`n")
 Rejects {Update-ReviewedEnvBytes $dup 'EDGE_WEBKASSA_ACCOUNT_FILE' 'a' ''} 'Duplicate key'
 Check (-not (Get-ChildItem $temp -Filter '*.tmp')) 'No temp file left'
}finally{Remove-Item $temp -Recurse -Force}
# Mock SCM: Edge with the three reviewed dependents of a point server.
$script:states=@{};$script:events=[Collections.Generic.List[string]]::new();$script:unknown=$false;$script:startFailure=''
function Reset-Scm {$script:states=@{PickChickEdge='Running';PickChickKitchenLink='Running';PickChickKitchenLAN='Running';PickChickPosSync='Running'};$script:events.Clear();$script:unknown=$false;$script:startFailure='';$script:webkassaStarted=@()}
function Get-Service {
 [CmdletBinding()]param([Parameter(Position=0)]$Name)
 if(-not $script:states.ContainsKey($Name)){if($ErrorActionPreference -eq 'SilentlyContinue'){return $null};throw 'No such service'}
 $s=[pscustomobject]@{Name=$Name;Status=$script:states[$Name];DependentServices=@()}
 if($Name -eq 'PickChickEdge'){$s.DependentServices=@(foreach($d in @('PickChickKitchenLink','PickChickKitchenLAN','PickChickPosSync')){if($script:states.ContainsKey($d)){[pscustomobject]@{Name=$d;Status=$script:states[$d]}}});if($script:unknown){$s.DependentServices+=[pscustomobject]@{Name='Foreign';Status='Running'}}}
 $s|Add-Member ScriptMethod WaitForStatus {param($status,$timeout)if($script:states[$this.Name] -ne [string]$status){throw 'SCM wait failed'}}
 return $s
}
function Stop-Service($Name){$script:events.Add('stop:'+$Name);$script:states[$Name]='Stopped'}
function Start-Service($Name){$script:events.Add('start:'+$Name);if($script:startFailure -eq $Name){$script:startFailure='';throw 'Start failed'};$script:states[$Name]='Running'}
$all='stop:PickChickPosSync,stop:PickChickKitchenLAN,stop:PickChickKitchenLink,stop:PickChickEdge,replace,start:PickChickEdge,start:PickChickKitchenLink,start:PickChickKitchenLAN,start:PickChickPosSync'
Reset-Scm;Invoke-WebkassaEdgeRestart {$script:events.Add('replace')}
Check (($script:events -join ',') -ceq $all) 'Edge and its reviewed dependents restart in order'
Reset-Scm;$script:states.PickChickKitchenLAN='Stopped';Invoke-WebkassaEdgeRestart {$script:events.Add('replace')}
Check (-not ($script:events -contains 'start:PickChickKitchenLAN') -and $script:states.PickChickKitchenLAN -ceq 'Stopped') 'A stopped dependent stays stopped'
Reset-Scm;$script:states.Remove('PickChickKitchenLAN');Invoke-WebkassaEdgeRestart {$script:events.Add('replace')}
Check (($script:events -join ',') -ceq 'stop:PickChickPosSync,stop:PickChickKitchenLink,stop:PickChickEdge,replace,start:PickChickEdge,start:PickChickKitchenLink,start:PickChickPosSync') 'Missing dependent is skipped'
Reset-Scm;$script:unknown=$true;Rejects {Invoke-WebkassaEdgeRestart {throw 'unreachable'}} 'Unknown dependent';Check ($script:events.Count -eq 0) 'Nothing stopped on unknown dependent'
Reset-Scm;$script:states.PickChickEdge='Stopped';Rejects {Invoke-WebkassaEdgeRestart {throw 'unreachable'}} 'Stopped Edge refused without resume';Check ($script:events.Count -eq 0) 'Nothing touched when Edge is down'
Reset-Scm;Rejects {Invoke-WebkassaEdgeRestart {throw 'CAS failed'}} 'CAS failure propagated'
Check (@($script:states.Values|Where-Object{$_ -ne 'Running'}).Count -eq 0) 'All services recover after CAS failure'
Reset-Scm;$script:startFailure='PickChickEdge';Rejects {Invoke-WebkassaEdgeRestart {}} 'Failed start is not success'
Check ($script:states.PickChickEdge -ceq 'Stopped') 'Edge left stopped after its failed start'
$script:events.Clear();Invoke-WebkassaEdgeRestart {$script:events.Add('restore')} -ResumeStopped
Check (@($script:states.Values|Where-Object{$_ -ne 'Running'}).Count -eq 0) 'Rollback resumes a stopped Edge and every dependent it had stopped'
Write-Output "$count webkassa edge guard checks passed"
