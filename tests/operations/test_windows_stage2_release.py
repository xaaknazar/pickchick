"""In-memory PowerShell guard/failure tests. SCM/files are mocked; no installer entrypoint."""
import base64
import hashlib
from pathlib import Path
import re
import sys
import unittest
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'infra/windows/update-runtime-stage2-1024.ps1'
NEIGHBOR_CASES = r"""
$script:svc=@{};$script:sleeps=0;$script:onSleep={}
function Get-CimInstance {param($ClassName,$Filter);if($ClassName -cne 'Win32_Service'){throw 'Unexpected CIM class'};return $script:svc[([regex]::Match($Filter,"Name='([^']+)'")).Groups[1].Value]}
function Start-Sleep {param($Seconds);$script:sleeps++;& $script:onSleep}
$neighborDir=Join-Path ([IO.Path]::GetTempPath()) ('pickchick-neighbor-'+[guid]::NewGuid().ToString('N'));$null=New-Item -ItemType Directory -Path $neighborDir
try {
$wrapper='"'+(Join-Path $neighborDir 'PickChickFulfillmentTunnel.exe')+'"';$wrapperXml=Join-Path $neighborDir 'PickChickFulfillmentTunnel.xml'
function New-Neighbor([string]$State,[int]$Id,[string]$Image=$wrapper,[string]$Account='NT AUTHORITY\LocalService'){return [pscustomobject]@{State=$State;ProcessId=$Id;PathName=$Image;StartName=$Account}}
$script:preserved=@{};$script:svc['PickChickFulfillmentTunnel']=New-Neighbor 'Running' 20
Rejects {Register-RuntimeTunnel} 'Tunnel without its configuration file refused'
Check ($script:preserved.Count -eq 0) 'Nothing registered for a tunnel without configuration'
[IO.File]::WriteAllText($wrapperXml,'<service><id>PickChickFulfillmentTunnel</id></service>')
Register-RuntimeTunnel
Check ($script:tunnelImage -ceq $wrapper -and $script:tunnelAccount -ceq 'NT AUTHORITY\LocalService') 'Tunnel wrapper and account recorded'
Check ($script:preserved.Count -eq 1 -and $script:preserved[$wrapperXml] -ceq (Get-FileHash -LiteralPath $wrapperXml -Algorithm SHA256).Hash) 'Tunnel configuration joins the preserved files'
$script:svc['PickChickPostgres']=New-Neighbor 'Running' 10
Check ((Assert-RuntimeNeighbor 'PickChickPostgres' 10) -eq 10) 'Unchanged database process accepted'
Check ((Assert-RuntimeNeighbor 'PickChickFulfillmentTunnel' 20) -eq 20 -and $script:sleeps -eq 0) 'Unchanged tunnel accepted without waiting'
$script:svc['PickChickFulfillmentTunnel']=New-Neighbor 'Running' 21
Check ((Assert-RuntimeNeighbor 'PickChickFulfillmentTunnel' 20) -eq 21 -and $script:sleeps -eq 0) 'Restarted tunnel accepted with its new process'
$script:svc['PickChickFulfillmentTunnel']=New-Neighbor 'Stopped' 0;$script:onSleep={if($script:sleeps -ge 3){$script:svc['PickChickFulfillmentTunnel']=New-Neighbor 'Running' 22}}
Check ((Assert-RuntimeNeighbor 'PickChickFulfillmentTunnel' 21) -eq 22 -and $script:sleeps -eq 3) 'Tunnel awaited through its restart delay'
$script:onSleep={};$script:sleeps=0;$script:svc['PickChickFulfillmentTunnel']=New-Neighbor 'Stopped' 0
Rejects {Assert-RuntimeNeighbor 'PickChickFulfillmentTunnel' 22} 'Tunnel that stays down refused'
Check ($script:sleeps -eq 60) 'Wait for the tunnel is bounded to three minutes'
$script:sleeps=0;$script:svc['PickChickFulfillmentTunnel']=New-Neighbor 'Running' 23 'C:\other\ssh.exe'
Rejects {Assert-RuntimeNeighbor 'PickChickFulfillmentTunnel' 22} 'Tunnel service with another wrapper refused'
$script:svc['PickChickFulfillmentTunnel']=New-Neighbor 'Running' 23 $wrapper 'LocalSystem'
Rejects {Assert-RuntimeNeighbor 'PickChickFulfillmentTunnel' 22} 'Tunnel service under another account refused'
$script:svc['PickChickFulfillmentTunnel']=New-Neighbor 'Stopped' 0 'C:\other\ssh.exe'
Rejects {Assert-RuntimeNeighbor 'PickChickFulfillmentTunnel' 22} 'Rebound tunnel refused even while stopped'
Check ($script:sleeps -eq 0) 'A changed tunnel service is refused without waiting'
$script:svc.Remove('PickChickFulfillmentTunnel')
Rejects {Assert-RuntimeNeighbor 'PickChickFulfillmentTunnel' 22} 'Removed tunnel service refused'
$script:svc['PickChickPostgres']=New-Neighbor 'Running' 11;$script:sleeps=0
Rejects {Assert-RuntimeNeighbor 'PickChickPostgres' 10} 'Restarted database refused'
$script:svc['PickChickPostgres']=New-Neighbor 'Stopped' 0
Rejects {Assert-RuntimeNeighbor 'PickChickPostgres' 10} 'Stopped database refused'
$script:svc['PickChickOther']=New-Neighbor 'Running' 31
Rejects {Assert-RuntimeNeighbor 'PickChickOther' 30} 'Any other restarted neighbour refused'
Check ($script:sleeps -eq 0) 'Only the tunnel is awaited'
$script:svc['PickChickPostgres']=New-Neighbor 'Running' 10;$script:svc['PickChickFulfillmentTunnel']=New-Neighbor 'Running' 24
$script:neighbors=@{PickChickPostgres=10;PickChickFulfillmentTunnel=22}
Assert-RuntimePreserved
Check ($script:neighbors['PickChickFulfillmentTunnel'] -eq 24 -and $script:neighbors['PickChickPostgres'] -eq 10) 'New tunnel process becomes the expected one'
Assert-RuntimePreserved;Check $true 'Second check after the restart passes'
[IO.File]::WriteAllText($wrapperXml,'<service><id>PickChickFulfillmentTunnel</id><arguments>other</arguments></service>')
Rejects {Assert-RuntimePreserved} 'Restart with a changed tunnel configuration refused'
[IO.File]::WriteAllText($wrapperXml,'<service><id>PickChickFulfillmentTunnel</id></service>')
Assert-RuntimePreserved;Check $true 'Restored tunnel configuration accepted'
$script:svc['PickChickPostgres']=New-Neighbor 'Running' 12
Rejects {Assert-RuntimePreserved} 'Database restart still stops the step'
} finally {[IO.Directory]::Delete($neighborDir,$true);Remove-Item function:Get-CimInstance,function:Start-Sleep,function:New-Neighbor -ErrorAction SilentlyContinue}
"""
CASES = r'''
$script:cases=0
function Check([bool]$Value,[string]$Why){if(!$Value){throw $Why};$script:cases++}
function Rejects([scriptblock]$Run,[string]$Why){$bad=$false;try{& $Run|Out-Null}catch{$bad=$true};Check $bad $Why}
Assert-Stage2Predecessor '0fb95c9f09031d93e38e3af2a0c4a1bcc81f591c'
Check $true 'Reviewed schema023 bridge accepted'
Rejects {Assert-Stage2Predecessor 'e4eb91b52ed912254e388513853e72b430d12c88'} 'Shared schema024 tree is not a schema023 bridge'
Rejects {Assert-Stage2Predecessor ('a'*40)} 'Unreviewed predecessor refused'
$a=@(@{scope='edge';version='001.sql';checksum='hash'})
Assert-RuntimeLedger $a @([pscustomobject]@{checksum='hash';scope='edge';version='001.sql'})
Check $true 'Ledger compares semantic values'
Rejects {Assert-RuntimeLedger @() $a} 'Missing ledger row'
Rejects {Assert-RuntimeLedger @(@{scope='edge';version='001.sql';checksum='wrong'}) $a} 'Changed migration'
$script:node='C:\node.exe'
$xml='<service><id>Example</id><executable>C:\node.exe</executable><workingdirectory>C:\old</workingdirectory><arguments>--env-file="C:\private\worker.env" "C:\old\worker.mjs" "C:\private\identity.json"</arguments><serviceaccount><user>LocalService</user><domain>NT AUTHORITY</domain></serviceaccount></service>'
$h=[Security.Cryptography.SHA256]::Create();try{$hash=[BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
$result=[xml](New-RuntimeBinding $xml $hash 'Example' 'C:\old' 'C:\new')
Check ($result.service.workingdirectory -ceq 'C:\new') 'New immutable path'
Check ($result.service.arguments -ceq '--env-file="C:\private\worker.env" "C:\new\worker.mjs" "C:\private\identity.json"') 'Config and identity arguments exact'
Rejects {New-RuntimeBinding ($xml+' ') $hash 'Example' 'C:\old' 'C:\new'} 'Foreign XML refused'
Rejects {New-RuntimeBinding $xml $hash 'Other' 'C:\old' 'C:\new'} 'Wrong service refused'
function Reset-Mock {
 $script:states=@{};$script:log=@();$script:fault='';$script:foreign=$false
 foreach($name in @('PickChickEdge','PickChickFulfillmentWorker','PickChickMenuSyncWorker','PickChickDeviceAccessWorker','PickChickKitchenLink')){$script:states[$name]='Running'}
}
function Get-Service([string]$Name){
 $s=[pscustomobject]@{Name=$Name;Status=$script:states[$Name];DependentServices=@()}
 if($script:foreign){$s.DependentServices=@([pscustomobject]@{Name='Foreign';Status='Running'})}
 $s|Add-Member ScriptMethod WaitForStatus {param($status,$timeout);if($script:states[$this.Name] -ne $status){throw 'Wrong simulated status'}}
 return $s
}
function Stop-Service([string]$Name){$script:log+='stop:'+ $Name;$script:states[$Name]='Stopped';if($script:fault -ceq $Name){throw 'Simulated partial stop'}}
function Start-Service([string]$Name){$script:log+='start:'+ $Name;$script:states[$Name]='Running'}
Reset-Mock;Invoke-RuntimeQuiesced {Check (@($script:states.Values|Where-Object {$_ -ne 'Stopped'}).Count -eq 0) 'Every writer stopped including device mailbox';$script:log+='action'}
Check (@($script:states.Values|Where-Object {$_ -ne 'Running'}).Count -eq 0) 'Every original service resumed'
Check ($script:log[0] -ceq 'stop:PickChickFulfillmentWorker' -and $script:log[6] -ceq 'start:PickChickEdge') 'Producer stop and edge-first start order'
foreach($name in @('PickChickFulfillmentWorker','PickChickMenuSyncWorker','PickChickDeviceAccessWorker','PickChickKitchenLink','PickChickEdge')){
 Reset-Mock;$script:fault=$name
 Rejects {Invoke-RuntimeQuiesced {throw 'Must not enter action'}} ('Partial stop reported: '+$name)
 Check (@($script:states.Values|Where-Object {$_ -ne 'Running'}).Count -eq 0) ('All services restored after '+$name)
}
Reset-Mock;Rejects {Invoke-RuntimeQuiesced {throw 'Migration failed'}} 'Migration failure reported'
Check (@($script:states.Values|Where-Object {$_ -ne 'Running'}).Count -eq 0) 'Failed migration resumes original services'
Reset-Mock;$script:foreign=$true;Rejects {Invoke-RuntimeQuiesced {throw 'No action allowed'}} 'Foreign dependent refused'
Check ($script:log.Count -eq 0) 'No service stopped with foreign dependent'
Reset-Mock;Rejects {Invoke-RuntimeQuiesced {} -BeforeResume {throw 'Foreign binding'}} 'Foreign binding blocks restart'
Check (@($script:log|Where-Object {$_ -like 'start:*'}).Count -eq 0) 'Foreign binary never started'
$now=[DateTime]::UtcNow
$proof=[pscustomobject]@{lastTaskResult=0;health=[pscustomobject]@{state='ok';stale=$false;schema='schema024';lastSuccessAt=$now}}
Assert-Stage2BackupHealth $proof 24 $now.AddSeconds(-1)
Check $true 'Fresh schema024 backup accepted'
Rejects {Assert-Stage2BackupHealth $proof 23 $now.AddSeconds(-1)} 'Old schema rejected'
Rejects {Assert-Stage2BackupHealth $proof 24 $now.AddSeconds(1)} 'Stale receipt rejected'
$proof.health.state='failed';Rejects {Assert-Stage2BackupHealth $proof 24 $now.AddSeconds(-1)} 'Failed backup rejected'
$script:taskLog=@();$script:backupPaused=$false
function Disable-ScheduledTask {param($TaskPath,$TaskName);$script:taskLog+='disable'}
function Enable-ScheduledTask {param($TaskPath,$TaskName);$script:taskLog+='enable'}
function Get-ScheduledTask {param($TaskPath,$TaskName);$script:taskLog+='inspect';return [pscustomobject]@{State='Ready'}}
Suspend-Stage2Backup
Check $script:backupPaused 'Backup paused before maintenance'
Check ($script:taskLog[0] -ceq 'disable' -and $script:taskLog[1] -ceq 'inspect') 'Disable before checking active job'
Resume-Stage2Backup
Check (!$script:backupPaused -and $script:taskLog[-1] -ceq 'enable') 'Backup schedule resumed'
''' + NEIGHBOR_CASES + r'''Write-Output ('stage2-1024: '+$script:cases+' checks passed; mocked SCM, no installation')
'''


