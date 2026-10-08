import hashlib
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
class WindowsKioskUpgrade(unittest.TestCase):
    def test_reviewed_dependencies_and_migrations_match_checked_in_bytes(self):
        source=(ROOT/'infra/windows/update-native-kiosk-qr.ps1').read_text()
        for path in ['infra/windows/install-native-foundation.ps1','infra/windows/update-native-service.ps1','db/edge/migrations/016_edge_cashier_reports.sql','db/edge/migrations/017_edge_kiosk_prepaid.sql']:
            self.assertIn(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),source)
    def test_native_gate_uses_the_current_canonical_ci_job_set(self):
        source=(ROOT/'infra/windows/update-native-kiosk-qr.ps1').read_text()
        names=set(re.findall(r"'([^']+)'",re.search(r'\$required=@\(([^\n]+)\)',source)[1]))
        workflow=(ROOT/'.github/workflows/ci.yml').read_text()
        actual=set(re.findall(r'^    name: (.+)$',workflow,re.M))
        self.assertEqual(names,actual)
    def test_postgres_upgrade_is_in_the_current_ci_entry_point(self):
        self.assertIn("import './windows-kiosk-upgrade.test.mjs'",(ROOT/'tests/operations/windows-reserved-number.test.mjs').read_text())
        self.assertIn('tests/operations/windows-reserved-number.test.mjs',(ROOT/'.github/workflows/ci.yml').read_text())

if __name__=='__main__': unittest.main()
