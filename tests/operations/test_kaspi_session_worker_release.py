import ast
import runpy
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class KaspiSessionWorkerRelease(unittest.TestCase):
    def setUp(self):
        self.source = (ROOT / 'infra/staging/release-kaspi-session-worker.py').read_text()
        tree = ast.parse(self.source)
        self.remote = next(n.value.value for n in tree.body if isinstance(n, ast.Assign)
                           and any(isinstance(t, ast.Name) and t.id == 'code' for t in n.targets))

    def test_both_scripts_compile_and_exact_ci_is_required(self):
        compile(self.source, 'profile', 'exec')
        compile(self.remote, 'remote', 'exec')
        self.assertIn('exact_jobs=True', self.source)
        self.assertIn("prepared['sha']==sha", self.source)
        self.assertIn("289da31b47915b2d5cc3bb1813a4df613eb265b2", self.remote)

    def test_all_eleven_reviewed_jobs_required_without_relaxing_exact_match(self):
        market = runpy.run_path(str(ROOT / 'infra/staging/release-market.py'))
        tree = ast.parse(self.source)
        required = next(n.value for n in tree.body if isinstance(n, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == 'required_jobs' for t in n.targets))
        jobs = eval(compile(ast.Expression(required), 'jobs', 'eval'), {'m': market})
        self.assertEqual(len(jobs), 11)
        sha = 'a' * 40
        proof = {'run': {'head_sha': sha, 'status': 'completed', 'conclusion': 'success',
                         'path': '.github/workflows/ci.yml',
                         'head_repository': {'full_name': 'xaaknazar/pickchick'}},
                 'jobs': {'total_count': 11, 'jobs': [
                     {'name': name, 'status': 'completed', 'conclusion': 'success', 'head_sha': sha}
                     for name in jobs]}}
        market['verify_ci'](proof, sha, jobs, exact_jobs=True)
        proof['jobs']['jobs'].pop()
        proof['jobs']['total_count'] = 10
        with self.assertRaises(market['GuardFailure']):
            market['verify_ci'](proof, sha, jobs, exact_jobs=True)

    def test_prepare_only_builds_exact_archive_without_packaging_or_starting_api(self):
        preparation = self.source.split('if args.prepare_only:')[1].split("prepared=json.loads")[0]
        for required in ['git','archive', 'docker build -q', 'ci_proof_sha256',
                         'org.opencontainers.image.revision', "installed':False", 'kaspi-builds/']:
            self.assertIn(required, preparation)
        for forbidden in ['compose(', 'prepare-web', 'release.env', 'GRANT', 'db:migrate']:
            self.assertNotIn(forbidden, preparation)

    def test_worker_only_has_financial_secret_neighbor_and_pointer_guards(self):
        for guard in ["before['unsettled']==0 and before['pending']==0", 'ledger()==before',
                      'secret_hashes()==secrets', "actual['HostConfig']['ReadonlyRootfs']",
                      "actual['Config']['User']=='1000:1000'", "actual['RestartCount']==0",
                      "compose(r/'kaspi-companion'/old)", 'pointers()', "['up','-d','--no-deps','worker']"]:
            self.assertIn(guard, self.remote)
        self.assertNotIn("api=p['sha']", self.remote)
        self.assertIn('new_grants', self.remote)
        self.assertIn('for t in new_grants', self.remote)

    def test_probe_uses_fake_bank_and_never_issues_invoice(self):
        self.assertIn('new KaspiBridgeClient(c,async(url,init)', self.remote)
        self.assertIn('sessionPreflight:true,newInvoiceCreated:false', self.remote)
        self.assertNotIn('createInvoice(', self.remote)
        self.assertNotIn('client.checkSession()', self.remote.split('probe=r')[0])


if __name__ == '__main__':
    unittest.main()
