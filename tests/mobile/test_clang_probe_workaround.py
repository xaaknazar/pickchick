import importlib.util
import json
import os
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


class NestedXcodebuildLauncherTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ClangProbeWorkaroundTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.real = self.root / 'Xcode With Spaces/usr/bin/xcodebuild'
        self.real.parent.mkdir(parents=True)
        self.real.write_text(f'''#!{sys.executable}
import json, os, sys
if '-fixture-sigkill' in sys.argv:
    os.kill(os.getpid(), 9)
print(json.dumps({{'argv': sys.argv, 'environment': dict(os.environ), 'cwd': os.getcwd()}}))
os.write(2, b'fixture real xcodebuild stderr\\x00\\xff')
sys.exit(37)
''')
        self.real.chmod(0o700)
        self.metadata = WORKAROUND.prepare_launcher(
            self.root / 'nested launcher', self.fixture.real, self.fixture.cxx, self.real)
        self.environment = {'PATH': self.metadata['path_prefix'] + ':/usr/bin:/bin',
                            'PODS_ROOT': '/fixture/Pods With Spaces',
                            'RN_ROOT': '/fixture/RN', 'DEVELOPER_DIR': '/fixture/Xcode',
                            'UNCHANGED_FIXTURE': 'value with spaces=$()',
                            'XCODE_XCCONFIG_FILE': '/fixture/parent settings.xcconfig'}

    def invoke(self, arguments, launcher=True, clean_environment=False):
        command = [self.metadata['xcodebuild_launcher'] if launcher else str(self.real),
                   *arguments]
        if clean_environment:
            # The real Expo script forwards PATH, but not XCODE_XCCONFIG_FILE.
            forwarded = {key: value for key, value in self.environment.items()
                         if key != 'XCODE_XCCONFIG_FILE'}
            command = ['/usr/bin/env', '-i',
                       *[f'{key}={value}' for key, value in forwarded.items()],
                       'xcodebuild', *arguments]
        return subprocess.run(command, cwd=self.root, env=self.environment,
                              capture_output=True, timeout=5)

    def test_scoped_build_survives_env_i_and_preserves_all_other_arguments(self):
        arguments = ['build', '-scheme', 'ExpoModulesJSI', '-sdk', 'iphonesimulator',
                     '-destination', 'generic/platform=iOS Simulator',
                     '-derivedDataPath', '/fixture/Derived Data', '-quiet',
                     'CC=/obsolete/clang', 'CXX=/obsolete/clang++',
                     'LD=/fixture/linker', 'OTHER_CFLAGS=-DNAME="a b"',
                     'SWIFT_COMPILATION_MODE=wholemodule']
        result = self.invoke(arguments, clean_environment=True)
        captured = json.loads(result.stdout)
        self.assertEqual(result.returncode, 37)
        self.assertEqual(result.stderr, b'fixture real xcodebuild stderr\x00\xff')
        self.assertEqual(captured['argv'], [str(self.real),
                         *[arg for arg in arguments if not arg.startswith(('CC=', 'CXX='))],
                         'CC=' + self.metadata['cc'], 'CXX=' + self.metadata['cxx']])
        self.assertEqual(captured['cwd'], str(self.root.resolve()))
        self.assertNotIn('XCODE_XCCONFIG_FILE', captured['environment'])
        for key, value in self.environment.items():
            if key != 'XCODE_XCCONFIG_FILE':
                self.assertEqual(captured['environment'][key], value)

    def test_other_invocations_are_byte_for_byte_pass_through(self):
        cases = [[], ['-version'], ['archive', '-scheme', 'ExpoModulesJSI'],
                 ['build', '-scheme', 'PickChickKiosk'],
                 ['build', '-scheme', 'ExpoModulesJSI', '-showBuildSettings'],
                 ['build', '-scheme', 'ExpoModulesJSI', 'clean'],
                 ['build', '-scheme', 'ExpoModulesJSI', '-scheme', 'Other'],
                 ['build', '-scheme'], ['build', '-workspace', 'ExpoModulesJSI'],
                 ['build', 'MY_SCHEME=ExpoModulesJSI'],
                 ['-scheme', 'ExpoModulesJSI', 'build'],
                 ['-create-xcframework', '-framework', 'ExpoModulesJSI.framework']]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                expected = self.invoke(arguments, launcher=False)
                actual = self.invoke(arguments)
                self.assertEqual((actual.returncode, actual.stdout, actual.stderr),
                                 (expected.returncode, expected.stdout, expected.stderr))

    def test_matching_build_preserves_environment_and_real_signal_exit(self):
        arguments = ['build', '-scheme', 'ExpoModulesJSI']
        actual = json.loads(self.invoke(arguments).stdout)
        expected = json.loads(self.invoke(arguments, launcher=False).stdout)
        self.assertEqual(actual['environment'], expected['environment'])
        self.assertEqual(self.invoke([*arguments, '-fixture-sigkill']).returncode, -9)

    def test_opt_in_and_provenance_identify_actual_launchers_and_binaries(self):
        self.assertNotIn('path_prefix', self.fixture.metadata)
        self.assertFalse((self.fixture.destination / 'path-bin').exists())
        saved = json.loads((self.root / 'nested launcher/provenance.json').read_text())
        self.assertEqual(saved, self.metadata)
        self.assertEqual(saved['real_xcodebuild'], str(self.real))
        self.assertEqual(saved['real_xcodebuild_sha256'], WORKAROUND.sha256(self.real))
        launcher = Path(saved['xcodebuild_launcher'])
        self.assertEqual(saved['xcodebuild_launcher_sha256'], WORKAROUND.sha256(launcher))
        self.assertTrue(os.access(launcher, os.X_OK))
        self.assertEqual(saved['xcodebuild_overrides'],
                         {'CC': saved['cc'], 'CXX': saved['cxx']})
        self.assertEqual(list(Path(saved['path_prefix']).iterdir()), [launcher])

    def test_invalid_real_xcodebuild_does_not_create_partial_destination(self):
        destination = self.root / 'invalid launcher'
        with self.assertRaises(ValueError):
            WORKAROUND.prepare_launcher(destination, self.fixture.real, self.fixture.cxx,
                                        self.root / 'absent xcodebuild')
        self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
