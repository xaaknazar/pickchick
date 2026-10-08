"""Release provenance checks and executable PowerShell contract tests when available.

The PowerShell suite extracts actual functions, uses synthetic CI/backup records and
mocks SCM, and therefore also runs on a developer Mac without touching a cashier.
"""
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'infra/windows/update-native-unified-menu.ps1'


class WindowsUnifiedMenuRelease(unittest.TestCase):
    def test_reviewed_executable_dependencies_and_migrations_match(self):
        text = SOURCE.read_text()
        for name in [
            'infra/windows/install-native-foundation.ps1',
            'infra/windows/update-native-service.ps1',
            'infra/windows/install-native-menu-sync.ps1',
            'db/edge/migrations/018_edge_menu_publication.sql',
            'db/edge/migrations/019_edge_remote_stops.sql',
        ]:
            with self.subTest(path=name):
                self.assertIn(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), text)

    def test_exact_ci_job_set_tracks_canonical_workflow(self):
        text = SOURCE.read_text()
        names = set(re.findall(r"'([^']+)'", re.search(r'\$required=@\(([^\n]+)\)', text)[1]))
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertEqual(names, set(re.findall(r'^    name: (.+)$', workflow, re.M)))
        self.assertEqual(len(names), 11)

    def test_runtime_contains_the_executed_database_helpers(self):
        # Parse the builder's literal manifest list without executing its build entrypoint.
        import ast
        tree = ast.parse((ROOT / 'scripts/build-windows-edge-runtime.py').read_text())
        shipped = next(ast.literal_eval(node.value) for node in tree.body
                       if isinstance(node, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id == 'ADMIN_FILES' for t in node.targets))
        for helper in ['menu-sync-upgrade-db.mjs', 'remote-stops-upgrade-db.mjs',
                       'native-menu-sync-worker.mjs', 'native-fulfillment-worker.mjs']:
            self.assertIn('infra/windows/' + helper, shipped)

    def test_actual_powershell_guards_and_service_recovery(self):
        executable = os.environ.get('PICKCHICK_TEST_PWSH') or shutil.which('pwsh') or shutil.which('powershell')
        if not executable:
            self.skipTest('PowerShell unavailable: run windows-unified-menu-upgrade.test.ps1 on operator host')
        result = subprocess.run([executable, '-NoProfile', '-NonInteractive', '-File',
                                 str(ROOT / 'tests/operations/windows-unified-menu-upgrade.test.ps1')],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('checks passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
