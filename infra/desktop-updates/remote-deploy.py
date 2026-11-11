#!/usr/bin/env python3
"""Desktop update feed of PickChick POS and Kitchen on the existing PickChick VPS.

  inspect   read-only: what is installed and published, and the values the other modes expect
  install   once: static feed container, gateway route /desktop-updates/ and the first feed
  publish   a new version: files and one symlink; no container is restarted
  withdraw  point the feed back at a release that was already published

Without --apply every mode only checks. The public gateway restarts in `install` only.
No database, API, credential, payment setting or neighbouring service is changed.
The shared release lock stays behind only with `uncertain` or `rollback_needs_review`: a refusal,
also one after the lock was taken, and a confirmed rollback give it back. A step that changed
something prints how it ended on stdout, also when an error line on stderr follows.
Ctrl+C and `kill` are answered once: by a refusal before the first change, by the way back after it.
Procedure: docs/operations/desktop-updates.md.
"""
import argparse
from contextlib import contextmanager, suppress
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('desktop_updates_base', HERE.parent / 'roadmap/remote-deploy.py')
b = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(b)

SIDECAR = 'pickchick-desktop-updates'
# The base helpers let exactly one container besides the gateway differ; here it is the feed.
b.SERVICE = SIDECAR
NETWORK = 'pickchick-desktop-updates_ingress'
NETWORK_KEY = 'desktop_updates_ingress'
FEED_ORIGIN = 'https://api.pickchick.kz'
PREFIX = '/desktop-updates'
# The same names the installed programs accept (apps/pos-desktop/updater.mjs).
APPS = {'pos': 'PickChick-POS-Setup-', 'kitchen': 'PickChick-Kitchen-Setup-'}
NUMBER = '(0|[1-9][0-9]?[0-9]?[0-9]?)'
VERSION = NUMBER + r'\.' + NUMBER + r'\.' + NUMBER
# No braces: the same text is a Caddy path_regexp below and in sidecar.Caddyfile.
PATHS = ('^' + PREFIX + '/(' + '|'.join(
    app + r'/(latest\.json|' + prefix + VERSION + r'-x64\.exe)' for app, prefix in APPS.items()) + ')$')
MIN_INSTALLER_BYTES = 1_000_000
MAX_INSTALLER_BYTES = 400 * 1024 * 1024
MAX_MANIFEST_BYTES = 4096
# The installed program asks for the installer in pieces of this size.
CHUNK_BYTES = 4 * 1024 * 1024
RESERVE_BYTES = 2 * 1024 * 1024 * 1024
RELEASE_NAME = '[a-z0-9][a-z0-9.-]{0,79}'
PACKAGE_FILES = {'infra/desktop-updates/remote-deploy.py', 'infra/desktop-updates/compose.yaml',
                 'infra/desktop-updates/sidecar.Caddyfile', 'infra/roadmap/remote-deploy.py'}
START = '\t# BEGIN PICKCHICK DESKTOP UPDATES\n'
END = '\t# END PICKCHICK DESKTOP UPDATES\n'
ROUTE = START + '''\t@desktop_updates {
\t\tmethod GET HEAD
\t\tpath_regexp desktop_updates ''' + PATHS + '''
\t}
\thandle @desktop_updates {
\t\treverse_proxy ''' + SIDECAR + ''':8080 {
\t\t\theader_up -Authorization
\t\t\theader_up -Cookie
\t\t\theader_up -X-Device-Id
\t\t\ttransport http {
\t\t\t\tdial_timeout 2s
\t\t\t\tresponse_header_timeout 5s
\t\t\t}
\t\t}
\t}
''' + END

require = b.require


class Untouched(RuntimeError):
    """A refusal after the lock was taken and before the first change."""


# Stop requests of an --apply run: whether one is answered right now, and one that waits.
STOP = {'held': False, 'noted': None}
# The request stop() raised for, until the exception has reached the step. An exception raised
# while a finalizer runs (a closed HTTP answer, a closed file) is dropped by Python.
RAISED = []


def stop(number, frame=None):
    """Ctrl+C and `kill`: answered once, and only where the step can answer.

    Before the first change the answer is a refusal, on the way there it is the way back. While
    the lock is taken or given back, between those stretches and on the way back itself a request
    is only noted: a way back that is cut off leaves the server half way with nobody to finish it.
    """
    if STOP['held']:
        STOP['noted'] = number
        return
    STOP.update(held=True, noted=None)
    RAISED[:] = [number]
    answer(number)


def answer(number):
    if number == signal.SIGINT:
        raise KeyboardInterrupt
    raise SystemExit(128 + number)


@contextmanager
def interruptible():
    """A stretch where a stop request is answered at once, also one that was noted before it."""
    try:
        RAISED.clear()
        # From this statement on the handler answers by itself, so the note cannot change under us.
        STOP['held'] = False
        noted, STOP['noted'] = STOP['noted'], None
        if noted is not None:
            stop(noted)
        yield
    except BaseException:
        # Whatever ends the stretch, the request (if any) has been answered by it.
        RAISED.clear()
        raise
    finally:
        STOP['held'] = True
    if RAISED:
        # The answer was lost on the way: the stretch ends with it all the same.
        answer(RAISED.pop())


