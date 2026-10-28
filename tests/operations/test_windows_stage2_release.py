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
CASES = r'''
$script:cases=0
function Check([bool]$Value,[string]$Why){if(!$Value){throw $Why};$script:cases++}
function Rejects([scriptblock]$Run,[string]$Why){$bad=$false;try{& $Run|Out-Null}catch{$bad=$true};Check $bad $Why}
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
Write-Output ('stage2-1024: '+$script:cases+' checks passed; mocked SCM, no installation')
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
