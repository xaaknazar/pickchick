import ast
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
