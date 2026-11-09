#!/usr/bin/env python3
"""Opt-in synthetic Б10 rehearsal. Creates/removes only randomly named fixtures.

Run on a disposable Linux Docker host, from the repository root:
python3 tests/operations/server_storage_docker.py
The pinned Redis image must already be pulled. No production container is read.
"""
import ast
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('storage_audit', ROOT / 'infra/operations/server-storage-audit.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
IMAGE = 'redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232'


def release_logging_flags():
    """Exercise the actual initial-install options with Docker, without deploying."""
    tree = ast.parse((ROOT / 'infra/backoffice-login/release.py').read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.List) and len(node.elts) > 4:
            prefix = [item.value if isinstance(item, ast.Constant) else None for item in node.elts[:4]]
            if prefix == ['docker', 'create', '--name', 'pickchick-staff-login']:
                values = [item.value if isinstance(item, ast.Constant) else None for item in node.elts]
                flags = []
                for index, value in enumerate(values):
                    if value in ('--log-driver', '--log-opt'):
                        assert isinstance(values[index + 1], str)
                        flags.extend([value, values[index + 1]])
                assert flags, 'Initial installer has no explicit logging policy'
                return flags
    raise AssertionError('Initial staff-login create command not found')


def main():
    env = {key: value for key, value in os.environ.items() if key not in
           {'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'}}

    def docker(*args):
        return subprocess.run([*m.DOCKER, *args], env=env, check=True,
                              capture_output=True, text=True, timeout=30).stdout.strip()

    docker('image', 'inspect', '--format', '{{.Id}}', IMAGE)
    prefix = 'pickchick-b10-fixture-' + uuid.uuid4().hex[:12]
    created = []
    with tempfile.TemporaryDirectory(prefix='b10-synthetic-', dir=ROOT / '.local') as directory:
        path = Path(directory) / 'redis.conf'
        # This is a public synthetic marker, never a real credential.
        marker = 'synthetic-b10-marker-not-a-real-secret'
        path.write_text('save ""\nappendonly no\nrequirepass ' + marker + '\n')
        path.chmod(0o644)
        try:
            def create(suffix, options, command, mount=False):
                name = prefix + suffix
                argv = ['create', '--name', name, '--network', 'none', '--read-only',
                        '--security-opt', 'no-new-privileges:true', '--memory', '96m',
                        '--cpus', '0.5', '--pids-limit', '32', *options]
                if mount:
                    argv += ['--mount', f'type=bind,src={path},dst=/usr/local/etc/redis/redis.conf,readonly']
                docker(*argv, IMAGE, *command)
                created.append(name)
                docker('start', name)
                return name

            bounded = release_logging_flags()
            redis = create('-redis', bounded, ['redis-server', '/usr/local/etc/redis/redis.conf'], True)
            # Wait for readiness without returning credentials or configuration.
            ready = False
            for _ in range(30):
                if 'NOAUTH' in docker('exec', redis, 'redis-cli', 'ping'):
                    ready = True
                    break
                time.sleep(0.1)
            assert ready, 'Synthetic Redis did not become ready'
            staff = create('-staff', bounded, ['sh', '-c', 'echo synthetic-fixture; sleep 120'])
            # Requires a disposable daemon without default json-file rotation.
            # Docker documents -1 as the default but rejects explicitly setting it.
            unbounded = create('-unbounded', ['--log-driver', 'json-file'],
                               ['sh', '-c', 'echo synthetic-fixture; sleep 120'])
            report = m.audit(path, redis, [staff, unbounded])
            assert report['redisFile']['mode'] == '0644'
            assert report['redisFile']['otherReadBit'] and not report['redisFile']['otherDacReadPath']
            assert report['redisMount']['status'] == 'read_only' and report['redisMount']['running']
            assert [item['status'] for item in report['containerLogs']] == ['bounded', 'bounded', 'unbounded']
            assert report['containerLogs'][1]['nominalCapacityBytes'] == 30 * 1024 * 1024
            assert marker not in json.dumps(report) and str(path) not in json.dumps(report)

            # Same image and host-owned file: blind chmod 0600 prevents startup
            # after the entrypoint drops to Redis's non-root uid.
            docker('stop', '--time', '1', redis)
            path.chmod(0o600)
            restricted = create('-restricted', bounded, ['redis-server', '/usr/local/etc/redis/redis.conf'], True)
            exit_code = docker('wait', restricted)
            assert exit_code == '1', 'Expected protected fixture to reject config access'
            logs = docker('logs', restricted)
            assert 'Permission denied' in logs, 'Fixture did not fail for expected permission reason'
            result = {'syntheticOnly': True, 'image': IMAGE, 'checks': {
                'redis0644ProtectedParentStarts': True, 'readonlyBindDetected': True,
                'initialStaffInstall30MiBPolicy': True, 'unboundedLogsDetected': True,
                'noConfigurationContentsInReport': True, 'blind0600BreaksRedisStartup': True},
                'audit': report}
        finally:
            for name in reversed(created):
                docker('rm', '-f', '-v', name)
        result['fixturesRemoved'] = True
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    (ROOT / '.local').mkdir(exist_ok=True)
    main()
