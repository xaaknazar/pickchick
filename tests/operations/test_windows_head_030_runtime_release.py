"""Run the actual schema030 head-runtime (audit 28.11 P0-1) guard functions with mocked SCM/SQL/files.

Never invokes the operator entrypoint, a service manager or a database.
"""
import base64
import hashlib
import importlib.util
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('stage2_guards', Path(__file__).with_name('test_windows_stage2_release.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.SOURCE = ROOT / 'infra/windows/update-runtime-head-030.ps1'
LISTS = re.findall(r"^\$script:(?:writers|startOrder)=@\([^\n]+\)$", base.SOURCE.read_text(encoding='utf-8'), re.M)
base.CASES = r'''
$script:cases=0
function Check([bool]$Value,[string]$Why){if(!$Value){throw $Why};$script:cases++}
function Rejects([scriptblock]$Run,[string]$Why){$bad=$false;try{& $Run|Out-Null}catch{$bad=$true};Check $bad $Why}
$script:node='C:\node.exe'
# The same lists as the operator (test_service_lists_match_the_operator keeps them equal).
__SERVICE_LISTS__
# Before the mocked Assert-RuntimePreserved below: the real neighbour checks of the operator.
__NEIGHBOR_CASES__
function Xml([string]$App){return '<service><id>Example</id><executable>C:\node.exe</executable><workingdirectory>'+$App+'</workingdirectory><arguments>--env-file="C:\private\worker.env" "'+$App+'\worker.mjs" "C:\private\identity.json"</arguments><serviceaccount><user>LocalService</user><domain>NT AUTHORITY</domain></serviceaccount></service>'}
# An earlier head-029 saved the step-028 binding (pointing at the 028 runtime) and bound the 029
# runtime; this operator binds the 030 runtime to it in turn (the chain app-029 relies on too).
$original=Xml 'C:\edge-028\app'
$after029=New-RuntimeBinding $original (Get-TextSha256 $original) 'Example' 'C:\edge-028\app' 'C:\edge-029\app'
$next=[xml](Get-HeadBinding $after029 $original 'Example' 'C:\edge-029\app' 'C:\edge-new\app' 'C:\edge-028\app')
Check ($next.service.workingdirectory -ceq 'C:\edge-new\app') 'Candidate runtime path bound'
Check ($next.service.arguments -ceq '--env-file="C:\private\worker.env" "C:\edge-new\app\worker.mjs" "C:\private\identity.json"') 'Config and identity arguments exact'
Rejects {Get-HeadBinding ($after029.Replace('worker.env','other.env')) $original 'Example' 'C:\edge-029\app' 'C:\edge-new\app' 'C:\edge-028\app'} 'Changed configuration after 029 refused'
Rejects {Get-HeadBinding $original $original 'Example' 'C:\edge-029\app' 'C:\edge-new\app' 'C:\edge-028\app'} 'Binding that never went through 029 refused'
Rejects {Get-HeadBinding $after029 $original 'Other' 'C:\edge-029\app' 'C:\edge-new\app' 'C:\edge-028\app'} 'Wrong service refused'
Rejects {Get-HeadBinding $after029 $original 'Example' 'C:\edge-other\app' 'C:\edge-new\app' 'C:\edge-028\app'} 'Other predecessor refused'
Rejects {Get-HeadBinding $after029 $original 'Example' 'C:\edge-029\app' 'C:\edge-new\app' 'C:\edge-other\app'} 'Original of another predecessor refused'
$already=New-RuntimeBinding $after029 (Get-TextSha256 $after029) 'Example' 'C:\edge-029\app' 'C:\edge-new\app'
Rejects {Get-HeadBinding $already $original 'Example' 'C:\edge-029\app' 'C:\edge-new\app' 'C:\edge-028\app'} 'Already switched binding is not switched again'
# POS-sync: its own installer wrote the XML; only the runtime path changes.
$pos=Xml 'C:\edge-029\app'
$posNext=[xml](New-RuntimeBinding $pos (Get-TextSha256 $pos) 'Example' 'C:\edge-029\app' 'C:\edge-new\app')
Check ($posNext.service.workingdirectory -ceq 'C:\edge-new\app') 'POS-sync runtime path bound'
Rejects {New-RuntimeBinding $pos (Get-TextSha256 $pos) 'Example' 'C:\edge-other\app' 'C:\edge-new\app'} 'POS-sync on another runtime refused'
Rejects {New-RuntimeBinding ($pos.Replace('LocalService','System')) (Get-TextSha256 ($pos.Replace('LocalService','System'))) 'Example' 'C:\edge-029\app' 'C:\edge-new\app'} 'POS-sync under another account refused'
$done=[pscustomobject]@{sourceCommit=('a'*40);predecessorCommit=('c'*40);schema=29;databasePreserved=$true;environmentChanged=$false}
Assert-HeadPredecessor $done ('a'*40);Check $true 'Completed schema029 runtime accepted as the predecessor'
Rejects {Assert-HeadPredecessor $done ('b'*40)} 'Other predecessor refused'
Rejects {Assert-HeadPredecessor $null ('a'*40)} 'Missing predecessor record refused'
$done.schema=28;Rejects {Assert-HeadPredecessor $done ('a'*40)} 'A step 028 record is not a schema029 record';$done.schema=29
$done.schema=30;Rejects {Assert-HeadPredecessor $done ('a'*40)} 'A schema030 record is not a predecessor of the 030 step';$done.schema=29
$done.predecessorCommit='';Rejects {Assert-HeadPredecessor $done ('a'*40)} 'A record without its own predecessor refused';$done.predecessorCommit=('c'*40)
$done.databasePreserved='true';Rejects {Assert-HeadPredecessor $done ('a'*40)} 'String is not proof';$done.databasePreserved=$true
$done.environmentChanged=$true;Rejects {Assert-HeadPredecessor $done ('a'*40)} 'Changed environment refused';$done.environmentChanged=$false
$now=[DateTime]::UtcNow
$proof=[pscustomobject]@{lastTaskResult=0;health=[pscustomobject]@{state='ok';stale=$false;schema='schema030';lastSuccessAt=$now}}
Assert-HeadBackupHealth $proof $now.AddSeconds(-1);Check $true 'Fresh schema030 backup accepted'
Rejects {Assert-HeadBackupHealth $proof $now.AddSeconds(1)} 'Old backup refused'
$proof.health.schema='schema029';Rejects {Assert-HeadBackupHealth $proof $now.AddSeconds(-1)} 'schema029 backup refused';$proof.health.schema='schema030'
$proof.health.state='failed';Rejects {Assert-HeadBackupHealth $proof $now.AddSeconds(-1)} 'Failed backup refused';$proof.health.state='ok'
$proof.lastTaskResult=1;Rejects {Assert-HeadBackupHealth $proof $now.AddSeconds(-1)} 'Failed task refused';$proof.lastTaskResult=0
function Assert-LocalNtfsPath([string]$Path){}
$script:backupDisk=1;$script:diskOffline=$false;$script:diskReadonly=$false
function Get-Partition([string]$DriveLetter){return [pscustomobject]@{DiskNumber=$(if($DriveLetter -eq 'C'){0}else{$script:backupDisk})}}
function Get-Disk([int]$Number){return [pscustomobject]@{IsOffline=$script:diskOffline;IsReadOnly=$script:diskReadonly}}
Assert-HeadBackupDisk 'D:\Backups';Check $true 'Separate physical disk accepted'
Rejects {Assert-HeadBackupDisk 'C:\Backups'} 'System disk refused'
$script:backupDisk=0;Rejects {Assert-HeadBackupDisk 'D:\Backups'} 'Second partition of the system disk refused'
Assert-HeadBackupDisk 'D:\Backups' $true;Check $true 'Second partition accepted by the owner switch'
Rejects {Assert-HeadBackupDisk 'C:\Backups' $true} 'System partition refused even with the owner switch'
$script:diskOffline=$true;Rejects {Assert-HeadBackupDisk 'D:\Backups' $true} 'Offline same disk refused';$script:diskOffline=$false;$script:backupDisk=1
$script:diskOffline=$true;Rejects {Assert-HeadBackupDisk 'D:\Backups'} 'Offline disk refused';$script:diskOffline=$false
$script:diskReadonly=$true;Rejects {Assert-HeadBackupDisk 'D:\Backups'} 'Readonly disk refused';$script:diskReadonly=$false
Rejects {Assert-HeadBackupDisk '\\server\share'} 'UNC refused'
function Reset-Mock {
 $script:states=@{};$script:log=@();$script:foreign=$false;$script:startFault=''
 foreach($name in $script:writers){$script:states[$name]='Stopped'}
}
function Get-Service([string]$Name){
 $s=[pscustomobject]@{Name=$Name;Status=$script:states[$Name];DependentServices=@()}
 if($script:foreign){$s.DependentServices=@([pscustomobject]@{Name='PickChickKitchenLAN';Status='Running'})}
 $s|Add-Member ScriptMethod WaitForStatus {param($status,$timeout);if($script:states[$this.Name] -ne $status){throw 'Wrong simulated status'}}
 return $s
}
function Start-Service([string]$Name){$script:log+='start:'+$Name;if($Name -ceq $script:startFault){throw 'Startup failed'};$script:states[$Name]='Running'}
Reset-Mock;Assert-HeadWritersStopped;Check $true 'Stopped writers accepted'
Reset-Mock;$script:states['PickChickEdge']='Running';Rejects {Assert-HeadWritersStopped} 'Running edge refused'
Reset-Mock;$script:states['PickChickKitchenLink']='Running';Rejects {Assert-HeadWritersStopped} 'Running KitchenLink refused'
Reset-Mock;$script:foreign=$true;Rejects {Assert-HeadWritersStopped} 'Running KitchenLAN gateway refused'
Reset-Mock;$script:states['PickChickPosSync']='Running';Rejects {Assert-HeadWritersStopped} 'Running POS-sync refused'

$temp=Join-Path ([IO.Path]::GetTempPath()) ('head-guards-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp)|Out-Null
try {
 $script:bindingCount=5;$bindings=@();for($i=0;$i -lt 5;$i++){$path=Join-Path $temp ($i.ToString()+'.xml');$bindings+=,@($path,('old'+$i),('new'+$i));[IO.File]::WriteAllText($path,('old'+$i))}
 Check ((Assert-HeadBindings $bindings) -ceq 'old') 'All old bindings recognised'
 [IO.File]::WriteAllText($bindings[0][0],$bindings[0][2]);Rejects {Assert-HeadBindings $bindings} 'Mixed bindings refused'
 [IO.File]::WriteAllText($bindings[0][0],'foreign');Rejects {Assert-HeadBindings $bindings} 'Foreign binding refused'
 $ledger=@();for($i=1;$i -le 30;$i++){$ledger+=@{scope='edge';version=('{0:D3}_fixture.sql' -f $i);checksum=('a'*64)}}
 function Reset-Transition {
  Reset-Mock
  $script:ledgerSnapshot=$ledger;$script:replaceFault=-1;$script:restoreFault=$false;$script:replaces=0;$script:restores=0
  foreach($b in $bindings){[IO.File]::WriteAllText($b[0],$b[1])}
 }
 function Assert-RuntimePreserved {}
 function Read-RuntimeLedger {return @{ledger=$script:ledgerSnapshot}}
 function Replace-UnifiedXml([string]$Path,[string]$Old,[string]$New){$script:replaces++;if($script:replaceFault -eq $script:replaces){throw 'Partial XML replace'};[IO.File]::WriteAllText($Path,$New)}
 function Restore-UnifiedBindings($Items){$script:restores++;if($script:restoreFault){throw 'Restore interrupted'};foreach($b in $Items){[IO.File]::WriteAllText($b[0],$b[1])}}
 Reset-Transition;Invoke-HeadRuntimeSwitch $bindings $ledger
 Check ($script:replaces -eq 5 -and $script:restores -eq 0) 'All five bindings switched once'
 foreach($b in $bindings){Check ([IO.File]::ReadAllText($b[0]) -ceq $b[2]) 'Candidate binding in place'}
 Check (@($script:states.Values|Where-Object {$_ -ne 'Running'}).Count -eq 0) 'All six writers started'
 Check ($script:log[-1] -ceq 'start:PickChickPosSync') 'POS-sync starts last, after the edge it depends on'
 Check ($script:log[0] -ceq 'start:PickChickEdge') 'Edge starts first'
 Reset-Transition;$script:ledgerSnapshot=@($ledger[0..28])
 Rejects {Invoke-HeadRuntimeSwitch $bindings $ledger} 'schema029 database refused'
 Check ($script:replaces -eq 0 -and $script:log.Count -eq 0) 'Nothing switched or started on schema029'
 Reset-Transition;$script:states['PickChickMenuSyncWorker']='Running'
 Rejects {Invoke-HeadRuntimeSwitch $bindings $ledger} 'Running writer refused'
 Check ($script:replaces -eq 0) 'No switch with a running writer'
 foreach($failAt in 1..5){
  Reset-Transition;$script:replaceFault=$failAt
  Rejects {Invoke-HeadRuntimeSwitch $bindings $ledger} ('Partial switch reported '+$failAt)
  Check ($script:restores -eq 1) 'Original bindings restored'
  foreach($b in $bindings){Check ([IO.File]::ReadAllText($b[0]) -ceq $b[1]) 'Predecessor binding retained'}
  Check ($script:log.Count -eq 0) 'Writers stay stopped after a failed switch'
 }
 Reset-Transition;$script:replaceFault=2;$script:restoreFault=$true
 Rejects {Invoke-HeadRuntimeSwitch $bindings $ledger} 'Failed rollback reported'
 Check ($script:log.Count -eq 0) 'Mixed bindings never start a service'
 Reset-Transition;$script:startFault='PickChickEdge'
 Rejects {Invoke-HeadRuntimeSwitch $bindings $ledger} 'Startup failure reported'
 Check ($script:restores -eq 0) 'No old binaries restored after the candidate started'
 Check (@($script:log|Where-Object {$_ -like 'start:*'}).Count -eq 6) 'Every start still attempted'
 foreach($b in $bindings){Check ([IO.File]::ReadAllText($b[0]) -ceq $b[2]) 'Candidate binding retained after startup failure'}
} finally {[IO.Directory]::Delete($temp,$true)}
# The reviewed ledger file, read the way the operator reads it: from the file next to the script.
$dir=Join-Path ([IO.Path]::GetTempPath()) ('pickchick-head030-ledger-'+[guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($dir)
try {
 $ledgerFile=Join-Path $dir 'native-edge-backup-ledger.json'
 $ledgerBytes=[Convert]::FromBase64String('__REVIEWED_LEDGER__')
 [IO.File]::WriteAllBytes($ledgerFile,$ledgerBytes)
 $ledgerFunctions=@($functions|Where-Object {$_.Name -cin @('Assert-RuntimeLedger','Assert-HeadMigrationSet')})
 Check ($ledgerFunctions.Count -eq 2) 'Both ledger checks found in the operator'
 [IO.File]::WriteAllText((Join-Path $dir 'head-ledger.ps1'),(($ledgerFunctions|ForEach-Object {$_.Extent.Text}) -join "`n"))
 . (Join-Path $dir 'head-ledger.ps1')
 $rows=[Text.Encoding]::UTF8.GetString($ledgerBytes)|ConvertFrom-Json
 Check (@($rows).Count -eq 30) 'The reviewed ledger has 30 rows'
 function Copy-LedgerRows($Rows){return @($Rows|ForEach-Object {@{scope=$_.scope;version=$_.version;checksum=$_.checksum}})}
 Assert-HeadMigrationSet (Copy-LedgerRows $rows);Check $true 'The reviewed 030 candidate is accepted'
 Rejects {Assert-HeadMigrationSet (Copy-LedgerRows $rows[0..28])} 'A 029 candidate is refused'
 Rejects {Assert-HeadMigrationSet (Copy-LedgerRows $rows[0..27])} 'A 028 candidate is refused'
 Rejects {Assert-HeadMigrationSet (Copy-LedgerRows $rows[0..24])} 'A 025 candidate is refused'
 Rejects {Assert-HeadMigrationSet (Copy-LedgerRows $rows[0..26])} 'A 027 candidate is refused'
 $changed=Copy-LedgerRows $rows;$changed[29].checksum='0'*64
 Rejects {Assert-HeadMigrationSet $changed} 'A changed 030 migration is refused'
 $changed=Copy-LedgerRows $rows;$changed[28].checksum='0'*64
 Rejects {Assert-HeadMigrationSet $changed} 'A changed 029 migration is refused'
 $changed=Copy-LedgerRows $rows;$changed[27].checksum='0'*64
 Rejects {Assert-HeadMigrationSet $changed} 'A changed 028 migration is refused'
 $changed=Copy-LedgerRows $rows;$changed[5].checksum='0'*64
 Rejects {Assert-HeadMigrationSet $changed} 'A changed historical migration is refused'
 [IO.File]::WriteAllText($ledgerFile,(ConvertTo-Json @(Copy-LedgerRows $rows[0..28]) -Depth 3))
 Rejects {Assert-HeadMigrationSet (Copy-LedgerRows $rows)} 'A ledger file without 030 is refused'
} finally {[IO.Directory]::Delete($dir,$true)}
Write-Output ('head-runtime-030: '+$script:cases+' checks passed; mocked SCM/SQL, no installation')
'''.replace('__NEIGHBOR_CASES__', base.NEIGHBOR_CASES.strip()).replace('__SERVICE_LISTS__', '\n'.join(LISTS)).replace(
    '__REVIEWED_LEDGER__',
    base64.b64encode((ROOT / 'infra/windows/native-edge-backup-ledger.json').read_bytes()).decode(),
)


class HeadRuntime030Guards(base.RuntimeGuardTests):
    def test_stage2_helpers_are_byte_pinned(self):
        pins = re.findall(r" '([^']+)'='([a-f0-9]{64})'", base.SOURCE.read_text())
        self.assertEqual(len(pins), 2)
        for name, digest in pins:
            self.assertEqual(hashlib.sha256((base.SOURCE.parent/name).read_bytes()).hexdigest(), digest)

    def test_operator_runs_no_sql_and_keeps_every_migration(self):
        text = base.SOURCE.read_text(encoding='utf-8')
        self.assertNotIn('Invoke-RuntimeSchema', text)
        self.assertNotIn('upgrade-db', text)
        # The predecessor is a finished schema029 step of head-029 or app-029; this step keeps its own state.
        self.assertIn("@('runtime-head-029-','runtime-app-029-')", text)
        self.assertIn("'EdgeTools\\runtime-head-030-'", text)
        self.assertNotIn("'EdgeTools\\runtime-app-029-'+$SourceCommit", text)
        self.assertIn("if($names.Count -ne 30){throw 'Exact schema030 required.'}", text)
        # 001-029 are byte for byte the installed ones; 030 is the only new file.
        self.assertIn("if($i -lt 29 -and (!$installed.ContainsKey($p) -or $installed[$p] -cne $files[$p].sha256)){throw 'Historical migration changed.'}", text)
        self.assertIn("Completed.schema -ne 29", text)
        self.assertIn("schema=30;completedAt", text)
        self.assertIn("health.schema -cne 'schema030'", text)

    def test_shared_guards_are_the_app_029_ones(self):
        # The five-service operator in production (app-029) is the pattern: every guard this one
        # did not need to change is byte for byte the same function.
        app = (ROOT / 'infra/windows/update-runtime-app-029.ps1').read_text(encoding='utf-8')
        text = base.SOURCE.read_text(encoding='utf-8')
        for name in ('New-RuntimeBinding', 'Get-HeadBinding', 'Read-RuntimeLedger', 'Assert-RuntimeLedger',
                     'Assert-HeadBackupDisk', 'Register-RuntimeTunnel', 'Assert-RuntimeNeighbor',
                     'Assert-RuntimePreserved', 'Assert-HeadBindings', 'Assert-HeadToolPins',
                     'Import-RuntimeFunctions', 'Get-TextSha256'):
            pick = lambda t: re.search(r'^function ' + name + r'\b.*?^}', t, re.S | re.M).group(0)
            self.assertEqual(pick(text), pick(app), name)
        # Same writers, same start order (POS-sync last), same helper pins except the two re-chained ones.
        self.assertEqual(LISTS, re.findall(r"^\$script:(?:writers|startOrder)=@\([^\n]+\)$", app, re.M))
        pins = lambda t: dict(re.findall(r" '([^']+)'='([a-f0-9]{64})'", t))
        self.assertEqual(pins(text), pins(app))
        helpers = lambda t: re.findall(r"Import-RuntimeFunctions \(Join-Path \$PSScriptRoot '([^']+)'\) '([a-f0-9]{64})'", t)
        self.assertEqual(helpers(text), helpers(app))
        self.assertEqual(len(helpers(text)), 3)

    def test_ledger_pins_match_the_kaspi_tools(self):
        text = base.SOURCE.read_text(encoding='utf-8')
        kaspi = (ROOT / 'infra/windows/kaspi-pos-upgrade-db.mjs').read_text(encoding='utf-8')
        release = (ROOT / 'infra/windows/kaspi-pos-release-upgrade-db.mjs').read_text(encoding='utf-8')
        digest029 = re.search(r"export const KASPI_POS_SHA256 = '([a-f0-9]{64})'", kaspi).group(1)
        digest030 = re.search(r"export const KASPI_POS_RELEASE_SHA256 =\s*'([a-f0-9]{64})'", release).group(1)
        self.assertEqual(hashlib.sha256((ROOT / 'db/edge/migrations/029_edge_kaspi_pos.sql').read_bytes()).hexdigest(), digest029)
        self.assertEqual(hashlib.sha256((ROOT / 'db/edge/migrations/030_edge_kaspi_pos_release.sql').read_bytes()).hexdigest(), digest030)
        self.assertIn("$expected[28].checksum -cne '" + digest029 + "'", text)
        self.assertIn("$expected[29].checksum -cne '" + digest030 + "'", text)
        self.assertIn("$expected[29].version -cne '030_edge_kaspi_pos_release.sql'", text)

    def test_every_pinned_digest_is_the_file_it_names(self):
        # The chain: the ledger and the backup installer pinned here, the installer in turn pins the
        # backup library and the ledger (test_windows_edge_backup.py keeps those equal as well).
        text = base.SOURCE.read_text(encoding='utf-8')
        installer = (ROOT / 'infra/windows/install-edge-backup.ps1').read_text(encoding='utf-8')
        for name, digest in re.findall(r"'([^']+)'\s*=\s*'([a-f0-9]{64})'", installer):
            self.assertEqual(hashlib.sha256((ROOT / 'infra/windows' / name).read_bytes()).hexdigest(), digest, name)
        self.assertEqual(len(re.findall(r"'([^']+)'\s*=\s*'([a-f0-9]{64})'", installer)), 5)

    def test_service_lists_match_the_operator(self):
        self.assertEqual(len(LISTS), 2)
        self.assertIn('__SERVICE_LISTS__', base.CASES.replace('\n'.join(LISTS), '__SERVICE_LISTS__'))

    def test_runbook_names_the_operator_and_the_database_tool(self):
        guide = (ROOT / 'docs/operations/stage2-windows-1030/head-runtime-030.md').read_text(encoding='utf-8')
        self.assertIn('update-runtime-head-030.ps1', guide)
        self.assertIn('kaspi-pos-release-upgrade-db.mjs', guide)


if __name__ == '__main__':
    unittest.main()
