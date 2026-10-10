"""Executable source/byte-CAS/failure guards for the post-Devices continuation."""
import ast
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import unittest
ROOT = Path(__file__).resolve().parents[2]

class RemoteStopsActivation(unittest.TestCase):
    def test_helper_pins_and_package(self):
        profile = (ROOT / 'infra/windows/enable-native-remote-stops.ps1').read_text()
        for name in ['install-native-menu-sync.ps1', 'update-native-unified-menu.ps1', 'update-native-service.ps1', 'reviewed-env-bytes.ps1']:
            self.assertIn(hashlib.sha256((ROOT / 'infra/windows' / name).read_bytes()).hexdigest(), profile)
        tree = ast.parse((ROOT / 'scripts/build-windows-edge-runtime.py').read_text())
        shipped = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'ADMIN_FILES' for t in n.targets))
        for name in ['enable-native-remote-stops.ps1', 'remote-stops-readiness.mjs']:
            self.assertIn('infra/windows/' + name, shipped)

    def test_executable_guards(self):
        exe = os.environ.get('PICKCHICK_TEST_PWSH') or shutil.which('pwsh') or shutil.which('powershell')
        if not exe:
            self.skipTest('PowerShell unavailable; execute guard suite on operator host')
        r = subprocess.run([exe, '-NoProfile', '-NonInteractive', '-File', str(ROOT / 'tests/operations/windows-remote-stops-activation.test.ps1')], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('remote stop activation guard checks passed', r.stdout)
