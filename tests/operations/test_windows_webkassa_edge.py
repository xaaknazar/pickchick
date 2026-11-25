"""Pins and executable guards for the Webkassa point-server operator."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import unittest
ROOT = Path(__file__).resolve().parents[2]


class WebkassaEdge(unittest.TestCase):
    def test_helper_pins(self):
        operator = (ROOT / 'infra/windows/enable-webkassa-edge.ps1').read_text()
        for name in ['install-native-menu-sync.ps1', 'reviewed-env-bytes.ps1']:
            self.assertIn(hashlib.sha256((ROOT / 'infra/windows' / name).read_bytes()).hexdigest(), operator)
        self.assertNotIn('Write-Output $bytes', operator)
        self.assertNotIn('Write-Host', operator)

    def test_executable_guards(self):
        exe = os.environ.get('PICKCHICK_TEST_PWSH') or shutil.which('pwsh') or shutil.which('powershell')
        if not exe:
            self.skipTest('PowerShell unavailable; execute guard suite on operator host')
        r = subprocess.run([exe, '-NoProfile', '-NonInteractive', '-File', str(ROOT / 'tests/operations/windows-webkassa-edge.test.ps1')], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('webkassa edge guard checks passed', r.stdout)


if __name__ == '__main__':
    unittest.main()
