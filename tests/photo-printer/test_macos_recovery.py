import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('photo_supervisor', Path(__file__).resolve().parents[2] / 'tools/photo-printer/macos/supervisor.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
URI = 'usb://Printer/POS-80?serial=fixture'


class Child:
    def __init__(self):
        self.pid = 123
        self.code = None
        self.stopped = 0

    def poll(self):
        return self.code

    def terminate(self):
        self.stopped += 1
        self.code = 0

    def wait(self, timeout):
        return self.code


class RecoveryTests(unittest.TestCase):
    def test_launch_agent_restarts_without_shell_or_privileged_account(self):
        path = Path(__file__).resolve().parents[2] / 'tools/photo-printer/macos/launch_agent.py'
        spec = importlib.util.spec_from_file_location('photo_agent', path)
        agent = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(agent)
        data = agent.definition('/tmp/Photo Service/supervisor.py', '/tmp/Photo Service/config.json', '/tmp/Photo Service/logs')
        self.assertEqual(data['ProgramArguments'], ['/usr/bin/python3','-u',str(Path('/tmp/Photo Service/supervisor.py').resolve()),str(Path('/tmp/Photo Service/config.json').resolve())])
        self.assertTrue(data['KeepAlive'])
        self.assertTrue(data['RunAtLoad'])
        self.assertNotIn('UserName', data)
        self.assertNotIn('--pair', str(data))

    def test_probe_exact_printer_private_interface_only(self):
        def run(args, **kw):
            out = '192.168.2.102\n' if 'ipconfig' in args[0] else f'direct {URI} "POS" "POS" "CMD:ESC/POS;"\n'
            return subprocess.CompletedProcess(args, 0, out, '')
        self.assertEqual(m.probe('en0', URI, run), ('192.168.2.102', 'ready'))
        self.assertEqual(m.probe('en0', URI+'2', run)[1], 'waiting-printer')
        with self.assertRaises(ValueError):
            m.probe('utun3', URI, run)
        for address in ['0.0.0.0', '127.0.0.1', '169.254.2.4', '8.8.8.8', '::1', 'bad']:
            self.assertFalse(m.private_ipv4(address))

    def test_probe_handles_absent_network_and_accessory_timeout(self):
        def missing(args, **kw):
            return subprocess.CompletedProcess(args, 1, '', '')
        self.assertEqual(m.probe('en0', URI, missing)[1], 'waiting-network')
        def timeout(args, **kw):
            raise subprocess.TimeoutExpired(args, 6)
        self.assertEqual(m.probe('en0', URI, timeout)[1], 'waiting-hardware')

    def test_reconnect_network_change_and_crash_never_send_print_commands(self):
        with tempfile.TemporaryDirectory() as d:
            current = [None, 'waiting-printer']
            launches = []
            def launch(args, **kw):
                child = Child()
                launches.append((args, kw, child))
                return child
            config = {'interface':'en0','node':'/safe/node','server':'/safe/server.mjs','release':'/safe',
                      'service':{'usbUri':URI,'database':'/private/jobs.sqlite','tlsKey':'/private/key','bind':'old'}}
            cleaned = []
            s = m.Supervisor(config, d, inspect=lambda *_:tuple(current), launch=launch, cleanup=cleaned.append)
            s.tick()
            self.assertEqual(len(launches), 0)
            current[:] = ['192.168.2.102','ready']
            s.tick();s.tick()
            self.assertEqual(len(launches), 1)
            first = s.child
            current[0] = '192.168.3.49'
            s.tick()
            self.assertEqual(first.stopped, 1)
            self.assertEqual(cleaned, [123])
            runtime = json.loads((Path(d)/'runtime.json').read_text())
            self.assertEqual(runtime['bind'], '192.168.3.49')
            self.assertEqual(runtime['database'], '/private/jobs.sqlite')
            self.assertEqual(config['service']['bind'], 'old')
            self.assertEqual((Path(d)/'runtime.json').stat().st_mode & 0o777, 0o600)
            s.child.code = 1
            s.tick()
            self.assertEqual(len(launches), 3)
            current[:] = [None,'waiting-printer']
            s.tick()
            self.assertIsNone(s.child)
            current[:] = ['192.168.3.49','ready']
            s.tick()
            self.assertEqual(len(launches), 4)
            for args, _, _ in launches:
                self.assertEqual(args, ['/safe/node','/safe/server.mjs',str(Path(d)/'runtime.json')])
                self.assertNotIn('--pair', args)
            s.stop_child()

    def test_kernel_lock_excludes_second_writer_and_releases_without_deletion(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'supervisor.lock'
            first = m.acquire_lock(path)
            with self.assertRaises(RuntimeError):
                m.acquire_lock(path)
            inode = path.stat().st_ino
            first.close()
            with m.acquire_lock(path):
                self.assertEqual(path.stat().st_ino, inode)


if __name__ == '__main__':
    unittest.main()
