#!/usr/bin/env python3
"""PickChick watchdog host runner (systemd timer, user pickchick-ops).

1. Collects read-only host facts: `docker inspect`/`docker logs` of the three Kaspi
   containers (only whitelisted fields of the workers' own JSON event lines), disk usage
   and the encrypted backup listing. Optionally (off by default) runs the existing
   bridge `session-check.mjs` at most every N >= 6 hours.
2. Runs the pinned watchdog container (`docker compose run --rm`) that evaluates the
   facts, reads PostgreSQL as pickchick_watchdog and notifies Telegram.

It never changes containers, databases or files outside /opt/pickchick-staging/watchdog,
and never prints the private env file. The release is pinned by the symlink
/opt/pickchick-staging/watchdog/current -> /opt/pickchick-staging/releases/<sha>.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import time

BASE = Path('/opt/pickchick-staging')
HOME = BASE / 'watchdog'
ENV_FILE = BASE / 'secrets' / 'watchdog.env'
OPERATOR = 'pickchick-ops'
SHA = re.compile(r'[a-f0-9]{40}')
CONTAINERS = {
    'kaspi-bridge': 'pickchick-kaspi-bridge',
    'kaspi-remote-worker': 'pickchick-kaspi-worker',
    'kiosk-qr-worker': 'pickchick-kiosk-kaspi-qr-worker',
}
WORKER_EVENTS = {
    'kaspi-remote-worker': {'kaspi_remote', 'kaspi_remote_attention', 'kaspi_remote_failed'},
    'kiosk-qr-worker': {'kiosk_kaspi_qr', 'kiosk_kaspi_qr_attention', 'kiosk_kaspi_qr_failed'},
}
FULFILLMENT_EVENT = 'fulfillment_transport_attention'
KASPI_REASONS = {'session_inactive', 'session_missing', 'session_rejected', 'bridge_unreachable',
                 'unknown_overdue', 'invoice_not_sent', 'worker_errors'}
REASON_CODE = re.compile(r'[A-Z][A-Z0-9_]{0,40}')
STATUS_FILES = {'status': 'backup-status.json', 'offsite': 'offsite-status.json', 'wal': 'wal-status.json'}
STATUS_FIELDS = {
    'status': {'lastAttemptAt': 'time', 'lastSuccessAt': 'time', 'ok': 'bool', 'stage': 'stage'},
    'offsite': {'enabled': 'bool', 'lastAttemptAt': 'time', 'lastSuccessAt': 'time', 'ok': 'bool',
                'sizeBytes': 'count'},
    'wal': {'enabled': 'bool', 'checkedAt': 'time', 'ok': 'bool', 'pending': 'count', 'oldestPendingAt': 'time',
            'lastShippedAt': 'time', 'lastBaseBackupAt': 'time'},
}
STAGES = {'config', 'counts', 'dump', 'encrypt', 'manifest', 'offsite', 'base_backup', 'retention',
          'wal_ship', 'unknown'}
CONTAINER_STATES = {'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'}
HEALTH = {'starting', 'healthy', 'unhealthy'}
PROBE_REASONS = {'verified', 'not_verified', 'unavailable', 'missing_session'}
INSPECT_FORMAT = (
    '{"status":{{json .State.Status}},"running":{{json .State.Running}},'
    '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},'
    '"restarts":{{json .RestartCount}},"startedAt":{{json .State.StartedAt}}}'
)
LOG_LINE = re.compile(r'^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.[0-9]+)?Z (\{"event":".*)$')
STARTED = re.compile(r'^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.[0-9]+)?Z$')
PATH = re.compile(r'/[A-Za-z0-9._/-]{0,200}')
BACKUP = re.compile(r'cloud-[0-9]{8}T[0-9]{6}Z\.dump\.age')
NETWORK = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')
DEFAULTS = {
    'WATCHDOG_LOG_WINDOW_SECONDS': '600',
    'WATCHDOG_DISK_PATHS': '/,/var/lib/docker,/opt/pickchick-staging/backups',
    'WATCHDOG_BACKUP_DIR': '/opt/pickchick-staging/backups',
    'WATCHDOG_STAGING_NETWORK': 'pickchick-staging_private',
    'WATCHDOG_KASPI_SESSION_PROBE_HOURS': '0',
    # Empty: the fulfillment worker runs on the Windows cashier (DB check covers it).
    'WATCHDOG_FULFILLMENT_CONTAINER': '',
}


def parse_settings(text):
    """Only the host keys above; secrets in the same file are never retained."""
    values = dict(DEFAULTS)
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = (part.strip() for part in line.split('=', 1))
        if key in DEFAULTS and value != '':
            values[key] = value
    window = values['WATCHDOG_LOG_WINDOW_SECONDS']
    if not re.fullmatch('[0-9]{3,4}', window) or not 300 <= int(window) <= 3600:
        raise ValueError('WATCHDOG_LOG_WINDOW_SECONDS')
    disks = values['WATCHDOG_DISK_PATHS'].split(',')
    if not 1 <= len(disks) <= 8 or not all(PATH.fullmatch(path) for path in disks):
        raise ValueError('WATCHDOG_DISK_PATHS')
    if not PATH.fullmatch(values['WATCHDOG_BACKUP_DIR']):
        raise ValueError('WATCHDOG_BACKUP_DIR')
    if not NETWORK.fullmatch(values['WATCHDOG_STAGING_NETWORK']):
        raise ValueError('WATCHDOG_STAGING_NETWORK')
    fulfillment = values['WATCHDOG_FULFILLMENT_CONTAINER']
    if fulfillment and not NETWORK.fullmatch(fulfillment):
        raise ValueError('WATCHDOG_FULFILLMENT_CONTAINER')
    hours = values['WATCHDOG_KASPI_SESSION_PROBE_HOURS']
    if not re.fullmatch('[0-9]{1,3}', hours) or not (int(hours) == 0 or 6 <= int(hours) <= 168):
        raise ValueError('WATCHDOG_KASPI_SESSION_PROBE_HOURS')
    return {
        'window': int(window),
        'disks': disks,
        'backups': values['WATCHDOG_BACKUP_DIR'],
        'network': values['WATCHDOG_STAGING_NETWORK'],
        'probe_hours': int(hours),
        'fulfillment': fulfillment or None,
    }


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def is_count(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 1_000_000


def sanitize_worker_line(role, line):
    """Keeps only counters/flags of the worker's own event JSON; drops everything else."""
    match = LOG_LINE.match(line.strip())
    if not match or len(line) > 4096:
        return None
    try:
        raw = json.loads(match.group(2))
    except ValueError:
        return None
    if not isinstance(raw, dict) or raw.get('event') not in WORKER_EVENTS[role]:
        return None
    event = {'at': match.group(1) + 'Z', 'event': raw['event']}
    for key in ('errors', 'unknownOverdue', 'submitted', 'checked', 'pendingUnsent', 'oldestUnsentSeconds'):
        if is_count(raw.get(key)):
            event[key] = raw[key]
    # An explicit false (a tick that reached the bank, or the recovery line) clears the problem.
    if raw.get('sessionProblem') is True or raw.get('sessionRejected') is True:
        event['sessionProblem'] = True
    elif raw.get('sessionProblem') is False or raw.get('sessionRejected') is False:
        event['sessionProblem'] = False
    if raw.get('recovered') is True:
        event['recovered'] = True
    if raw.get('reason') in KASPI_REASONS:
        event['reason'] = raw['reason']
    if raw.get('state') in ('disabled', 'no_cashier_session'):
        event['state'] = raw['state']
    return event


