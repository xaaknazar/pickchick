"""Existing-agent upgrade is distinct from first-install and pins its shared helpers."""
import hashlib
from pathlib import Path
import unittest
ROOT = Path(__file__).resolve().parents[2]
class LinkUpdate(unittest.TestCase):
    def test_reviewed_helpers_and_exact_agent_manifest(self):
        text = (ROOT / 'infra/kitchen-portal/update-agent.ps1').read_text()
        for name in ['install-native-foundation.ps1', 'update-native-service.ps1', 'update-native-unified-menu.ps1']:
            self.assertIn(hashlib.sha256((ROOT / 'infra/windows' / name).read_bytes()).hexdigest(), text)
        for name in ['infra/kitchen-portal/agent.mjs', 'infra/kitchen-portal/link.mjs', 'apps/kitchen/server.mjs', 'apps/kitchen/terminal-cookie.mjs']:
            self.assertIn(name, text)
            self.assertIn(name, (ROOT / 'infra/kitchen-portal/package.mjs').read_text())
        self.assertNotIn(' install\n', text)
