import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('roadmap_deploy', Path(__file__).with_name('remote-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentGuards(unittest.TestCase):
    def test_runtime_port_is_allowed_by_fetch_and_matches_gateway(self):
        config = Path(__file__).with_name('compose.yaml').read_text()
        self.assertIn("ROADMAP_PORT: '4192'", config)
        self.assertIn('127.0.0.1:4192/roadmap/health', config)
        self.assertIn('pickchick-roadmap:4192', deploy.ROUTE)
        self.assertNotIn('4190', config + deploy.ROUTE)

    def test_first_install_cleanup_removes_only_stopped_owned_container(self):
        release = Path('/opt/pickchick-staging/roadmap/releases/' + 'a' * 40)
        mounts = [{'Destination': '/app', 'Source': str(release / 'apps/roadmap')}]
        with patch.object(deploy, 'run', side_effect=['container-id', json.dumps(mounts), 'false', 'removed']) as run:
            deploy.remove_failed_first_container(release)
            self.assertEqual(run.call_args.args[0], ['docker', 'rm', deploy.SERVICE])

    def test_first_install_cleanup_rejects_unowned_or_running_container(self):
        release = Path('/opt/pickchick-staging/roadmap/releases/' + 'a' * 40)
        cases = [
            ['container-id', json.dumps([{'Destination': '/app', 'Source': '/another-release'}])],
            ['container-id', json.dumps([{'Destination': '/app', 'Source': str(release / 'apps/roadmap')}]), 'true'],
        ]
        for answers in cases:
            with patch.object(deploy, 'run', side_effect=answers) as run:
                with self.assertRaises(RuntimeError):
                    deploy.remove_failed_first_container(release)
                self.assertFalse(any(call.args[0][:2] == ['docker', 'rm'] for call in run.call_args_list))

    def test_first_install_cleanup_accepts_absent_container(self):
        with patch.object(deploy, 'run', return_value='') as run:
            deploy.remove_failed_first_container(Path('/unused'))
            self.assertEqual(run.call_count, 1)

    def test_gateway_extension_preserves_existing_routes(self):
        source = '{\n admin off\n}\n:8080 {\n handle /business { respond unchanged }\n\thandle { respond 404 }\n}\n'
        updated = deploy.add_route(source)
        self.assertEqual(updated.replace('\n' + deploy.ROUTE, '', 1), source)
        self.assertEqual(deploy.add_route(updated), updated)
        self.assertIn('path /roadmap /roadmap/*', updated)
        self.assertNotIn('header_up -Cookie', updated)

    def test_unknown_roadmap_configuration_cannot_be_overwritten(self):
        with self.assertRaisesRegex(RuntimeError, 'Unrecognized'):
            deploy.add_route(':8080 {\n handle /roadmap/* {}\n\thandle {}\n}')

    def test_incomplete_markers_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'markers'):
            deploy.add_route(deploy.MARKER_START + 'incomplete')

    def test_public_manifest_detects_asset_corruption_without_rewriting_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            web = root / 'infra/public-staging/public-web'
            web.mkdir(parents=True)
            content = b'original public asset'
            (web / 'app.js').write_bytes(content)
            original = json.dumps({'source_sha': 'a' * 40, 'files': {
                'app.js': hashlib.sha256(content).hexdigest()}}).encode()
            (web / '.release.json').write_bytes(original)
            deploy.public_files(root)
            self.assertEqual((web / '.release.json').read_bytes(), original)
            (web / 'app.js').write_text('corrupted')
            with self.assertRaisesRegex(RuntimeError, 'manifest'):
                deploy.public_files(root)

    def test_public_manifest_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            web = root / 'infra/public-staging/public-web'
            web.mkdir(parents=True)
            (web / '.release.json').write_text(json.dumps({'files': {'../../secret': 'a' * 64}}))
            with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
                deploy.public_files(root)

    def test_success_releases_own_lock_and_uncertainty_retains_it(self):
        old_lock = deploy.LOCK
        try:
            with tempfile.TemporaryDirectory() as temporary:
                deploy.LOCK = Path(temporary) / 'lock'
                with deploy.lock('a' * 40):
                    self.assertTrue(deploy.LOCK.is_dir())
                self.assertFalse(deploy.LOCK.exists())
                with self.assertRaises(RuntimeError):
                    with deploy.lock('b' * 40):
                        raise RuntimeError('unknown completion')
                self.assertTrue((deploy.LOCK / 'owner.json').is_file())
                with self.assertRaises(FileExistsError):
                    with deploy.lock('c' * 40):
                        pass
        finally:
            deploy.LOCK = old_lock


if __name__ == '__main__':
    unittest.main()
