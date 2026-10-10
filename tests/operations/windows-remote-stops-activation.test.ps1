# Executable guards, actual temp-file byte CAS and simulated SCM failure paths only.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
foreach($file in @('enable-native-remote-stops.ps1','reviewed-env-bytes.ps1')) {
 $t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot ('../../infra/windows/'+$file)),[ref]$t,[ref]$e)
 if($e.Count){throw ($e|Out-String)}
 foreach($f in $a.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([scriptblock]::Create($f.Extent.Text))}
}
$count=0
function Check($x,$m){if(-not $x){throw $m};$script:count++}
function Rejects([scriptblock]$x,$m){$caught=$false;try{& $x|Out-Null}catch{$caught=$true};Check $caught $m}
function Clone($x){$x|ConvertTo-Json -Depth 15|ConvertFrom-Json}
$sha='a'*40;$branch='11111111-1111-4111-8111-111111111111';$device='22222222-2222-4222-8222-222222222222'
$head=[ordered]@{format='pickchick-unified-menu-head-v1';source_sha=$sha;branch_id=$branch;edge_device_id=$device;completed_epoch=1000;catalog_version=6;menu_release_id='33333333-3333-4333-8333-333333333333';menu_version=7;menu_hash='b'*64}
$menu=@{branch_id=$branch;edge_device_id=$device;schema=20;grants_verified=$true;read_only=$true;pending_menu_acks=0;pending_stop_commands=0;menu_release_id=$head.menu_release_id;menu_version=$head.menu_version;menu_hash=$head.menu_hash}
Assert-StopHead (Clone $head) (Clone $menu) $sha $branch $device 1001;Check $true 'Matching cloud head does not require cloud remote-stops already on'
foreach($field in @('format','source_sha','branch_id','edge_device_id','catalog_version','menu_release_id','menu_version','menu_hash')) {$bad=Clone $head;$bad.$field=$false;Rejects {Assert-StopHead $bad (Clone $menu) $sha $branch $device 1001} ('Head fence '+$field)}
foreach($field in @('schema','grants_verified','read_only')) {$bad=Clone $menu;$bad.$field=$false;Rejects {Assert-StopHead (Clone $head) $bad $sha $branch $device 1001} ('Actual guard '+$field)}
foreach($field in @('pending_menu_acks','pending_stop_commands')) {$bad=Clone $menu;$bad.$field=1;Rejects {Assert-StopHead (Clone $head) $bad $sha $branch $device 1001} ('No side effect '+$field)}
Rejects {Assert-StopHead (Clone $head) (Clone $menu) $sha $branch $device 999} 'Future proof'
Rejects {Assert-StopHead (Clone $head) (Clone $menu) $sha $branch $device 1901} 'Expired proof'
$plan=[ordered]@{source_sha=$sha;env_before_sha256='c'*64;services=[ordered]@{edge=1;worker=2};menu=$menu}
Assert-StopReviewedPlan (Clone $plan) $plan;Check $true 'Roundtrip saved plan'
$bad=Clone $plan;$bad.services.worker=3;Rejects {Assert-StopReviewedPlan $bad $plan} 'Restart since plan requires reread'
function Assert-Acl {param($Path,[switch]$Foundation,[switch]$ServiceRead,[switch]$InheritedAllowed)}
function Set-ProtectedAcl {param($Path,[switch]$ServiceRead)}
$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../../infra/windows/install-native-menu-sync.ps1'),[ref]$t,[ref]$e)
$f=$a.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-NewText'},$false);. ([scriptblock]::Create($f.Extent.Text))
function Assert-NtfsPath {param($Path)}
function Hash-File($Path){(Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('stop-cas-'+[guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($temp)
try {
 $marker=Join-Path $temp ($sha+'-attempt.json');New-StopAttemptMarker $marker $plan 'synthetic-attempt'
 $first=Hash-File $marker;Rejects {New-StopAttemptMarker $marker $plan 'replacement'} 'No replay after unknown or failed attempt'
 Check ((Hash-File $marker) -ceq $first) 'Original attempt bytes retained'
 $path=Join-Path $temp 'edge.env';$before=[Text.Encoding]::UTF8.GetBytes("UNCHANGED=one`r`nEDGE_DEVICE_ACCESS_ENABLED=true`n# untouched`r`n")
 Assert-StopFlag $before 'EDGE_REMOTE_STOPS_ENABLED' 'false' -AllowAbsent
 $after=Update-ReviewedEnvBytes $before 'EDGE_REMOTE_STOPS_ENABLED' 'false' 'true' -AllowAbsent
 Check ([Text.Encoding]::UTF8.GetString($after) -ceq ([Text.Encoding]::UTF8.GetString($before)+"EDGE_REMOTE_STOPS_ENABLED=true`r`n")) 'Mixed original prefix and final newline preserved'
 [IO.File]::WriteAllBytes($path,$before);Write-StopCas $path $before $after
 Assert-StopFlag ([IO.File]::ReadAllBytes($path)) 'EDGE_REMOTE_STOPS_ENABLED' 'true';Check $true 'Actual enabled byte CAS'
 Rejects {Write-StopCas $path $before $after} 'Stale CAS'
 Restore-StopCas $path $before $after;Check ((Hash-File $path) -ceq (Stop-BytesHash $before)) 'Known candidate restores exact bytes'
 Restore-StopCas $path $before $after;Check $true 'Already original rollback retains bytes'
 [IO.File]::WriteAllText($path,"FOREIGN=1`n");Rejects {Restore-StopCas $path $before $after} 'Foreign bytes retained'
 Check ([IO.File]::ReadAllText($path) -ceq "FOREIGN=1`n") 'No foreign overwrite'
 Rejects {Assert-StopFlag ([Text.Encoding]::UTF8.GetBytes("EDGE_REMOTE_STOPS_ENABLED=false`nEDGE_REMOTE_STOPS_ENABLED=false`n")) 'EDGE_REMOTE_STOPS_ENABLED' 'false'} 'Duplicate flag'
 Rejects {Assert-StopFlag $before 'EDGE_REMOTE_STOPS_ENABLED' 'true'} 'Verify needs actual enabled key'
}finally{Remove-Item $temp -Recurse -Force}
# Mock SCM to execute restart orchestration, including failure after a stop took effect.
$script:states=@{};$script:events=[Collections.Generic.List[string]]::new();$script:unknown=$false;$script:stopFailure='';$script:startFailure=''
function Reset-Scm {$script:states=@{PickChickEdge='Running';PickChickKitchenLink='Running'};$script:events.Clear();$script:unknown=$false;$script:stopFailure='';$script:startFailure=''}
function Get-Service($Name) {
 $s=[pscustomobject]@{Name=$Name;Status=$script:states[$Name];DependentServices=@()}
 if($Name -eq 'PickChickEdge') {$s.DependentServices=@([pscustomobject]@{Name='PickChickKitchenLink';Status=$script:states.PickChickKitchenLink});if($script:unknown){$s.DependentServices+= [pscustomobject]@{Name='Foreign';Status='Running'}}}
 $s | Add-Member ScriptMethod WaitForStatus {param($status,$timeout)if($script:states[$this.Name] -ne [string]$status){throw 'SCM wait failed'}}
 return $s
}
function Stop-Service($Name){$script:events.Add('stop:'+ $Name);$script:states[$Name]='Stopped';if($script:stopFailure -eq $Name){$script:stopFailure='';throw 'Stop failed after stopping'}}
function Start-Service($Name){$script:events.Add('start:'+ $Name);if($script:startFailure -eq $Name){$script:startFailure='';throw 'Start failed'};$script:states[$Name]='Running'}
Reset-Scm;Invoke-StopEdgeRestart {$script:events.Add('replace')}
Check (($script:events -join ',') -ceq 'stop:PickChickKitchenLink,stop:PickChickEdge,replace,start:PickChickEdge,start:PickChickKitchenLink') 'Only Edge and required dependent restart in order'
Reset-Scm;$script:unknown=$true;Rejects {Invoke-StopEdgeRestart {throw 'unreachable'}} 'Unknown dependency';Check ($script:events.Count -eq 0) 'No stop on unknown dependency'
Reset-Scm;$script:stopFailure='PickChickEdge';Rejects {Invoke-StopEdgeRestart {throw 'unreachable'}} 'Partial stop failure propagated'
Check ($script:states.PickChickEdge -ceq 'Running' -and $script:states.PickChickKitchenLink -ceq 'Running') 'Finally recovers every originally running service'
Reset-Scm;Rejects {Invoke-StopEdgeRestart {throw 'CAS failed'}} 'CAS failure propagated'
Check ($script:states.PickChickEdge -ceq 'Running' -and $script:states.PickChickKitchenLink -ceq 'Running') 'CAS failure services recover'
Reset-Scm;$script:startFailure='PickChickEdge';Rejects {Invoke-StopEdgeRestart {}} 'Failed new service start is not success'
Invoke-StopEdgeRestart {$script:events.Add('restore')} -ResumeStopped
Check ($script:states.PickChickEdge -ceq 'Running' -and $script:states.PickChickKitchenLink -ceq 'Running') 'Owned rollback resumes even a stopped Edge'
Write-Output "$count remote stop activation guard checks passed"
