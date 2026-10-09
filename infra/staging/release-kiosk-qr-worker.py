#!/usr/bin/env python3
"""Kiosk Kaspi QR worker image update: installed 6ac409f worker -> candidate commerce-core.

Owner-run and guarded; without --apply only the read-only preflight runs. Updates exactly one
container, pickchick-kiosk-kaspi-qr-worker: the candidate API image (same Dockerfile) and its
compose copied byte for byte except the image tag. Its env/session bind sources, network
namespace (the bank bridge), limits and command stay identical. Requires exact-SHA green CI of
all jobs, the documented installed worker (image, compose and env hashes), no QR being issued
at the switch, and every other container unchanged. The API, gateway, bridge, mobile worker and
database are never restarted. No QR, payment, order or schema change is made; a failure
restores the previous worker compose. Read docs/operations/kaspi-qr-pending-2026-10-09.md.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

spec = importlib.util.spec_from_file_location('qr_worker_market', Path(__file__).with_name('release-market.py'))
market = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = market
spec.loader.exec_module(market)
require, digest, quote, GuardFailure = market.require, market.digest, market.quote, market.GuardFailure
REPO, REMOTE, DB = market.REPO, market.REMOTE, market.DB
spec = importlib.util.spec_from_file_location('qr_worker_unified', Path(__file__).with_name('release-unified-menu.py'))
um = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = um
spec.loader.exec_module(um)

WORKER = 'pickchick-kiosk-kaspi-qr-worker'
BRIDGE = 'pickchick-kaspi-bridge'
BASE_SHA = '6ac409f710f96e5247e8423963e2ef511a9e4d4a'
BASE_IMAGE = 'sha256:6ef62d34b54cf1f6788358a8e972d72c3c4fc2f7ad5325734812d45f8131185c'
BASE_COMPOSE = f'{REMOTE}/releases/{BASE_SHA}/kiosk-qr-worker.json'
BASE_COMPOSE_SHA256 = '3500ce8f7d87e2a53775c783a660478a5ed558ee4bc1950ee09d1e08258eb28e'
WORKER_ENV = f'{REMOTE}/kaspi-bridge/releases/85f23d582540f89b0df86b7415cc764f7594774a/qr-worker.env'
WORKER_ENV_SHA256 = '1934c3121c1088c8d2bd347c1d29586055969a7618dcb03bea59ec239907e1dc'


def worker_candidate(raw, sha):
    """Installed worker compose with only the image tag moved to the candidate."""
    require(digest(raw.encode()) == BASE_COMPOSE_SHA256, 'Installed worker compose changed')
    value = json.loads(raw)
    require(set(value) == {'name', 'services'} and set(value['services']) == {'worker'}, 'Unexpected worker compose shape')
    service = value['services']['worker']
    require(service['image'] == 'pickchick-api:' + BASE_SHA and service['container_name'] == WORKER and
            service['network_mode'] == 'container:' + BRIDGE, 'Installed worker service differs')
    candidate = json.loads(raw)
    candidate['services']['worker']['image'] = 'pickchick-api:' + sha
    changed = {k for k in service if candidate['services']['worker'][k] != service[k]}
    require(changed == {'image'}, 'Candidate worker compose changed more than the image')
    return json.dumps(candidate)


class Release(market.Release):
    def __init__(self, args):
        args.action = 'kiosk-qr-worker'
        jobs = um.workflow_jobs((REPO / '.github/workflows/ci.yml').read_text())
        profile = market.ReleaseProfile('kiosk-qr-worker', BASE_SHA, BASE_SHA, 0, (), jobs, frozenset(),
                                        'kiosk-qr-worker-release', (), exact_ci_jobs=True)
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
                'mounts': sorted((m['Source'], m['Destination'], m['RW']) for m in raw['Mounts'])}

    def issuing(self):
        return int(self.psql(DB, "SELECT count(*) FROM commerce_kiosk_kaspi_qr WHERE state='issuing'"))

    def neighbors(self):
        result = self.fingerprint()
        require(WORKER in result['containers'], 'Installed QR worker absent')
        result['containers'].pop(WORKER)
        return result

    def baseline(self):
        state = self.worker_state()
        require(state['image'] == BASE_IMAGE and state['running'] and state['network'] and not state['ports'],
                'Installed QR worker is not the documented 6ac409f worker')
        require(self.file_hashes([BASE_COMPOSE, WORKER_ENV]) == {BASE_COMPOSE: BASE_COMPOSE_SHA256, WORKER_ENV: WORKER_ENV_SHA256},
                'Installed worker compose or environment changed')
        compose = self.remote('cat ' + quote(BASE_COMPOSE)) + '\n'
        compose = compose if digest(compose.encode()) == BASE_COMPOSE_SHA256 else compose[:-1]
        return {'compose': compose, 'candidate': worker_candidate(compose, self.sha), 'state': state}

    def write_remote(self, path, text):
        writer = ('from pathlib import Path;import sys;p=Path(sys.argv[1]);p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)')
        self.remote('python3 -c ' + quote(writer) + ' ' + quote(path), input=text)

    def compose(self, path):
        return 'docker compose -f ' + quote(path)

    def run(self):
        self.source_checks()
        self.ci()
        base = self.baseline()
        if not self.args.apply:
            print(json.dumps({'phase': 'qr-worker', 'validated': True, 'applied': False, 'running_api': self.running_api,
                              'issuing_now': self.issuing()}), flush=True)
            return
        with self.deployment_lock():
            self.apply(base)

    def apply(self, base):
        target = f'{REMOTE}/releases/{self.sha}'
        candidate_path = target + '/kiosk-qr-worker.json'
        if self.remote(f'test -e {target} && echo yes || echo no') == 'no':
            archive = self.execute(['git', 'archive', '--format=tar', self.sha, *market.ARCHIVE_PATHS])
            self.remote(f'mkdir {target} && tar -xf - -C {target}', input=archive, timeout=180)
        if self.remote('docker image inspect pickchick-api:' + self.sha + ' >/dev/null 2>&1 && echo yes || echo no') == 'no':
            self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} '
                        f'-t pickchick-api:{self.sha} .', timeout=1200)
        image = self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + self.sha)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Candidate image missing')
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
        require(self.issuing() == 0, 'A QR is being issued; retry later')
        stage = 'switch'
        try:
            self.remote(self.compose(candidate_path) + ' up -d --no-deps --wait --wait-timeout 60 worker', timeout=120)
            time.sleep(20)
            after = self.worker_state()
            require(after['image'] == image and after['running'] and after['restarts'] == 0 and after['network'] and
                    not after['ports'], 'Candidate worker is not running cleanly on the bridge')
            require(after['cmd'] == base['state']['cmd'] and after['mounts'] == base['state']['mounts'],
                    'Worker command or mounts changed')
            require(self.file_hashes([WORKER_ENV]) == {WORKER_ENV: WORKER_ENV_SHA256}, 'Worker environment changed')
            require(self.neighbors() == before['neighbors'], 'Neighbour containers changed (API, bridge, database)')
        except market.CommandUncertain:
            raise
        except Exception:
            self.save('failure-stage.json', {'stage': stage})
            self.rollback()
            raise
        self.save('phase-qr-worker.json', {'phase': 'qr-worker', 'source_sha': self.sha, 'image': image,
                                           'compose_sha256': digest(base['candidate'].encode()), 'base': BASE_SHA,
                                           'completed_epoch': time.time()})
        print(json.dumps({'phase': 'qr-worker', 'applied': True, 'image': image[:19]}), flush=True)

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
