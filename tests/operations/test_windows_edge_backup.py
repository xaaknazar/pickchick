"""Guards for infra/windows/install-edge-backup.ps1 (scheduled cashier database backup).

No Windows here: the installer is checked statically. Its pure helpers are exercised by an
in-memory PowerShell script for the real cashier or a Windows runner:
  python3 tests/operations/test_windows_edge_backup.py --emit-powershell > edge-backup.ps1
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File edge-backup.ps1
"""
import base64
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
WINDOWS = ROOT / 'infra/windows'
SOURCE = WINDOWS / 'install-edge-backup.ps1'
TEXT = SOURCE.read_text(encoding='utf-8')
TOOLS = [
    'edge-backup-lib.mjs',
    'edge-backup-restore.mjs',
    'edge-backup-setup.mjs',
    'edge-backup-task.mjs',
    'native-edge-backup-ledger.json',
]
MUTATING = re.compile(
    r'Initialize-ProtectedDirectory|Copy-VerifiedTools|Protect-File|Set-Acl|Register-ScheduledTask|'
    r'Unregister-ScheduledTask|Start-ScheduledTask|Remove-Item|New-Item|\[IO\.File\]::Copy|'
    r"Invoke-BackupNode \$toolRoot")


def section(start, end):
    begin = TEXT.index(start)
    return TEXT[begin:TEXT.index(end, begin + len(start))]


class EdgeBackupInstallerTests(unittest.TestCase):
    def test_every_tool_file_is_byte_pinned_to_the_repository(self):
        pins = dict(re.findall(r"'([a-z0-9.-]+\.(?:mjs|json))'\s*=\s*'([a-f0-9]{64})'", TEXT))
        self.assertEqual(sorted(pins), TOOLS)
        for name, digest in pins.items():
            self.assertEqual(hashlib.sha256((WINDOWS / name).read_bytes()).hexdigest(), digest, name)

    def test_tool_files_only_load_pinned_siblings_and_the_foundation_pg_driver(self):
        for name in TOOLS:
            if not name.endswith('.mjs'):
                continue
            text = (WINDOWS / name).read_text(encoding='utf-8')
            relative = set(re.findall(r"from '(\./[^']+)'", text))
            relative |= set(re.findall(r"new URL\('(\./[^']+)'", text))
            for target in relative:
                self.assertIn(target[2:], TOOLS, f'{name} -> {target}')
            for module in re.findall(r"from '([^.'][^']*)'", text):
                self.assertTrue(module.startswith('node:'), f'{name} imports {module}')
            # The only non-core module is pg, resolved from the protected foundation tools.
            for start in [match.end() for match in re.finditer(r'createRequire\(', text)]:
                self.assertIn("'package.json'))", text[start:start + 80], name)

    def test_inspect_is_the_default_and_changes_nothing(self):
        self.assertIn("[ValidateSet('Inspect', 'Install', 'Uninstall')][string]$Mode = 'Inspect'", TEXT)
        inspect = section("if ($Mode -eq 'Inspect') {", '    return\n}')
        self.assertIsNone(MUTATING.search(inspect), MUTATING.search(inspect))

    def test_dry_run_returns_before_any_persistent_change(self):
        install = TEXT[TEXT.index('# Install\n'):]
        dry = install.index('if ($DryRun) {')
        first = MUTATING.search(install[install.index('    return\n}', dry):])
        self.assertIsNotNone(first)
        before = install[:dry]
        self.assertIsNone(MUTATING.search(before), MUTATING.search(before))
        dry_block = section("if ($DryRun) {\n    $temporary", '    return\n}')
        # The dry run executes only a private temporary copy and removes it again.
        self.assertIn("Invoke-BackupNode $temporary (@('plan')", dry_block)
        self.assertIn('Remove-Item -LiteralPath $temporary -Recurse -Force', dry_block)
        self.assertNotIn("@('install')", dry_block)
        uninstall = section("if ($Mode -eq 'Uninstall') {", "\n# Install\n")
        self.assertLess(uninstall.index('if ($DryRun) {'), uninstall.index('Unregister-ScheduledTask'))
        self.assertIn("'plan-remove'", uninstall[:uninstall.index('Unregister-ScheduledTask')])

    def test_task_runs_as_system_with_only_tool_and_config_paths(self):
        self.assertIn("New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount", TEXT)
        self.assertIn("$taskArguments = (Format-ProcessArgument (Join-Path $toolRoot 'edge-backup-task.mjs'))"
                      " + ' ' + (Format-ProcessArgument $configPath)", TEXT)
        self.assertIn('-Argument $taskArguments', TEXT)
        self.assertIn('-MultipleInstances IgnoreNew', TEXT)
        self.assertIn('-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries', TEXT)
        lower = TEXT.lower()
        for secret in ('pgpassword', '-password', 'read-host', 'convertto-securestring', 'write-host'):
            self.assertNotIn(secret, lower)
        # The task time limit ends a run long before the tool treats its lock as stale.
        limit = int(re.search(r'-ExecutionTimeLimit \(New-TimeSpan -Minutes (\d+)\)', TEXT).group(1))
        stale = (WINDOWS / 'edge-backup-lib.mjs').read_text(encoding='utf-8')
        hours = int(re.search(r'const LOCK_STALE_MS = (\d+) \* 3600_000;', stale).group(1))
        self.assertLess(limit, hours * 60)
        self.assertIn("schema = 'public'", stale)

    def test_uninstall_never_removes_the_key_configuration_or_copies(self):
        removals = re.findall(r'Remove-Item -LiteralPath (\$\w+)', TEXT)
        self.assertEqual(sorted(set(removals)), ['$credential', '$temporary'])
        self.assertIn("$credential = Join-Path $privateRoot 'backup-db.json'", TEXT)
        self.assertNotIn('$Destination -Recurse', TEXT)

    def test_private_files_get_an_explicit_protected_acl(self):
        self.assertIn("foreach ($name in @('backup-key.json', 'backup-db.json', 'edge-backup.json')) "
                      "{ Protect-File (Join-Path $privateRoot $name) }", TEXT)
        self.assertIn("Initialize-ProtectedDirectory (Join-Path $stateRoot 'health') -ServiceRead", TEXT)
        for name in ('private', 'staging', 'logs'):
            self.assertIn(f"'{name}'", TEXT)

    @unittest.skipUnless(shutil.which('pwsh') or shutil.which('powershell'), 'PowerShell is not installed')
    def test_emitted_powershell_checks_pass(self):
        shell = shutil.which('pwsh') or shutil.which('powershell')
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'edge-backup-checks.ps1'
            script.write_text(powershell_tests() + '\n', encoding='utf-8')
            result = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-File', str(script)],
                                    text=True, capture_output=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(result.stdout, r'edge-backup: [0-9]+ checks passed')


