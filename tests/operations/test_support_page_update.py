"""Existing support-page update: exact pins, atomic replacement and complete rollback."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('support_update', ROOT/'infra/public-staging/support-page-release.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.old = self.root/'public-https/releases'/('a'*40)
        self.api = self.root/'releases'/('b'*40)
        self.api.mkdir(parents=True)
        self.web = self.old/'infra/public-staging/public-web'
        (self.web/'support').mkdir(parents=True)
        (self.web/'legal').mkdir()
        (self.web/'legal/privacy.html').write_text('<p>+7 (700) 000-00-00.</p>')
        (self.web/'legal/terms.html').write_text('unchanged terms')
        for k in m.SUPPORT_ASSETS:
            (self.web/k).write_text('old '+k)
        self.manifest = {'source_sha': 'a'*40, 'files': {
            str(p.relative_to(self.web)): m.r.digest(p) for p in self.web.rglob('*') if p.is_file()}}
        self.manifest_file = self.web/'.release.json'
        self.manifest_file.write_text(json.dumps(self.manifest)+'\n')
        self.original_manifest = self.manifest_file.read_bytes()
        self.config = self.old/'infra/public-staging/gateway.Caddyfile'
        self.config.write_text('unchanged before\n'+m.BLOCK+'unchanged after\n')
        (self.root/'public-https/current').symlink_to(self.old)
        (self.root/'current').symlink_to(self.api)
        self.before = {'gateway': ['original-id','pinned-image','started'], 'api': ['api-id','image','started']}
        self.args = SimpleNamespace(source_sha='c'*40, apply=True,
            expected_manifest_sha256=m.r.digest(self.manifest_file), expected_gateway_sha256=m.r.digest(self.config))
        self.patch(m.r,'ROOT',self.root)
        self.patch(m.r,'LOCK',self.root/'.market-release.lock')
        self.patch(m.r,'containers',lambda: self.before)
        self.patch(m.d.r,'containers',lambda: self.before)
        self.patch(m.r,'baseline',lambda a: (self.old,self.api,self.before))
        self.patch(m.r,'http',self.http)
        self.patch(m.r,'verify_public_asset',self.verify_asset)
        # Linux runs the entire success/rollback suite against real renameat2.
        # macOS uses a portable test double; production has no fallback.
        if m.sys.platform != 'linux':
            self.patch(m,'exchange_directories',self.exchange)

    def patch(self, obj, name, value):
        p = patch.object(obj,name,value);p.start();self.addCleanup(p.stop)

    def exchange(self,left,right):
        tmp=left.with_name('test-exchange-temp')
        left.rename(tmp);right.rename(left);tmp.rename(right)

    def http(self,path):
        if path=='/support/': f=self.web/'support/ru.html'
        elif path.startswith('/support/'): f=self.web/path.lstrip('/')
        elif path.startswith('/legal/'): f=self.web/(path.lstrip('/')+'.html')
        else:return 200,b'stable',{}
        return 200,f.read_bytes(),{}

    def verify_asset(self,item):
        name,digest=item
        self.assertEqual(m.r.digest(self.web/name),digest)

    def run_update(self):
        m.update_existing(self.args,self.old,self.api,self.before)

    def test_success_changes_only_support_and_keeps_verified_backup(self):
        config=self.config.read_bytes()
        self.run_update()
        actual=m.r.public_files(self.old)
        for k,v in self.manifest['files'].items():
            if not k.startswith('support/'):self.assertEqual(actual['files'][k],v)
        for lang in ('ru','kk','en'):
            self.assertIn('id="delete-account"',(self.web/f'support/{lang}.html').read_text())
        backup=self.root/'support-updates'/self.args.source_sha
        m.support_tree(backup/'before',self.manifest['files'])
        self.assertEqual((backup/'manifest.before.json').read_bytes(),self.original_manifest)
        self.assertEqual(self.config.read_bytes(),config)
        self.assertEqual((self.root/'public-https/current').resolve(),self.old)
        self.assertFalse(m.r.LOCK.exists())
        self.assertEqual(json.loads((backup/'result.json').read_text())['status'],'PASS')

    def test_explicit_rollback_after_success(self):
        self.run_update()
        self.args.expected_manifest_sha256=m.r.digest(self.manifest_file)
        m.rollback_update(self.args,self.old,self.api,self.before)
        self.assertEqual(self.manifest_file.read_bytes(),self.original_manifest)
        m.support_tree(self.web/'support',self.manifest['files'])
        self.assertFalse(m.r.LOCK.exists())

    def test_public_permissions_under_private_release_umask(self):
        previous = os.umask(0o077)
        try:
            self.run_update()
        finally:
            os.umask(previous)
        self.assertEqual((self.web/'support').stat().st_mode & 0o777, 0o755)
        for name in m.SUPPORT_ASSETS:
            self.assertEqual((self.web/name).stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.manifest_file.stat().st_mode & 0o777, 0o644)
        backup = self.root/'support-updates'/self.args.source_sha
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)

    def test_rollback_refuses_intervening_manifest_change(self):
        self.run_update()
        self.args.expected_manifest_sha256=m.r.digest(self.manifest_file)
        self.manifest_file.write_bytes(self.manifest_file.read_bytes()+b' ')
        with self.assertRaisesRegex(RuntimeError,'current_manifest'):
            m.rollback_update(self.args,self.old,self.api,self.before)
        self.assertFalse(m.r.LOCK.exists())

    def test_dry_run_has_no_writes(self):
        self.args.apply=False;self.run_update()
        self.assertEqual(self.manifest_file.read_bytes(),self.original_manifest)
        self.assertFalse((self.root/'support-updates').exists())
        self.assertFalse(m.r.LOCK.exists())

    def test_stale_manifest_refuses_before_lock(self):
        self.args.expected_manifest_sha256='0'*64
        with self.assertRaisesRegex(RuntimeError,'manifest_pin'):self.run_update()
        self.assertFalse(m.r.LOCK.exists())

    def test_existing_route_must_match_exactly(self):
        self.config.write_text(m.BLOCK.replace('DENY','SAMEORIGIN'))
        with self.assertRaisesRegex(RuntimeError,'existing_route'):self.run_update()
        self.assertFalse(m.r.LOCK.exists())

    def test_unlisted_support_file_refused(self):
        (self.web/'support/extra.html').write_text('extra')
        with self.assertRaisesRegex(RuntimeError,'directory_contents'):self.run_update()

    def test_symlink_support_file_refused(self):
        f=self.web/'support/ru.html';f.unlink();f.symlink_to(self.web/'legal/privacy.html')
        with self.assertRaises(RuntimeError):self.run_update()

    def test_foreign_lock_never_removed(self):
        m.r.LOCK.mkdir();(m.r.LOCK/'owner.json').write_text('{"id":"foreign"}')
        with self.assertRaises(FileExistsError):self.run_update()
        self.assertEqual((m.r.LOCK/'owner.json').read_text(),'{"id":"foreign"}')
        self.assertEqual(self.manifest_file.read_bytes(),self.original_manifest)

    def test_failure_after_exchange_restores_exact_bytes_and_retains_lock(self):
        self.patch(m,'verify',lambda *a: (_ for _ in ()).throw(RuntimeError('synthetic HTTP failure')))
        with self.assertRaisesRegex(RuntimeError,'synthetic HTTP'):self.run_update()
        self.assertEqual(self.manifest_file.read_bytes(),self.original_manifest)
        m.support_tree(self.web/'support',self.manifest['files'])
        self.assertTrue(m.r.LOCK.exists())
        result=json.loads((self.root/'support-updates'/self.args.source_sha/'result.json').read_text())
        self.assertEqual(result['status'],'rolled_back')

    def test_directory_exchange_unsupported_stops_before_public_change(self):
        self.patch(m,'exchange_directories',lambda *a: (_ for _ in ()).throw(RuntimeError('unsupported')))
        with self.assertRaisesRegex(RuntimeError,'unsupported'):self.run_update()
        m.support_tree(self.web/'support',self.manifest['files'])
        self.assertEqual(self.manifest_file.read_bytes(),self.original_manifest)

    def test_unreadable_new_page_names_check_and_rolls_back(self):
        def inaccessible_new_page(item):
            name, _ = item
            if not (self.web/name).read_bytes().startswith(b'old '):
                raise RuntimeError('synthetic HTTP 403')
            self.verify_asset(item)
        self.patch(m.r, 'verify_public_asset', inaccessible_new_page)
        with self.assertRaisesRegex(RuntimeError, r'support.update.http_asset.en.html'):
            self.run_update()
        self.assertEqual(self.manifest_file.read_bytes(),self.original_manifest)
        m.support_tree(self.web/'support',self.manifest['files'])
        self.assertTrue(m.r.LOCK.exists())

    def test_third_party_asset_cannot_be_added_to_pages(self):
        with self.assertRaisesRegex(RuntimeError,'page_set'):
            m.update_manifest(self.manifest,{'legal/privacy.html':'changed'})

    def test_unexpected_existing_manifest_entry_refused(self):
        bad=json.loads(json.dumps(self.manifest));bad['files']['support/extra.html']='0'*64
        with self.assertRaisesRegex(RuntimeError,'existing_asset_set'):
            m.update_manifest(bad,{k:'test' for k in m.SUPPORT_ASSETS})


class LinuxExchangeTests(unittest.TestCase):
    @unittest.skipUnless(m.sys.platform=='linux','Linux-only atomic exchange syscall')
    def test_real_exchange_and_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            left=Path(directory)/'left';right=Path(directory)/'right'
            left.mkdir();right.mkdir();(left/'x').write_text('before');(right/'x').write_text('after')
            m.exchange_directories(left,right)
            self.assertEqual((left/'x').read_text(),'after')
            self.assertEqual((right/'x').read_text(),'before')
            m.exchange_directories(left,right)
            self.assertEqual((left/'x').read_text(),'before')


if __name__=='__main__':unittest.main()
