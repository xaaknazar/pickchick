"""DB_POOL_MAX operator for the point server: pinned helper, no env output, executable guards."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'infra/windows/set-native-edge-db-pool.ps1'


class EdgeDbPool(unittest.TestCase):
    def test_pins_reviewed_env_bytes(self):
        text = SCRIPT.read_text()
        digest = hashlib.sha256((ROOT / 'infra/windows/reviewed-env-bytes.ps1').read_bytes()).hexdigest()
        self.assertIn(f"$script:ReviewedEnvBytesSha256='{digest}'", text)

    def test_never_prints_environment(self):
        text = SCRIPT.read_text()
        # Output is only the plan/result objects; no host/output of env text or bytes.
        self.assertNotRegex(text, r'Write-(Host|Output|Verbose|Information)')
        self.assertNotRegex(text, r'Get-Content')
        self.assertNotIn('$before |', text)
        self.assertNotIn('$after |', text)
        for line in text.splitlines():
            if 'ConvertTo-Json' in line:
                self.assertNotRegex(line, r'\$(before|after|copy)\b(?!Hash)')

    def test_param_block_has_no_script_root(self):
        text = SCRIPT.read_text()
        block = re.search(r'param\((.*?)\n\)', text, re.S).group(1)
        self.assertNotIn('PSScriptRoot', block)
        self.assertNotIn('Join-Path', block)

    def test_executable_guards(self):
        exe = os.environ.get('PICKCHICK_TEST_PWSH') or shutil.which('pwsh') or shutil.which('powershell')
        if not exe:
            if os.environ.get('CI'):
                self.fail('PowerShell is required for the CI DB_POOL_MAX regression')
            self.skipTest('Set PICKCHICK_TEST_PWSH to run the DB_POOL_MAX guard suite')
        r = subprocess.run([exe, '-NoProfile', '-NonInteractive', '-File',
                            str(ROOT / 'tests/operations/windows-edge-db-pool.test.ps1')],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertRegex(r.stdout, r'edge db pool checks passed: [1-9][0-9]+')


if __name__ == '__main__':
    unittest.main()
