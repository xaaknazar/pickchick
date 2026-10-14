"""Recovery guard provenance and executable read-only state/login tests."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import unittest
ROOT = Path(__file__).resolve().parents[2]

class Recovery(unittest.TestCase):
    def test_pins_and_no_runtime_mutations(self):
        script = (ROOT / 'infra/windows/recover-native-device-access.ps1').read_text()
        for name in ['install-native-foundation.ps1', 'update-native-service.ps1',
                     'update-native-unified-menu.ps1', 'update-native-device-access.ps1',
                     'device-access-recovery.mjs']:
            digest = hashlib.sha256((ROOT / 'infra/windows' / name).read_bytes()).hexdigest()
            self.assertIn(digest, script)
        for prohibited in ['Start-Service ', 'Stop-Service ', 'Set-Service ', "Mode='Prepare'", 'ALTER ROLE', 'CREATE ROLE']:
            self.assertNotIn(prohibited, script)
        self.assertIn("if($Apply) {Save-UnifiedEvidence 'Prepare.json' $record}", script)
        self.assertIn('do not overwrite or replay', script)
        self.assertIn('Assert-UnifiedCi', script)
        self.assertIn('Enter-UnifiedMaintenanceLock', script)
        self.assertIn('$result=Invoke-UnifiedQuiesced {Invoke-UpdateProcess', script)
        self.assertIn('servicesBrieflyQuiesced=$true;servicesRestored=$true', script)
        self.assertIn('originalPreparationReceiptAvailable=$false', script)

    def test_read_only_login_and_state_guards(self):
        result = subprocess.run([shutil.which('node'), '--test', str(ROOT / 'tests/operations/device-access-recovery.test.mjs')], text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
