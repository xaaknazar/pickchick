#!/usr/bin/env python3
"""PickChick restore drill: restore an encrypted backup into an ISOLATED throwaway container.

  restore-drill.py dump --dump cloud-<stamp>.dump.age [--manifest ...] --identity -|<file>
  restore-drill.py pitr --base base-<stamp>.tar.gz.age --wal-dir <dir of *.gz.age>
                        --target-time 2026-10-20T08:15:00Z --identity -|<file>

The container has no network (`--network none`), its own anonymous/named volume and resource
limits; nothing touches the working database. `--identity -` reads the age private key from
stdin and keeps it in memory (it is handed to age through a pipe, never written to disk), so on
the VPS it can come over SSH from the owner's computer. Files come from the local backup
directory or from off-site storage (`backup-offsite.py fetch` with a read-only key).

dump: verifies the .sha256, restores with pg_restore --exit-on-error and compares every table's
row count with the encrypted manifest written by backup.sh (counts read just before and just
after the dump; the restored count must lie in that range) and the migration ledger head.
pitr: base backup + archived WAL replayed up to --target-time, then promoted; reports counts.
Prints one JSON report (no row data) and exits 0 only when the drill passed.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

IMAGE = ('postgres:18.3-alpine@sha256:'
         '54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7')
DATABASE = 'pickchick_cloud'
# Same statement as backup.sh (tests/operations/test_backup_offsite.py keeps them identical).
COUNTS_SQL = """SELECT json_build_object('capturedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'migration', (SELECT max(version) FROM schema_migrations
  WHERE scope = 'cloud'), 'tables', (SELECT json_object_agg(c.relname, (xpath('/row/c/text()',
  query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true,
  '')))[1]::text::bigint ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON
  n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')))"""
TARGET = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z')
WAL_FILE = re.compile(r'([0-9A-F]{24}(\.partial|\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)\.gz\.age')


class DrillError(Exception):
    """Secret-free reason for the report."""


def docker(*args, timeout=120, check=True, **kwargs):
    result = subprocess.run(['docker', *args], timeout=timeout, **kwargs)
    if check and result.returncode != 0:
        raise DrillError('docker ' + args[0] + ' failed')
    return result


class Identity:
    """age identity kept in memory and handed to each `age -d` through an inherited pipe."""

    def __init__(self, text):
        if 'AGE-SECRET-KEY-1' not in text:
            raise DrillError('identity is not an age secret key')
        self.data = text.encode()

    def decrypt(self, source, stdout, timeout=3600):
        read, write = os.pipe()
        try:
            os.write(write, self.data)
        finally:
            os.close(write)
        try:
            with open(source, 'rb') as encrypted:
                return subprocess.run(['age', '-d', '-i', '/dev/fd/' + str(read)], stdin=encrypted,
                                      stdout=stdout, stderr=subprocess.DEVNULL, pass_fds=(read,),
                                      timeout=timeout).returncode
        finally:
            os.close(read)

    def decrypt_bytes(self, source):
        with tempfile.TemporaryFile() as output:
            if self.decrypt(source, output) != 0:
                raise DrillError('cannot decrypt ' + Path(source).name)
            output.seek(0)
            return output.read()


def verify_checksum(dump):
    checksum = Path(str(dump) + '.sha256')
    if not checksum.is_file():
        return False
    expected = checksum.read_text().split()[0]
    digest = hashlib.sha256()
    with open(dump, 'rb') as source:
        for block in iter(lambda: source.read(1 << 20), b''):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise DrillError('sha256 mismatch: the encrypted dump is damaged')
    return True


def wait_ready(name, deadline_seconds=120, recovery=False):
    # TCP on loopback: the image's temporary init server listens only on the socket.
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        ready = docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', check=False,
                       capture_output=True).returncode == 0
        if ready and recovery:
            state = docker('exec', name, 'psql', '-X', '-A', '-t', '-U', 'postgres', '-d', 'postgres', '-c',
                           'SELECT pg_is_in_recovery()', check=False, capture_output=True, text=True)
            ready = state.returncode == 0 and state.stdout.strip() == 'f'
        if ready:
            return
        if docker('inspect', '--format', '{{.State.Running}}', name, check=False, capture_output=True,
                  text=True).stdout.strip() != 'true':
            raise DrillError('drill server stopped (see docker logs of the drill container)')
        time.sleep(1)
    raise DrillError('drill server not ready in time')


def counts(name, database):
    result = docker('exec', name, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres',
                    '-d', database, '-c', COUNTS_SQL, capture_output=True, text=True, timeout=600)
    return json.loads(result.stdout)


