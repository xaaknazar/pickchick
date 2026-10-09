"""Pinned operator dependency checks plus executable PowerShell CAS/phase guards."""
import ast
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import unittest
ROOT = Path(__file__).resolve().parents[2]

class DeviceRelease(unittest.TestCase):
    def test_pinned_helpers_match(self):
        for profile in ['update-native-device-access.ps1', 'install-native-device-access.ps1']:
            text = (ROOT / 'infra/windows' / profile).read_text()
            for name in ['update-native-service.ps1', 'update-native-unified-menu.ps1']:
                self.assertIn(hashlib.sha256((ROOT / 'infra/windows' / name).read_bytes()).hexdigest(), text)
        text = (ROOT / 'infra/windows/update-native-device-access.ps1').read_text()
        self.assertIn(hashlib.sha256((ROOT / 'db/edge/migrations/020_terminal_access.sql').read_bytes()).hexdigest(), text)
        installer = (ROOT / 'infra/windows/install-native-device-access.ps1').read_text()
        self.assertIn(hashlib.sha256((ROOT / 'infra/windows/reviewed-env-bytes.ps1').read_bytes()).hexdigest(), installer)
        self.assertIn("$oldApp=Join-Path $program 'Edge\\edge-23fb39e\\app'", text)

    def test_privileged_db_helper_and_installer_are_packaged(self):
        tree = ast.parse((ROOT / 'scripts/build-windows-edge-runtime.py').read_text())
        shipped = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id == 'ADMIN_FILES' for t in n.targets))
        for name in ['terminal-access-upgrade-db.mjs', 'install-native-device-access.ps1', 'native-device-access-worker.mjs', 'terminal-access-grants.mjs']:
            self.assertIn('infra/windows/' + name, shipped)

    def test_executable_guards(self):
        exe = os.environ.get('PICKCHICK_TEST_PWSH') or shutil.which('pwsh') or shutil.which('powershell')
        if not exe:
            self.skipTest('PowerShell unavailable; execute the guard suite on operator host')
        r = subprocess.run([exe, '-NoProfile', '-NonInteractive', '-File', str(ROOT / 'tests/operations/windows-device-access-upgrade.test.ps1')], text=True, capture_output=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('device guard checks passed', r.stdout)
