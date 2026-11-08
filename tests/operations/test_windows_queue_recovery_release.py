"""Run actual 025 guard functions with synthetic receipts/files and mocked SCM/SQL.

Never invokes an installer entrypoint or connects to a database/service manager.
The inherited suite also exercises partial stops, helper hashes and backup guards.
"""
import importlib.util
import hashlib
from pathlib import Path
import re
import json
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('stage2_guards', Path(__file__).with_name('test_windows_stage2_release.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.SOURCE = ROOT / 'infra/windows/update-runtime-queue-recovery-025.ps1'
# Keep the same service failure scenarios, dropping only the 023-specific predecessor pin.
start = base.CASES.index("Assert-Stage2Predecessor '0fb")
end = base.CASES.index('$a=@(', start)
base.CASES = base.CASES[:start] + base.CASES[end:] + r'''
$now=[DateTime]::UtcNow;$sha='a'*40;$branch='11111111-1111-4111-8111-111111111111'
$proof=[pscustomobject]@{format='pickchick-queue-recovery-cloud-v1';sourceCommit=$sha;apiSourceCommit=$sha;branchId=$branch;apiImageId=('sha256:'+('b'*64));observedAt=$now;databaseVerified=$true;grantsVerified=$true;apiReady=$true;schema023Compatible=$true;schema024Compatible=$true;flagsPreserved=$true;migration=[pscustomobject]@{version='072_cloud_kitchen_restore_review.sql';checksum='d222ea9bf0aeebcaaeea96bc119c9b8aa3e1d9f032a1af7914aefe5c8981c5e2'}}
Assert-QueueCloudReceipt $proof $sha $branch $now
Check $true 'Complete current cloud receipt accepted'
foreach($field in @('databaseVerified','grantsVerified','apiReady','schema023Compatible','schema024Compatible','flagsPreserved')){
 $proof.$field=$false;Rejects {Assert-QueueCloudReceipt $proof $sha $branch $now} ('Missing cloud check '+$field)
 $proof.$field='true';Rejects {Assert-QueueCloudReceipt $proof $sha $branch $now} ('String is not proof '+$field)
 $proof.$field=$true
}
Rejects {Assert-QueueCloudReceipt $proof ('c'*40) $branch $now} 'Wrong cloud source'
Rejects {Assert-QueueCloudReceipt $proof $sha '22222222-2222-4222-8222-222222222222' $now} 'Wrong branch'
Rejects {Assert-QueueCloudReceipt $proof $sha $branch $now.AddMinutes(61)} 'Stale cloud receipt'
Rejects {Assert-QueueCloudReceipt $proof $sha $branch $now.AddSeconds(-1)} 'Future cloud receipt'
$proof.apiSourceCommit='c'*40;Rejects {Assert-QueueCloudReceipt $proof $sha $branch $now} 'Wrong installed API';$proof.apiSourceCommit=$sha
$proof.migration.checksum='0'*64;Rejects {Assert-QueueCloudReceipt $proof $sha $branch $now} 'Modified cloud072'
$ledger=@();for($i=1;$i -le 25;$i++){$ledger+=@{scope='edge';version=('{0:D3}_fixture.sql' -f $i);checksum=('a'*64)}}
Assert-QueueResumeLedger @($ledger[0..23]) $ledger
Assert-QueueResumeLedger $ledger $ledger
Rejects {Assert-QueueResumeLedger @($ledger[0..22]) $ledger} 'Wrong migration outcome'
$altered=@($ledger|ForEach-Object {@{scope=$_.scope;version=$_.version;checksum=$_.checksum}});$altered[24].checksum='b'*64
Rejects {Assert-QueueResumeLedger $altered $ledger} 'Changed committed ledger'
function Assert-LocalNtfsPath([string]$Path){}
$script:backupDisk=1;$script:diskOffline=$false;$script:diskReadonly=$false
function Get-Partition([string]$DriveLetter){return [pscustomobject]@{DiskNumber=$(if($DriveLetter -eq 'C'){0}else{$script:backupDisk})}}
function Get-Disk([int]$Number){return [pscustomobject]@{IsOffline=$script:diskOffline;IsReadOnly=$script:diskReadonly}}
Assert-QueueBackupDisk 'D:\Backups';Check $true 'Separate physical disk accepted'
Rejects {Assert-QueueBackupDisk 'C:\Backups'} 'System disk refused'
$script:backupDisk=0;Rejects {Assert-QueueBackupDisk 'D:\Backups'} 'Different partition on same disk refused';$script:backupDisk=1
$script:diskOffline=$true;Rejects {Assert-QueueBackupDisk 'D:\Backups'} 'Offline backup disk refused';$script:diskOffline=$false
$script:diskReadonly=$true;Rejects {Assert-QueueBackupDisk 'D:\Backups'} 'Readonly backup disk refused';$script:diskReadonly=$false
Rejects {Assert-QueueBackupDisk '\\server\share'} 'UNC outside local disk operator refused'

$temp=Join-Path ([IO.Path]::GetTempPath()) ('queue-guards-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp)|Out-Null
try {
 $bindings=@();for($i=0;$i -lt 4;$i++){$path=Join-Path $temp ($i.ToString()+'.xml');$bindings+=,@($path,('old'+$i),('new'+$i));[IO.File]::WriteAllText($path,('old'+$i))}
 Assert-QueueResumeBindings $bindings;Check $true 'All old bindings accepted'
 [IO.File]::WriteAllText($bindings[0][0],$bindings[0][2]);Rejects {Assert-QueueResumeBindings $bindings} 'Mixed old/new bindings refused'
 foreach($b in $bindings){[IO.File]::WriteAllText($b[0],$b[2])}
 Assert-QueueResumeBindings $bindings;Check $true 'All new bindings accepted'
 [IO.File]::WriteAllText($bindings[1][0],'foreign');Rejects {Assert-QueueResumeBindings $bindings} 'Foreign binding refused'
 function Reset-Transition {
  Reset-Mock
  $script:ledgerSnapshot=@($ledger[0..23]);$script:applyFault='';$script:replaceFault=-1;$script:restoreFault=$false;$script:startFault='';$script:replaces=0;$script:restores=0
  foreach($b in $bindings){[IO.File]::WriteAllText($b[0],$b[1])}
 }
 function Assert-RuntimePreserved {}
 function Read-RuntimeLedger {return @{ledger=$script:ledgerSnapshot}}
 function Write-UpdateText([string]$Path,[string]$Text){}
 function Invoke-RuntimeSchema([string]$Mode) {
  Check (@($script:states.Values|Where-Object {$_ -ne 'Stopped'}).Count -eq 0) 'No migration with writers running'
  if($Mode -eq 'apply'){
   if($script:applyFault -eq 'before'){throw 'SQL rollback'}
   if($script:applyFault -ne 'ledger'){$script:ledgerSnapshot=$ledger}
   if($script:applyFault -eq 'after'){throw 'Lost commit response'}
  }
  return @{mode=$Mode;migrations=$(if($Mode -eq 'apply'){25}else{24});fingerprint=$(if($Mode -eq 'apply' -and $script:applyFault -eq 'proof'){'wrong'}else{('a'*64)});dataPreserved=$true;restoreFenceExecuted=$false}
 }
 function Replace-UnifiedXml([string]$Path,[string]$Old,[string]$New){[IO.File]::WriteAllText($Path,$New);$script:replaces++;if($script:replaceFault -eq $script:replaces){throw 'Partial XML replace'}}
 function Restore-UnifiedBindings($Items){$script:restores++;if($script:restoreFault){throw 'Restore interrupted'};foreach($b in $Items){[IO.File]::WriteAllText($b[0],$b[1])}}
 function Start-Service([string]$Name){$script:log+='start:'+ $Name;if($Name -eq $script:startFault){throw 'Startup failed'};$script:states[$Name]='Running'}
 Reset-Transition;Invoke-QueueRuntimeSwitch $bindings @($ledger[0..23]) $ledger $temp
 Check ($script:replaces -eq 4 -and $script:restores -eq 0) 'Successful transition switches all four exactly once'
 Check (@($script:states.Values|Where-Object {$_ -ne 'Running'}).Count -eq 0) 'All services resumed'
 foreach($databaseFault in @('before','after')){
  Reset-Transition;$script:applyFault=$databaseFault
  Rejects {Invoke-QueueRuntimeSwitch $bindings @($ledger[0..23]) $ledger $temp} ('Database failure reported '+$databaseFault)
  Check ($script:replaces -eq 0) 'Database failure cannot switch bindings'
  Check (@($script:states.Values|Where-Object {$_ -ne 'Running'}).Count -eq 0) 'Known additive ledger resumes original services'
 }
 Reset-Transition;$script:applyFault='ledger';Rejects {Invoke-QueueRuntimeSwitch $bindings @($ledger[0..23]) $ledger $temp} 'Candidate with old ledger refused'
 Check (@($script:log|Where-Object {$_ -like 'start:*'}).Count -eq 0) 'No new runtime can start against024'
 Reset-Transition;$script:applyFault='proof';Rejects {Invoke-QueueRuntimeSwitch $bindings @($ledger[0..23]) $ledger $temp} 'Preservation mismatch reported'
 Check (@($script:log|Where-Object {$_ -like 'start:*'}).Count -eq 0) 'Preservation mismatch leaves all writers stopped'
 foreach($failAt in 1..4){
  Reset-Transition;$script:replaceFault=$failAt
  Rejects {Invoke-QueueRuntimeSwitch $bindings @($ledger[0..23]) $ledger $temp} ('Partial binding failure reported '+$failAt)
  Check ($script:restores -eq 1) 'Original bindings restored before startup'
  foreach($b in $bindings){Check ([IO.File]::ReadAllText($b[0]) -ceq $b[1]) 'Old binding retained'}
  Check (@($script:states.Values|Where-Object {$_ -ne 'Running'}).Count -eq 0) 'Every original service resumed after binding rollback'
 }
 Reset-Transition;$script:replaceFault=2;$script:restoreFault=$true
 Rejects {Invoke-QueueRuntimeSwitch $bindings @($ledger[0..23]) $ledger $temp} 'Failed binding rollback reported'
 Check (@($script:log|Where-Object {$_ -like 'start:*'}).Count -eq 0) 'Mixed bindings cannot start any service'
 Reset-Transition;$script:startFault='PickChickEdge'
 Rejects {Invoke-QueueRuntimeSwitch $bindings @($ledger[0..23]) $ledger $temp} 'Startup failure reported'
 Check ($script:restores -eq 0) 'No old binaries restored after candidate startup began'
 Check (@($script:log|Where-Object {$_ -like 'start:*'}).Count -eq 5) 'Every service recovery still attempted'
 foreach($b in $bindings){Check ([IO.File]::ReadAllText($b[0]) -ceq $b[2]) 'Candidate bindings retained after startup failure'}
} finally {[IO.Directory]::Delete($temp,$true)}
Write-Output ('queue-recovery-025: '+$script:cases+' checks passed; mocked SCM/SQL, no installation')
'''


class QueueReleaseGuards(base.RuntimeGuardTests):
    def test_database_driver_rejects_nonlocal_connections_without_loading_pg(self):
        body = base.SOURCE.read_text().split('function Invoke-RuntimeSchema(', 1)[1]
        driver = re.search(r"\$code=@'\n(.*?)\n'@", body, re.S).group(1)
        node = shutil.which('node')
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'package.json').write_text('{"private":true}')
            pg = root/'node_modules/pg'
            pg.mkdir(parents=True)
            (pg/'index.js').write_text(
                "require('node:fs').writeFileSync(process.env.PICKCHICK_TEST_MARKER,'loaded');"
                "exports.Client=class {constructor(){throw Error('Synthetic database boundary');}};"
            )
            marker = root/'loaded'
            url = 'postgresql://pickchick_edge_owner:test-secret@127.0.0.1:55433/pickchick_edge'
            cases = [(url, True), (url.replace('127.0.0.1', 'remote.invalid'), False),
                     (url.replace('55433', '5432'), False), (url.replace('/pickchick_edge', '/other'), False),
                     (url.replace('pickchick_edge_owner:', 'postgres:'), False),
                     (url+'?host=remote.invalid', False), (url+'#fragment', False),
                     (url.replace('postgresql:', 'https:'), False)]
            for connection, expected in cases:
                with self.subTest(connection=connection.replace('test-secret', 'REDACTED')):
                    marker.unlink(missing_ok=True)
                    result = subprocess.run(
                        [node, '--input-type=module', '-', 'inspect', str(root), str(ROOT),
                         '11111111-1111-4111-8111-111111111111',
                         str(ROOT/'infra/windows/queue-recovery-upgrade-db.mjs')],
                        input=driver, text=True, capture_output=True, timeout=10,
                        env={**os.environ, 'EDGE_DATABASE_URL': connection,
                             'PICKCHICK_TEST_MARKER': str(marker)},
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn('test-secret', result.stdout+result.stderr)
                    self.assertEqual(marker.exists(), expected)

    def test_stage2_helpers_are_byte_pinned(self):
        pins = re.findall(r" '([^']+)'='([a-f0-9]{64})'", base.SOURCE.read_text())
        self.assertEqual(len(pins), 3)
        for name, digest in pins:
            self.assertEqual(hashlib.sha256((base.SOURCE.parent/name).read_bytes()).hexdigest(), digest)


if __name__ == '__main__':
    unittest.main()
