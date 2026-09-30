"""Pure operator-crontab preservation checks; never reads or installs host cron."""
import importlib.util
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[2] / 'infra/staging/install-identity-cleanup-cron.py'
spec = importlib.util.spec_from_file_location('identity_cleanup_cron', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MaintenanceCron(unittest.TestCase):
    def test_keeps_other_jobs_and_pins_release_on_first_and_repeated_install(self):
        previous = 'MAILTO=""\n# Operator backup\n0 2 * * * /usr/local/bin/backup\n'
        first = module.render_crontab(previous, 'a' * 40)
        self.assertTrue(first.startswith(previous))
        self.assertEqual(module.render_crontab(first, 'a' * 40), first)
        second = module.render_crontab(first, 'b' * 40)
        self.assertTrue(second.startswith(previous))
        self.assertNotIn('a' * 40, second)
        self.assertEqual(second.count('*/15 * * * *'), 1)
        self.assertIn('/releases/' + 'b' * 40 + '/infra/staging/identity-cleanup-cron.sh', second)

    def test_keeps_jobs_after_existing_managed_block(self):
        original = module.render_crontab('', 'a' * 40) + '5 * * * * /usr/local/bin/report\n'
        updated = module.render_crontab(original, 'b' * 40)
        self.assertIn('5 * * * * /usr/local/bin/report\n', updated)
        self.assertEqual(updated.count(module.START), 1)

    def test_malformed_owned_markers_stop_instead_of_removing_other_jobs(self):
        for text in [module.START, module.END, module.END + '\n' + module.START,
                     '\n'.join([module.START, module.END, module.START, module.END])]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                module.render_crontab(text, 'a' * 40)

    def test_rejects_shell_or_cron_injection_before_rendering(self):
        for sha in ['', 'a' * 39, 'A' * 40, 'a' * 40 + '\n* * * * * arbitrary',
                    'a' * 40 + '; arbitrary', '$(arbitrary)', 'a' * 40 + '%payload']:
            with self.subTest(sha=sha), self.assertRaises(ValueError):
                module.render_crontab('', sha)


if __name__ == '__main__':
    unittest.main()
