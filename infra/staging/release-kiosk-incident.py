#!/usr/bin/env python3
"""Kiosk payment-incident API release: installed unified-menu API 23fb39e1 -> candidate with cloud050.

Owner-run and guarded; without --apply it only runs the read-only preflight and prints its plan.

  deploy   exact-SHA green CI (all CI jobs), the documented live baseline (API image and pointer
           23fb39e1, cloud ledger 001-049 with matching checksums, the live compose given by
           --expected-compose-sha256), an encrypted backup with an isolated restore, then the owner
           step (infra/staging/kiosk-incident-owner.mjs) applies 050 and grants SELECT,INSERT on its
           one table in a repeatable-read transaction that proves existing rows unchanged. The old
           API keeps serving on the additive schema (compatibility proof) before the new API starts.

The live compose (including every unified-menu flag value) is carried over byte for byte; only
RELEASE_SHA in release.env changes. The gateway, public files, kiosk QR worker, bank bridge,
mobile worker and database containers are never touched and must stay exactly as found. A
failure after the API switch returns the previous API; schema 050 stays (additive). An unknown
remote outcome keeps the shared deployment lock for manual inspection. No payment, QR, order or
incident is created. Read docs/operations/kiosk-payment-incident.md first.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

spec = importlib.util.spec_from_file_location('incident_unified_menu', Path(__file__).with_name('release-unified-menu.py'))
um = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = um
spec.loader.exec_module(um)
market = um.market
require, digest, quote, GuardFailure = market.require, market.digest, market.quote, market.GuardFailure
REPO, REMOTE, DB = market.REPO, market.REMOTE, market.DB

MIGRATION = '050_cloud_kiosk_payment_incidents.sql'
NEW_TABLE = 'commerce_kiosk_payment_incidents'
# Installed by release-unified-menu.py deploy on 9 October 2026 (unified-menu-installation-2026-10-09.md).
BASE_API_SHA = '23fb39e152fccaa97a32e9bf179c2d89a50dc1d5'
BASE_API_IMAGE = 'sha256:5dbfb3d5c76af3a7b864fee6ced56a8548b810f260ba195596d26d34747fac00'
BASE_SCHEMA = tuple(range(1, 41)) + tuple(range(42, 50))
EXACT_ACL = frozenset({(NEW_TABLE, None, 'SELECT'), (NEW_TABLE, None, 'INSERT')})


def check_base_schema(names):
    require(all(re.fullmatch(r'\d{3}_[a-z0-9_]+\.sql', n) for n in names) and
            [int(n[:3]) for n in names] == list(BASE_SCHEMA),
            'Installed API tree is not cloud schema049 (001-040, 042-049)')


def incident_plan(ledger, files, checksums):
    """Installed ledger is an exact prefix of the candidate; only 050 may be pending."""
    require(files and files[-1] == MIGRATION, 'Candidate migrations do not end with 050')
    require(len(ledger) <= len(files) and all(
        row == {'version': files[i], 'scope': 'cloud', 'checksum': checksums[files[i]]}
        for i, row in enumerate(ledger)), 'Installed migration ledger differs from the candidate')
    pending = files[len(ledger):]
    require(pending in ([MIGRATION], []), 'Pending migrations are not exactly 050')
    return pending


class Release(um.Release):
    """Reuses the unified-menu remote plumbing (ssh, psql, lock, backup, evidence, neighbours)."""

    def __init__(self, args):
        args.action = 'kiosk-incident-deploy'
        jobs = um.workflow_jobs((REPO / '.github/workflows/ci.yml').read_text())
        profile = market.ReleaseProfile('kiosk-incident-050', BASE_API_SHA, BASE_API_SHA, 0, (MIGRATION,), jobs,
                                        frozenset(), 'kiosk-incident-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)
        require(re.fullmatch(um.UUID_RE, args.branch_id or ''), 'A lower-case catalog branch UUID is required')
        self.branch_id = args.branch_id

    def evidence(self):
        path = self.private / 'phase-deploy.json'
        if path.is_file() and not path.is_symlink():
            record = json.loads(path.read_text())
            require(record.get('phase') == 'deploy' and record.get('source_sha') == self.sha, 'Foreign phase evidence')
            return {'deploy': record}
        return {}

    def owner(self, *argv, sha=None):
        output = self.remote(market.api_compose(sha or self.sha) + ' run --rm --no-deps --entrypoint node provision '
                             'infra/staging/kiosk-incident-owner.mjs ' + ' '.join(map(quote, argv)), timeout=240)
        return json.loads(output.splitlines()[-1])

    def source_checks(self):
        args = self.args
        require(re.fullmatch('[a-f0-9]{40}', self.sha) and self.sha != BASE_API_SHA, 'A new full commit SHA is required')
        require(self.git('rev-parse', 'HEAD') == self.sha, 'Release must use the checked-out HEAD')
        require(not self.git('status', '--porcelain', '--untracked-files=all'), 'Source checkout is dirty')
        require(re.fullmatch('[A-Za-z0-9._/-]{1,160}', args.branch) and '..' not in args.branch, 'Invalid pushed branch name')
        pushed = self.git('ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/' + args.branch)
        require(pushed.split()[0] == self.sha, 'Pushed branch differs from the checked SHA')
        self.execute(['git', 'merge-base', '--is-ancestor', BASE_API_SHA, self.sha])
        files, _ = self.candidate_migrations()
        installed = sorted(Path(p).name for p in self.git('ls-tree', '-r', '--name-only', BASE_API_SHA, '--',
                                                         'db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        check_base_schema(installed)
        require(files == installed + [MIGRATION], 'Candidate migrations are not schema049 plus 050')
        for name in installed:
            prior = self.execute(['git', 'show', BASE_API_SHA + ':db/cloud/migrations/' + name])
            require((REPO / 'db/cloud/migrations' / name).read_bytes() == prior, 'An installed migration was edited: ' + name)

    def deploy_baseline(self):
        a = self.args
        require(re.fullmatch('[a-f0-9]{64}', a.expected_compose_sha256 or ''),
                '--expected-compose-sha256 must be the SHA-256 of the live API compose')
        require(self.running_revision() == BASE_API_SHA, 'Running API is not the installed 23fb39e1')
        require(self.api_image() == BASE_API_IMAGE, 'Running API image is not the installed image')
        require(self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + BASE_API_SHA) ==
                BASE_API_IMAGE, 'Rollback image differs from the installed image')
        require(self.remote('readlink -f ' + REMOTE + '/current') == f'{REMOTE}/releases/{BASE_API_SHA}', 'API pointer changed')
        compose = self.read_text(self.compose_path(BASE_API_SHA))
        require(digest(compose.encode()) == a.expected_compose_sha256, 'Live API compose differs from the reviewed hash')
        self.role_restricted()
        files, checksums = self.candidate_migrations()
        pending = incident_plan(self.ledger(), files, checksums)
        self.neighbors()
        return {'compose': compose, 'pending': pending, 'environment': self.runtime_environment()}

    def run(self):
        evidence = self.evidence()
        if 'deploy' in evidence:
            require(self.running_revision() == self.sha, 'Deploy evidence exists but another API is running')
            print(json.dumps({'phase': 'deploy', 'already_complete': True}), flush=True)
            return
        self.source_checks()
        self.ci()
        base = self.deploy_baseline()
        if not self.args.apply:
            return self.plan('deploy', {'pending_migrations': base['pending'], 'compose': 'carried over unchanged'})
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0,
                'Protected backup identity required')
        with self.deployment_lock():
            self.deploy_apply(base)

    def prepare_artifacts(self, base):
        target = f'{REMOTE}/releases/{self.sha}'
        archive = self.execute(['git', 'archive', '--format=tar', self.sha, *market.ARCHIVE_PATHS])
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}', input=archive, timeout=180)
        env = '''from pathlib import Path
import sys
old,new,sha,old_sha=sys.argv[1:]
lines=Path(old).read_text().splitlines()
assert lines.count('RELEASE_SHA='+old_sha)==1
lines=[line for line in lines if not line.startswith('RELEASE_SHA=')]
with open(new,'x') as output:
 Path(new).chmod(0o600)
 output.write('\\n'.join(lines+['RELEASE_SHA='+sha])+'\\n')
'''
        self.remote('python3 -c ' + quote(env) + ' ' + ' '.join(map(quote, [
            f'{REMOTE}/releases/{BASE_API_SHA}/release.env', target + '/release.env', self.sha, BASE_API_SHA])))
        self.write_remote(self.compose_path(self.sha), base['compose'])
        self.remote('! docker image inspect pickchick-api:' + self.sha + ' >/dev/null 2>&1')
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} '
                            f'-t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Docker build did not return one image ID')
        self.remote(market.api_compose(self.sha) + ' config --quiet')
        return {'image_id': image, 'archive_sha256': digest(archive), 'compose_sha256': digest(base['compose'].encode())}

    def verify_prepared(self, prepared, base):
        require(prepared['compose_sha256'] == digest(base['compose'].encode()), 'Prepared candidate differs from today’s')
        require(digest(self.read_text(self.compose_path(self.sha)).encode()) == prepared['compose_sha256'],
                'Prepared remote compose changed')
        require(self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + self.sha) ==
                prepared['image_id'], 'Prepared API image changed')

    def incident_route(self):
        """The new route answers (401 without a manager token), not the 404 of an old API."""
        status, _ = self.http(f'/v1/admin/backoffice/branches/{self.branch_id}/kiosk-payment-incidents', public=False)
        return status

    def deploy_apply(self, base):
        if (self.private / 'prepared.json').is_file():
            prepared = json.loads((self.private / 'prepared.json').read_text())
            self.verify_prepared(prepared, base)
        else:
            prepared = self.prepare_artifacts(base)
            self.save('prepared.json', prepared)
        before = {'acl': self.acl(), 'availability': self.availability_rows(), 'environment': base['environment'],
                  'capabilities': self.http_json('/v1/capabilities', public=False), 'neighbors': self.neighbors()}
        self.save('before.json', {k: v for k, v in before.items() if k != 'environment'})
        backup = self.backup_restore()
        self.save('backup.json', backup)
        stage = 'migrating'
        try:
            result = self.owner('deploy')
            self.save('owner-deploy.json', result)
            require(result['applied'] == base['pending'] and result['lastMigration'] == MIGRATION, 'Owner step result differs')
            # The old API keeps serving on the retained, additive schema (compatibility proof).
            self.ready()
            um.verify_acl_change(before['acl'], self.acl(), new_tables=frozenset({NEW_TABLE}), exact_new=EXACT_ACL)
            um.verify_availability(before['availability'], self.availability_rows())
            require(self.neighbors() == before['neighbors'], 'Neighbour containers changed (QR worker, bank bridge, database)')
            stage = 'api'
            self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.ready()
            require(self.api_image() == prepared['image_id'], 'Running image differs from the prepared image')
            require(self.running_revision() == self.sha, 'Running API revision differs from the candidate')
            um.verify_environment_delta(before['environment'], self.runtime_environment(), {}, release_sha_may_change=True)
            require(self.http_json('/v1/capabilities', public=False) == before['capabilities'], 'API capabilities changed')
            require(self.incident_route() in (401, 403), 'Incident route is not served by the new API')
            self.switch(REMOTE + '/current', f'{REMOTE}/releases/{BASE_API_SHA}', f'{REMOTE}/releases/{self.sha}')
            um.verify_availability(before['availability'], self.availability_rows())
            require(self.neighbors() == before['neighbors'], 'Neighbour containers changed (QR worker, bank bridge, database)')
        except market.CommandUncertain:
            raise  # Completion unknown: keep the lock, inspect before any rollback.
        except Exception:
            self.save('failure-stage.json', {'stage': stage})
            if stage != 'migrating':
                self.rollback_deploy(stage)
            raise
        self.complete('deploy', {'image_id': prepared['image_id'], 'compose_sha256': prepared['compose_sha256'],
                                 'backup': backup, 'applied_migrations': result['applied'], 'base_api': BASE_API_SHA})
        print(json.dumps({'phase': 'deploy', 'applied': True, 'migrations': result['applied'],
                          'flags': 'unchanged', 'backup_restore': 'passed'}), flush=True)

    def rollback_deploy(self, stage):
        """Previous API back; schema 050 retained (additive, proven compatible)."""
        try:
            if self.remote('readlink -f ' + REMOTE + '/current') != f'{REMOTE}/releases/{BASE_API_SHA}':
                self.switch(REMOTE + '/current', f'{REMOTE}/releases/{self.sha}', f'{REMOTE}/releases/{BASE_API_SHA}')
            self.remote(market.api_compose(BASE_API_SHA) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.ready()
            require(self.running_revision() == BASE_API_SHA, 'Rollback API revision differs')
            require(self.api_image() == BASE_API_IMAGE, 'Rollback API image differs')
            self.save('rollback.json', {'stage': stage, 'api': BASE_API_SHA, 'schema': 'retained 050'})
        except Exception:
            raise market.CommandUncertain('Rollback unverified; deployment lock retained') from None


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('sha')
    p.add_argument('--branch', required=True, help='pushed git branch of the SHA')
    p.add_argument('--branch-id', required=True, help='catalog branch UUID of the restaurant')
    p.add_argument('--expected-compose-sha256', required=True)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--ssh-key', type=Path, default=Path.home() / '.ssh/pickchick_staging_ed25519')
    p.add_argument('--backup-identity', type=Path, default=REPO / '.local/vps/backup-identity.agekey')
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
