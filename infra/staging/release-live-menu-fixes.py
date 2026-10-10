#!/usr/bin/env python3
"""Guarded API-only release of the mobile live-menu fixes on top of the installed 3bc98faf API.

Default is read-only; prepare/apply/rollback change the server only with --apply.

Reuses release-live-menu.py (loaded as a private module copy; that file is not edited) with the
baseline moved from cf25cb9e to the installed 3bc98faf. The candidate must keep exactly schema050
(no migration, no GRANT, no provision) and the repository compose of 3bc98faf. The live compose of
3bc98faf, including the current CUSTOMER_CHECKOUT_HEAD_GUARD value, is carried over byte for byte;
only RELEASE_SHA in release.env changes. The head guard is never switched by this profile.

  prepare  exact-SHA green CI of every Foundation job, the live baseline (API revision, image
           given by --expected-api-image, pointer, ledger, runtime ACL, public pointer, gateway,
           compose given by --expected-compose-sha256), then builds pickchick-api:<sha>.
  apply    shared release lock, table snapshot, encrypted backup with an isolated restore, then
           recreates only the API container and switches the API pointer. Neighbours (kiosk QR
           worker, bank bridge, mobile worker, database, gateway) must stay exactly as found;
           readiness, ACL, ledger, environment and capabilities must match. Any failure after the
           switch starts returns the 3bc98faf image and pointer automatically; the lock is kept.
  rollback explicit return to 3bc98faf (or, after an automatic rollback, verification of the
           restored baseline so that --owner-id can release the retained lock).

No bank request, order, payment, QR or production dump restoration. Read
docs/operations/mobile-live-menu.md and docs/operations/mobile-live-fixes.md first.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

spec = importlib.util.spec_from_file_location('live_menu_fixes_base', Path(__file__).with_name('release-live-menu.py'))
lm = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = lm
spec.loader.exec_module(lm)
market, base = lm.market, lm.base
require, digest, quote = lm.require, lm.digest, lm.quote
GuardFailure, CommandUncertain, REMOTE = lm.GuardFailure, market.CommandUncertain, lm.REMOTE
FLAG = lm.FLAG

PREVIOUS_BASELINE = 'cf25cb9e4712a7beedc2d2b52a9d64d3e557598f'
# Installed 9 October 2026 by release-live-menu.py (docs/operations/mobile-live-menu.md,
# "Состояние 9 октября 2026": revision 3bc98faf, exact image below, head guard enabled).
BASELINE = '3bc98faf7c76f16273e4ee240b2c673846002516'
DOCUMENTED_API_IMAGE = 'sha256:245e5edbc27799a5c6b3049c548a9c4484ad9c7c998ab4a2de4b181dd15089f3'
SCHEMA = tuple(range(1, 41)) + tuple(range(42, 51))  # schema050: 49 files, no 041
QR_WORKER = 'pickchick-kiosk-kaspi-qr-worker'
ACTIONS = ('prepare', 'apply', 'rollback')

# The private module copy now pins every inherited baseline use (ledger, release.env, rollback
# image, pointers) to 3bc98faf. release-live-menu.py itself keeps cf25cb9e.
require(lm.BASELINE == PREVIOUS_BASELINE, 'release-live-menu.py baseline changed; review this profile')
lm.BASELINE = BASELINE


def check_pins(args):
    require(args.expected_api_sha == BASELINE, 'Exact 3bc98faf API baseline required')
    require(re.fullmatch('[a-f0-9]{40}', args.expected_public_sha or ''), 'Reviewed public pointer required')
    for name in ['expected_compose_sha256', 'expected_gateway_sha256']:
        require(re.fullmatch('[a-f0-9]{64}', getattr(args, name) or ''), 'Reviewed compose/gateway hashes required')
    require(re.fullmatch('sha256:[a-f0-9]{64}', args.expected_api_image or ''), 'Reviewed API image ID required')
    require(args.expected_api_image == DOCUMENTED_API_IMAGE, 'API image differs from the documented 3bc98faf install')
    require(re.fullmatch('sha256:[a-f0-9]{64}', args.expected_qr_worker_image or ''), 'Reviewed QR worker image ID required')
    require(args.action in ACTIONS, 'Only prepare, apply and rollback; the head guard is not switched here')


def api_section(text):
    require(text.count('\n  api:\n') == 1, 'API boundary ambiguous')
    start = text.index('\n  api:\n') + 1
    match = re.search(r'^  [A-Za-z][A-Za-z0-9_-]*:', text[start + len('  api:\n'):], re.M)
    end = start + len('  api:\n') + match.start() if match else len(text)
    return text[start:end]


def compose_carry(text, expected):
    """The live compose unchanged; returns it with its single API head guard value."""
    require(digest(text.encode()) == expected, 'Installed compose differs from reviewed hash')
    values = re.findall('^      ' + FLAG + ': "(true|false)"\n', api_section(text), re.M)
    require(text.count(FLAG) == 1 and len(values) == 1, 'Head guard must appear exactly once, in the API section')
    return {'text': text, 'head_guard': values[0]}


class Release(lm.Release):
    def __init__(self, args):
        check_pins(args)
        profile = market.ReleaseProfile('mobile-live-fixes-api-schema050', BASELINE, args.expected_public_sha,
            len(SCHEMA), (), base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()), frozenset(),
            'live-menu-fixes-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def source_checks(self):
        market.Release.source_checks(self)  # exact schema050 migration set, no edited migration
        self.execute(['git', 'merge-base', '--is-ancestor', BASELINE, self.sha])
        require(not self.git('diff', '--name-only', BASELINE, self.sha, '--', 'db/cloud/', 'infra/staging/compose.yaml'),
                'Candidate changes cloud migrations or the repository compose')

    def plan(self, phase, detail):
        detail = {key: value for key, value in detail.items() if key != 'head_guard'}
        lm.Release.plan(self, phase, {**detail, 'baseline': BASELINE, 'head_guard': 'unchanged', 'compose': 'carried over'})

    def neighbors(self):
        result = lm.Release.neighbors(self)
        row = result['containers'].get(QR_WORKER, '').split()
        require(len(row) == 5 and row[1] == self.args.expected_qr_worker_image and row[3] == 'running',
                'Kiosk QR worker is not the reviewed running image')
        return result

    def baseline(self):
        a = self.args
        require(self.running_revision() == BASELINE and self.api_image() == a.expected_api_image, 'Live API baseline differs')
        require(self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + BASELINE) ==
                a.expected_api_image, 'Rollback image differs')
        require(self.remote('readlink -f ' + REMOTE + '/current') == REMOTE + '/releases/' + BASELINE, 'API pointer differs')
        require(self.ledger() == self.expected_ledger(), 'Installed ledger is not exact schema050')
        self.runtime_acl(); self.verify_public()
        carry = compose_carry(self.read_text(self.compose_path(BASELINE)), a.expected_compose_sha256)
        env = self.runtime_environment()
        require(env.get(FLAG) == digest(carry['head_guard'].encode()), 'Running head guard differs from the live compose')
        return {'candidate': carry['text'], 'head_guard': carry['head_guard'], 'environment': env,
                'rollback': self.rollback_artifacts(), 'neighbors': self.neighbors(), 'acl': self.acl(),
                'capabilities': self.http_json('/v1/capabilities', public=False)}

    def artifacts(self):
        result = lm.Release.artifacts(self)
        require(result['files'][self.compose_path(self.sha)] == self.args.expected_compose_sha256,
                'Candidate compose is not the live compose byte for byte')
        return result

    def current(self, proof, flag=None):
        """Candidate state; the environment differs from the baseline only by RELEASE_SHA."""
        require(self.running_revision() == self.sha and self.api_image() == proof['artifacts']['image'], 'Candidate API changed')
        require(self.remote('readlink -f ' + REMOTE + '/current') == REMOTE+'/releases/'+self.sha, 'Candidate pointer changed')
        require(self.ledger() == self.expected_ledger() and self.acl() == proof['before']['acl'], 'Schema or ACL changed')
        require(self.neighbors() == proof['before']['neighbors'], 'Bank/QR/gateway or another container changed')
        require(self.rollback_artifacts() == proof['before']['rollback'], 'Rollback artifacts changed')
        base.verify_environment_delta(proof['before']['environment'], self.runtime_environment(), {},
                                      release_sha_may_change=True)
        self.runtime_acl(); self.verify_public()
        require(self.http_json('/v1/capabilities', public=False) == proof['before']['capabilities'], 'Capabilities changed')

    def apply(self):
        proof = self.prepared()
        require(self.baseline() == proof['before'] and self.artifacts() == proof['artifacts'], 'Prepared baseline/artifacts drift')
        if not self.args.apply:
            return self.plan('apply', {'api_only': True, 'backup_restore_required': True})
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0, 'Protected backup identity required')
        self.save('before-snapshot.json', self.snapshot())
        backup = self.backup_restore()
        require(backup.get('restore') == 'passed', 'Isolated backup restore not confirmed')
        self.save('backup.json', backup)
        require(self.baseline() == proof['before'], 'Baseline changed during backup/restore')
        stage = 'api'
        try:
            self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.ready()
            require(self.api_image() == proof['artifacts']['image'], 'API image differs')
            stage = 'pointer'
            self.switch(REMOTE+'/current', REMOTE+'/releases/'+BASELINE, REMOTE+'/releases/'+self.sha)
            stage = 'verify'
            self.current(proof)
        except CommandUncertain:
            raise  # Completion unknown: keep the lock, inspect the actual state first.
        except Exception:
            self.save('failure-stage.json', {'stage': stage})
            self.restore_baseline(stage)
            raise
        self.save('after-snapshot.json', self.snapshot())
        self.save('applied.json', {'sha': self.sha, 'baseline': BASELINE, 'head_guard': proof['before']['head_guard'],
                                  'backup': backup, 'applied_at': time.time(), 'schema': 50, 'migrations': [],
                                  'acl_unchanged': True})

    def restore_baseline(self, stage):
        """Automatic return of the 3bc98faf image and pointer; the database is not restored."""
        try:
            if self.remote('readlink -f ' + REMOTE + '/current') != REMOTE + '/releases/' + BASELINE:
                self.switch(REMOTE+'/current', REMOTE+'/releases/'+self.sha, REMOTE+'/releases/'+BASELINE)
            self.remote(market.api_compose(BASELINE) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.ready()
            require(self.running_revision() == BASELINE and self.api_image() == self.args.expected_api_image,
                    'Restored API differs')
            self.save('rollback.json', {'sha': self.sha, 'stage': stage, 'restored_api': BASELINE,
                                        'database_restored': False, 'automatic': True})
        except Exception:
            raise CommandUncertain('Automatic rollback unverified; release lock retained') from None

    def rollback(self):
        proof = self.prepared()
        restored = self.private / 'rollback.json'
        if self.running_revision() == BASELINE and restored.is_file() and not restored.is_symlink():
            require(self.remote('readlink -f ' + REMOTE + '/current') == REMOTE + '/releases/' + BASELINE, 'API pointer differs')
            require(self.baseline() == proof['before'], 'Restored baseline differs from the prepared baseline')
            if not self.args.apply:
                return self.plan('rollback', {'already_restored': True, 'database_restore': False})
            self.save('rollback-verified.json', {'sha': self.sha, 'restored_api': BASELINE, 'verified_at': time.time()})
            return
        return lm.Release.rollback(self)


def parse(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=ACTIONS)
    for name in ['sha', 'branch', 'expected-api-sha', 'expected-public-sha', 'expected-api-image',
                 'expected-compose-sha256', 'expected-gateway-sha256', 'expected-qr-worker-image']:
        parser.add_argument('--'+name, required=True)
    for name in ['ssh-key', 'backup-identity', 'ci-proof']:
        parser.add_argument('--'+name, type=Path, required=name == 'ssh-key')
    parser.add_argument('--ci-run'); parser.add_argument('--owner-id')
    parser.add_argument('--apply', action='store_true')
    return parser.parse_args(argv)


def main(argv=None):
    os.umask(0o077)
    release = Release(parse(argv))
    try:
        release.run()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error, GuardFailure) else 'Stopped; inspect private evidence; owned lock retained.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