def sanitize_fulfillment_line(line):
    """`fulfillment_transport_attention` (PM interface ful -> ops): counts and reason codes only."""
    match = LOG_LINE.match(line.strip())
    if not match or len(line) > 4096:
        return None
    try:
        raw = json.loads(match.group(2))
    except ValueError:
        return None
    if not isinstance(raw, dict) or raw.get('event') != FULFILLMENT_EVENT:
        return None
    event = {'at': match.group(1) + 'Z', 'event': FULFILLMENT_EVENT}
    if raw.get('recovered') is True:
        event['recovered'] = True
        return event
    for key in ('deferred', 'parked', 'unresolvedFailures'):
        if is_count(raw.get(key)):
            event[key] = raw[key]
    reasons = raw.get('reasons')
    if isinstance(reasons, dict):
        kept = {code: value for code, value in list(reasons.items())[:8]
                if isinstance(code, str) and REASON_CODE.fullmatch(code) and is_count(value)}
        if kept:
            event['reasons'] = kept
    return event


def read_status(directory, kind):
    """Small status JSON written by backup.sh / backup-offsite.py; whitelisted fields only."""
    path = Path(directory, STATUS_FILES[kind])
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
            return None
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    result = {}
    for key, kind_of in STATUS_FIELDS[kind].items():
        value = raw.get(key)
        if kind_of == 'time' and isinstance(value, str) and STARTED.match(value):
            result[key] = STARTED.match(value).group(1) + 'Z'
        elif kind_of == 'bool' and isinstance(value, bool):
            result[key] = value
        elif kind_of == 'count' and isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            result[key] = value
        elif kind_of == 'stage' and value in STAGES:
            result[key] = value
    return result


def parse_inspect(output):
    raw = json.loads(output)
    status = raw.get('status') if raw.get('status') in CONTAINER_STATES else None
    started = STARTED.match(raw.get('startedAt') or '')
    return {
        'present': True,
        'status': status,
        'running': raw.get('running') is True and status == 'running',
        'health': raw.get('health') if raw.get('health') in HEALTH else None,
        'restarts': raw['restarts'] if is_count(raw.get('restarts')) else 0,
        'startedAt': started.group(1) + 'Z' if started and not started.group(1).startswith('0001') else None,
    }


