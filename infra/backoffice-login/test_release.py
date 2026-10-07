import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('ceo_release',Path(__file__).with_name('release.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Guards(unittest.TestCase):
    def proof(self):
        sha='a'*40
        return {'run':{'head_sha':sha,'conclusion':'success','status':'completed','path':'.github/workflows/ci.yml','head_repository':{'full_name':'xaaknazar/pickchick'}},
                'jobs':{'total_count':11,'jobs':[{'name':name,'head_sha':sha,'status':'completed','conclusion':'success'} for name in m.JOBS]}}
    def test_exact_ci(self):m.verify_ci(self.proof(),'a'*40)
    def test_missing_job(self):
        p=self.proof();p['jobs']['jobs'].pop()
        with self.assertRaises(RuntimeError):m.verify_ci(p,'a'*40)
    def test_failed_job(self):
        p=self.proof();p['jobs']['jobs'][0]['conclusion']='failure'
        with self.assertRaises(RuntimeError):m.verify_ci(p,'a'*40)
    def test_wrong_source(self):
        with self.assertRaises(RuntimeError):m.verify_ci(self.proof(),'b'*40)
    def test_append_only_and_no_duplicate(self):
        old=b'neighbor.example { respond "unchanged" }\n'
        block=Path(__file__).with_name('pickchick.Caddyfile').read_bytes()
        new=m.domain.candidate(old,block)
        self.assertTrue(new.startswith(old));self.assertIn(b'pickchick-staff-login:4177',new)
        with self.assertRaises(RuntimeError):m.domain.candidate(new,block)
if __name__=='__main__':unittest.main()
