"""Execute the actual PowerShell byte transformer; never read a real env file."""
import os
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ReviewedEnvironmentBytes(unittest.TestCase):
    def test_actual_powershell_byte_preservation_and_rejections(self):
        executable = os.environ.get('PICKCHICK_TEST_PWSH') or shutil.which('pwsh') or shutil.which('powershell')
        if not executable:
            if os.environ.get('CI'):
                self.fail('PowerShell is required for the CI environment-byte regression')
            self.skipTest('Set PICKCHICK_TEST_PWSH to run the native byte transformer')
        result = subprocess.run([executable, '-NoProfile', '-NonInteractive', '-File',
                                 str(ROOT / 'tests/operations/windows-reviewed-env-bytes.test.ps1')],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Reviewed environment byte checks passed: 59', result.stdout)


if __name__ == '__main__':
    unittest.main()
