import copy
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'infra/staging/cloud1-preflight.py'
spec = importlib.util.spec_from_file_location('cloud1_preflight', SCRIPT)
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)
SHA = 'a' * 40


class CloudOneTests(unittest.TestCase):
    def setUp(self):
        self.compose = {'name': 'pickchick-staging', 'services': {
            'api': {'image': 'pickchick-api:' + cloud.BASELINE,
                    'environment': {'CLOUD_POS_ORDER_SYNC': 'true',
                                    'BACKOFFICE_ENABLED': 'true',
                                    'CLOUD_DATABASE_URL': 'fixture-only',
                                    'CUSTOMER_AUTH_TERMS_URL': 'https://example.invalid/legal/terms'},
                    'ports': ['127.0.0.1:13100:3100']},
            'cloud-db': {'image': 'postgres:18.3-alpine', 'volumes': ['cloud:/var/lib/postgresql']},
            'redis-cache': {'image': 'redis:8-alpine'}},
            'volumes': {'cloud': {'name': 'pickchick-staging_cloud'}}}
        self.pr = {'number': 343, 'merged': True, 'merge_commit_sha': 'b' * 40,
                   'base': {'ref': cloud.BRANCH, 'repo': {'full_name': cloud.REPO}}}
        self.run = {'id': 123, 'head_sha': SHA, 'head_branch': cloud.BRANCH,
                    'head_repository': {'full_name': cloud.REPO},
                    'path': '.github/workflows/ci.yml', 'event': 'push',
                    'status': 'completed', 'conclusion': 'success'}
        self.jobs = {'total_count': len(cloud.JOBS), 'jobs': [
            {'run_id': 123, 'head_sha': SHA, 'status': 'completed',
             'conclusion': 'success', 'name': name} for name in sorted(cloud.JOBS)]}

    def prepare(self, data=None):
        data = data if data is not None else json.dumps(self.compose).encode()
        with patch.object(cloud, 'COMPOSE_SHA', cloud.digest(data)):
            return cloud.resolved_compose(data, SHA)

    def gate(self, **kwargs):
        values = dict(sha=SHA, published_sha=SHA, pr=self.pr, run=self.run,
                      jobs=self.jobs, merged_ancestor=True)
        values.update(kwargs)
        return cloud.candidate_gate(**values)

    def test_resolved_compose_preserves_neighbors_and_existing_flags(self):
        result = json.loads(self.prepare())
        before = copy.deepcopy(self.compose)
        before['services']['api']['image'] = 'pickchick-api:' + SHA
        before['services']['api']['environment'].update({key: 'false' for key in cloud.FLAGS})
        self.assertEqual(before, result)
        self.assertNotIn('provision', result['services'])
        self.assertEqual('true', result['services']['api']['environment']['BACKOFFICE_ENABLED'])

    def test_unknown_baseline_is_not_repaired(self):
        with self.assertRaisesRegex(cloud.Stop, 'baseline_sha256'):
            cloud.resolved_compose(json.dumps(self.compose).encode(), SHA)

    def test_wrong_image_services_existing_flags_and_release_override_refused(self):
        for defect in ('image', 'services', 'flag', 'release'):
            with self.subTest(defect=defect):
                value = copy.deepcopy(self.compose)
                if defect == 'image':
                    value['services']['api']['image'] = 'other-image'
                elif defect == 'services':
                    value['services']['worker'] = {'image': 'bank-worker'}
                elif defect == 'flag':
                    value['services']['api']['environment'][cloud.FLAGS[0]] = 'true'
                else:
                    value['services']['api']['environment']['RELEASE_SHA'] = 'c' * 40
                with self.assertRaises(cloud.Stop):
                    self.prepare(json.dumps(value).encode())

    def test_duplicate_keys_refused(self):
        with self.assertRaisesRegex(cloud.Stop, 'duplicate_key'):
            self.prepare(b'{"services": {}, "services": {}}')

    def test_candidate_requires_full_immutable_sha(self):
        data = json.dumps(self.compose).encode()
        with patch.object(cloud, 'COMPOSE_SHA', cloud.digest(data)):
            for value in ('latest', 'a' * 8, cloud.BASELINE, None):
                with self.subTest(value=value), self.assertRaises(cloud.Stop):
                    cloud.resolved_compose(data, value)

    def test_full_exact_candidate_accepted(self):
        self.assertEqual({'candidate': SHA, 'foundationRun': 123, 'jobs': 11}, self.gate())

    def test_unmerged_pr_or_wrong_branch_ancestry_refused(self):
        for key, value in (('merged', False), ('number', 344), ('merge_commit_sha', None)):
            pr = copy.deepcopy(self.pr)
            pr[key] = value
            with self.subTest(key=key), self.assertRaises(cloud.Stop):
                self.gate(pr=pr)
        with self.assertRaises(cloud.Stop):
            self.gate(merged_ancestor=False)
        self.pr['base']['ref'] = 'main'
        with self.assertRaises(cloud.Stop):
            self.gate()

    def test_moving_published_head_refused(self):
        with self.assertRaisesRegex(cloud.Stop, 'published_head'):
            self.gate(published_sha='c' * 40)

    def test_stale_foreign_partial_or_wrong_workflow_refused(self):
        for key, value in (('head_sha', 'c' * 40), ('head_branch', 'codex/other'),
                           ('event', 'pull_request'), ('status', 'in_progress'),
                           ('conclusion', 'failure'), ('path', 'other.yml'),
                           ('head_repository', {'full_name': 'other/pickchick'})):
            run = {**self.run, key: value}
            with self.subTest(key=key), self.assertRaises(cloud.Stop):
                self.gate(run=run)

    def test_missing_duplicate_extra_and_non_success_job_refused(self):
        for defect in ('missing', 'duplicate', 'extra', 'skipped', 'cancelled',
                       'failure', 'sha', 'run'):
            jobs = copy.deepcopy(self.jobs)
            rows = jobs['jobs']
            if defect == 'missing':
                rows.pop()
            elif defect == 'duplicate':
                rows[-1] = copy.deepcopy(rows[0])
            elif defect == 'extra':
                rows.append(copy.deepcopy(rows[0]))
            elif defect == 'sha':
                rows[0]['head_sha'] = 'c' * 40
            elif defect == 'run':
                rows[0]['run_id'] = 456
            else:
                rows[0]['conclusion'] = defect
            with self.subTest(defect=defect), self.assertRaises(cloud.Stop):
                self.gate(jobs=jobs)

    def test_cli_failure_does_not_write_or_print_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'private.json'
            dest = Path(directory) / 'out.json'
            source.write_text(json.dumps(self.compose))
            source.chmod(0o600)
            result = subprocess.run(['python3', str(SCRIPT), '--compose', str(source),
                                     '--candidate', SHA, '--out', str(dest)],
                                    text=True, capture_output=True)
            self.assertEqual(1, result.returncode)
            self.assertEqual({'status': 'STOP', 'check': 'compose.baseline_sha256'},
                             json.loads(result.stdout))
            self.assertFalse(dest.exists())
            self.assertNotIn('fixture-only', result.stdout + result.stderr)

    def test_cli_output_private_no_overwrite_or_symlink_follow(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'private.json'
            dest = Path(directory) / 'out.json'
            source.write_text(json.dumps(self.compose))
            source.chmod(0o600)
            argv = [str(SCRIPT), '--compose', str(source), '--candidate', SHA, '--out', str(dest)]
            with patch.object(cloud, 'COMPOSE_SHA', cloud.digest(source.read_bytes())), \
                    patch('sys.argv', argv), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(0, cloud.main())
                self.assertEqual(0, dest.stat().st_mode & 0o077)
                before = dest.read_bytes()
                self.assertEqual(1, cloud.main())
                self.assertEqual(before, dest.read_bytes())
                dest.unlink()
                dest.symlink_to(source)
                self.assertEqual(1, cloud.main())
                self.assertEqual(self.compose, json.loads(source.read_text()))
                self.assertNotIn('fixture-only', output.getvalue())

    def test_github_unmerged_pr_stops_before_fetch_or_server_work(self):
        responses = [subprocess.CompletedProcess([], 0, json.dumps({'object': {'sha': SHA}})),
                     subprocess.CompletedProcess([], 0, json.dumps({'merged': False}))]
        with patch.object(cloud.subprocess, 'run', side_effect=responses) as run:
            with self.assertRaisesRegex(cloud.Stop, 'pr343_not_merged'):
                cloud.github_gate('gh', SCRIPT.parents[2])
            self.assertEqual(2, run.call_count)
            self.assertTrue(all(call.args[0][:2] == ['gh', 'api'] for call in run.call_args_list))


if __name__ == '__main__':
    unittest.main()