def run(command, timeout=90):
    """The base helper's `run`, with the command in a session of its own.

    A Ctrl+C typed in a terminal goes to every process of the foreground group, and the way back
    must not lose its Docker command to it. And a command this process gives up on (a stop
    request, a timeout) is ended together with its helpers, the Compose plugin of `docker` among
    them, so that none of them keeps working on the server behind the way back. What the Docker
    Engine was already asked to do goes on; the way back reckons with that.
    """
    answers = not STOP['held']
    # A stop request that comes while the command is being started waits until the command can
    # be ended with it: answered in between, it would leave the command at work with no owner.
    STOP['held'] = True
    try:
        process = subprocess.Popen(command, text=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
    except BaseException:
        STOP['held'] = not answers
        raise
    with process:
        try:
            if answers:
                STOP['held'] = False
                noted, STOP['noted'] = STOP['noted'], None
                if noted is not None:
                    stop(noted)
            output = process.communicate(timeout=timeout)[0]
        except BaseException as error:
            with suppress(OSError):
                os.killpg(process.pid, signal.SIGKILL)
            if isinstance(error, subprocess.TimeoutExpired):
                raise b.Uncertain('Command timed out; inspect Docker before any retry') from None
            raise
    require(process.returncode == 0, 'Command failed: ' + command[0] + ' (output withheld)')
    return output.strip()


# Every Docker command of this script and of the base helpers it calls.
b.run = run


def containers():
    """Every container of the host except one-off Compose jobs (`docker compose run`).

    Such a job comes and goes while a step runs and is no service: the server starts one every
    15 minutes (infra/staging/identity-cleanup-cron.sh). A container that is gone between the
    listing and its inspection is listed again, so only a container that exists has to answer.
    """
    for attempt in range(3):
        names = set(b.run(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines())
        names -= set(b.run(['docker', 'ps', '-a', '--filter', 'label=com.docker.compose.oneoff=True',
                            '--format', '{{.Names}}']).splitlines())
        try:
            return {name: b.run(['docker', 'inspect', '--format',
                                 '{{.Id}}|{{.Image}}|{{.State.StartedAt}}', name]).split('|')
                    for name in sorted(names)}
        except b.Uncertain:
            raise
        except RuntimeError:
            if attempt == 2:
                raise


# b.baseline and b.unchanged compare the same snapshot.
b.containers = containers


@contextmanager
def locked(sha, action, release, journal):
    """The shared release lock under this step's own name, with the journal the step will write.

    Untouched means the server is as it was: the lock is given back and the step can be repeated.
    Any other exception keeps the lock, as the base helper does. A lock that names a journal
    which does not exist was left by a process that ended before its first change.
    """
    refusal = None
    lock_is_free()
    # From here to the end of the step a stop request waits for a stretch that can answer it.
    STOP.update(held=True, noted=None)
    with b.lock(sha) as owner:
        try:
            with before_any_change():
                owner.update(action='desktop-updates-' + action, feed_release=release, journal=str(journal))
                replace_json(b.LOCK / 'owner.json', owner)
            yield
        except Untouched as error:
            refusal = error
            # A refusal leaves no journal: the first line may have been written just before a stop.
            with suppress(OSError):
                journal.unlink()
    if refusal is not None:
        raise RuntimeError(str(refusal) + '; nothing was changed and the release lock is free')


@contextmanager
def before_any_change():
    """Checks between taking the lock and the first change; an interruption here changes nothing either."""
    try:
        with interruptible():
            yield
    except BaseException as error:
        text = str(error) if isinstance(error, Exception) and str(error) else 'Interrupted: ' + type(error).__name__
        raise Untouched(text) from None


def lock_is_free():
    require(not b.LOCK.exists(), 'The shared release lock is held: another release is running or one '
            'was left for review (inspect prints its owner)')


def survive_the_terminal():
    """The way back lives in this process: a closed terminal must not end an --apply run half way,
    and a stop request is answered by the step itself (stop())."""
    STOP.update(held=False, noted=None)
    if hasattr(signal, 'SIGHUP'):
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
    for number in (signal.SIGINT, signal.SIGTERM):
        signal.signal(number, stop)


def state():
    return b.ROOT / 'desktop-updates'


def replace_json(path, value):
    """The file changes whole or not at all: a process stopped while it writes leaves the previous content."""
    temporary = path.with_name('.' + path.name + '.tmp')
    try:
        b.save(temporary, value)
        temporary.replace(path)
    except BaseException:
        with suppress(OSError):
            temporary.unlink()
        raise


def open_journal(journal, outcome, phase):
    """The first line of the journal is a condition of the step.

    The journal and the lock are all that is left of a run whose process is killed, so a server
    where the journal cannot be written is refused while nothing is changed yet.
    """
    outcome.update(phase=phase, journal=str(journal))
    try:
        replace_json(journal, outcome)
    except OSError as error:
        raise RuntimeError('The journal of the step cannot be written: ' + type(error).__name__) from None


def record(journal, outcome):
    """After the first change the journal decides only once more, in the line before devices can
    be offered the release (the step checks `journal_not_written` there). Any other write that
    fails is named in the answer (the file then holds an earlier state), and the step ends the
    way it would have ended."""
    outcome.pop('journal_not_written', None)
    try:
        replace_json(journal, outcome)
    except OSError as error:
        outcome['journal_not_written'] = type(error).__name__


def reached(journal, outcome, phase):
    """The journal names how far a run came, also when the process was killed there."""
    outcome['phase'] = phase
    record(journal, outcome)


def say(outcome):
    """The answer of a step on stdout. With the terminal gone it is still in the journal."""
    try:
        print(json.dumps(outcome), flush=True)
    except (OSError, ValueError):
        pass


@contextmanager
def told(outcome):
    """A step that ends with an error after its first change says itself how it ended.

    The error line alone reads like a refusal, while `uncertain` and `rollback_needs_review` leave
    the shared lock behind and wait for a person.
    """
    try:
        yield
    except BaseException:
        if outcome['status'] != 'preparing':
            say(outcome)
        raise


def way_back_begins(journal, outcome, error):
    """The journal and one line on stderr say that the way back runs.

    It can take minutes and prints nothing else before its verdict, and a process killed in it
    must not read like one that was killed on the way there.
    """
    outcome.update(status='rolling_back', reason=type(error).__name__, detail=str(error))
    record(journal, outcome)
    try:
        # stdout carries the answer of the step and nothing else, also with stderr closed.
        if sys.stderr is not None:
            print(json.dumps({'status': 'rolling_back', 'reason': outcome['reason'],
                              'journal': outcome['journal']}), file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


def feed_root():
    return state() / 'feed'


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def plain(path, directory=False):
    return not path.is_symlink() and (path.is_dir() if directory else path.is_file())


def version_key(version):
    return tuple(int(part) for part in version.split('.'))


def read_manifest(text, app):
    """latest.json as the feed builder writes it; nothing the installed program refuses passes.

    Stricter than the program in two places, on purpose: it would take `bytes` written as 1.2e8
    and `apply: null`, the builder (scripts/desktop-update-feed.mjs) writes neither.
    """
    require(len(text.encode()) <= MAX_MANIFEST_BYTES, 'Manifest is too large: ' + app)
    try:
        value = json.loads(text)
    except ValueError:
        raise RuntimeError('Manifest is not JSON: ' + app) from None
    keys = {'app', 'version', 'file', 'sha256', 'bytes'}
    require(isinstance(value, dict) and set(value) in (keys, keys | {'apply'}), 'Manifest keys differ: ' + app)
    version, size = value['version'], value['bytes']
    require(type(size) is int and value.get('apply', 'idle') in ('idle', 'now'),
            'The feed builder does not write such a manifest (bytes, apply): ' + app)
    require(value['app'] == app and isinstance(version, str) and re.fullmatch(VERSION, version) and
            value['file'] == APPS[app] + version + '-x64.exe' and
            isinstance(value['sha256'], str) and re.fullmatch('[a-f0-9]{64}', value['sha256']) and
            MIN_INSTALLER_BYTES <= size <= MAX_INSTALLER_BYTES,
            'The installed program would refuse this manifest: ' + app)
    return value


def verify_app(directory, app):
    """One application of a feed: latest.json and the installer it names, nothing else."""
    require(plain(directory, directory=True), 'Feed application directory is missing: ' + app)
    manifest_path = directory / 'latest.json'
    require(plain(manifest_path) and manifest_path.stat().st_size <= MAX_MANIFEST_BYTES,
            'latest.json is missing: ' + app)
    manifest = read_manifest(manifest_path.read_text(), app)
    require(sorted(path.name for path in directory.iterdir()) == sorted(['latest.json', manifest['file']]),
            'Feed directory must hold exactly latest.json and its installer: ' + app)
    installer = directory / manifest['file']
    require(plain(installer) and installer.stat().st_size == manifest['bytes'],
            'Installer size differs from latest.json: ' + app)
    with installer.open('rb') as source:
        require(source.read(2) == b'MZ', 'Installer is not a Windows executable: ' + app)
    require(file_sha256(installer) == manifest['sha256'], 'Installer hash differs from latest.json: ' + app)
    return manifest


def verify_feed(feed, expected):
    """A feed as CI lays it out (pos/ and/or kitchen/); `expected` is what the operator read in the CI run."""
    require(plain(feed, directory=True), 'Feed must be an extracted directory')
    names = sorted(path.name for path in feed.iterdir())
    require(names and set(names) <= set(APPS), 'Feed may hold only pos/ and kitchen/')
    require(set(names) == set(expected),
            'Give --expected-<app>-sha256 for exactly the applications in the feed')
    manifests = {}
    for app in names:
        manifests[app] = verify_app(feed / app, app)
        require(manifests[app]['sha256'] == expected[app],
                'Installer is not the one the operator named: ' + app)
    return manifests


def release_name(manifests):
    return '-'.join(app + '-' + manifests[app]['version'] for app in sorted(manifests))


def published():
    """The release the feed points at and its manifests; (None, {}) before the first install."""
    link = feed_root() / 'current'
    if not link.is_symlink():
        require(not link.exists(), 'Feed pointer is not a symlink')
        return None, {}
    target = os.readlink(link)
    require(re.fullmatch('releases/' + RELEASE_NAME, target), 'Feed pointer leaves the releases directory')
    release = feed_root() / target
    require(plain(release, directory=True), 'Published feed release is missing')
    names = sorted(path.name for path in release.iterdir())
    require(names and set(names) <= set(APPS), 'Published feed release holds unexpected entries')
    manifests = {app: verify_app(release / app, app) for app in names}
    require(release.name == release_name(manifests), 'Published feed release name differs from its content')
    return release, manifests


def plan(new, old):
    """Per application: taken from the new feed or carried over. Never a lower or an equal version."""
    result = {}
    for app in sorted(set(new) | set(old)):
        if app in new and app in old:
            require(version_key(new[app]['version']) > version_key(old[app]['version']),
                    'Version must be higher than the published ' + old[app]['version'] + ': ' + app)
        result[app] = 'new' if app in new else 'carried'
    return result


def add_route(source):
    require(source.count(START) == source.count(END) <= 1, 'Invalid desktop update markers')
    if START in source:
        require(source.count(ROUTE) == 1, 'Installed desktop update route differs; review manually')
        return source
    require(PREFIX not in source and SIDECAR not in source,
            'Unrecognized desktop update route; review manually')
    location = source.rfind('\n\thandle {')
    require(location >= 0, 'Gateway fallback not found')
    return source[:location] + '\n' + ROUTE + source[location:]


def gateway_candidate(old, config, web):
    """The installed gateway definition with the two mount sources moved and the feed network added."""
    result = json.loads(json.dumps(old))
    require(set(result['services']) == {'gateway'}, 'Only the gateway service is expected')
    gateway = result['services']['gateway']
    volumes = gateway['volumes']
    require(len(volumes) == 2 and {v['target'] for v in volumes} == {'/etc/caddy/Caddyfile', '/srv/public'}
            and all(v.get('read_only') for v in volumes), 'Gateway mount profile changed')
    for volume in volumes:
        volume['source'] = str(config if volume['target'] == '/etc/caddy/Caddyfile' else web)
    networks = gateway.setdefault('networks', {})
    require(isinstance(networks, dict) and isinstance(result.setdefault('networks', {}), dict),
            'Gateway networks are not in the normalized form')
    networks[NETWORK_KEY] = None
    result['networks'][NETWORK_KEY] = {'name': NETWORK, 'external': True}
    return result


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url, headers=None, method='GET', limit=CHUNK_BYTES):
    """One request without following redirects: the installed program refuses them too."""
    request = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=45) as response:
            data = response.read(limit + 1)
            require(len(data) <= limit, 'Response is larger than expected: ' + url)
            return response.status, data, response.headers
    except urllib.error.HTTPError as error:
        # Closed here and not by a finalizer, where an exception (a stop request) would be dropped.
        with suppress(OSError):
            error.close()
        return error.code, b'', error.headers
    except http.client.HTTPException as error:
        raise RuntimeError('The answer broke off (' + type(error).__name__ + '): ' + url) from None


def served_manifest(origin, app):
    """latest.json as a device gets it: a plain 200 that no cache may keep, or None."""
    status, body, headers = fetch(origin + PREFIX + '/' + app + '/latest.json', limit=MAX_MANIFEST_BYTES)
    if status != 200 or 'no-store' not in (headers.get('Cache-Control') or ''):
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


def verify_served(origin, manifests, installers=True):
    """What a device gets: the manifest, then the installer in the same pieces the program asks for."""
    for app, manifest in manifests.items():
        base = origin + PREFIX + '/' + app + '/'
        require(served_manifest(origin, app) == manifest, 'Served manifest differs: ' + app)
        if not installers:
            continue
        total, offset, digest = manifest['bytes'], 0, hashlib.sha256()
        status, _, headers = fetch(base + manifest['file'], method='HEAD')
        require(status == 200 and headers.get('Content-Length') == str(total),
                'Served installer size differs: ' + app)
        while offset < total:
            last = min(offset + CHUNK_BYTES, total) - 1
            status, data, headers = fetch(base + manifest['file'], {'Range': 'bytes=%d-%d' % (offset, last)})
            require(status == 206 and len(data) == last - offset + 1 and
                    headers.get('Content-Range') == 'bytes %d-%d/%d' % (offset, last, total),
                    'Served installer piece differs: ' + app)
            digest.update(data)
            offset = last + 1
        require(digest.hexdigest() == manifest['sha256'], 'Served installer hash differs: ' + app)


def verify_refusals(origin, manifests):
    """Only the two files of each application answer; no listing, no other name, no write."""
    app = sorted(manifests)[0]
    here = PREFIX + '/' + app + '/'
    for path in [PREFIX, PREFIX + '/', here, here + manifests[app]['file'] + '.blockmap',
                 here + APPS[app] + '0.0.0-x64.exe', here + 'latest.json.tmp',
                 PREFIX + '/current/' + app + '/latest.json', PREFIX + '/releases/']:
        require(fetch(origin + path)[0] == 404, 'Feed answers outside its two files: ' + path)
    require(fetch(origin + here + 'latest.json', method='POST')[0] in (404, 405),
            'Feed accepts a write method')


def alias_reaches_gateway():
    """Read-only: whatever terminates HTTPS for the feed host hands the request to our gateway."""
    try:
        status, body, _ = fetch(FEED_ORIGIN + '/health/live', limit=4096)
        answer = json.loads(body)
        return status == 200 and isinstance(answer, dict) and answer.get('service') == 'pickchick-public-gateway'
    except (OSError, ValueError, RuntimeError):
        # Whatever answers there in another way is not the gateway; inspect still prints its report.
        return False


def sidecar_compose(release):
    return b.compose(release / 'compose.yaml', release / 'sidecar.env')


def sidecar_mounts():
    mounts = json.loads(b.run(['docker', 'inspect', '--format', '{{json .Mounts}}', SIDECAR]))
    return {mount['Destination']: mount['Source'] for mount in mounts}


def sidecar_serves(manifests):
    for app, manifest in manifests.items():
        raw = b.run(['docker', 'exec', SIDECAR, 'wget', '-q', '-O', '-',
                     'http://127.0.0.1:8080' + PREFIX + '/' + app + '/latest.json'])
        require(json.loads(raw) == manifest, 'Feed container serves another manifest: ' + app)


def validate_caddy(image, config):
    b.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
           '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
           '--tmpfs', '/tmp', '--tmpfs', '/config', '--tmpfs', '/data',
           '-v', str(config) + ':/etc/caddy/Caddyfile:ro', image,
           'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])


def tree_bytes(path):
    return sum(item.lstat().st_size for item in path.rglob('*') if plain(item))


def require_space(needed):
    free = shutil.disk_usage(b.ROOT).free
    require(free >= needed + RESERVE_BYTES,
            'Not enough free disk space: %d MB free, %d MB needed with the reserve' %
            (free // 2**20, (needed + RESERVE_BYTES) // 2**20))


def copy_release(sources, target):
    """Appears under its final name only when every file is there and hashes as its manifest says.

    Until then the copy carries the name every leftover of a failed run has. Whatever cuts it
    off, a killed process included, nothing is deleted, nothing stays hidden from `ls` and
    nothing looks like a release.
    """
    staging = target.with_name(target.name + '.FAILED-' + uuid.uuid4().hex)
    staging.mkdir(parents=True)
    staging.chmod(0o755)
    manifests = {}
    for app, source in sources.items():
        (staging / app).mkdir()
        (staging / app).chmod(0o755)
        for item in sorted(source.iterdir()):
            shutil.copyfile(item, staging / app / item.name)
            (staging / app / item.name).chmod(0o644)
        manifests[app] = verify_app(staging / app, app)
    staging.rename(target)
    return manifests


def release_on_disk(directory):
    """The builds of a release directory, hashed: what `withdraw --to` it would publish."""
    require(plain(directory, directory=True), 'Feed release is not a directory: ' + directory.name)
    names = sorted(path.name for path in directory.iterdir())
    require(names and set(names) <= set(APPS), 'Feed release content differs: ' + directory.name)
    manifests = {app: verify_app(directory / app, app) for app in names}
    require(directory.name == release_name(manifests), 'Feed release content differs: ' + directory.name)
    return manifests


# The journal phases in which the feed pointer may already lead devices to the release of a run.
OFFERED = {'switch', 'switch_gateway', 'verify', 'publish_pointers'}


def offered_builds():
    """Every build devices may have been offered: {(app, version): {sha256: release name}}.

    A version number belongs to the bytes that went out under it: a device that installed them
    never takes other bytes of the same number. Two memories, because either can be gone: the
    release directories (a release of a package that wrote no `builds` yet has nothing else) and
    the journals of the runs that moved the pointer, whether they stayed or went back (an
    operator may remove an old or a bad directory, nobody removes a journal).
    """
    known = {}

    def note(app, version, sha256, release):
        known.setdefault((app, version), {}).setdefault(sha256, release)

    releases = feed_root() / 'releases'
    for directory in sorted(releases.iterdir()) if plain(releases, directory=True) else []:
        if not re.fullmatch(RELEASE_NAME, directory.name) or not plain(directory, directory=True):
            continue
        for app in APPS:
            path = directory / app / 'latest.json'
            try:
                require(plain(path) and path.stat().st_size <= MAX_MANIFEST_BYTES, 'No manifest')
                manifest = read_manifest(path.read_text(), app)
            except (RuntimeError, OSError, ValueError):
                continue
            note(app, manifest['version'], manifest['sha256'], directory.name)
    journals = state() / 'deployments'
    for path in sorted(journals.glob('*.json')) if plain(journals, directory=True) else []:
        try:
            require(plain(path) and path.stat().st_size <= 64 * 1024, 'Not a journal')
            entry = json.loads(path.read_text())
            if entry['phase'] not in OFFERED:
                continue
            for app, build in entry['builds'].items():
                if app in APPS and re.fullmatch(VERSION, build['version']) and \
                        re.fullmatch('[a-f0-9]{64}', build['sha256']) and \
                        re.fullmatch(RELEASE_NAME, entry['feed_release']):
                    note(app, build['version'], build['sha256'], entry['feed_release'])
        except (RuntimeError, OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    return known


def builds(manifests):
    return {app: {'version': manifest['version'], 'sha256': manifest['sha256']}
            for app, manifest in manifests.items()}


def confirmed(check):
    """A way back is confirmed where the way there was checked: at the addresses devices and guests use.

    One failed attempt is no verdict: the gateway container may have been replaced once more a
    moment ago, and the proxy in front of the gateway is not under this lock.
    """
    for attempt in range(3):
        try:
            return check()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(3)


def back_as_before(probes):
    """After the way back of an install: the gateway answers as before and the feed path is gone."""
    for path, answer in probes.items():
        now = b.http(path)[:2]
        # The health answer is the gateway's own text; what the API says may change by itself.
        require(now == answer if path == '/health/live' else now[0] == answer[0],
                'Existing endpoint differs after rollback: ' + path)
    require(alias_reaches_gateway(), 'The feed host does not reach the gateway after rollback')
    for origin in (b.ORIGIN, FEED_ORIGIN):
        require(fetch(origin + PREFIX + '/pos/latest.json')[0] == 404,
                'The feed path still answers after rollback')


def set_aside(path):
    """A release of a rolled-back run keeps its bytes under another name, so the step can be repeated."""
    if path.exists() and not path.is_symlink():
        # Upper case: never mistaken for a release name by inspect or withdraw.
        path.rename(path.with_name(path.name + '.FAILED-' + uuid.uuid4().hex))


def verify_package(package, sha):
    require(plain(package, directory=True), 'Package must be an extracted directory')
    manifest = json.loads((package / 'desktop-updates-package.json').read_text())
    require(manifest.get('source_sha') == sha, 'Package source SHA mismatch')
    require(set(manifest.get('files', {})) == PACKAGE_FILES, 'Package file list differs')
    for name, expected in manifest['files'].items():
        target = package / name
        require(target.is_file() and not any(path.is_symlink() for path in [target, *target.parents]),
                'Package paths must be ordinary files')
        require(b.digest(target) == expected, 'Package file hash mismatch')
    require(Path(__file__).resolve() == (package / 'infra/desktop-updates/remote-deploy.py').resolve(),
            'Run the script of the package itself')
    return manifest


def installed(before):
    """Publish and withdraw work only on the layout `install` left behind."""
    current = b.pointer(b.ROOT / 'public-https/current')
    config = current / 'infra/public-staging/gateway.Caddyfile'
    require(config.read_text().count(ROUTE) == 1, 'Gateway has no desktop update route: run install first')
    require(b.gateway_mounts().get('/etc/caddy/Caddyfile') == str(config),
            'Gateway does not run the current public release')
    require(SIDECAR in before and
            b.run(['docker', 'inspect', '--format', '{{.State.Running}}', SIDECAR]) == 'true',
            'Feed container is not running')
    release = b.pointer(state() / 'sidecar/current')
    require(sidecar_mounts() == {'/etc/caddy/Caddyfile': str(release / 'sidecar.Caddyfile'),
                                 '/srv/feed': str(feed_root())}, 'Feed container mounts differ')


def lock_owner():
    """Which step holds the shared lock: the fields the scripts of this server write, nothing else.

    Most of them, this one included, write `action` and `sha`; the Kaspi worker releases write
    `operation`, the cabinet and domain releases write `task` and `source_sha`. The `id` is the
    handle that releases a lock and is never printed.
    """
    try:
        owner = json.loads((b.LOCK / 'owner.json').read_text())
        return {key: owner[key] for key in ('action', 'task', 'operation', 'sha', 'source_sha',
                                            'feed_release', 'journal') if isinstance(owner.get(key), str)}
    except (OSError, ValueError, AttributeError):
        return None


def inspect(a, expected):
    public = b.pointer(b.ROOT / 'public-https/current')
    config = public / 'infra/public-staging/gateway.Caddyfile'
    before = b.containers()
    release, manifests = published()
    releases = feed_root() / 'releases'
    names = sorted(path.name for path in releases.iterdir()) if releases.is_dir() else []
    report = {
        'status': 'inspected',
        'expected_public_release': str(public),
        'expected_api_release': str(b.pointer(b.ROOT / 'current')),
        'expected_gateway_sha256': b.digest(config),
        'gateway_route_installed': config.read_text().count(ROUTE) == 1,
        'feed_container': SIDECAR in before,
        'published_release': release.name if release else None,
        'published': {app: manifest['version'] for app, manifest in manifests.items()},
        'releases_on_disk': [name for name in names if re.fullmatch(RELEASE_NAME, name)],
        # What stopped runs left next to the releases: an operator removes it, a step never does.
        'feed_leftovers': [name for name in names if not re.fullmatch(RELEASE_NAME, name)],
        'feed_host_reaches_gateway': alias_reaches_gateway(),
        'free_disk_mb': shutil.disk_usage(b.ROOT).free // 2**20,
        'deployment_lock_present': b.LOCK.exists(),
        'deployment_lock_owner': lock_owner(),
    }
    if a.feed:
        new = verify_feed(a.feed, expected)
        steps = plan(new, manifests)
        final = {app: new.get(app, manifests.get(app)) for app in steps}
        report.update(feed={app: manifest['version'] for app, manifest in new.items()}, plan=steps,
                      next_release=release_name(final), next_step='publish' if release else 'install')
    print(json.dumps(report))
    return 0


def install(a, expected):
    sha = a.expected_source_sha
    require(re.fullmatch('[a-f0-9]{64}', a.expected_gateway_sha256 or ''), 'Expected gateway SHA-256')
    manifests = verify_feed(a.feed, expected)
    require(set(manifests) == set(APPS), 'The first feed must hold both pos/ and kitchen/')
    old_public, api, before = b.baseline(a)
    old_config = old_public / 'infra/public-staging/gateway.Caddyfile'
    require(START not in old_config.read_text(), 'Desktop update route is already installed: use publish')
    new_config = add_route(old_config.read_text())
    in_the_way = ([SIDECAR] if SIDECAR in before else []) + [
        str(link) for link in [feed_root() / 'current', state() / 'sidecar/current'] if os.path.lexists(link)]
    require(not in_the_way, 'A feed installation already exists: ' + ', '.join(in_the_way))
    require(alias_reaches_gateway(), 'The feed host does not reach the PickChick gateway')
    probes = {path: b.http(path)[:2] for path in ['/health/live', '/v1/capabilities']}
    require(probes['/health/live'][0] == 200, 'Gateway health failed before the change')
    for origin in (b.ORIGIN, FEED_ORIGIN):
        # Whatever stands in front of the gateway must not answer the feed path by itself.
        require(fetch(origin + PREFIX + '/pos/latest.json')[0] == 404, 'The feed path already answers')
    name = release_name(manifests)
    sidecar_release = state() / 'sidecar' / sha
    new_public = b.ROOT / 'public-https/releases' / sha
    feed_release = feed_root() / 'releases' / name

    def free():
        for path in [sidecar_release, new_public, feed_release]:
            require(not os.path.lexists(path), 'Immutable release already exists: ' + str(path) +
                    ' (left by a stopped run of this step: move it aside; made by another release: '
                    'take a later commit)')

    free()
    require_space(tree_bytes(old_public / 'infra/public-staging/public-web') + tree_bytes(a.feed))
    lock_is_free()
    others = [container for container in before if container not in (b.GATEWAY, SIDECAR)]
    outcome = {'action': 'install', 'source_sha': sha, 'feed_release': name,
               'published': {app: manifest['version'] for app, manifest in manifests.items()},
               'builds': builds(manifests)}
    if not a.apply:
        print(json.dumps({**outcome, 'status': 'inspected', 'validated': True, 'applied': False}))
        return 0
    outcome['status'] = 'preparing'
    journal = state() / 'deployments' / ('install-' + sha + '-' + uuid.uuid4().hex + '.json')
    touched_docker = started_sidecar = switched_gateway = False
    with told(outcome), locked(sha, 'install', name, journal):
        with before_any_change():
            require(b.baseline(a) == (old_public, api, before), 'Baseline drift after lock')
            free()
            open_journal(journal, outcome, 'prepare')
        try:
            with interruptible():
                for directory in [state(), feed_root(), feed_root() / 'releases']:
                    directory.mkdir(parents=True, exist_ok=True)
                    require(plain(directory, directory=True), 'State directory must not be a symlink')
                    directory.chmod(0o755)
                require(copy_release({app: a.feed / app for app in manifests}, feed_release) == manifests,
                        'Copied feed differs')
                b.switch(feed_root() / 'current', Path('releases') / name)
                candidate = new_public / 'infra/public-staging'
                candidate.mkdir(parents=True)
                shutil.copytree(old_public / 'infra/public-staging/public-web', candidate / 'public-web')
                public_manifest = b.public_files(new_public)
                require(public_manifest == b.public_files(old_public), 'Public copy differs')
                config = candidate / 'gateway.Caddyfile'
                config.write_text(new_config)
                config.chmod(0o644)
                old_compose = json.loads(b.run(b.compose(old_public / 'infra/public-staging/compose.yaml') +
                                               ['config', '--format', 'json']))
                new_compose = gateway_candidate(old_compose, config, candidate / 'public-web')
                b.save(candidate / 'compose.yaml', new_compose)
                image = new_compose['services']['gateway']['image']
                sidecar_release.mkdir(parents=True)
                for item in ['compose.yaml', 'sidecar.Caddyfile']:
                    shutil.copyfile(a.package / 'infra/desktop-updates' / item, sidecar_release / item)
                    (sidecar_release / item).chmod(0o644)
                # The image the gateway already runs: nothing is pulled during the step.
                (sidecar_release / 'sidecar.env').write_text(
                    'DESKTOP_UPDATES_IMAGE=' + image + '\n' +
                    'DESKTOP_UPDATES_CONFIG=' + str(sidecar_release / 'sidecar.Caddyfile') + '\n' +
                    'DESKTOP_UPDATES_FEED_DIR=' + str(feed_root()) + '\n')
                # Until here Docker was only read: a command that timed out left nothing behind.
                touched_docker = True
                validate_caddy(image, sidecar_release / 'sidecar.Caddyfile')
                validate_caddy(image, config)
                require(b.baseline(a) == (old_public, api, before), 'Baseline changed during prepare')
                reached(journal, outcome, 'start_feed_container')
                started_sidecar = True
                b.run(sidecar_compose(sidecar_release) +
                      ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'feed'], timeout=180)
                require(sidecar_mounts() == {'/etc/caddy/Caddyfile': str(sidecar_release / 'sidecar.Caddyfile'),
                                             '/srv/feed': str(feed_root())}, 'Feed container mounts differ')
                sidecar_serves(manifests)
                for path, answer in probes.items():
                    # The way back is confirmed against these answers, read before the lock: an
                    # answer that has changed by itself ends the step while the gateway is untouched.
                    require(b.http(path)[:2] == answer,
                            'Existing endpoint changed before the gateway was touched: ' + path)
                reached(journal, outcome, 'switch_gateway')
                require('journal_not_written' not in outcome,
                        'The journal cannot remember the release before it is offered: ' +
                        outcome.get('journal_not_written', ''))
                switched_gateway = True
                b.run(b.compose(candidate / 'compose.yaml') +
                      ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'gateway'], timeout=120)
                require(b.gateway_mounts() == {'/etc/caddy/Caddyfile': str(config),
                                               '/srv/public': str(candidate / 'public-web')},
                        'Candidate gateway mounts differ')
                reached(journal, outcome, 'verify')
                with b.ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(b.verify_public_asset, public_manifest['files'].items()))
                for path, answer in probes.items():
                    require(b.http(path)[:2] == answer, 'Existing endpoint changed: ' + path)
                verify_served(FEED_ORIGIN, manifests)
                verify_served(b.ORIGIN, manifests, installers=False)
                for origin in (FEED_ORIGIN, b.ORIGIN):
                    verify_refusals(origin, manifests)
                b.unchanged(before)
                require(b.pointer(b.ROOT / 'current') == api and
                        b.pointer(b.ROOT / 'public-https/current') == old_public, 'Pointer drift')
            # Every check has passed: from here a stop request no longer turns the step back.
            reached(journal, outcome, 'publish_pointers')
            b.switch(state() / 'sidecar/current', sidecar_release)
            b.switch(b.ROOT / 'public-https/current', new_public)
            outcome.update(status='deployed', public_release=str(new_public),
                           previous_public_release=str(old_public), gateway_sha256=b.digest(config),
                           unchanged_services=others)
            record(journal, outcome)
        except BaseException as error:
            if isinstance(error, b.Uncertain) and touched_docker:
                # A changing Docker command may still be at work: nothing is taken back blindly.
                outcome.update(status='uncertain', lock_retained=True, reason=type(error).__name__,
                               detail=str(error))
                record(journal, outcome)
                raise
            try:
                way_back_begins(journal, outcome, error)
                if switched_gateway:
                    old_gateway = b.compose(old_public / 'infra/public-staging/compose.yaml')
                    # A switch that was cut off leaves the gateway anywhere between its two
                    # definitions: the old container while Docker is still stopping it (`up` would
                    # find it running and change nothing, and a moment later it would be gone), a
                    # new one that was made and never started, both, or neither. So every container
                    # of the service goes, and one is made from the old definition.
                    b.run(old_gateway + ['rm', '--stop', '--force', 'gateway'], timeout=120)
                    b.run(old_gateway + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'gateway'],
                          timeout=120)
                if started_sidecar:
                    # Container and its own network only; the feed files stay on disk.
                    b.run(sidecar_compose(sidecar_release) + ['down', '--timeout', '15'], timeout=120)
                pointer = b.pointer(b.ROOT / 'public-https/current')
                require(pointer in (old_public, new_public), 'Foreign public pointer')
                if pointer == new_public:
                    b.switch(b.ROOT / 'public-https/current', old_public)
                for link in [state() / 'sidecar/current', feed_root() / 'current']:
                    if link.is_symlink():
                        link.unlink()
                for leftover in [new_public, sidecar_release, feed_release]:
                    set_aside(leftover)
                # The gateway container is a new one after the way there and back; its release is not.
                current, api_now, now = b.baseline(a)
                require(current == old_public and api_now == api and SIDECAR not in now,
                        'Baseline differs after rollback')
                b.unchanged(before)
                if switched_gateway:
                    confirmed(lambda: back_as_before(probes))
                outcome['status'] = 'rolled_back'
                record(journal, outcome)
            except BaseException as failure:
                outcome.update(status='rollback_needs_review', lock_retained=True,
                               reason=type(error).__name__, detail=str(error),
                               rollback_reason=type(failure).__name__, rollback_detail=str(failure))
                record(journal, outcome)
                raise RuntimeError('Rollback is not confirmed; deployment lock retained') from None
    say(outcome)
    return 0 if outcome['status'] == 'deployed' else 1


