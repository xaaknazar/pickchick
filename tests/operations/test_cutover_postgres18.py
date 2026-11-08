import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/verify-cutover-postgres18.py'
spec = importlib.util.spec_from_file_location('cutover_postgres18', SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class CutoverPostgres18Tests(unittest.TestCase):
    def test_production_configuration_cannot_enter_test_environment(self):
        env = runner.environment({
            'PATH': '/tools', 'HOME': '/user', 'DOCKER_CONFIG': '/docker-auth',
            'PLAYWRIGHT_BROWSERS_PATH': '/browser',
            'EDGE_DATABASE_URL': 'postgres://production',
            'CLOUD_DATABASE_URL': 'postgres://production',
            'APP_ENV': 'staging', 'PGPASSWORD': 'private',
            'NODE_OPTIONS': '--env-file=production.env',
            'DOCKER_HOST': 'ssh://production', 'DOCKER_CONTEXT': 'production',
            'DOCKER_TLS_VERIFY': '1', 'DOCKER_CERT_PATH': '/private',
            'CLOUD_POS_SALES_SYNC_ENABLED': 'true',
        })
        self.assertEqual(env, {'PATH': '/tools', 'HOME': '/user',
                               'DOCKER_CONFIG': '/docker-auth',
                               'PLAYWRIGHT_BROWSERS_PATH': '/browser'})

    def test_only_complete_success_is_accepted(self):
        log = '# tests 28\n# pass 28\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
        self.assertEqual(runner.test_summary(log)['pass'], 28)
        for bad in (
            log.replace('# skipped 0', '# skipped 1'),
            log.replace('# fail 0', '# fail 1'),
            log.replace('# cancelled 0', '# cancelled 1'),
            log.replace('# todo 0', '# todo 1'),
            log.replace('# pass 28', '# pass 27'),
            log.replace('# tests 28', '# tests 0'),
            log.replace('# skipped 0\n', ''),
            log + '# pass 28\n',
            '',
        ):
            with self.subTest(log=bad), self.assertRaises(RuntimeError):
                runner.test_summary(bad)


if __name__ == '__main__':
    unittest.main()