CASES = r'''
$script:cases=0
function Check([bool]$Value,[string]$Why){if(!$Value){throw $Why};$script:cases++}
function Rejects([scriptblock]$Run,[string]$Why){$bad=$false;try{& $Run|Out-Null}catch{$bad=$true};Check $bad $Why}
Check ((Format-ProcessArgument 'C:\Program Files\x') -ceq '"C:\Program Files\x"') 'Quoted path'
Check ((Format-ProcessArgument 'C:\dir\') -ceq '"C:\dir\\"') 'Trailing backslash doubled'
Check ((Format-ProcessArgument 'a"b') -ceq '"a\"b"') 'Embedded quote escaped'
Rejects {Format-ProcessArgument "a`nb"} 'Newline refused'
Check ((Get-ToolId) -match '^[a-f0-9]{12}$') 'Tool id from pins'
$dir=Join-Path ([IO.Path]::GetTempPath()) ('ebk-'+[guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($dir)|Out-Null
try {
 $now=[DateTime]::Parse('2026-10-24T12:00:00Z').ToUniversalTime()
 $missing=Get-BackupHealth (Join-Path $dir 'none.json') $now
 Check ($missing.state -ceq 'missing' -and $missing.stale) 'Missing record is stale'
 $file=Join-Path $dir 'status.json'
 [IO.File]::WriteAllText($file,'{"format":"pickchick-edge-backup-status-v1","state":"ok","error":null,"lastAttemptAt":"2026-10-24T11:37:00.000Z","lastSuccessAt":"2026-10-24T11:37:30.000Z","maxAgeMinutes":120,"schema":"schema020","copies":3,"keyId":"0123456789abcdef"}')
 $fresh=Get-BackupHealth $file $now
 Check ($fresh.ageMinutes -eq 22 -and -not $fresh.stale -and $fresh.schema -ceq 'schema020') 'Fresh copy'
 $late=Get-BackupHealth $file $now.AddHours(3)
 Check ($late.stale -and $late.ageMinutes -eq 202) 'Older than the limit is stale'
 [IO.File]::WriteAllText($file,'{"format":"pickchick-edge-backup-status-v1","state":"failed","error":"UNREVIEWED_SCHEMA","lastAttemptAt":"2026-10-24T11:37:00.000Z","lastSuccessAt":null,"maxAgeMinutes":120,"schema":null,"copies":null,"keyId":null}')
 $never=Get-BackupHealth $file $now
 Check ($never.stale -and $null -eq $never.ageMinutes -and $never.error -ceq 'UNREVIEWED_SCHEMA') 'Never succeeded is stale'
} finally { Remove-Item -LiteralPath $dir -Recurse -Force }
Rejects {Test-BackupDestination 'C:\PickChickBackup' 'C:\ProgramData\PickChick'} 'Same drive as the database'
Rejects {Test-BackupDestination 'PickChickBackup' 'C:\ProgramData\PickChick'} 'Relative path'
Rejects {Test-BackupDestination 'D:' 'C:\ProgramData\PickChick'} 'Drive root'
Rejects {Test-BackupDestination ('\\nas-'+[guid]::NewGuid().ToString('N').Substring(0,8)+'\missing\x') 'C:\ProgramData\PickChick'} 'Unreachable share'
Write-Output ('edge-backup: '+$script:cases+' checks passed; no installation')
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
$pins=$ast.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$script:toolPins'},$true)
. ([scriptblock]::Create($pins.Extent.Text))
$script:trusted=@('S-1-5-18','S-1-5-32-544')
''' + CASES


if __name__ == '__main__':
    if sys.argv[1:] == ['--emit-powershell']:
        print(powershell_tests())
    else:
        unittest.main()
