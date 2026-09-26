#!/usr/bin/env python3
"""Local Linux DAC regression for ops UID 1000 and the production hardened Caddy.

No SSH, database, credentials, production container/network or public ports.
Uses a fresh native Docker volume because macOS bind mounts can mask Linux ownership.
"""
import argparse
import ast
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
OLD = 'dccc516f0d75f5bdbfb183b097ded4c11a228a09'
spec = importlib.util.spec_from_file_location('maintenance_permissions', ROOT / 'infra/staging/release-transport.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tool-image', required=True, help='Local image containing python3 and coreutils (no network installation)')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    output = args.output.resolve(); output.mkdir(parents=True, mode=0o700, exist_ok=False)
    name = 'pickchick-maintenance-dac-' + uuid.uuid4().hex[:12]
    volume = name + '-files'
    created = False
    def run(command, *, input=None, check=True, timeout=45):
        result = subprocess.run(command, input=input.encode() if isinstance(input, str) else input,
                                capture_output=True, timeout=timeout, cwd=ROOT)
        if check and result.returncode:
            path = output / ('error-' + uuid.uuid4().hex + '.log')
            path.write_bytes(result.stdout + b'\n' + result.stderr); path.chmod(0o600)
            raise AssertionError('Local DAC fixture command failed; private diagnostics retained')
        return result
    def docker(*command, **kwargs): return run(['docker', *command], **kwargs)
    try:
        host = json.loads(docker('context', 'inspect').stdout)[0]['Endpoints']['docker']['Host']
        assert host.startswith('unix://'), 'Only local Docker is allowed'
        original = run(['git', 'show', OLD + ':infra/staging/release-transport.py']).stdout.decode()
        tree = ast.parse(original)
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'create_maintenance')
        program = next(n.value.value for n in ast.walk(method) if isinstance(n, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id == 'program' for t in n.targets)
                       and isinstance(n.value, ast.Constant))
        docker('volume', 'create', volume); created = True
        mount = json.loads(docker('volume', 'inspect', volume).stdout)[0]['Mountpoint']
        docker('run', '--rm', '-v', volume + ':/proof', args.tool_image,
               'sh', '-c', 'mkdir /proof/operator && chown 1000:1000 /proof/operator && chmod 700 /proof/operator')
        contents = {'owner.json': json.dumps({'id': str(uuid.uuid4())}),
                    'maintenance.json': json.dumps(release.maintenance_config(), sort_keys=True),
                    'compose.json': '{}'}
        rows = []
        for case, writer, mode in [('before', program, '600'), ('after', release.maintenance_write_script(), '644')]:
            directory = '/proof/operator/' + case
            docker('run', '--rm', '-i', '--user', '1000:1000', '-v', volume + ':/proof', args.tool_image,
                   'python3', '-c', writer, directory, input=json.dumps(contents))
            stats = docker('run', '--rm', '-v', volume + ':/proof:ro', args.tool_image, 'stat', '-c', '%u:%g %a',
                           directory, directory + '/owner.json', directory + '/compose.json', directory + '/maintenance.json').stdout.decode().splitlines()
            assert stats == ['1000:1000 700', '1000:1000 600', '1000:1000 600', '1000:1000 ' + mode], stats
            source = mount + '/operator/' + case + '/maintenance.json'
            validation = run(shlex.split(release.caddy_validation_command(source)), check=False)
            if case == 'before':
                assert validation.returncode != 0 and b'permission denied' in validation.stderr
            else:
                assert validation.returncode == 0, validation.stderr
            # Render the actual gateway + overlay. Only resource identifiers and the unused
            # normal web mounts are changed for isolation; DAC/caps/read_only/security stay exact.
            overlay = output / (case + '-overlay.json')
            overlay.write_text(json.dumps(release.maintenance_overlay(mount + '/operator/' + case)))
            rendered = json.loads(docker('compose', '-f', str(ROOT / 'infra/public-staging/compose.yaml'),
                '-f', str(overlay), 'config', '--format', 'json').stdout)
            gateway = rendered['services']['gateway']
            assert gateway['cap_drop'] == ['ALL'] and gateway['cap_add'] == ['NET_BIND_SERVICE']
            assert gateway['read_only'] is True and gateway['security_opt'] == ['no-new-privileges:true']
            assert not gateway.get('ports')
            gateway['container_name'] = name
            gateway['restart'] = 'no'  # Deterministic old-failure observation, no retry loop.
            gateway['networks'] = {'isolated': None}
            gateway['volumes'] = [v for v in gateway['volumes'] if v['target'] == '/etc/caddy/maintenance.json']
            compose = output / (case + '-compose.json')
            compose.write_text(json.dumps({'name': name, 'services': {'gateway': gateway},
                                           'networks': {'isolated': {'internal': True}}}))
            docker('compose', '-f', str(compose), 'up', '-d', '--no-deps', timeout=60)
            try:
                for _ in range(80):
                    state = json.loads(docker('inspect', name).stdout)[0]
                    if not state['State']['Running'] or state['State'].get('Health', {}).get('Status') == 'healthy': break
                    time.sleep(0.1)
                logs = docker('logs', name).stdout + docker('logs', name).stderr
                if case == 'before':
                    assert not state['State']['Running'] and b'permission denied' in logs
                else:
                    assert state['State']['Running'] and state['State']['Health']['Status'] == 'healthy'
                    assert docker('exec', name, 'id', '-u').stdout.strip() == b'0'
                    status = docker('exec', name, 'cat', '/proc/1/status').stdout.decode()
                    capabilities = {line.split(':')[0]:line.split(':')[1].strip() for line in status.splitlines() if line.startswith(('CapEff:', 'CapBnd:'))}
                    assert all(int(value, 16) == 0x400 for value in capabilities.values()), capabilities
                    docker('exec', name, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8099/')
                    probe = docker('exec', name, 'wget', '-S', '-O', '-', 'http://127.0.0.1:8080/v1/admin/catalog/branches', check=False)
                    assert probe.returncode != 0 and b'503' in probe.stderr
                rows.append({'case':case,'file_mode':mode,'owner_uid':1000,
                             'hardened_validate_success':validation.returncode==0,
                             'gateway_running':state['State']['Running'],
                             'permission_denied':b'permission denied' in logs})
            finally:
                docker('compose', '-f', str(compose), 'down', '--timeout', '5', timeout=30)
        result = {'scope':'local_Linux_DAC_regression','source_before':OLD,'checks':'passed','cases':rows,
                  'production_caps':['NET_BIND_SERVICE'],'cap_drop':['ALL'],'read_only':True,
                  'secrets_permissions_unchanged':True,'vps_called':False,'ports_published':False,
                  'docker':docker('version','--format','{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}').stdout.decode().strip(),
                  'caddy_image':release.CADDY,
                  'source_file_sha256':{name:release.digest((ROOT/name).read_bytes()) for name in [
                      'infra/staging/release-transport.py','tests/operations/rehearse_maintenance_permissions.py']}}
        (output/'result.json').write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
        print('Actual UID1000 + hardened Caddy: old permission-denied reproduced; new maintenance and health passed.')
    except Exception as error:
        import traceback
        path=output/'exception.log';path.write_text(''.join(traceback.format_exception(type(error),error,error.__traceback__)));path.chmod(0o600)
        raise
    finally:
        # Every resource name belongs to this invocation; no shared or production resource is used.
        if created:
            docker('rm','-f',name,check=False)
            docker('network','rm',name+'_isolated',check=False)
            docker('volume','rm',volume)


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Local maintenance permission regression stopped; inspect private diagnostics.')
        raise SystemExit(1) from None
