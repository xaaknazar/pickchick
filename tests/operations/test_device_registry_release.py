import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('device_registry_release', ROOT / 'infra/staging/release-device-registry.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)
GuardFailure = r.GuardFailure
PEPPER = '0123456789abcdef' * 4  # Synthetic test value, never a deployed secret.


def files_and_ledger(upto):
    files = sorted(p.name for p in (ROOT / 'db/cloud/migrations').glob('*.sql') if p.name <= '050_z')
    sums = {n: r.digest((ROOT / 'db/cloud/migrations' / n).read_bytes()) for n in files}
    files.append(r.MIGRATION)
    sums[r.MIGRATION] = '5' * 64
    ledger = [{'version': n, 'scope': 'cloud', 'checksum': sums[n]} for n in files if n <= upto]
    return files, sums, ledger


class Plan(unittest.TestCase):
    def test_only_051_may_be_pending(self):
        files, sums, ledger = files_and_ledger('050_z')
        self.assertEqual(r.registry_plan(ledger, files, sums), [r.MIGRATION])
        _, _, applied = files_and_ledger('051_z')
        self.assertEqual(r.registry_plan(applied, files, sums), [])
        with self.assertRaisesRegex(GuardFailure, 'exactly 051'):
            r.registry_plan(ledger[:-1], files, sums)

    def test_changed_history_or_extra_migration_refused(self):
        files, sums, ledger = files_and_ledger('050_z')
        bad = [dict(row) for row in ledger]
        bad[-1]['checksum'] = '0' * 64
        with self.assertRaisesRegex(GuardFailure, 'ledger differs'):
            r.registry_plan(bad, files, sums)
        with self.assertRaisesRegex(GuardFailure, 'end with 051'):
            r.registry_plan(ledger, files + ['052_cloud_unreviewed.sql'], {**sums, '052_cloud_unreviewed.sql': '1' * 64})

    def test_base_schema_is_050_without_041(self):
        names = sorted(p.name for p in (ROOT / 'db/cloud/migrations').glob('*.sql') if p.name <= '050_z')
        r.check_base_schema(names)
        with self.assertRaises(GuardFailure):
            r.check_base_schema(names[:-1])
        with self.assertRaises(GuardFailure):
            r.check_base_schema(names + [r.MIGRATION])


class Privileges(unittest.TestCase):
    def test_acl_matches_owner_step(self):
        owner = (ROOT / 'infra/staging/device-registry-owner.mjs').read_text()
        self.assertIn("REGISTRY_MIGRATION = '" + r.MIGRATION + "'", owner)
        block = owner.split('export const REGISTRY_PRIVILEGES', 1)[1].split('].sort()', 1)[0]
        self.assertEqual(r._acl(re.findall(r"'([a-z_]+\|[a-z_]*\|[A-Z]+)'", block)), r.REQUIRED_ACL)
        tables = owner.split('export const REGISTRY_NEW_TABLES', 1)[1].split(');', 1)[0]
        self.assertEqual(set(re.findall(r"'([a-z_]+)'", tables)), r.NEW_TABLES)

    def test_acl_matches_the_runtime_grant_module(self):
        grants = (ROOT / 'infra/staging/device-registry-grants.mjs').read_text()
        block = grants.split('export const DEVICE_REGISTRY_ACL', 1)[1].split('].map(', 1)[0]
        rows = re.findall(r"\['([a-z_]+)', (null|'[a-z_]+'), '([A-Z]+)'\]", block)
        self.assertTrue(rows)
        self.assertEqual(frozenset((t, None if c == 'null' else c.strip("'"), p) for t, c, p in rows), r.REQUIRED_ACL)
        tables = grants.split('export const DEVICE_REGISTRY_TABLES', 1)[1].split(');', 1)[0]
        self.assertEqual(set(re.findall(r"'([a-z_]+)'", tables)), r.NEW_TABLES)

    def test_owner_step_targets_the_real_051_shape(self):
        sql = (ROOT / 'db/cloud/migrations' / r.MIGRATION).read_text()
        owner = (ROOT / 'infra/staging/device-registry-owner.mjs').read_text()
        block = owner.split('export const REGISTRY_DEVICE_COLUMNS', 1)[1].split(']);', 1)[0]
        columns = re.findall(r"'([a-z_]+)'", block)
        added = re.findall(r'ADD COLUMN ([a-z_]+)', sql)
        self.assertEqual(sorted(columns), sorted(added))
        self.assertEqual(set(re.findall(r'CREATE TABLE ([a-z_]+)', sql)), r.NEW_TABLES)
        self.assertNotRegex(sql, r'(?i)\b(DROP|TRUNCATE|DELETE FROM|RENAME)\b')

    def test_new_tables_are_append_or_state_only(self):
        self.assertEqual({row[0] for row in r.EXACT_NEW_ACL}, r.NEW_TABLES)
        self.assertFalse({row for row in r.REQUIRED_ACL if row[2] in ('DELETE', 'TRUNCATE')})
        self.assertNotIn(('device_pairing_codes', 'code_hash', 'UPDATE'), r.REQUIRED_ACL)
        self.assertNotIn(('device_credentials', None, 'SELECT'), r.REQUIRED_ACL)  # never token_hash


class Pepper(unittest.TestCase):
    def test_environment_is_exactly_one_hex_pepper(self):
        self.assertEqual(r.validate_environment({r.PEPPER: PEPPER}), {r.PEPPER: PEPPER})
        for bad in [{}, {r.PEPPER: PEPPER, 'OTHER': '1'}, {r.PEPPER: PEPPER.upper()}, {r.PEPPER: 'ab' * 16},
                    {r.PEPPER: '0' * 64}, {r.PEPPER: 64}]:
            with self.assertRaises(GuardFailure):
                r.validate_environment(bad)

    def test_private_environment_must_be_0600(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / 'device-registry.env.json'  # macOS /var is a symlink
            path.write_text(json.dumps({r.PEPPER: PEPPER}))
            path.chmod(0o644)
            with self.assertRaises(GuardFailure):
                r.private_read(path)
            path.chmod(0o600)
            self.assertIn(b'DEVICE_PAIRING_PEPPER', r.private_read(path))

    def test_compose_gains_the_switch_and_pepper_lines_only(self):
        raw = (ROOT / 'infra/staging/compose.yaml').read_text()
        result = r.pepper_compose(raw)
        self.assertEqual(result.replace(r.PEPPER_LINE, '', 1).replace(r.PROVISION_LINE, '', 1), raw)
        api = result.split('\n  api:\n', 1)[1].split('\n  provision:\n', 1)[0]
        self.assertIn('    environment:\n' + r.PEPPER_LINE, api)
        provision = result.split('\n  provision:\n', 1)[1]
        self.assertNotIn(r.PEPPER, provision)
        self.assertIn('    environment:\n' + r.PROVISION_LINE, provision)
        self.assertNotIn(PEPPER, result)
        self.assertIn('      ' + r.ENABLED + ': "true"\n', api)
        with self.assertRaisesRegex(GuardFailure, 'already configured'):
            r.pepper_compose(result)
        api_env = "    environment:\n      APP_ENV: staging\n      API_PORT: '3100'\n"
        self.assertEqual(raw.count(api_env), 1)
        with self.assertRaisesRegex(GuardFailure, 'switch already present'):
            r.pepper_compose(raw.replace(api_env, api_env + '      ' + r.ENABLED + ': "false"\n'))

    def test_compose_with_service_after_api_and_missing_anchor(self):
        raw = ('services:\n  api:\n    image: x\n    environment:\n      A: b\n  worker:\n    environment:\n      C: d\n'
               '  provision:\n    environment:\n      E: f\n')
        result = r.pepper_compose(raw)
        self.assertEqual(result.count(r.PEPPER_LINE), 1)
        self.assertTrue(result.startswith('services:\n  api:\n    image: x\n    environment:\n' + r.PEPPER_LINE))
        self.assertTrue(result.endswith('  provision:\n    environment:\n' + r.PROVISION_LINE + '      E: f\n'))
        self.assertIn('  worker:\n    environment:\n      C: d\n', result)
        with self.assertRaisesRegex(GuardFailure, 'environment anchor'):
            r.pepper_compose('services:\n  api:\n    image: x\n  worker:\n    environment:\n      C: d\n'
                             '  provision:\n    environment:\n      E: f\n')
        with self.assertRaisesRegex(GuardFailure, 'provision service anchor'):
            r.pepper_compose('services:\n  api:\n    image: x\n    environment:\n      A: b\n')

    def test_release_env_program_appends_pepper_once(self):
        old_sha, new_sha = 'a' * 40, 'b' * 40
        with tempfile.TemporaryDirectory() as directory:
            old, new = Path(directory) / 'old.env', Path(directory) / 'new.env'
            old.write_text('FLAG=true\nRELEASE_SHA=' + old_sha + '\n')
            command = [sys.executable, '-c', r.release_env_program(), str(old), str(new), new_sha, old_sha, r.PEPPER]
            run = subprocess.run(command, input=json.dumps({r.PEPPER: PEPPER}), text=True, capture_output=True)
            self.assertEqual(run.returncode, 0)
            self.assertNotIn(PEPPER, run.stdout + run.stderr)
            self.assertEqual(new.read_text(), f'FLAG=true\nRELEASE_SHA={new_sha}\n{r.PEPPER}={PEPPER}\n')
            self.assertEqual(new.stat().st_mode & 0o777, 0o600)
            again = subprocess.run(command, input=json.dumps({r.PEPPER: PEPPER}), text=True, capture_output=True)
            self.assertNotEqual(again.returncode, 0)  # never overwrites a prepared release.env
            new.unlink()
            old.write_text(old.read_text() + r.PEPPER + '=x\n')
            refused = subprocess.run(command, input=json.dumps({r.PEPPER: PEPPER}), text=True, capture_output=True)
            self.assertNotEqual(refused.returncode, 0)

    def test_environment_delta_requires_the_pepper_digest(self):
        before = {'RELEASE_SHA': r.digest(b'a'), 'DB': r.digest(b'x')}
        after = {'RELEASE_SHA': r.digest(b'b'), 'DB': r.digest(b'x'), r.PEPPER: r.digest(PEPPER.encode()),
                 r.ENABLED: r.digest(b'true')}
        r.verify_pepper_environment(before, after, PEPPER)
        without_switch = {k: v for k, v in after.items() if k != r.ENABLED}
        with self.assertRaisesRegex(GuardFailure, r.ENABLED):
            r.verify_pepper_environment(before, without_switch, PEPPER)
        with self.assertRaises(GuardFailure):
            r.verify_pepper_environment(before, {**after, r.ENABLED: r.digest(b'false')}, PEPPER)
        with self.assertRaisesRegex(GuardFailure, 'switch'):
            r.verify_pepper_environment({**before, r.ENABLED: r.digest(b'false')}, after, PEPPER)
        with self.assertRaises(GuardFailure):
            r.verify_pepper_environment(before, {**after, r.PEPPER: r.digest(b'other')}, PEPPER)
        with self.assertRaises(GuardFailure):
            r.verify_pepper_environment(before, {**after, 'DB': r.digest(b'y')}, PEPPER)
        with self.assertRaises(GuardFailure):
            r.verify_pepper_environment(after, after, PEPPER)


class Arguments(unittest.TestCase):
    def test_arguments_require_ci_compose_image_and_environment(self):
        base = ['a' * 40, '--branch', 'codex/x', '--branch-id', '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1',
                '--base-image', 'sha256:' + 'c' * 64, '--environment', '/nonexistent']
        with self.assertRaises(SystemExit):
            r.parse(base + ['--ci-run', '1'])
        with self.assertRaises(SystemExit):
            r.parse(base + ['--expected-compose-sha256', 'b' * 64])
        with self.assertRaises(SystemExit):
            r.parse(base[:5] + base[7:] + ['--expected-compose-sha256', 'b' * 64, '--ci-run', '1'])
        args = r.parse(base + ['--expected-compose-sha256', 'b' * 64, '--ci-run', '1'])
        self.assertFalse(args.apply)
        self.assertEqual(r.BASE_API_SHA[:8], 'cf25cb9e')


if __name__ == '__main__':
    unittest.main()
