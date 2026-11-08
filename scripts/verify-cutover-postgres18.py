#!/usr/bin/env python3
"""K15: run the existing cutover tests on disposable PostgreSQL 18 databases.

Accepts a clean source checkout with installed dependencies and its exact commit. Never reads .env or
accepts a database URL. The only databases used are created by this invocation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time


IMAGE = 'postgres:18.6-alpine@sha256:123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395'
TESTS = (
    'tests/integration/windows-edge-backup.test.mjs',
    'tests/integration/windows-cutover-upgrade.test.mjs',
    'tests/integration/pos-sales-setup.test.mjs',
    'tests/integration/pos-sales-desk-number.test.mjs',
    'tests/integration/cutover-tools-cli.test.mjs',
    'tests/pos/paid-day-browser.test.mjs',
)
DOCKER = ['docker', '--host=unix:///var/run/docker.sock']


def environment(parent):
    # Do not inherit service flags, database URLs, NODE_OPTIONS or PG* credentials.
    allowed = ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DOCKER_CONFIG',
               'COREPACK_HOME', 'PNPM_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
               'PLAYWRIGHT_BROWSERS_PATH', 'POS_TEST_PYTHON')
    return {key: parent[key] for key in allowed if key in parent}


def command(args, *, env, cwd=None, timeout=60):
    result = subprocess.run(args, env=env, cwd=cwd, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode:
        # No command line or captured stderr: commands may contain test credentials.
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {result.returncode})')
    return result.stdout.strip()


def source_sha(source, expected, env):
    actual = command(['git', 'rev-parse', 'HEAD'], cwd=source, env=env)
    if actual != expected:
        raise RuntimeError('Source HEAD differs from --expected-sha')
    command(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=source, env=env)
    # Untracked source can shadow files or change the migration ledger.
    if command(['git', 'ls-files', '--others', '--exclude-standard'], cwd=source, env=env):
        raise RuntimeError('Source has untracked files')
    return actual


def test_summary(log):
    fields = {}
    for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
        values = re.findall(r'^# ' + key + r' (\d+)\s*$', log, re.M)
        if len(values) != 1:
            raise RuntimeError('Missing or ambiguous TAP summary: ' + key)
        fields[key] = int(values[0])
    if (fields['tests'] < len(TESTS) or fields['pass'] != fields['tests']
            or any(fields[key] for key in ('fail', 'cancelled', 'skipped', 'todo'))):
        raise RuntimeError('Tests did not all pass without skips')
    return fields


def docker(args, env, timeout=60):
    return command([*DOCKER, *args], env=env, timeout=timeout)


def verify_tool_version(tool, version):
    if not re.search(r'\(PostgreSQL\) 18\.6(?:\s|$)', version):
        raise RuntimeError(tool + ' must match the PostgreSQL 18.6 rehearsal baseline')


def wait_database(name, database, env):
    for attempt in range(60):
        try:
            # initdb's temporary server accepts Unix sockets but is about to stop.
            # Only the final server listens on TCP and is usable by the Node tests.
            docker(['exec', name, 'pg_isready', '-h', '127.0.0.1',
                    '-U', 'pickchick_local', '-d', database], env)
            return docker(['exec', name, 'psql', '-U', 'pickchick_local',
                           '-d', database, '-Atc', 'SHOW server_version_num'], env)
        except RuntimeError:
            if attempt == 59:
                raise RuntimeError('Disposable PostgreSQL did not become ready') from None
            time.sleep(1)


def run(args):
    env = environment(os.environ)
    source = args.source.resolve()
    pg_bin = args.pg_bin.resolve()
    sha = source_sha(source, args.expected_sha, env)
    for path in TESTS:
        if not (source / path).is_file():
            raise RuntimeError('Source is missing required test: ' + path)
    node = command(['node', '--version'], env=env)
    expected_node = (source / '.node-version').read_text().strip().removeprefix('v')
    if node.removeprefix('v') != expected_node:
        raise RuntimeError('Node version differs from source .node-version')
    pnpm = command(['pnpm', '--version'], env=env)
    manager = json.loads((source / 'package.json').read_text())['packageManager']
    if manager.split('+')[0] != 'pnpm@' + pnpm:
        raise RuntimeError('pnpm version differs from source packageManager')
    versions = {}
    for tool in ('pg_dump', 'pg_restore'):
        version = command([str(pg_bin / tool), '--version'], env=env)
        verify_tool_version(tool, version)
        versions[tool] = version
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {'status': 'failed', 'sourceSha': sha, 'node': node, 'pnpm': pnpm, 'tools': versions,
              'image': IMAGE, 'tests': list(TESTS), 'syntheticOnly': True,
              'windowsAcceptance': False, 'productionChanged': False}
    containers = []
    failure = None
    try:
        with (output / 'build.log').open('w') as log:
            result = subprocess.run(['pnpm', 'build'], cwd=source, env=env,
                                    stdout=log, stderr=subprocess.STDOUT,
                                    timeout=1200, check=False)
        if result.returncode:
            raise RuntimeError('Source build failed; see build.log')
        for scope in ('cloud', 'edge'):
            name = 'pickchick-k15-' + secrets.token_hex(8)
            # Remember our unique name before starting, including timeout/error cleanup.
            containers.append(name)
            password = secrets.token_hex(24)
            database = 'pickchick_' + scope
            docker(['run', '--detach', '--rm', '--name', name,
                    '--label', 'pickchick.verification=k15',
                    '--publish', '127.0.0.1::5432',
                    '--tmpfs', '/var/lib/postgresql:rw',
                    '--env', 'POSTGRES_USER=pickchick_local',
                    '--env', 'POSTGRES_PASSWORD=' + password,
                    '--env', 'POSTGRES_DB=' + database, IMAGE], env, timeout=180)
            binding = docker(['port', name, '5432/tcp'], env)
            if not re.fullmatch(r'127\.0\.0\.1:\d+', binding):
                raise RuntimeError('Unexpected database port binding')
            server = wait_database(name, database, env)
            if server != '180006':
                raise RuntimeError('Server does not match the PostgreSQL 18.6 rehearsal baseline')
            report[scope + 'ServerVersionNum'] = int(server)
            env[scope.upper() + '_DATABASE_URL'] = (
                f'postgresql://pickchick_local:{password}@{binding}/{database}')
        # These fixtures use PostgreSQL only; the config requires a Redis URL but no Redis client.
        env.update(APP_ENV='test', REDIS_URL='redis://127.0.0.1:1',
                   EDGE_BRANCH_ID='10000000-0000-4000-8000-000000000003',
                   EDGE_BACKUP_TEST_PG_BIN=str(pg_bin))
        with (output / 'tests.tap').open('w') as log:
            result = subprocess.run(['node', '--test', '--test-reporter=tap',
                                     '--test-concurrency=1', *TESTS],
                                    cwd=source, env=env, stdout=log,
                                    stderr=subprocess.STDOUT, timeout=1800, check=False)
        if result.returncode:
            raise RuntimeError('Test process failed; see tests.tap')
        report['summary'] = test_summary((output / 'tests.tap').read_text())
        source_sha(source, sha, env)
        report['status'] = 'passed'
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        failure = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        report['error'] = failure
    finally:
        cleanup_errors = []
        for name in reversed(containers):
            # Remove only containers this invocation named; no shared compose down/volume prune.
            try:
                found = docker(['container', 'ls', '--all', '--filter', 'name=^/' + name + '$',
                                '--format', '{{.Names}}'], env)
                if found:
                    docker(['rm', '--force', name], env)
            except (RuntimeError, OSError, subprocess.TimeoutExpired):
                cleanup_errors.append(name)
        report['cleanupPending'] = cleanup_errors
        if cleanup_errors:
            report['status'] = 'failed'
            failure = failure or 'Disposable container cleanup failed'
        for file in output.glob('*.tap'):
            report[file.name + '.sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
        (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    if failure:
        raise RuntimeError(failure)
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--pg-bin', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New evidence directory')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{40}', args.expected_sha):
        parser.error('--expected-sha must be the full commit SHA')
    try:
        run(args)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        parser.exit(1, (str(error) if isinstance(error, RuntimeError) else type(error).__name__) + '\n')


if __name__ == '__main__':
    main()