def compare(restored, manifest):
    """Every manifest table exists and its restored count lies within [before, after]."""
    before, after = manifest['before'], manifest['after']
    problems = []
    if restored.get('migration') != after.get('migration'):
        problems.append({'check': 'migration', 'restored': restored.get('migration'),
                         'expected': after.get('migration')})
    tables = restored.get('tables') or {}
    expected = set(before.get('tables') or {}) | set(after.get('tables') or {})
    for table in sorted(expected - set(tables)):
        problems.append({'check': 'missing_table', 'table': table})
    for table in sorted(set(tables) - expected):
        problems.append({'check': 'unexpected_table', 'table': table})
    for table in sorted(expected & set(tables)):
        bounds = [value for value in ((before.get('tables') or {}).get(table),
                                      (after.get('tables') or {}).get(table)) if value is not None]
        if not bounds or not min(bounds) <= tables[table] <= max(bounds):
            problems.append({'check': 'row_count', 'table': table, 'restored': tables[table],
                             'before': (before.get('tables') or {}).get(table),
                             'after': (after.get('tables') or {}).get(table)})
    return problems


def run_container(name, image, volume=None, command=()):
    password = secrets.token_hex(16)
    mount = ['-v', volume + ':/var/lib/postgresql'] if volume else []
    docker('run', '-d', '--name', name, '--network', 'none', '--label', 'pickchick.restore-drill=1',
           '--memory', '768m', '--cpus', '1', '--pids-limit', '128', '-e', 'POSTGRES_PASSWORD=' + password,
           '-e', 'POSTGRES_DB=' + DATABASE, *mount, image, *command, capture_output=True)