def disk_usage(paths, statvfs=os.statvfs, device=lambda path: os.stat(path).st_dev):
    result, seen = [], set()
    for path in paths:
        try:
            dev = device(path)
            if dev in seen:
                continue
            seen.add(dev)
            vfs = statvfs(path)
            used = (vfs.f_blocks - vfs.f_bfree) * vfs.f_frsize
            avail = vfs.f_bavail * vfs.f_frsize
            percent = round(used * 100 / (used + avail), 1) if used + avail else 0.0
            result.append({'path': path, 'usedPercent': percent,
                           'sizeBytes': vfs.f_blocks * vfs.f_frsize, 'availBytes': avail})
        except OSError:
            result.append({'path': path, 'error': 'unavailable'})
    return result


def list_backups(directory):
    try:
        files = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if not BACKUP.fullmatch(entry.name):
                    continue
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    continue
                checksum = Path(directory, entry.name + '.sha256')
                files.append({'name': entry.name, 'mtime': iso(info.st_mtime), 'sizeBytes': info.st_size,
                              'checksum': checksum.is_file() and not checksum.is_symlink()})
        files.sort(key=lambda item: item['mtime'], reverse=True)
        listing = {'files': files[:10]}
        for kind in STATUS_FILES:
            status = read_status(directory, kind)
            if status is not None:
                listing[kind] = status
        return listing
    except OSError:
        return {'error': 'unavailable', 'files': []}


def docker(run, *args, timeout=20):
    return run(['docker', *args], capture_output=True, text=True, errors='replace', timeout=timeout)


def write_private_json(path, data):
    temporary = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(data, output)
        output.write('\n')
    os.replace(temporary, path)


