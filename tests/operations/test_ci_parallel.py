"""CI split must retain every historical suite and fail closed at its gate."""
import json
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / '.github/workflows/ci.yml').read_text()


class ParallelCiTest(unittest.TestCase):
    def test_browser_coverage(self):
        expected = '''kiosk_recovery browser_staff_display browser_service_shift
        browser_checkout browser_cart_sheet browser_catalog_recovery browser_menu_recovery
        browser_demo_account browser_profile browser_complete_catalog layout_regression
        browser_mockup_fidelity browser_pick_blocks browser_pick_man browser_arcade
        browser_arcade_motion browser_account_required browser_peak_loyalty
        browser_customer_account browser_kaspi_checkout'''.split()
        for name in expected:
            self.assertEqual(WORKFLOW.count('/' + name + '.py'), 1, name)
        self.assertEqual(WORKFLOW.count('tests/backoffice/content-browser.mjs'), 1)

    def test_transaction_coverage(self):
        for command in ['pnpm check', 'pnpm test:integration', 'pnpm test:commerce',
                        'pnpm test:loyalty', 'pnpm test:fulfillment\n', 'pnpm test:mobile',
                        'pnpm test:pos\n', 'pnpm test:backoffice', 'pnpm audit:release',
                        'windows-reserved-number.test.mjs', 'windows-native-service-upgrade.test.mjs',
                        'tiptoppay-http.test.mjs', 'kaspi-remote-http.test.mjs']:
            self.assertIn(command, WORKFLOW)
        self.assertEqual(WORKFLOW.count('pnpm db:migrate\n'), 2)
        self.assertEqual(WORKFLOW.count('pnpm db:seed\n'), 2)

    def test_gate_fails_on_failed_skipped_or_cancelled_suite(self):
        gate = WORKFLOW.split('  verify:\n', 1)[1].split('\n  kiosk:', 1)[0]
        self.assertIn('if: always()', gate)
        self.assertIn('name: Build, contracts and PostgreSQL integration', gate)
        needs = re.search(r'needs:\s*\[(.*?)\]', gate, re.S).group(1).replace('\n', '').replace(' ', '').rstrip(',').split(',')
        self.assertEqual(len(needs), 5)
        for name in needs:
            self.assertIn('\n  ' + name + ':\n', WORKFLOW)
        source = gate.split("python3 - <<'PYTHON'\n", 1)[1].split('          PYTHON', 1)[0]
        source = '\n'.join(line[10:] for line in source.splitlines())
        for status in ['success', 'failure', 'skipped', 'cancelled']:
            result = subprocess.run(['python3', '-c', source], env={'RESULTS': json.dumps(['success'] * 4 + [status])}, capture_output=True)
            self.assertEqual(result.returncode == 0, status == 'success', status)

    def test_isolated_runners_and_local_infrastructure(self):
        for block in WORKFLOW.split('\n  foundation_')[1:]:
            block = block.split('\n  verify:', 1)[0]
            self.assertIn('runs-on: ubuntu-24.04', block)
            self.assertIn('cp .env.example .env', block)
            self.assertIn('pnpm infra:up', block)
            self.assertIn('if: always()', block)
            self.assertIn('compose.yaml down', block)


if __name__ == '__main__':
    unittest.main()