def move_pointer(a, action, name, sources, final, old_release, old):
    """Shared by publish and withdraw: one symlink moves, and it moves back unless devices see the result."""
    outcome = {'action': action, 'feed_release': name, 'previous_feed_release': old_release.name,
               'published': {app: manifest['version'] for app, manifest in final.items()},
               'builds': builds(final)}
    before = b.containers()
    installed(before)
    require(alias_reaches_gateway(), 'The feed host does not reach the PickChick gateway')
    verify_served(FEED_ORIGIN, old, installers=False)
    target = feed_root() / 'releases' / name
    if sources and os.path.lexists(target):
        # The name tells the versions only, so what `withdraw --to` it would publish is read first.
        try:
            there = release_on_disk(target)
        except (RuntimeError, OSError, ValueError) as error:
            raise RuntimeError(name + ' on the server is not a complete release (' +
                               (str(error) if isinstance(error, RuntimeError) else type(error).__name__) +
                               '): move it aside') from None
        raise RuntimeError(
            'These builds are already on the server as ' + name + ': withdraw --to it publishes them again'
            if there == final else
            'Other builds of the same versions are on the server as ' + name + ': raise the version')
    if sources:
        require_space(sum(tree_bytes(source) for source in sources.values()))
    lock_is_free()
    if not a.apply:
        print(json.dumps({**outcome, 'status': 'inspected', 'validated': True, 'applied': False}))
        return 0
    outcome['status'] = 'preparing'
    journal = state() / 'deployments' / (action + '-' + name + '-' + uuid.uuid4().hex + '.json')
    switched = False
    with told(outcome), locked(a.expected_source_sha, action, name, journal):
        with before_any_change():
            require(published() == (old_release, old) and b.containers() == before, 'Drift after lock')
            require(not sources or not os.path.lexists(target), 'Feed release appeared after the lock: ' + name)
            open_journal(journal, outcome, 'copy' if sources else 'switch')
        try:
            with interruptible():
                if sources:
                    require(copy_release(sources, target) == final, 'Copied feed differs')
                    reached(journal, outcome, 'switch')
                    # The journal remembers the builds devices may be offered from here on; the
                    # release directory is set aside if the step goes back.
                    require('journal_not_written' not in outcome,
                            'The journal cannot remember the release before it is offered: ' +
                            outcome.get('journal_not_written', ''))
                switched = True
                b.switch(feed_root() / 'current', Path('releases') / name)
                reached(journal, outcome, 'verify')
                verify_served(FEED_ORIGIN, final)
                verify_served(b.ORIGIN, final, installers=False)
                verify_refusals(FEED_ORIGIN, final)
                require(b.containers() == before, 'A container changed during a file-only step')
            # Every check has passed: from here a stop request no longer turns the step back.
            outcome['status'] = 'deployed'
            record(journal, outcome)
        except BaseException as error:
            try:
                way_back_begins(journal, outcome, error)
                if switched:
                    b.switch(feed_root() / 'current', Path('releases') / old_release.name)
                require(published() == (old_release, old), 'Feed pointer differs after rollback')
                confirmed(lambda: verify_served(FEED_ORIGIN, old, installers=False))
                if sources:
                    set_aside(target)
                outcome['status'] = 'rolled_back'
                record(journal, outcome)
            except BaseException as failure:
                outcome.update(status='rollback_needs_review', lock_retained=True,
                               reason=type(error).__name__, detail=str(error),
                               rollback_reason=type(failure).__name__, rollback_detail=str(failure))
                record(journal, outcome)
                raise RuntimeError('Rollback is not confirmed; deployment lock retained') from None
    say(outcome)
    return 0 if outcome['status'] == 'deployed' else 1


