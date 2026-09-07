import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


SOURCE = Path(__file__).parents[2] / 'scripts/mobile/clang_probe_workaround.py'
SPEC = importlib.util.spec_from_file_location('clang_probe_workaround', SOURCE)
WORKAROUND = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKAROUND)


class ClangProbeWorkaroundTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.real = self.root / 'toolchain/usr/bin/clang'
        self.real.parent.mkdir(parents=True)
        self.real.write_text(f'''#!{sys.executable}
import os, sys
if '-fixture-sigkill' in sys.argv:
    os.kill(os.getpid(), 9)
if '-dM' in sys.argv:
    os.write(2, b'verbose compiler data' * 10000)
    os.write(1, b'actual feature data' * 10000)
    sys.exit(7)
print(sys.argv[0], '|'.join(sys.argv[1:]), os.getcwd())
''')
        self.real.chmod(0o700)
        self.cxx = self.real.with_name('clang++')
        self.cxx.symlink_to('clang')
        self.features = self.real.parent.parent / 'share/clang/features.json'
        self.features.parent.mkdir(parents=True)
        self.features.write_text('{"features":["fixture-feature"]}')
        self.destination = self.root / 'launcher'
        self.metadata = WORKAROUND.prepare_launcher(self.destination, self.real, self.cxx)

    def test_sequential_reader_gets_exact_bytes_and_failure_status(self):
        arguments = ['-v', '-E', '-dM', '-c', '/dev/null']
        expected = subprocess.run([str(self.real), *arguments], capture_output=True, timeout=5)
        process = subprocess.Popen([self.metadata['cc'], *arguments],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        captured = []
        def read_sequentially():
            captured.append(process.stdout.read())
            captured.append(process.stderr.read())
            process.wait()
        reader = threading.Thread(target=read_sequentially, daemon=True)
        try:
            reader.start()
            reader.join(5)
            self.assertFalse(reader.is_alive(), 'sequential reader deadlocked')
            self.assertEqual(captured, [expected.stdout, expected.stderr])
            self.assertEqual(process.returncode, expected.returncode)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
            reader.join(5)
            process.stdout.close()
            process.stderr.close()

    def test_non_probe_clang_and_cxx_preserve_identity_arguments_and_cwd(self):
        for real, launcher in [(self.real, self.metadata['cc']), (self.cxx, self.metadata['cxx'])]:
            arguments = ['-fsyntax-only', '-x', 'c++', '/dev/null']
            expected = subprocess.run([str(real), *arguments], capture_output=True, timeout=5)
            actual = subprocess.run([launcher, *arguments], capture_output=True, timeout=5)
            self.assertEqual((actual.returncode, actual.stdout, actual.stderr),
                             (expected.returncode, expected.stdout, expected.stderr))

    def test_probe_signal_exit_is_preserved(self):
        arguments = ['-v', '-E', '-dM', '-c', '/dev/null', '-fixture-sigkill']
        result = subprocess.run([self.metadata['cc'], *arguments], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, -9)

    def test_features_stay_in_real_toolchain_and_existing_destination_is_preserved(self):
        local_features = Path(self.metadata['cc']).parent.parent / 'share/clang/features.json'
        self.assertEqual(local_features.resolve(), self.features.resolve())
        self.assertEqual(WORKAROUND.sha256(local_features), self.metadata['features_sha256'])
        with self.assertRaises(FileExistsError):
            WORKAROUND.prepare_launcher(self.destination, self.real, self.cxx)
        self.assertTrue(Path(self.metadata['cc']).is_file())


if __name__ == '__main__':
    unittest.main()
