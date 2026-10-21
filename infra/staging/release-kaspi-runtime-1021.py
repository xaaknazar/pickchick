#!/usr/bin/env python3
"""Guarded image-only update of the installed b18beb08 mobile invoice worker.

Exact published source and full CI are required. Preserve compose settings,
credentials, bank bridge, all neighboring services and cloud schema. Default
is read-only; --apply uses the shared deployment lock and rollback image.
No new invoice, QR, order, test payment or credential is created by this tool.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

spec = importlib.util.spec_from_file_location('invoice_runtime_market', Path(__file__).with_name('release-market.py'))
market = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = market
spec.loader.exec_module(market)
require, digest, quote, GuardFailure = market.require, market.digest, market.quote, market.GuardFailure
REPO, REMOTE, DB = market.REPO, market.REMOTE, market.DB
spec = importlib.util.spec_from_file_location('invoice_runtime_unified', Path(__file__).with_name('release-unified-menu.py'))
um = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = um
spec.loader.exec_module(um)

WORKER = 'pickchick-kaspi-worker'
BRIDGE = 'pickchick-kaspi-bridge'
BASE_SHA = 'b18beb08b86341e13ab2b919edd01f523cea0c23'
BASE_IMAGE = 'sha256:bb7ba74705a2a39a9165e51ab21ce8b6939bb2ab20d0928013cf5ac4dd303b19'
BASE_COMPOSE = f'{REMOTE}/kaspi-companion/{BASE_SHA}/compose.yaml'
BASE_RELEASE_ENV = f'{REMOTE}/kaspi-companion/{BASE_SHA}/release.env'
BASE_RELEASE_ENV_HASH = '44fc7f4f580a089db2ad7ee68e984c6feaae1c876d113877f10f0af7a9da4024'
BASE_COMPOSE_SHA256 = '06ebbfff99ed2c222f80aa04fc0a7e2bbaf5ed6232f2895f015345c0e60bfdac'
WORKER_ENV = f'{REMOTE}/secrets/kaspi-bridge/worker.env'
SESSION_ENV = f'{REMOTE}/secrets/kaspi-bridge/session.env'
WORKER_ENV_SHA256 = '9ab0f41ca79db0244031fbbc1aa8e34c564fa689749c29f45154800714459f4d'


def worker_candidate(raw, sha):
    """Resolve the pinned non-secret compose variables, then change only image."""
    require(re.fullmatch('[a-f0-9]{40}', sha), 'Full source SHA required')
    require(digest(raw.encode()) == BASE_COMPOSE_SHA256, 'Installed worker compose changed')
    image = '${API_RELEASE_SHA:?Set verified API SHA}'
    secrets = '${KASPI_SECRETS_DIR:?Set protected directory}'
    require(raw.count(image) == 1 and raw.count(secrets) == 2, 'Unexpected compose substitution')
    return raw.replace(image, sha).replace(secrets, REMOTE+'/secrets/kaspi-bridge')


class Release(market.Release):
    def __init__(self, args):
        args.action = 'kaspi-invoice-runtime-1021'
        jobs = um.workflow_jobs((REPO / '.github/workflows/ci.yml').read_text())
        profile = market.ReleaseProfile('kaspi-invoice-runtime-1021', BASE_SHA, BASE_SHA, 0, (), jobs, frozenset(),
                                        'kaspi-invoice-runtime-1021', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def source_checks(self):
        args = self.args
        require(re.fullmatch('[a-f0-9]{40}', self.sha) and self.sha != BASE_SHA, 'A new full commit SHA is required')
        require(self.git('rev-parse', 'HEAD') == self.sha, 'Release must use the checked-out HEAD')
        require(not self.git('status', '--porcelain', '--untracked-files=all'), 'Source checkout is dirty')
        require(re.fullmatch('[A-Za-z0-9._/-]{1,160}', args.branch) and '..' not in args.branch, 'Invalid pushed branch name')
        pushed = self.git('ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/' + args.branch)
        require(pushed.split()[0] == self.sha, 'Pushed branch differs from the checked SHA')
        # The worker shares the cloud schema with the running API; the candidate adds no migration.
        running = self.remote('docker inspect --format ' + quote('{{index .Config.Labels "org.opencontainers.image.revision"}}') +
                              ' ' + market.API_CONTAINER)
        require(re.fullmatch('[a-f0-9]{40}', running), 'Running API revision unreadable')
        self.execute(['git', 'merge-base', '--is-ancestor', running, self.sha])
        files = sorted(p.name for p in (REPO / 'db/cloud/migrations').glob('*.sql'))
        installed = sorted(Path(p).name for p in self.git('ls-tree', '-r', '--name-only', running, '--',
                                                         'db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require(files == installed, 'Candidate migrations differ from the running API schema')
        self.running_api = running

    def worker_state(self):
        raw = json.loads(self.remote('docker inspect --format ' + quote('{{json .}}') + ' ' + WORKER))
        bridge = self.remote('docker inspect --format ' + quote('{{.Id}}') + ' ' + BRIDGE)
        return {'image': raw['Image'], 'running': raw['State']['Running'], 'restarts': raw['RestartCount'],
                'network': raw['HostConfig']['NetworkMode'] == 'container:' + bridge,
                'ports': raw['HostConfig']['PortBindings'] or {}, 'cmd': raw['Config']['Cmd'],
                'security': {k: raw['HostConfig'][k] for k in ('ReadonlyRootfs','CapDrop','SecurityOpt','Memory','NanoCpus','PidsLimit')},
                'user': raw['Config']['User'],
                'mounts': sorted((m['Source'], m['Destination'], m['RW']) for m in raw['Mounts'])}

    def issuing(self):
        return int(self.psql(DB, "SELECT (SELECT count(*) FROM commerce_kaspi_invoices WHERE state IN ('issuing','issued','unknown')) + (SELECT count(*) FROM commerce_outbox e JOIN commerce_payment_attempts a ON a.id=(e.payload->>'attemptId')::uuid WHERE e.event_type='payment.submit_requested' AND e.acknowledged_at IS NULL AND a.state='pending')"))

    def neighbors(self):
        result = self.fingerprint()
        require(WORKER in result['containers'], 'Installed invoice worker absent')
        result['containers'].pop(WORKER)
        return result

    def baseline(self):
        state = self.worker_state()
        require(state['image'] == BASE_IMAGE and state['running'] and state['network'] and not state['ports'],
                'Installed invoice worker is not the documented b18beb08 worker')
        require(self.file_hashes([BASE_COMPOSE, WORKER_ENV]) == {BASE_COMPOSE: BASE_COMPOSE_SHA256, WORKER_ENV: WORKER_ENV_SHA256},
                'Installed worker compose or environment changed')
        compose = self.remote('cat ' + quote(BASE_COMPOSE)) + '\n'
        compose = compose if digest(compose.encode()) == BASE_COMPOSE_SHA256 else compose[:-1]
        require(self.file_hashes([BASE_RELEASE_ENV]) == {BASE_RELEASE_ENV: BASE_RELEASE_ENV_HASH}, 'Rollback environment changed')
        return {'compose': compose, 'candidate': worker_candidate(compose, self.sha), 'state': state,
                'secrets': self.file_hashes([WORKER_ENV, SESSION_ENV])}

    def write_remote(self, path, text):
        writer = ('from pathlib import Path;import sys;p=Path(sys.argv[1]);p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)')
        self.remote('python3 -c ' + quote(writer) + ' ' + quote(path), input=text)

    def compose(self, path):
        return 'docker compose ' + ('--env-file '+quote(BASE_RELEASE_ENV)+' ' if path == BASE_COMPOSE else '') + '-f ' + quote(path)

    def run(self):
        self.source_checks()
        self.ci()
        base = self.baseline()
        if not self.args.apply:
            print(json.dumps({'phase': 'invoice-worker', 'validated': True, 'applied': False, 'running_api': self.running_api,
                              'issuing_now': self.issuing()}), flush=True)
            return
        with self.deployment_lock():
            self.apply(base)

    def apply(self, base):
        target = f'{REMOTE}/releases/{self.sha}'
        candidate_path = target + '/kaspi-invoice-worker.yaml'
        if self.remote(f'test -e {target} && echo yes || echo no') == 'no':
            archive = self.execute(['git', 'archive', '--format=tar', self.sha, *market.ARCHIVE_PATHS])
            self.remote(f'mkdir {target} && tar -xf - -C {target}', input=archive, timeout=180)
        if self.remote('docker image inspect pickchick-api:' + self.sha + ' >/dev/null 2>&1 && echo yes || echo no') == 'no':
            self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} '
                        f'-t pickchick-api:{self.sha} .', timeout=1200)
        image = self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + self.sha)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Candidate image missing')
        revision = self.remote('docker image inspect --format ' +
                               quote('{{index .Config.Labels "org.opencontainers.image.revision"}}') +
                               ' pickchick-api:' + self.sha)
        require(revision == self.sha, 'Candidate image source differs')
        if self.remote('test -e ' + quote(candidate_path) + ' && echo yes || echo no') == 'yes':
            require(self.remote('sha256sum ' + quote(candidate_path)).split()[0] == digest(base['candidate'].encode()),
                    'Existing candidate worker compose differs')
        else:
            self.write_remote(candidate_path, base['candidate'])
        self.remote(self.compose(candidate_path) + ' config --quiet')
        before = {'neighbors': self.neighbors(), 'state': base['state']}
        self.save('before.json', before)
        # Never interrupt a create whose answer is still in flight.
        for _ in range(12):
            if self.issuing() == 0:
                break
            time.sleep(5)
        require(self.issuing() == 0, 'Pending or unsettled invoices exist; keep the installed worker')
        stage = 'switch'
        try:
            self.remote(self.compose(candidate_path) + ' up -d --no-deps --wait --wait-timeout 60 worker', timeout=120)
            time.sleep(20)
            after = self.worker_state()
            require(after['image'] == image and after['running'] and after['restarts'] == 0 and after['network'] and
                    not after['ports'], 'Candidate worker is not running cleanly on the bridge')
            require(after['cmd'] == base['state']['cmd'] and after['mounts'] == base['state']['mounts']
                    and after['security'] == base['state']['security'] and after['user'] == base['state']['user'],
                    'Worker command or mounts changed')
            require(self.file_hashes([WORKER_ENV, SESSION_ENV]) == base['secrets'], 'Worker/session environment changed')
            require(self.neighbors() == before['neighbors'], 'Neighbour containers changed (API, bridge, database)')
        except market.CommandUncertain:
            raise
        except Exception:
            self.save('failure-stage.json', {'stage': stage})
            self.rollback()
            raise
        self.save('phase-invoice-worker.json', {'phase': 'invoice-worker', 'source_sha': self.sha, 'image': image,
                                           'compose_sha256': digest(base['candidate'].encode()), 'base': BASE_SHA,
                                           'completed_epoch': time.time()})
        print(json.dumps({'phase': 'invoice-worker', 'applied': True, 'image': image[:19]}), flush=True)

    def rollback(self):
        try:
            self.remote(self.compose(BASE_COMPOSE) + ' up -d --no-deps --wait --wait-timeout 60 worker', timeout=120)
            state = self.worker_state()
            require(state['image'] == BASE_IMAGE and state['running'] and state['network'], 'Rollback worker differs')
            self.save('rollback.json', {'worker': BASE_SHA})
        except Exception:
            raise market.CommandUncertain('Worker rollback unverified; deployment lock retained') from None


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('sha')
    p.add_argument('--branch', required=True)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--ssh-key', type=Path, default=Path.home() / '.ssh/pickchick_staging_ed25519')
    proof = p.add_mutually_exclusive_group(required=True)
    proof.add_argument('--ci-run')
    proof.add_argument('--ci-proof', type=Path)
    return p.parse_args(argv)


def main(argv=None, factory=Release):
    os.umask(0o077)
    args = parse(argv)
    require(re.fullmatch('[a-f0-9]{40}', args.sha), 'Expected a full SHA')
    release = factory(args)
    try:
        release.run()
    except Exception as error:
        release.record_error(error)
        raise


if __name__ == '__main__':
    try:
        main()
    except GuardFailure as error:
        print('Release stopped: ' + str(error), flush=True)
        raise SystemExit(1) from None
    except Exception:
        print('Release stopped. Review private evidence and actual state before retrying.', flush=True)
        raise SystemExit(1) from None
