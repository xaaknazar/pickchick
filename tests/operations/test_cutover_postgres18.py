import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/verify-cutover-postgres18.py'
spec = importlib.util.spec_from_file_location('cutover_postgres18', SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class CutoverPostgres18Tests(unittest.TestCase):
    def test_waits_past_the_temporary_unix_only_initdb_server(self):
        probes = 0

        def server(args, env):
            nonlocal probes
            if 'pg_isready' in args:
                self.assertIn('127.0.0.1', args)
                probes += 1
                if probes == 1:
                    raise RuntimeError('TCP not ready during initdb')
                return ''
            self.assertGreaterEqual(probes, 2, 'Unix-only temporary server is not ready')
            return '180006'

        with patch.object(runner, 'docker', side_effect=server), patch.object(runner.time, 'sleep'):
            self.assertEqual(runner.wait_database('owned-fixture', 'pickchick_edge', {}), '180006')
        with patch.object(runner, 'docker', side_effect=RuntimeError('unavailable')), \
                patch.object(runner.time, 'sleep'), self.assertRaisesRegex(RuntimeError, 'did not become ready'):
            runner.wait_database('owned-fixture', 'pickchick_edge', {})

    def test_backup_tools_match_the_native_setup_baseline(self):
        for tool in ('pg_dump', 'pg_restore'):
            runner.verify_tool_version(tool, tool + ' (PostgreSQL) 18.6')
            runner.verify_tool_version(tool, tool + ' (PostgreSQL) 18.6 (packaged build)')
            for version in ('16.9', '18.3', '18.60', '19.0', '18.6beta1', ''):
                with self.subTest(tool=tool, version=version), self.assertRaises(RuntimeError):
                    runner.verify_tool_version(tool, tool + ' (PostgreSQL) ' + version)

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
