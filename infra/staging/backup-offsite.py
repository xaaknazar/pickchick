#!/usr/bin/env python3
"""PickChick encrypted off-site backups to S3-compatible storage (stdlib only, user pickchick-ops).

Commands (all off unless the 0600 env file enables them; see backup-offsite.env.example):
  upload <cloud-*.dump.age>  copy the age-encrypted dump, its manifest and .sha256 (backup.sh)
  ship-wal                   PITR option: gzip+age each archived WAL segment and upload it
  base-backup                PITR option: pg_basebackup tar -> gzip -> age -> upload
  list <prefix>              list stored objects (restore drills)
  fetch <key> <file>         download one object (restore drills; use a read-only key)
  pitr-sql enable|disable    print the ALTER SYSTEM statements for WAL archiving (PITR option)

Everything uploaded is already encrypted with the owner's age recipient; the age private key
never touches this host. Credentials come only from the env file and are never printed.
The VPS key needs only s3:PutObject (plus GetObject/ListBucket for a separate drill key);
retention and immutability are bucket settings (lifecycle rule + versioning/object lock).
Status for the watchdog: <backups>/offsite-status.json and <backups>/wal-status.json.
"""
import base64
import datetime
import fcntl
import gzip
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import xml.etree.ElementTree as ElementTree

ROOT = Path(os.environ.get('PICKCHICK_STAGING_ROOT', '/opt/pickchick-staging'))
DEFAULTS = {
    'BACKUP_OFFSITE_ENABLED': 'false',
    'BACKUP_S3_ENDPOINT': '',
    'BACKUP_S3_REGION': 'us-east-1',
    'BACKUP_S3_BUCKET': '',
    'BACKUP_S3_PREFIX': 'pickchick-staging',
    'BACKUP_S3_ACCESS_KEY_ID': '',
    'BACKUP_S3_SECRET_ACCESS_KEY': '',
    'BACKUP_S3_ADDRESSING': 'path',
    'BACKUP_PITR_ENABLED': 'false',
    'BACKUP_DB_CONTAINER': 'pickchick-staging-cloud-db-1',
    'BACKUP_WAL_ARCHIVE_DIR': '/var/lib/postgresql/wal-archive',
}
WAL_NAME = re.compile(r'[0-9A-F]{24}(\.partial|\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history')
KEY = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,500}')
DUMP = re.compile(r'cloud-[0-9]{8}T[0-9]{6}Z\.dump\.age')
EMPTY_SHA256 = hashlib.sha256(b'').hexdigest()


class OffsiteError(Exception):
    """Short, secret-free reason (an env variable name or a stage), safe for journald."""