def kaspi_session_probe(settings, bridge_present, run, now, state_dir):
    """Reuses the bridge's own read-only session-check.mjs; never more often than configured."""
    hours = settings['probe_hours']
    if hours == 0:
        return None, False
    target = state_dir / 'kaspi-session-probe.json'
    previous = None
    try:
        previous = json.loads(target.read_text())
        checked = datetime.strptime(previous['checkedAt'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        if now() - checked.timestamp() < hours * 3600:
            return previous, False
    except (OSError, ValueError, KeyError, TypeError):
        previous = None
    if not bridge_present:
        return previous, False
    probe = {'checkedAt': iso(now()), 'active': None, 'reason': 'probe_failed'}
    failed = False
    try:
        result = docker(run, 'exec', CONTAINERS['kaspi-bridge'], 'node',
                        '--env-file=/run/kaspi/session.env', 'session-check.mjs', timeout=60)
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        raw = json.loads(lines[-1]) if lines else {}
        if isinstance(raw, dict) and raw.get('invoiceAttempted') is False and isinstance(raw.get('active'), bool):
            probe['active'] = raw['active']
            probe['reason'] = raw.get('reason') if raw.get('reason') in PROBE_REASONS else 'probe_failed'
        else:
            failed = True
    except (OSError, ValueError, subprocess.TimeoutExpired):
        failed = True
    write_private_json(target, probe)
    return probe, failed


def collect(settings, run=subprocess.run, now=time.time, state_dir=HOME / 'state'):
    errors = []
    containers = {role: {'present': False} for role in CONTAINERS}
    events = {role: [] for role in WORKER_EVENTS}
    docker_ok = False
    try:
        docker_ok = docker(run, 'version', '--format', '{{.Server.Version}}').returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        docker_ok = False
    if not docker_ok:
        errors.append('docker_unavailable')
    else:
        for role, name in CONTAINERS.items():
            try:
                result = docker(run, 'inspect', '--type', 'container', '--format', INSPECT_FORMAT, name)
                if result.returncode == 0:
                    containers[role] = parse_inspect(result.stdout)
            except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
                errors.append('docker_unavailable')
        for role in WORKER_EVENTS:
            if not containers[role]['present']:
                continue
            try:
                result = docker(run, 'logs', '--since', str(settings['window']) + 's', '--timestamps',
                                '--tail', '5000', CONTAINERS[role], timeout=30)
                if result.returncode != 0:
                    raise OSError('logs')
                lines = (result.stdout + '\n' + result.stderr).splitlines()
                parsed = [sanitize_worker_line(role, line) for line in lines]
                events[role] = sorted((item for item in parsed if item), key=lambda item: item['at'])[-200:]
            except (OSError, subprocess.TimeoutExpired):
                errors.append('logs_unavailable')
    fulfillment, fulfillment_collected = [], False
    if docker_ok and settings.get('fulfillment'):
        try:
            result = docker(run, 'logs', '--since', str(settings['window']) + 's', '--timestamps',
                            '--tail', '5000', settings['fulfillment'], timeout=30)
            if result.returncode == 0:
                lines = (result.stdout + '\n' + result.stderr).splitlines()
                parsed = [sanitize_fulfillment_line(line) for line in lines]
                fulfillment = sorted((item for item in parsed if item), key=lambda item: item['at'])[-200:]
                fulfillment_collected = True
        except (OSError, subprocess.TimeoutExpired):
            errors.append('logs_unavailable')
    probe, probe_failed = kaspi_session_probe(
        settings, docker_ok and containers['kaspi-bridge'].get('running') is True, run, now, state_dir)
    if probe_failed:
        errors.append('probe_unavailable')
    return {
        'version': 1,
        'collectedAt': iso(now()),
        'logWindowSeconds': settings['window'],
        'collectorErrors': sorted(set(errors)),
        'containers': containers,
        'workerEvents': events,
        'fulfillmentEvents': fulfillment,
        'fulfillmentCollected': fulfillment_collected,
        'disks': disk_usage(settings['disks']),
        'backups': list_backups(settings['backups']),
        'kaspiSessionProbe': probe,
    }


def release_of(script):
    """<BASE>/releases/<sha>/infra/staging/watchdog/run-watchdog.py -> (sha, release dir)."""
    release = Path(script).resolve().parents[3]
    if release.parent != BASE / 'releases' or not SHA.fullmatch(release.name):
        raise RuntimeError('Run only from a pinned release directory')
    marker = (release / 'release.env').read_text()
    if re.search('^RELEASE_SHA=' + release.name + '$', marker, re.MULTILINE) is None:
        raise RuntimeError('Release marker mismatch')
    return release.name, release


def compose_command(release, extra):
    return ['docker', 'compose', '-p', 'pickchick-watchdog', '-f',
            str(release / 'infra/staging/watchdog/compose.yaml'),
            'run', '--rm', '--no-deps', '-T', 'watchdog', *extra]


def compose_environment(sha, settings, uid, gid, base_environment):
    environment = {key: value for key, value in base_environment.items() if key in ('PATH', 'HOME', 'LANG')}
    environment.update({
        'WATCHDOG_RELEASE_SHA': sha,
        'WATCHDOG_UID': str(uid),
        'WATCHDOG_GID': str(gid),
        'WATCHDOG_ENV_FILE': str(ENV_FILE),
        'WATCHDOG_FACTS_FILE': str(HOME / 'host-facts.json'),
        'WATCHDOG_STATE_DIR': str(HOME / 'state'),
        'WATCHDOG_STAGING_NETWORK': settings['network'],
    })
    return environment


def private_env_text():
    info = ENV_FILE.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('watchdog.env must be a regular 0600 file owned by the operator')
    return ENV_FILE.read_text()


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--dry-run', action='store_true', help='print alerts, send nothing, keep state')
    parser.add_argument('--summary', action='store_true', help='also send the daily summary now')
    parser.add_argument('--collect-only', action='store_true', help='print sanitized host facts and stop')
    args = parser.parse_args(argv)
    os.umask(0o077)
    if pwd.getpwuid(os.getuid()).pw_name != OPERATOR:
        raise RuntimeError('Run only as the PickChick server operator')
    for directory in (HOME, HOME / 'state'):
        directory.mkdir(mode=0o700, exist_ok=True)
        directory.chmod(0o700)
    lock = open(HOME / '.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0
    settings = parse_settings(private_env_text())
    sha, release = release_of(__file__)
    revision = docker(subprocess.run, 'image', 'inspect', '--format',
                      '{{index .Config.Labels "org.opencontainers.image.revision"}}', 'pickchick-api:' + sha)
    if revision.returncode != 0 or revision.stdout.strip() != sha:
        raise RuntimeError('Pinned watchdog image is missing or mislabeled')
    facts = collect(settings)
    if args.collect_only:
        print(json.dumps(facts, indent=2))
        return 0
    write_private_json(HOME / 'host-facts.json', facts)
    extra = (['--dry-run'] if args.dry_run else []) + (['--summary'] if args.summary else [])
    started = time.time()
    status = subprocess.run(compose_command(release, extra),
                            env=compose_environment(sha, settings, os.getuid(), os.getgid(), os.environ),
                            timeout=180).returncode
    write_private_json(HOME / 'last-run.json', {'source_sha': sha, 'started_at': iso(started),
                                                'finished_at': iso(time.time()), 'exit_status': status})
    return status


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:  # noqa: BLE001 - never print paths or secrets from tracebacks
        reason = str(error) if isinstance(error, (RuntimeError, ValueError)) else type(error).__name__
        print(json.dumps({'event': 'watchdog_runner_failed', 'reason': reason[:120]}))
        sys.exit(1)
