import importlib.util
from pathlib import Path
import hashlib
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('legal_update',ROOT/'infra/public-staging/legal-update.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class LegalTests(unittest.TestCase):
    def test_guarded_terms_patch_preserves_operator_and_other_sections(self):
        original='<main><p>Действуют с old</p><p>Оператор: Synthetic</p><h2>Заказы и пилот</h2><p>Код действует 3 минуты. old</p><p>В приложении предусмотрены old</p><p>До отправки состав можно изменить old</p><h2>Акции</h2><p>unchanged</p></main>'
        with patch.dict(m.BEFORE, terms=hashlib.sha256(original.encode()).hexdigest()):
            result=m.candidate('terms', original,(ROOT/m.PROPOSAL).read_text(),'2026-10-22')
            self.assertIn('<p>Оператор: Synthetic</p>',result)
            self.assertIn('<h2>Акции</h2><p>unchanged</p>',result)
            self.assertIn('90 дней',result);self.assertIn('30 дней',result)
            self.assertIn('не отменяют банковский платёж',result)
            self.assertIn('демонстрация заказа',result)
            self.assertIn(m.VERSION,result)
            with self.assertRaises(RuntimeError):m.candidate('terms',result,(ROOT/m.PROPOSAL).read_text(),'2026-10-22')
    def test_refuses_drift_and_unapproved_text(self):
        for kind,text,date in [('terms','changed','2026-10-22'),('unknown','','2026-10-22')]:
            with self.assertRaises(RuntimeError):m.candidate(kind,text,'','bad')
    def test_html_escaped_and_replacement_unique(self):
        self.assertEqual(m.paragraphs(['<script>']),'<p>&lt;script&gt;</p>')
        with self.assertRaises(RuntimeError):m.replace_paragraph('<p>x</p><p>x</p>','x','new')


class RetentionTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        import json
        from types import SimpleNamespace
        self.json = json
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.old = self.root/'public-https/releases'/('a'*40)
        self.api = self.root/'releases'/('b'*40)
        self.web = self.old/'infra/public-staging/public-web'
        (self.web/'legal').mkdir(parents=True)
        self.privacy = self.web/'legal/privacy.html'
        self.original = b'<main><p>Operator unchanged</p>' + '<h2>Сроки хранения аккаунта</h2>'.encode() + b'<p>Existing policy.</p></main>'
        self.privacy.write_bytes(self.original)
        (self.web/'legal/terms.html').write_bytes(b'unchanged terms')
        self.manifest = {'files': {str(f.relative_to(self.web)): m.r.digest(f) for f in self.web.rglob('*') if f.is_file()}, 'source_sha':'a'*40}
        self.mp = self.web/'.release.json'
        self.mp.write_text(json.dumps(self.manifest)+'\n')
        self.original_manifest = self.mp.read_bytes()
        self.before = {'api': ['id','image','start'], 'gateway': ['id2','image2','start2']}
        self.args = SimpleNamespace(source_sha='c'*40, expected_manifest_sha256=m.r.digest(self.mp), apply=True, rollback_retention=False)
        self.patch(m.r,'ROOT',self.root)
        self.patch(m.r,'LOCK',self.root/'.market-release.lock')
        self.patch(m.r,'baseline',lambda a: (self.old,self.api,self.before))
        self.patch(m.r,'containers',lambda: self.before)
        self.patch(m.r,'http',self.http)
        self.patch(m.r,'verify_public_asset',lambda item: self.assertEqual(m.r.digest(self.web/item[0]),item[1]))
        self.patch(m,'RETENTION_BEFORE',hashlib.sha256(self.original).hexdigest())
        self.expected = self.original.replace('<h2>Сроки хранения аккаунта</h2>'.encode(), ('<h2>Сроки хранения аккаунта</h2>'+m.paragraphs([m.RETENTION_TEXT])).encode())
        self.patch(m,'RETENTION_AFTER',hashlib.sha256(self.expected).hexdigest())

    def patch(self,obj,key,value):
        p=patch.object(obj,key,value);p.start();self.addCleanup(p.stop)

    def http(self,path):
        if path=='/legal/privacy':return 200,self.privacy.read_bytes(),{}
        return 200,b'stable',{}

    def run_update(self):
        m.retention_update(self.args,self.old,self.api,self.before)

    def test_exact_insertion_backup_and_rollback(self):
        self.run_update()
        self.assertEqual(self.privacy.read_bytes(),self.expected)
        self.assertEqual((self.web/'legal/terms.html').read_bytes(),b'unchanged terms')
        backup=self.root/'legal-retention-updates'/self.args.source_sha
        self.assertEqual((backup/'privacy.before.html').read_bytes(),self.original)
        self.assertEqual((backup/'manifest.before.json').read_bytes(),self.original_manifest)
        self.assertEqual(backup.stat().st_mode&0o777,0o700)
        self.assertEqual((backup/'privacy.before.html').stat().st_mode&0o777,0o600)
        self.assertFalse(m.r.LOCK.exists())
        self.args.rollback_retention=True
        self.args.expected_manifest_sha256=m.r.digest(self.mp)
        self.run_update()
        self.assertEqual(self.privacy.read_bytes(),self.original)
        self.assertEqual(self.mp.read_bytes(),self.original_manifest)
        self.assertFalse(m.r.LOCK.exists())

    def test_dry_run_does_not_write(self):
        self.args.apply=False;self.run_update()
        self.assertEqual(self.mp.read_bytes(),self.original_manifest)
        self.assertFalse((self.root/'legal-retention-updates').exists())
        self.assertFalse(m.r.LOCK.exists())

    def test_manifest_drift_and_foreign_lock_refused(self):
        self.args.expected_manifest_sha256='0'*64
        with self.assertRaisesRegex(RuntimeError,'manifest_pin'):self.run_update()
        self.args.expected_manifest_sha256=m.r.digest(self.mp)
        m.r.LOCK.mkdir();(m.r.LOCK/'owner.json').write_text('{"id":"foreign"}')
        with self.assertRaises(FileExistsError):self.run_update()
        self.assertEqual((m.r.LOCK/'owner.json').read_text(),'{"id":"foreign"}')
        self.assertEqual(self.privacy.read_bytes(),self.original)

    def test_unapproved_drift_or_duplicate_refused(self):
        proposal=(ROOT/m.RETENTION_PROPOSAL).read_text()
        with self.assertRaisesRegex(RuntimeError,'owner_approval'):m.retention_candidate(self.original,'')
        with self.assertRaisesRegex(RuntimeError,'privacy_pin'):m.retention_candidate(self.original+b' ',proposal)
        with self.assertRaisesRegex(RuntimeError,'privacy_pin'):m.retention_candidate(self.expected,proposal)
        with patch.object(m,'RETENTION_AFTER','0'*64):
            with self.assertRaisesRegex(RuntimeError,'candidate_pin'):m.retention_candidate(self.original,proposal)

    def test_verification_failure_restores_exact_bytes(self):
        real=m.retention_verify
        calls=[]
        def fail_after_install(*args):
            calls.append(1)
            if len(calls)==2:raise RuntimeError('legal.retention.synthetic_http')
            return real(*args)
        self.patch(m,'retention_verify',fail_after_install)
        with self.assertRaisesRegex(RuntimeError,'synthetic_http'):self.run_update()
        self.assertEqual(self.privacy.read_bytes(),self.original)
        self.assertEqual(self.mp.read_bytes(),self.original_manifest)
        self.assertTrue(m.r.LOCK.exists())
        result=self.json.loads((self.root/'legal-retention-updates'/self.args.source_sha/'result.json').read_text())
        self.assertEqual(result['check'],'legal.retention.synthetic_http')
        self.assertEqual(result['status'],'rolled_back')

    def test_partial_write_failure_rolls_back(self):
        real=m.atomic_file
        calls=[]
        def fail_manifest(path,data):
            calls.append(1)
            if len(calls)==2:raise OSError('synthetic write failed')
            return real(path,data)
        self.patch(m,'atomic_file',fail_manifest)
        with self.assertRaises(OSError):self.run_update()
        self.assertEqual(self.privacy.read_bytes(),self.original)
        self.assertEqual(self.mp.read_bytes(),self.original_manifest)

    def test_foreign_edit_after_install_is_not_overwritten(self):
        real=m.retention_verify
        calls=[]
        def foreign(*args):
            calls.append(1)
            if len(calls)==2:
                self.privacy.write_bytes(b'foreign')
                raise RuntimeError('legal.retention.synthetic_foreign')
            return real(*args)
        self.patch(m,'retention_verify',foreign)
        with self.assertRaisesRegex(RuntimeError,'rollback_foreign_change'):self.run_update()
        self.assertEqual(self.privacy.read_bytes(),b'foreign')
        self.assertTrue(m.r.LOCK.exists())

    def test_public_permissions_under_private_umask(self):
        import os
        previous=os.umask(0o077)
        try:self.run_update()
        finally:os.umask(previous)
        self.assertEqual(self.privacy.stat().st_mode&0o777,0o644)
        self.assertEqual(self.mp.stat().st_mode&0o777,0o644)

    def test_rollback_refuses_new_manifest(self):
        self.run_update();self.args.rollback_retention=True
        self.mp.write_bytes(self.mp.read_bytes()+b' ')
        self.args.expected_manifest_sha256=m.r.digest(self.mp)
        with self.assertRaisesRegex(RuntimeError,'rollback_pins'):self.run_update()
        self.assertEqual(self.privacy.read_bytes(),self.expected)


if __name__=='__main__':unittest.main()