def powershell_tests():
    encoded = base64.b64encode(SOURCE.read_bytes()).decode()
    return r'''Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(''' + "'" + encoded + "'" + r'''))
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
$functions=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
. ([scriptblock]::Create(($functions.Extent.Text -join "`n")))
''' + CASES


class RuntimeGuardTests(unittest.TestCase):
    def test_reviewed_helpers_are_byte_pinned(self):
        pins = re.findall(r"Import-RuntimeFunctions \(Join-Path \$PSScriptRoot '([^']+)'\) '([a-f0-9]{64})'", SOURCE.read_text())
        self.assertEqual(len(pins), 3)
        for name, digest in pins:
            self.assertEqual(hashlib.sha256((SOURCE.parent/name).read_bytes()).hexdigest(), digest)

    def test_stage2_helpers_are_byte_pinned(self):
        pins = re.findall(r" '([^']+)'='([a-f0-9]{64})'", SOURCE.read_text())
        self.assertEqual(len(pins), 5)
        for name, digest in pins:
            self.assertEqual(hashlib.sha256((SOURCE.parent/name).read_bytes()).hexdigest(), digest)

    def test_powershell_failure_boundaries(self):
        exe = os.environ.get('PICKCHICK_TEST_PWSH') or shutil.which('pwsh')
        if not exe:
            if os.environ.get('CI'): self.fail('PowerShell required in CI for stage2 failure checks')
            self.skipTest('PowerShell absent')
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory)/'guards.ps1'
            script.write_text(powershell_tests())
            result = subprocess.run([exe, '-NoProfile', '-NonInteractive', '-File', str(script)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertIn('checks passed', result.stdout)


if __name__ == '__main__':
    if sys.argv[1:] == ['--emit-powershell']:
        print(powershell_tests())
    else:
        unittest.main()