def drill_dump(args, identity):
    dump = Path(args.dump)
    manifest_path = Path(args.manifest) if args.manifest else dump.with_name(
        dump.name.replace('.dump.age', '.manifest.json.age'))
    report = {'event': 'restore_drill', 'mode': 'dump', 'dump': dump.name, 'ok': False}
    report['checksum'] = 'verified' if verify_checksum(dump) else 'absent'
    manifest = json.loads(identity.decrypt_bytes(manifest_path)) if manifest_path.is_file() else None
    name = 'pickchick-restore-drill-' + secrets.token_hex(4)
    started = time.monotonic()
    try:
        run_container(name, args.image)
        wait_ready(name)
        restore = subprocess.Popen(['docker', 'exec', '-i', name, 'pg_restore', '-U', 'postgres', '-d', DATABASE,
                                    '--exit-on-error', '--no-owner', '--no-acl'], stdin=subprocess.PIPE,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        decrypted = identity.decrypt(dump, restore.stdin)
        restore.stdin.close()
        errors = restore.stderr.read().decode(errors='replace')
        if restore.wait(3600) != 0 or decrypted != 0:
            # pg_restore errors name objects, not row data; keep a short tail for the operator.
            report['error'] = 'pg_restore failed: ' + errors.strip().splitlines()[-1][:200] if errors.strip() \
                else 'decryption or restore failed'
            return report
        report['restoreSeconds'] = round(time.monotonic() - started, 1)
        restored = counts(name, DATABASE)
        report['migration'] = restored.get('migration')
        report['tables'] = len(restored.get('tables') or {})
        report['rows'] = sum((restored.get('tables') or {}).values())
        if manifest is None:
            report['manifest'] = 'absent'
            report['problems'] = [{'check': 'manifest', 'detail': 'no manifest: counts not compared'}]
            report['ok'] = not args.require_manifest
            return report
        report['manifest'] = manifest['after'].get('capturedAt')
        report['problems'] = compare(restored, manifest)
        report['ok'] = not report['problems']
        return report
    finally:
        if not args.keep:
            docker('rm', '-f', '-v', name, check=False, capture_output=True)


def wal_tar(identity, files, output):
    """Decrypted WAL files as one tar stream for the drill volume (restore-wal/<name>)."""
    with tarfile.open(fileobj=output, mode='w|') as archive:
        for path in files:
            with tempfile.TemporaryFile() as packed, tempfile.TemporaryFile() as plain:
                if identity.decrypt(path, packed) != 0:
                    raise DrillError('cannot decrypt ' + path.name)
                packed.seek(0)
                with gzip.GzipFile(fileobj=packed) as source:
                    shutil.copyfileobj(source, plain)
                info = tarfile.TarInfo('restore-wal/' + path.name[:-len('.gz.age')])
                info.size, info.mode, info.uid, info.gid = plain.tell(), 0o600, 70, 70
                plain.seek(0)
                archive.addfile(info, plain)


def drill_pitr(args, identity):
    if not TARGET.fullmatch(args.target_time):
        raise DrillError('--target-time must look like 2026-10-20T08:15:00Z')
    wal = sorted(path for path in Path(args.wal_dir).iterdir() if WAL_FILE.fullmatch(path.name))
    report = {'event': 'restore_drill', 'mode': 'pitr', 'base': Path(args.base).name, 'walFiles': len(wal),
              'targetTime': args.target_time, 'ok': False}
    data = docker('image', 'inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', args.image,
                  capture_output=True, text=True).stdout
    pgdata = next((line[7:] for line in data.splitlines() if line.startswith('PGDATA=')), '')
    if not re.fullmatch(r'/var/lib/postgresql(/[A-Za-z0-9._-]+)*', pgdata):
        raise DrillError('unexpected PGDATA in the drill image')
    relative = pgdata[len('/var/lib/postgresql/'):]
    suffix = secrets.token_hex(4)
    name, volume = 'pickchick-restore-drill-' + suffix, 'pickchick-restore-drill-' + suffix
    started = time.monotonic()
    docker('volume', 'create', '--label', 'pickchick.restore-drill=1', volume, capture_output=True)
    try:
        # 1. Base backup into PGDATA, WAL into restore-wal/, recovery settings; as root, then
        #    ownership to the image's postgres user. No network, throwaway container.
        settings = ("\nrestore_command = 'cp /var/lib/postgresql/restore-wal/%f \"%p\"'\n"
                    "recovery_target_time = '" + args.target_time.replace('T', ' ').replace('Z', '+00') + "'\n"
                    "recovery_target_action = 'promote'\narchive_mode = 'off'\n")
        script = ('set -e; mkdir -p "$1" /var/lib/postgresql/restore-wal; tar -x -C "$1" -f -; touch "$1/recovery.signal"; '
                  'printf %s "$2" >> "$1/postgresql.auto.conf"; '
                  'chown -R postgres:postgres /var/lib/postgresql; chmod 700 "$1"')
        helper = ['docker', 'run', '--rm', '-i', '--network', 'none', '--user', 'root', '-v',
                  volume + ':/var/lib/postgresql', '--entrypoint', 'sh', args.image, '-c', script, 'sh', pgdata,
                  settings]
        unpack = subprocess.Popen(helper, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        with tempfile.TemporaryFile() as packed:
            if identity.decrypt(args.base, packed) != 0:
                raise DrillError('cannot decrypt the base backup')
            packed.seek(0)
            with gzip.GzipFile(fileobj=packed) as source:
                shutil.copyfileobj(source, unpack.stdin, 1 << 20)
        unpack.stdin.close()
        if unpack.wait(1800) != 0:
            raise DrillError('cannot unpack the base backup')
        wal_helper = ['docker', 'run', '--rm', '-i', '--network', 'none', '--user', 'root', '-v',
                      volume + ':/var/lib/postgresql', '--entrypoint', 'sh', args.image, '-c',
                      'set -e; tar -x -C /var/lib/postgresql -f -; chown -R postgres:postgres '
                      '/var/lib/postgresql/restore-wal']
        unpack = subprocess.Popen(wal_helper, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        wal_tar(identity, wal, unpack.stdin)
        unpack.stdin.close()
        if unpack.wait(1800) != 0:
            raise DrillError('cannot unpack WAL files')
        # 2. Replay up to the target and promote.
        run_container(name, args.image, volume)
        wait_ready(name, args.timeout, recovery=True)
        report['restoreSeconds'] = round(time.monotonic() - started, 1)
        replay = docker('exec', name, 'psql', '-X', '-A', '-t', '-U', 'postgres', '-d', 'postgres', '-c',
                        "SELECT to_char(pg_last_xact_replay_timestamp() AT TIME ZONE 'UTC',"
                        " 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')", capture_output=True, text=True).stdout.strip()
        report['lastReplayedCommit'] = replay or None
        restored = counts(name, DATABASE)
        report['migration'] = restored.get('migration')
        report['tables'] = restored.get('tables') if args.show_counts else len(restored.get('tables') or {})
        report['rows'] = sum((restored.get('tables') or {}).values())
        report['ok'] = bool(restored.get('migration')) and (not replay or replay <= args.target_time)
        return report
    finally:
        if not args.keep:
            docker('rm', '-f', name, check=False, capture_output=True)
            docker('volume', 'rm', '-f', volume, check=False, capture_output=True)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest='mode', required=True)
    for mode in ('dump', 'pitr'):
        command = sub.add_parser(mode)
        command.add_argument('--identity', required=True, help='age identity file, or - for stdin')
        command.add_argument('--image', default=IMAGE)
        command.add_argument('--keep', action='store_true', help='keep the drill container for inspection')
        if mode == 'dump':
            command.add_argument('--dump', required=True)
            command.add_argument('--manifest')
            command.add_argument('--require-manifest', action='store_true')
        else:
            command.add_argument('--base', required=True)
            command.add_argument('--wal-dir', required=True)
            command.add_argument('--target-time', required=True)
            command.add_argument('--timeout', type=int, default=600)
            command.add_argument('--show-counts', action='store_true')
    args = parser.parse_args(argv)
    text = sys.stdin.read(65536) if args.identity == '-' else Path(args.identity).read_text()
    identity = Identity(text)
    report = drill_dump(args, identity) if args.mode == 'dump' else drill_pitr(args, identity)
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (DrillError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        reason = str(error) if isinstance(error, DrillError) else type(error).__name__
        print(json.dumps({'event': 'restore_drill', 'ok': False, 'error': reason[:200]}))
        sys.exit(1)