def utc(seconds=None):
    return datetime.datetime.fromtimestamp(time.time() if seconds is None else seconds,
                                           datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def private_text(path):
    """The env file must be a regular 0600 file of the operator; anything else is refused."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise OffsiteError('backup-offsite.env must be a regular 0600 file owned by the operator')
    return path.read_text()


def parse_settings(text):
    values = dict(DEFAULTS)
    for line in (text or '').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = (part.strip() for part in line.split('=', 1))
        if key in DEFAULTS and value != '':
            values[key] = value
    for name in ('BACKUP_OFFSITE_ENABLED', 'BACKUP_PITR_ENABLED'):
        if values[name] not in ('true', 'false'):
            raise OffsiteError(name)
    enabled = values['BACKUP_OFFSITE_ENABLED'] == 'true'
    pitr = values['BACKUP_PITR_ENABLED'] == 'true'
    if pitr and not enabled:
        raise OffsiteError('BACKUP_PITR_ENABLED')
    settings = {'enabled': enabled, 'pitr': pitr}
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', values['BACKUP_DB_CONTAINER']):
        raise OffsiteError('BACKUP_DB_CONTAINER')
    if not re.fullmatch(r'/[A-Za-z0-9._/-]{1,200}', values['BACKUP_WAL_ARCHIVE_DIR']):
        raise OffsiteError('BACKUP_WAL_ARCHIVE_DIR')
    settings.update(container=values['BACKUP_DB_CONTAINER'], archive=values['BACKUP_WAL_ARCHIVE_DIR'])
    if not enabled:
        return settings
    endpoint = urllib.parse.urlsplit(values['BACKUP_S3_ENDPOINT'])
    local = endpoint.hostname in ('127.0.0.1', 'localhost')
    # TLS is mandatory; plain http only for a loopback test double.
    if (endpoint.scheme != 'https' and not (endpoint.scheme == 'http' and local)) or not endpoint.hostname \
            or endpoint.username or endpoint.password or endpoint.path not in ('', '/') \
            or endpoint.query or endpoint.fragment:
        raise OffsiteError('BACKUP_S3_ENDPOINT')
    checks = {
        'BACKUP_S3_REGION': r'[a-z0-9][a-z0-9-]{0,40}',
        'BACKUP_S3_BUCKET': r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]',
        'BACKUP_S3_PREFIX': r'[A-Za-z0-9][A-Za-z0-9._/-]{0,100}',
        'BACKUP_S3_ACCESS_KEY_ID': r'[A-Za-z0-9_+=/.-]{8,128}',
        'BACKUP_S3_SECRET_ACCESS_KEY': r'[A-Za-z0-9_+=/.-]{16,128}',
        'BACKUP_S3_ADDRESSING': r'path|virtual',
    }
    for name, pattern in checks.items():
        if not re.fullmatch(pattern, values[name]):
            raise OffsiteError(name)
    settings.update(
        scheme=endpoint.scheme, host=endpoint.hostname, port=endpoint.port,
        region=values['BACKUP_S3_REGION'], bucket=values['BACKUP_S3_BUCKET'],
        prefix=values['BACKUP_S3_PREFIX'].strip('/'), access_key=values['BACKUP_S3_ACCESS_KEY_ID'],
        secret_key=values['BACKUP_S3_SECRET_ACCESS_KEY'], virtual=values['BACKUP_S3_ADDRESSING'] == 'virtual')
    return settings


def quote(value, safe='-_.~'):
    return urllib.parse.quote(value, safe=safe)


def sign_v4(method, host, path, query, headers, payload_hash, access_key, secret_key, region, amz_date,
            service='s3'):
    """AWS Signature Version 4. `headers` are lower-case names; returns the Authorization value."""
    canonical_headers = {name.lower(): ' '.join(str(value).split()) for name, value in headers.items()}
    canonical_headers['host'] = host
    names = sorted(canonical_headers)
    canonical_query = '&'.join(
        quote(key) + '=' + quote(value) for key, value in sorted(query.items()))
    canonical = '\n'.join([
        method, quote(path, safe='-_.~/'), canonical_query,
        ''.join(name + ':' + canonical_headers[name] + '\n' for name in names),
        ';'.join(names), payload_hash])
    scope = '/'.join([amz_date[:8], region, service, 'aws4_request'])
    to_sign = '\n'.join(['AWS4-HMAC-SHA256', amz_date, scope,
                         hashlib.sha256(canonical.encode()).hexdigest()])
    key = ('AWS4' + secret_key).encode()
    for part in (amz_date[:8], region, service, 'aws4_request'):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return ('AWS4-HMAC-SHA256 Credential=' + access_key + '/' + scope + ', SignedHeaders='
            + ';'.join(names) + ', Signature=' + signature)


class S3:
    """Minimal S3 client: PUT/GET object and ListObjectsV2, path or virtual-hosted style."""

    def __init__(self, settings, timeout=120, attempts=3, sleep=time.sleep, clock=time.time):
        self.s = settings
        self.timeout, self.attempts, self.sleep, self.clock = timeout, attempts, sleep, clock

    def key(self, *parts):
        key = '/'.join([self.s['prefix'], *parts])
        if not KEY.fullmatch(key) or '..' in key:
            raise OffsiteError('object key')
        return key

    def _target(self, key):
        host = (self.s['bucket'] + '.' + self.s['host']) if self.s['virtual'] else self.s['host']
        path = '/' + key if self.s['virtual'] else '/' + self.s['bucket'] + ('/' + key if key else '')
        if self.s['virtual'] and not key:
            path = '/'
        header_host = host if self.s['port'] is None else host + ':' + str(self.s['port'])
        return host, header_host, path

    def _connection(self, host):
        if self.s['scheme'] == 'https':
            return http.client.HTTPSConnection(host, self.s['port'], timeout=self.timeout,
                                               context=ssl.create_default_context())
        return http.client.HTTPConnection(host, self.s['port'], timeout=self.timeout)

    def request(self, method, key, query=None, body=None, length=0, payload_hash=EMPTY_SHA256,
                extra=None, sink=None):
        """One signed request with bounded retries on network errors and 5xx/429 answers."""
        query = query or {}
        host, header_host, path = self._target(key)
        for attempt in range(1, self.attempts + 1):
            amz_date = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(self.clock()))
            headers = {'x-amz-content-sha256': payload_hash, 'x-amz-date': amz_date, **(extra or {})}
            headers['Authorization'] = sign_v4(method, header_host, path, query, headers, payload_hash,
                                               self.s['access_key'], self.s['secret_key'],
                                               self.s['region'], amz_date)
            if method == 'PUT':
                headers['Content-Length'] = str(length)
            target = quote(path, safe='-_.~/') + (
                '?' + '&'.join(quote(k) + '=' + quote(v) for k, v in sorted(query.items())) if query else '')
            connection = self._connection(host)
            try:
                if body is not None:
                    body.seek(0)
                connection.request(method, target, body=body, headers={**headers, 'Host': header_host})
                response = connection.getresponse()
                if response.status < 300:
                    if sink is not None:
                        sink.seek(0)
                        sink.truncate()
                        shutil.copyfileobj(response, sink)
                        return response.status, b''
                    return response.status, response.read()
                response.read()
                if response.status < 500 and response.status != 429:
                    raise OffsiteError('storage refused ' + method + ' with HTTP ' + str(response.status))
            except (OSError, http.client.HTTPException):
                if attempt == self.attempts:
                    raise OffsiteError('storage unreachable during ' + method)
            finally:
                connection.close()
            if attempt == self.attempts:
                raise OffsiteError('storage failed ' + method + ' after ' + str(attempt) + ' attempts')
            self.sleep(2 ** attempt)
        raise OffsiteError('unreachable')

    def put_file(self, key, path):
        sha, md5, size = hashlib.sha256(), hashlib.md5(), 0
        with open(path, 'rb') as source:
            for block in iter(lambda: source.read(1 << 20), b''):
                sha.update(block)
                md5.update(block)
                size += len(block)
            # Content-MD5 is required by buckets with object lock; it also proves integrity.
            extra = {'content-md5': base64.b64encode(md5.digest()).decode(),
                     'content-type': 'application/octet-stream',
                     'x-amz-meta-sha256': sha.hexdigest()}
            self.request('PUT', key, body=source, length=size, payload_hash=sha.hexdigest(), extra=extra)
        return size

    def get_file(self, key, destination):
        with open(destination, 'wb') as sink:
            self.request('GET', key, sink=sink)

    def list(self, prefix):
        keys, token = [], None
        while True:
            query = {'list-type': '2', 'prefix': prefix, 'max-keys': '1000'}
            if token:
                query['continuation-token'] = token
            _, body = self.request('GET', '', query=query)
            root = ElementTree.fromstring(body)
            space = root.tag[:root.tag.index('}') + 1] if root.tag.startswith('{') else ''
            for item in root.iter(space + 'Contents'):
                keys.append({'key': item.findtext(space + 'Key'),
                             'size': int(item.findtext(space + 'Size') or 0)})
            token = root.findtext(space + 'NextContinuationToken')
            if (root.findtext(space + 'IsTruncated') or 'false') != 'true' or not token:
                return keys


def write_status(path, data):
    temporary = path.with_name('.' + path.name + '.' + str(os.getpid()) + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(data, output)
        output.write('\n')
    os.replace(temporary, path)


def read_status(path):
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def recipient(root):
    value = (root / 'secrets' / 'backup-recipient.txt').read_text().strip()
    if not re.fullmatch(r'age1[0-9a-z]{58}', value):
        raise OffsiteError('Invalid backup recipient')
    return value


def upload_dump(settings, root, dump, s3=None):
    """Uploads dump, manifest, then .sha256 last (the completion marker of a copy)."""
    backups = root / 'backups'
    status_path = backups / 'offsite-status.json'
    previous = read_status(status_path)
    if not settings['enabled']:
        write_status(status_path, {'enabled': False, 'lastAttemptAt': utc(), 'ok': True})
        return 0
    dump = Path(dump)
    if dump.parent.resolve() != backups.resolve() or not DUMP.fullmatch(dump.name):
        raise OffsiteError('upload expects a cloud-*.dump.age file in the backups directory')
    stamp = dump.name[len('cloud-'):-len('.dump.age')]
    manifest = backups / ('cloud-' + stamp + '.manifest.json.age')
    checksum = Path(str(dump) + '.sha256')
    status = {'enabled': True, 'lastAttemptAt': utc(), 'ok': False,
              'lastSuccessAt': previous.get('lastSuccessAt'), 'object': None, 'sizeBytes': None}
    try:
        s3 = s3 or S3(settings)
        size = s3.put_file(s3.key('dumps', dump.name), dump)
        if manifest.is_file():
            s3.put_file(s3.key('dumps', manifest.name), manifest)
        s3.put_file(s3.key('dumps', checksum.name), checksum)
        status.update(ok=True, lastSuccessAt=utc(), object=s3.key('dumps', dump.name), sizeBytes=size)
        return 0
    finally:
        write_status(status_path, status)


def docker(*args, timeout=60, **kwargs):
    return subprocess.run(['docker', *args], timeout=timeout, **kwargs)


def encrypt_stream(producer, destination, recipient_value, timeout=3600):
    """`producer` stdout -> gzip -> age -> private file, streamed without plaintext on disk."""
    with open(destination, 'wb') as output:
        source = subprocess.Popen(producer, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        age = subprocess.Popen(['age', '-r', recipient_value], stdin=subprocess.PIPE, stdout=output)
        try:
            with gzip.GzipFile(fileobj=age.stdin, mode='wb', mtime=0) as archive:
                shutil.copyfileobj(source.stdout, archive, 1 << 20)
            age.stdin.close()
            produced, encrypted = source.wait(timeout), age.wait(timeout)
        except (OSError, subprocess.TimeoutExpired):
            source.kill()
            age.kill()
            raise OffsiteError('encryption pipeline failed')
        finally:
            source.stdout.close()
    if produced != 0:
        raise OffsiteError('source command failed')
    if encrypted != 0 or os.path.getsize(destination) == 0:
        raise OffsiteError('age encryption failed')


def ship_wal(settings, root, s3=None, now=time.time):
    """Encrypts and uploads every archived WAL file, then removes it from the archive directory.

    Postgres writes the archive inside its own volume (compose.pitr.yaml); files are read and
    removed only through `docker exec` as the postgres user, never changed in place.
    """
    status_path = root / 'backups' / 'wal-status.json'
    status = read_status(status_path)
    if not settings['pitr']:
        return 0
    status.update(checkedAt=utc(now()), ok=False)
    pending = []
    try:
        listing = docker('exec', settings['container'], 'find', settings['archive'], '-maxdepth', '1',
                         '-type', 'f', capture_output=True, text=True)
        if listing.returncode != 0:
            raise OffsiteError('cannot list the WAL archive')
        # Names sort in WAL order; temporary copies (".name.tmp") never match.
        pending = sorted(name for name in (path.rsplit('/', 1)[-1] for path in listing.stdout.split())
                         if WAL_NAME.fullmatch(name))
        s3 = s3 or S3(settings)
        target = recipient(root)
        for index, name in enumerate(pending):
            source = settings['archive'] + '/' + name
            with tempfile.TemporaryDirectory(prefix='pickchick-wal-') as directory:
                encrypted = Path(directory, name + '.gz.age')
                encrypt_stream(['docker', 'exec', settings['container'], 'cat', source], encrypted, target,
                               timeout=300)
                s3.put_file(s3.key('wal', name + '.gz.age'), encrypted)
            removed = docker('exec', settings['container'], 'rm', '-f', source, capture_output=True)
            if removed.returncode != 0:
                raise OffsiteError('cannot remove a shipped WAL file')
            status['lastShippedAt'] = utc(now())
            status['lastSegment'] = name
            pending[index] = None
        status['ok'] = True
        return 0
    finally:
        remaining = [name for name in pending if name]
        status['pending'] = len(remaining)
        if remaining:
            status['oldestPendingAt'] = status.get('oldestPendingAt') or utc(now())
        else:
            status.pop('oldestPendingAt', None)
        write_status(status_path, status)


def base_backup(settings, root, s3=None, now=time.time):
    """Physical base backup for PITR: pg_basebackup tar (WAL included) -> gzip -> age -> upload."""
    if not settings['pitr']:
        return 0
    s3 = s3 or S3(settings)
    target = recipient(root)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(now()))
    with tempfile.TemporaryDirectory(prefix='pickchick-base-') as directory:
        encrypted = Path(directory, 'base.tar.gz.age')
        encrypt_stream(['docker', 'exec', settings['container'], 'pg_basebackup', '-U', 'postgres', '-D', '-',
                        '-F', 't', '-X', 'fetch', '--checkpoint=fast'], encrypted, target)
        s3.put_file(s3.key('base', 'base-' + stamp + '.tar.gz.age'), encrypted)
    with open(root / 'backups' / '.wal.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        status_path = root / 'backups' / 'wal-status.json'
        status = read_status(status_path)
        status['lastBaseBackupAt'] = utc(now())
        write_status(status_path, status)
    return 0


def pitr_sql(mode, archive=DEFAULTS['BACKUP_WAL_ARCHIVE_DIR'], timeout_seconds=60):
    """WAL archiving lives in postgresql.auto.conf (ALTER SYSTEM) inside the data volume, so
    compose recreations by later releases keep it. archive_mode needs one cloud-db restart.

    archive_command copies each finished segment into the archive directory through a temporary
    name and fsyncs it; a segment that is already there counts as archived only if identical.
    """
    if not re.fullmatch(r'/[A-Za-z0-9._/-]{1,200}', archive):
        raise OffsiteError('BACKUP_WAL_ARCHIVE_DIR')
    if mode == 'enable':
        command = ('mkdir -p {d} && if [ -f {d}/%f ]; then cmp -s %p {d}/%f; else cp %p {d}/.%f.tmp && '
                   'sync {d}/.%f.tmp && mv {d}/.%f.tmp {d}/%f; fi').format(d=archive)
        return '\n'.join([
            "ALTER SYSTEM SET archive_mode = 'on';",
            "ALTER SYSTEM SET archive_timeout = '" + str(int(timeout_seconds)) + "s';",
            "ALTER SYSTEM SET archive_command = '" + command + "';",
            'SELECT pg_reload_conf();'])
    if mode == 'disable':
        # '/bin/true' first: WAL must not pile up in pg_wal until the restart turns archiving off.
        return '\n'.join([
            "ALTER SYSTEM SET archive_command = '/bin/true';",
            'ALTER SYSTEM RESET archive_timeout;',
            'ALTER SYSTEM RESET archive_mode;',
            'SELECT pg_reload_conf();'])
    raise OffsiteError('usage: pitr-sql enable|disable')


def main(argv, root=ROOT):
    os.umask(0o077)
    if argv[:1] == ['pitr-sql'] and len(argv) == 2:
        print(pitr_sql(argv[1]))
        return 0
    if not argv or argv[0] not in ('upload', 'ship-wal', 'base-backup', 'list', 'fetch'):
        raise OffsiteError('usage: upload <dump> | ship-wal | base-backup | list <prefix> | fetch <key> <file>'
                           ' | pitr-sql enable|disable')
    env_file = Path(os.environ.get('BACKUP_OFFSITE_ENV_FILE', root / 'secrets' / 'backup-offsite.env'))
    settings = parse_settings(private_text(env_file))
    command = argv[0]
    if command == 'upload' and len(argv) == 2:
        return upload_dump(settings, root, argv[1])
    if command in ('list', 'fetch') and not settings['enabled']:
        raise OffsiteError('BACKUP_OFFSITE_ENABLED')
    if command == 'list' and len(argv) == 2 and KEY.fullmatch(argv[1]):
        for item in S3(settings).list(argv[1]):
            print(json.dumps(item))
        return 0
    if command == 'fetch' and len(argv) == 3:
        if not KEY.fullmatch(argv[1]):
            raise OffsiteError('object key')
        S3(settings).get_file(argv[1], argv[2])
        return 0
    if command in ('ship-wal', 'base-backup') and len(argv) == 1:
        (root / 'backups').mkdir(mode=0o700, exist_ok=True)
        if command == 'base-backup':
            return base_backup(settings, root)
        with open(root / 'backups' / '.wal.lock', 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0
            return ship_wal(settings, root)
    raise OffsiteError('usage: wrong arguments for ' + command)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except OffsiteError as error:
        print(json.dumps({'event': 'backup_offsite_failed', 'reason': str(error)[:160]}), file=sys.stderr)
        sys.exit(1)
    except Exception as error:  # noqa: BLE001 - tracebacks could carry paths or headers
        print(json.dumps({'event': 'backup_offsite_failed', 'reason': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
