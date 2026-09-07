"""Offline safety checks. No VPS, SSH, provider or real customer data calls."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('market_profile', ROOT / 'infra/staging/release-market.py')
market = importlib.util.module_from_spec(spec)
spec.loader.exec_module(market)
SHA = 'a' * 40


def proof():
    jobs = market.TRANSPORT_PROFILE.ci_jobs
    return {'run': {'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
                    'path': '.github/workflows/ci.yml',
                    'head_repository': {'full_name': 'xaaknazar/pickchick'}},
            'jobs': {'total_count': len(jobs), 'jobs': [
                {'name': name, 'head_sha': SHA, 'status': 'completed', 'conclusion': 'success'}
                for name in sorted(jobs)]}}


class ProfileTests(unittest.TestCase):
    def test_follow_on_baseline_is_distinct_from_historical_profile(self):
        p = market.TRANSPORT_PROFILE
        self.assertEqual(p.old_api, market.TRANSPORT_BASELINE)
        self.assertEqual(p.old_web, p.old_api)
        self.assertEqual(p.baseline_count, 13)
        self.assertEqual(p.migrations, ('014_cloud_fulfillment_transport.sql',))
        self.assertEqual(p.new_sequences, frozenset())
        self.assertEqual(len(market.TRANSPORT_TABLES), 6)
        instance = market.Release.__new__(market.Release)
        instance.profile = p
        instance.git = lambda *args: '\n'.join(f'db/cloud/migrations/{i:03d}_cloud.sql' for i in range(1, 14))
        self.assertEqual(len(instance.baseline_migrations()), 13)
        instance.profile = market.HISTORICAL_PROFILE
        with self.assertRaises(market.GuardFailure):
            instance.baseline_migrations()

    def test_six_exact_ci_jobs_reject_missing_duplicate_or_future_unreviewed_jobs(self):
        p = market.TRANSPORT_PROFILE
        market.verify_ci(proof(), SHA, p.ci_jobs, exact_jobs=p.exact_ci_jobs)
        for mutation in ['missing', 'duplicate', 'extra', 'wrong_sha', 'skipped']:
            value = copy.deepcopy(proof())
            rows = value['jobs']['jobs']
            if mutation == 'missing':
                rows.pop()
            elif mutation == 'duplicate':
                rows[-1] = rows[0]
            elif mutation == 'extra':
                rows.append({**rows[0], 'name': 'Unreviewed extra workflow'})
            elif mutation == 'wrong_sha':
                rows[0]['head_sha'] = 'b' * 40
            else:
                rows[0]['conclusion'] = 'skipped'
            value['jobs']['total_count'] = len(rows)
            with self.subTest(mutation=mutation), self.assertRaises(market.GuardFailure):
                market.verify_ci(value, SHA, p.ci_jobs, exact_jobs=p.exact_ci_jobs)

    def test_environment_preserves_unrelated_settings_and_forces_all_new_flags_off(self):
        p = market.TRANSPORT_PROFILE
        with tempfile.TemporaryDirectory() as directory:
            old, new = Path(directory) / 'old', Path(directory) / 'new'
            old.write_text(f'RELEASE_SHA={p.old_api}\nAPI_BIND=127.0.0.1\n'
                           'CLOUD_FULFILLMENT_TRANSPORT_ENABLED=true\nCUSTOMER_AUTH_ENABLED=true\n')
            subprocess.run([sys.executable, '-c', market.release_env_script(p), str(old), str(new), SHA, p.old_api],
                           check=True, capture_output=True)
            settings = dict(line.split('=', 1) for line in new.read_text().splitlines())
            self.assertEqual(settings, {'API_BIND': '127.0.0.1', 'RELEASE_SHA': SHA, **dict(p.settings)})
            self.assertEqual(new.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
