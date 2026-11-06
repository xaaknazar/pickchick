import importlib.util
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'infra/staging/stage2-owner-connection.py'
spec = importlib.util.spec_from_file_location('owner_connection', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
API = 'postgresql://pickchick_app:synthetic@cloud-db:5432/pickchick_cloud'
SECRET = 'a' * 64


class OwnerConnectionTests(unittest.TestCase):
    def test_resolved_api_only_compose_does_not_need_provision(self):
        compose = {'services': {'api': {'environment': {'CLOUD_DATABASE_URL': API}}}}
        env = module.owner_environment(compose['services']['api']['environment']['CLOUD_DATABASE_URL'],
                                       'DB_OWNER_PASSWORD=' + SECRET + '\nUNRELATED=keep-private\n')
        self.assertEqual(set(env), {'CLOUD_DATABASE_URL'})
        self.assertEqual(env['CLOUD_DATABASE_URL'],
                         'postgresql://pickchick_owner:' + SECRET + '@127.0.0.1:5432/pickchick_cloud')

    def test_wrong_database_contract_stops(self):
        for value in [API.replace('cloud-db', 'external.example'),
                      API.replace('5432', '15432'), API.replace('pickchick_cloud', 'other'),
                      API.replace('pickchick_app', 'postgres'), API + '?sslmode=disable',
                      API + '#fragment', 'invalid', None]:
            with self.subTest(value=value):
                with self.assertRaisesRegex(module.OwnerConnectionError, '^owner.api_database_contract$'):
                    module.owner_environment(value, 'DB_OWNER_PASSWORD=' + SECRET)

    def test_missing_duplicate_or_malformed_secret_stops_without_value(self):
        for settings in ['', 'DB_OWNER_PASSWORD=' + SECRET + '\nDB_OWNER_PASSWORD=' + SECRET,
                         'DB_OWNER_PASSWORD=do-not-log-this', 'DB_OWNER_PASSWORD=' + SECRET.upper(),
                         'DB_OWNER_PASSWORD=' + SECRET + ' ']:
            with self.subTest(case=len(settings)):
                with self.assertRaises(module.OwnerConnectionError) as caught:
                    module.owner_environment(API, settings)
                self.assertNotIn(SECRET, str(caught.exception))
                self.assertNotIn('do-not-log-this', str(caught.exception))
                self.assertTrue(str(caught.exception).startswith('owner.'))

    def test_protected_file_only(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'settings.env'
            file.write_text('DB_OWNER_PASSWORD=' + SECRET)
            file.chmod(0o600)
            self.assertIn('CLOUD_DATABASE_URL', module.read_owner_environment(API, file))
            file.chmod(0o644)
            with self.assertRaisesRegex(module.OwnerConnectionError, 'owner.file_permissions'):
                module.read_owner_environment(API, file)
            file.chmod(0o600)
            alias = Path(directory) / 'alias.env'
            alias.symlink_to(file)
            with self.assertRaisesRegex(module.OwnerConnectionError, 'owner.protected_file'):
                module.read_owner_environment(API, alias)


if __name__ == '__main__':
    unittest.main()
