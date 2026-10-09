import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rotation', Path(__file__).with_name('rotate.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RotationTests(unittest.TestCase):
    def config(self):
        return {'version': 2, 'origin': 'https://fixture.invalid', 'accounts': [
            {'username': 'ceo', 'salt': '1'*32, 'hash': '2'*64, 'token': '3'*64, 'actor_id': 'actor'},
            {'username': 'manager', 'salt': '4'*32, 'hash': '5'*64, 'token': '6'*64}]}

    def pair(self):
        before = self.config()
        after = copy.deepcopy(before)
        after['accounts'][0].update(salt='7'*32, hash='8'*64)
        return json.dumps(before).encode(), json.dumps(after).encode()

    def test_rotation_rejects_identity_other_account_origin_and_format_changes(self):
        before, after = self.pair()
        r.rotation_only(before, after)
        for field in ['token', 'actor_id', 'username']:
            changed = json.loads(after)
            changed['accounts'][0][field] = 'changed'
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                r.rotation_only(before, json.dumps(changed).encode())
        for change in [lambda c: c.update(origin='https://foreign.invalid'),
                       lambda c: c.update(version=1),
                       lambda c: c['accounts'].pop(),
                       lambda c: c['accounts'][1].update(hash='9'*64),
                       lambda c: c['accounts'][0].update(salt=c['accounts'][1]['salt']),
                       lambda c: c['accounts'][0].update(salt='1'*32)]:
            changed = json.loads(after)
            change(changed)
            with self.assertRaises(RuntimeError): r.rotation_only(before, json.dumps(changed).encode())
        legacy = {'version': 1, 'origin': 'https://fixture.invalid', **self.config()['accounts'][0]}
        r.rotation_only(json.dumps(legacy).encode(), json.dumps({**legacy, 'salt':'7'*32, 'hash':'8'*64}).encode())

    def test_real_bind_inode_cas_and_private_input_guards(self):
        before, after = self.pair()
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)/'live.json'
            p.write_bytes(before)
            p.chmod(0o600)
            inode = p.stat().st_ino
            identity = (p.stat().st_dev, inode)
            with p.open('rb') as bound:
                r.replace_in_place(p, r.d.digest(before), after, identity)
                self.assertEqual(bound.read(), after)
            self.assertEqual(p.stat().st_ino, inode)
            with self.assertRaises(RuntimeError): r.replace_in_place(p, r.d.digest(before), after, identity)
            self.assertEqual(p.read_bytes(), after)
            link = Path(directory)/'link'
            link.symlink_to(p)
            with self.assertRaises(OSError): r.private_bytes(link)
            link.unlink()
            os.link(p, link)
            with self.assertRaises(RuntimeError): r.private_bytes(p)
            link.unlink()
            replacement = Path(directory)/'replacement'
            replacement.write_bytes(after)
            replacement.chmod(0o600)
            replacement.replace(p)
            with self.assertRaisesRegex(RuntimeError, 'inode'):
                r.replace_in_place(p, r.d.digest(after), after, identity)
            p.chmod(0o644)
            with self.assertRaises(RuntimeError): r.private_bytes(p)

    def exercise(self, apply, fail_start=False):
        before, after = self.pair()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'backoffice-login').mkdir(mode=0o700)
            live, candidate, front, ci = [root/n for n in ('live', 'candidate', 'front', 'ci')]
            for p, value in [(live,before),(candidate,after),(front,b'front'),(ci,b'{}')]:
                p.write_bytes(value); p.chmod(0o600)
            source, portal = 'a'*40, 'b'*40
            image = 'sha256:'+'c'*64
            old = {'Id':'old-container', 'Image':image, 'Config':{'Image':'pickchick-staff-login:'+portal},
                   'HostConfig':{'ReadonlyRootfs':True}, 'State':{'Running':True,'Health':{'Status':'healthy'}},
                   'Mounts':[{'Source':str(live),'Destination':'/run/ceo.json','RW':False}]}
            calls = []
            def run(argv):
                calls.append(argv)
                if argv[1] == 'stop': old['State']['Running'] = False
                if argv[1] == 'start':
                    if fail_start: raise r.d.Uncertain('Lost start response')
                    old['State']['Running'] = True
                return b''
            a = types.SimpleNamespace(source_sha=source, expected_portal_sha=portal, expected_api_sha=source,
                 expected_public_sha=source, expected_portal_image=image, expected_private_sha256=r.d.digest(before),
                 candidate_sha256=r.d.digest(after), expected_front_hash=r.d.digest(b'front'),
                 expected_gateway_hash='d'*64, candidate=candidate, ci_proof=ci, apply=apply)
            output=io.StringIO()
            with contextlib.ExitStack() as stack:
                for obj, name, value in [(r,'PRIVATE',live),(r.d,'ROOT',root),(r.d,'FRONT',front),(r.d,'LOCK',root/'lock')]:
                    stack.enter_context(patch.object(obj,name,value))
                for obj, name in [(r.u.portal,'verify_ci'),(r.u,'verify_artifact'),(r.d,'guards'),(r.u,'healthy'),(r.u,'portal_http')]:
                    stack.enter_context(patch.object(obj,name))
                stack.enter_context(patch.object(r.u,'neighbors',return_value={'bank':'unchanged'}))
                stack.enter_context(patch.object(r.u,'inspect',side_effect=lambda _:copy.deepcopy(old)))
                stack.enter_context(patch.object(r.d,'baseline_http',return_value=('unchanged',b'capabilities')))
                stack.enter_context(patch.object(r.d,'run',side_effect=run))
                stack.enter_context(contextlib.redirect_stdout(output))
                if fail_start:
                    with self.assertRaises(r.d.Uncertain): r.main(a)
                else: r.main(a)
            self.assertEqual(live.read_bytes(), after if apply else before)
            self.assertNotIn('token', output.getvalue())
            if apply:
                self.assertEqual(calls,[['docker','stop',r.u.NAME],['docker','start',r.u.NAME]])
                self.assertEqual((root/'lock').exists(),fail_start)
                backups=list((root/'backoffice-login').glob('rotation-*/credentials.before.json'))
                self.assertEqual(len(backups),1)
                self.assertEqual(backups[0].read_bytes(),before)
                self.assertEqual(len(list((root/'backoffice-login').glob('rotation-*/attempt.json'))),1)
            else:
                self.assertEqual(calls,[])
                self.assertEqual(list((root/'backoffice-login').iterdir()),[])

    def test_plan_never_mutates_or_stops(self): self.exercise(False)
    def test_apply_changes_only_hash_on_same_container(self): self.exercise(True)
    def test_uncertain_start_retains_new_password_lock_and_attempt_without_old_password_rollback(self): self.exercise(True, True)


if __name__ == '__main__': unittest.main()
