import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('ingress',Path(__file__).resolve().parents[2]/'infra/pickchick-ingress/prepare.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class Ingress(unittest.TestCase):
    def test_exact_split_preserves_opaque_bytes(self):
        sites=b'pickchick.185.129.51.103.nip.io {\n respond 200\n}\n'
        legacy=b'legacy.test {\n respond "opaque"\n}\n\n'
        raw=legacy+sites
        with patch.object(r,'EXPECTED',r.digest(raw)),patch.object(r,'SITE_HASH',r.digest(sites)):
            self.assertEqual(r.split(raw,sites,r.digest(raw)),legacy)
            for bad in [raw+b' ',raw.replace(b'opaque',b'changed'),raw+sites]:
                with self.assertRaises(ValueError):r.split(bad,sites,r.digest(raw))
    def test_immutable_image_and_exact_networks(self):
        x=r.compose('sha256:'+'a'*64,['shared_public'])
        self.assertEqual(x['services']['caddy']['pull_policy'],'never')
        self.assertEqual(x['services']['caddy']['ports'],['80:80/tcp','443:443/tcp'])
        self.assertEqual(x['networks']['shared_public']['external'],True)
        for img,nets in [('caddy:latest',['net']),('sha256:'+'a'*64,[]),('sha256:'+'a'*64,['x','x'])]:
            with self.assertRaises(ValueError):r.compose(img,nets)
    def test_reviewed_routes_keep_longpoll_and_default_timeouts(self):
        sites=(Path(__file__).resolve().parents[2]/'infra/pickchick-ingress/sites.Caddyfile').read_bytes()
        self.assertEqual(r.digest(sites),r.SITE_HASH)
        self.assertEqual(sites.count(b'response_header_timeout 32s'),3)
        self.assertEqual(sites.count(b'response_header_timeout 8s'),1)
        self.assertIn(b'Strict-Transport-Security',sites)


class Cutover(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('cutover',Path(__file__).resolve().parents[2]/'infra/pickchick-ingress/switch.py')
        self.s=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.s)
    def test_rollback_when_start_or_probe_fails(self):
        for stage in ['start','probe']:
            calls=[]
            def cmd(args,**kw):calls.append(args)
            def start():
                if stage=='start':raise RuntimeError('fixture')
            def probe():
                if stage=='probe':raise RuntimeError('fixture')
            with self.assertRaises(RuntimeError):self.s.switch(start,probe,cmd)
            self.assertEqual(calls[-2:], [['docker','stop','--time','5',self.s.NEW],['docker','start',self.s.OLD]])
            self.assertFalse(any('rm' in c for c in calls))
    def test_restore_attempt_survives_new_container_stop_timeout(self):
        import subprocess
        calls=[]
        def cmd(args,**kw):
            calls.append(args)
            if args[-1]==self.s.NEW:raise subprocess.TimeoutExpired(args,20)
        def start():raise RuntimeError('fixture')
        with self.assertRaises(subprocess.TimeoutExpired):self.s.switch(start,lambda:None,cmd)
        self.assertEqual(calls[-1],['docker','start',self.s.OLD])
    def test_no_cutover_before_separate_night_and_watchdog(self):
        from datetime import datetime,timezone
        now=datetime(2026,11,8,20,30,tzinfo=timezone.utc)
        proof={'schema':1,'stage2_verified':True,'watchdog_test_received':True,'telegram_enabled_at':'2026-11-07T20:00:00+00:00','watchdog_false_alarms':0,'cashier_window':False,'cutover_date_almaty':'2026-11-09'}
        self.s.receipt_guard(proof,now)
        for field,value in [('stage2_verified',False),('watchdog_test_received',False),('telegram_enabled_at','2026-11-08T20:00:00+00:00'),('cashier_window',True),('cutover_date_almaty','2026-11-08')]:
            with self.assertRaises(ValueError):self.s.receipt_guard({**proof,field:value},now)

if __name__=='__main__':unittest.main()