def current_release(a):
    old_release, old = published()
    require(old_release is not None, 'Nothing is published yet: run install')
    require(a.expected_current == old_release.name,
            'Published release is ' + old_release.name + ', not --expected-current')
    return old_release, old


def publish(a, expected):
    new = verify_feed(a.feed, expected)
    old_release, old = current_release(a)
    steps = plan(new, old)
    offered = offered_builds()
    for app, manifest in new.items():
        elsewhere = sorted(release for sha256, release in offered.get((app, manifest['version']), {}).items()
                           if sha256 != manifest['sha256'])
        if elsewhere:
            raise RuntimeError('Version ' + manifest['version'] + ' of ' + app + ' was offered to devices '
                               'with other bytes as ' + elsewhere[0] + ': raise the version')
    final = {app: new[app] if steps[app] == 'new' else old[app] for app in steps}
    sources = {app: (a.feed if steps[app] == 'new' else old_release) / app for app in steps}
    return move_pointer(a, 'publish', release_name(final), sources, final, old_release, old)


def withdraw(a):
    old_release, old = current_release(a)
    require(re.fullmatch(RELEASE_NAME, a.to or '') and a.to != old_release.name,
            'Name another published release in --to')
    target = feed_root() / 'releases' / a.to
    require(plain(target, directory=True), 'No such feed release: ' + a.to)
    return move_pointer(a, 'withdraw', a.to, None, release_on_disk(target), old_release, old)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode', choices=['inspect', 'install', 'publish', 'withdraw'])
    parser.add_argument('--feed', type=Path)
    parser.add_argument('--package', type=Path)
    for name in ['expected-source-sha', 'expected-public-release', 'expected-api-release',
                 'expected-gateway-sha256', 'expected-pos-sha256', 'expected-kitchen-sha256',
                 'expected-current', 'to']:
        parser.add_argument('--' + name)
    parser.add_argument('--apply', action='store_true')
    a = parser.parse_args(argv)
    signed = ['package', 'expected_source_sha']
    needs = {'inspect': [],
             'install': signed + ['feed', 'expected_public_release', 'expected_api_release',
                                  'expected_gateway_sha256'],
             'publish': signed + ['feed', 'expected_current'],
             'withdraw': signed + ['to', 'expected_current']}[a.mode]
    missing = [name for name in needs if getattr(a, name) is None]
    if missing or (a.mode == 'inspect' and a.apply) or (a.mode == 'withdraw' and a.feed):
        parser.error(a.mode + ' needs: ' + ', '.join('--' + name.replace('_', '-') for name in needs))
    require(os.getuid() == 1000, 'Run as pickchick-ops (UID 1000), not root')
    for name in ['feed', 'package']:
        if getattr(a, name):
            setattr(a, name, getattr(a, name).absolute())
    expected = {app: getattr(a, 'expected_' + app + '_sha256') for app in APPS
                if getattr(a, 'expected_' + app + '_sha256')}
    require(all(re.fullmatch('[a-f0-9]{64}', value) for value in expected.values()),
            'Expected installer SHA-256 in lower-case hex')
    if a.mode == 'inspect':
        return inspect(a, expected)
    # Every changing mode runs only as the reviewed files of one commit.
    require(re.fullmatch('[a-f0-9]{40}', a.expected_source_sha), 'Expected full source SHA')
    verify_package(a.package, a.expected_source_sha)
    if a.apply:
        survive_the_terminal()
    if a.mode == 'install':
        return install(a, expected)
    if a.mode == 'publish':
        return publish(a, expected)
    return withdraw(a)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, KeyError, OSError, http.client.HTTPException) as error:
        # No subprocess output, server payload or credential reaches stdout or stderr.
        print(json.dumps({'status': 'failed', 'reason': str(error)}), file=sys.stderr)
        sys.exit(1)
