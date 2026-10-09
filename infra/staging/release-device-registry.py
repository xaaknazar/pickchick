#!/usr/bin/env python3
"""Device registry API release: installed kiosk-incident API cf25cb9e (schema050) -> candidate with cloud051.

Owner-run and guarded; without --apply it only runs the read-only preflight and prints its plan.

  deploy   exact-SHA green CI (all CI jobs), the documented live baseline (API pointer and image of
           cf25cb9e given by --base-image, cloud ledger 001-040,042-050 with matching checksums, the
           live compose given by --expected-compose-sha256), an encrypted backup with an isolated
           restore, then the owner step (infra/staging/device-registry-owner.mjs) applies 051 and the
           device-registry runtime grants in one repeatable-read transaction that proves existing
           columns and rows unchanged. The old API keeps serving on the additive schema
           (compatibility proof) before the new API starts.

The live compose (every flag value included) is carried over byte for byte except ONE new line in
the api environment: DEVICE_PAIRING_PEPPER: ${DEVICE_PAIRING_PEPPER:?...}. Its value comes only from
the owner's private 0600 --environment JSON (the same mechanism as KIOSK_ENROLLMENT_KEY in
release-kiosk-qr.py) and is appended to the candidate's 0600 release.env next to the replaced
RELEASE_SHA. This script never generates, prints or stores the value; only its SHA-256 is compared
with the running container. The gateway, public files, backoffice-login proxy, kiosk QR worker,
bank bridge, mobile worker and database containers are never touched and must stay exactly as
found. A failure after the API switch returns the previous API; schema 051 stays (additive). An
unknown remote outcome keeps the shared deployment lock for manual inspection. No device, pairing
code, kiosk alias, payment, QR or order is created. Read docs/operations/backoffice-devices.md first.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

spec = importlib.util.spec_from_file_location('registry_unified_menu', Path(__file__).with_name('release-unified-menu.py'))
um = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = um
spec.loader.exec_module(um)
market = um.market
require, digest, quote, GuardFailure = market.require, market.digest, market.quote, market.GuardFailure
REPO, REMOTE, DB = market.REPO, market.REMOTE, market.DB

MIGRATION = '051_cloud_device_registry.sql'
NEW_TABLES = frozenset({'device_pairing_codes', 'device_events'})
# Installed by release-kiosk-incident.py deploy (docs/operations/kiosk-payment-incident.md).
BASE_API_SHA = 'cf25cb9e4712a7beedc2d2b52a9d64d3e557598f'
BASE_SCHEMA = tuple(range(1, 41)) + tuple(range(42, 51))
PEPPER = 'DEVICE_PAIRING_PEPPER'
PEPPER_LINE = '      ' + PEPPER + ': ${' + PEPPER + ':?Private device pairing pepper required}\n'


def _acl(entries):
    return frozenset((t, c or None, p) for t, c, p in (e.split('|') for e in entries))


# Same list as REGISTRY_PRIVILEGES in device-registry-owner.mjs (unit test keeps them in sync).
REQUIRED_ACL = _acl([
    'device_credentials|device_id|SELECT', 'device_credentials|expires_at|SELECT',
    'device_events||INSERT', 'device_events||SELECT',
    'device_pairing_codes||INSERT', 'device_pairing_codes||SELECT',
    'device_pairing_codes|consumed_at|UPDATE', 'device_pairing_codes|consumed_request_id|UPDATE',
    'device_pairing_codes|failed_attempts|UPDATE', 'device_pairing_codes|state|UPDATE',
    'devices||INSERT', 'devices|app_version|UPDATE', 'devices|last_seen_at|UPDATE', 'devices|name|UPDATE',
    'devices|revoked_at|UPDATE', 'devices|revoked_by|UPDATE', 'devices|status|UPDATE',
    'kiosk_devices||INSERT', 'kiosk_devices|active|UPDATE', 'kiosk_sessions||SELECT',
])
EXACT_NEW_ACL = frozenset(row for row in REQUIRED_ACL if row[0] in NEW_TABLES)
EXISTING_TABLE_ACL = REQUIRED_ACL - EXACT_NEW_ACL


def check_base_schema(names):
    require(all(re.fullmatch(r'\d{3}_[a-z0-9_]+\.sql', n) for n in names) and
            [int(n[:3]) for n in names] == list(BASE_SCHEMA),
            'Installed API tree is not cloud schema050 (001-040, 042-050)')


def registry_plan(ledger, files, checksums):
    """Installed ledger is an exact prefix of the candidate; only 051 may be pending."""
    require(files and files[-1] == MIGRATION, 'Candidate migrations do not end with 051')
    require(len(ledger) <= len(files) and all(
        row == {'version': files[i], 'scope': 'cloud', 'checksum': checksums[files[i]]}
        for i, row in enumerate(ledger)), 'Installed migration ledger differs from the candidate')
    pending = files[len(ledger):]
    require(pending in ([MIGRATION], []), 'Pending migrations are not exactly 051')
    return pending


def private_read(path):
    path = Path(path)
    require(path.is_file() and not any(p.is_symlink() for p in [path, *path.parents])
            and path.stat().st_mode & 0o077 == 0, 'Protected 0600 input required')
    return path.read_bytes()


def validate_environment(value):
    """Exactly one key: a 32-byte pepper as 64 lower-case hex characters, made by the owner."""
    require(isinstance(value, dict) and set(value) == {PEPPER}, 'Exact device registry environment required')
    require(isinstance(value[PEPPER], str) and re.fullmatch('[a-f0-9]{64}', value[PEPPER]) is not None,
            'Invalid private device pairing pepper')
    require(len(set(value[PEPPER])) > 4, 'Device pairing pepper is not random')
    return value


def pepper_compose(raw):
    """The live compose plus exactly one api environment line referencing the private pepper."""
    require(PEPPER not in raw, 'Device pairing pepper already configured in the live compose')
    require(raw.count('\n  api:\n') == 1, 'Exact API service anchor required')
    head, tail = raw.split('\n  api:\n', 1)
    following = re.search(r'^(?:  )?[A-Za-z0-9_.-]+:', tail, re.M)  # next service or top-level key
    api, rest = (tail[:following.start()], tail[following.start():]) if following else (tail, '')
    anchors = list(re.finditer(r'^    environment:\n', api, re.M))
    require(len(anchors) == 1, 'Exact API environment anchor required')
    api = api[:anchors[0].end()] + PEPPER_LINE + api[anchors[0].end():]
    result = head + '\n  api:\n' + api + rest
    require(result.replace(PEPPER_LINE, '', 1) == raw and result.count(PEPPER) == 2, 'Existing compose changed')
    return result


def release_env_program():
    """Base release.env with RELEASE_SHA replaced and the pepper appended; value read from stdin."""
    return r'''from pathlib import Path
import json,sys
old,new,sha,old_sha,key=sys.argv[1:]
value=json.load(sys.stdin)[key]
lines=Path(old).read_text().splitlines()
assert lines.count('RELEASE_SHA='+old_sha)==1
assert not any(line.split('=',1)[0]==key for line in lines)
lines=[line for line in lines if not line.startswith('RELEASE_SHA=')]
with open(new,'x') as output:
 Path(new).chmod(0o600)
 output.write('\n'.join(lines+['RELEASE_SHA='+sha,key+'='+value])+'\n')
'''


def verify_pepper_environment(before, after, pepper):
    """Only RELEASE_SHA may change and the pepper appears; values compared as digests."""
    require(PEPPER not in before, 'Previous API already had a device pairing pepper')
    um.verify_environment_delta(before, after, {PEPPER: pepper}, release_sha_may_change=True)


class Release(um.Release):
    """Reuses the unified-menu remote plumbing (ssh, psql, lock, backup, evidence, neighbours)."""

    def __init__(self, args):
        args.action = 'device-registry-deploy'
        jobs = um.workflow_jobs((REPO / '.github/workflows/ci.yml').read_text())
        profile = market.ReleaseProfile('device-registry-051', BASE_API_SHA, BASE_API_SHA, 0, (MIGRATION,), jobs,
                                        frozenset(), 'device-registry-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)
        require(re.fullmatch(um.UUID_RE, args.branch_id or ''), 'A lower-case catalog branch UUID is required')
        require(re.fullmatch('sha256:[a-f0-9]{64}', args.base_image or ''), '--base-image must be the installed image ID')
        self.branch_id = args.branch_id
        self.base_image = args.base_image
        self.environment_bytes = private_read(args.environment)
        self.environment = validate_environment(json.loads(self.environment_bytes))
        self.check_base_evidence()

    def check_base_evidence(self):
        """When this Mac ran the kiosk-incident release, its evidence must agree with the arguments."""
        path = REPO / '.local/kiosk-incident-release' / BASE_API_SHA / 'phase-deploy.json'
        if path.is_file() and not path.is_symlink():
            record = json.loads(path.read_text())
            require(record.get('source_sha') == BASE_API_SHA and record.get('image_id') == self.base_image and
                    record.get('compose_sha256') == self.args.expected_compose_sha256,
                    'Arguments differ from the local kiosk-incident installation evidence')

    def evidence(self):
        path = self.private / 'phase-deploy.json'
        if path.is_file() and not path.is_symlink():
            record = json.loads(path.read_text())
            require(record.get('phase') == 'deploy' and record.get('source_sha') == self.sha, 'Foreign phase evidence')
            return {'deploy': record}
        return {}

    def owner(self, *argv, sha=None):
        output = self.remote(market.api_compose(sha or self.sha) + ' run --rm --no-deps --entrypoint node provision '
                             'infra/staging/device-registry-owner.mjs ' + ' '.join(map(quote, argv)), timeout=240)
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
        require(files == installed + [MIGRATION], 'Candidate migrations are not schema050 plus 051')
        for name in installed:
            prior = self.execute(['git', 'show', BASE_API_SHA + ':db/cloud/migrations/' + name])
            require((REPO / 'db/cloud/migrations' / name).read_bytes() == prior, 'An installed migration was edited: ' + name)
        for name in ['infra/staging/device-registry-owner.mjs', 'infra/staging/device-registry-grants.mjs']:
            require((REPO / name).is_file(), 'Candidate is missing ' + name)

    def deploy_baseline(self):
        a = self.args
        require(re.fullmatch('[a-f0-9]{64}', a.expected_compose_sha256 or ''),
                '--expected-compose-sha256 must be the SHA-256 of the live API compose')
        require(self.running_revision() == BASE_API_SHA, 'Running API is not the installed cf25cb9e')
        require(self.api_image() == self.base_image, 'Running API image is not the installed image')
        require(self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + BASE_API_SHA) ==
                self.base_image, 'Rollback image differs from the installed image')
        require(self.remote('readlink -f ' + REMOTE + '/current') == f'{REMOTE}/releases/{BASE_API_SHA}', 'API pointer changed')
        compose = self.read_text(self.compose_path(BASE_API_SHA))
        require(digest(compose.encode()) == a.expected_compose_sha256, 'Live API compose differs from the reviewed hash')
        candidate = pepper_compose(compose)
        environment = self.runtime_environment()
        require(PEPPER not in environment, 'Running API already has a device pairing pepper')
        require(digest(self.environment[PEPPER].encode()) not in environment.values(),
                'Device pairing pepper reuses an existing API secret')
        self.role_restricted()
        files, checksums = self.candidate_migrations()
        pending = registry_plan(self.ledger(), files, checksums)
        self.neighbors()
        return {'compose': compose, 'candidate_compose': candidate, 'pending': pending, 'environment': environment}

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
            return self.plan('deploy', {'pending_migrations': base['pending'],
                                        'compose': 'carried over plus one private pepper reference'})
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0,
                'Protected backup identity required')
        with self.deployment_lock():
            self.deploy_apply(base)

    def prepare_artifacts(self, base):
        target = f'{REMOTE}/releases/{self.sha}'
        archive = self.execute(['git', 'archive', '--format=tar', self.sha, *market.ARCHIVE_PATHS])
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}', input=archive, timeout=180)
        # The pepper travels over ssh stdin only, never on a command line or in local evidence.
        self.remote('python3 -c ' + quote(release_env_program()) + ' ' + ' '.join(map(quote, [
            f'{REMOTE}/releases/{BASE_API_SHA}/release.env', target + '/release.env', self.sha, BASE_API_SHA, PEPPER])),
            input=json.dumps(self.environment))
        self.write_remote(self.compose_path(self.sha), base['candidate_compose'])
        self.remote('! docker image inspect pickchick-api:' + self.sha + ' >/dev/null 2>&1')
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} '
                            f'-t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Docker build did not return one image ID')
        self.remote(market.api_compose(self.sha) + ' config --quiet')
        return {'image_id': image, 'archive_sha256': digest(archive),
                'compose_sha256': digest(base['candidate_compose'].encode()),
                'release_env_sha256': self.file_hashes([target + '/release.env'])[target + '/release.env']}

    def verify_prepared(self, prepared, base):
        target = f'{REMOTE}/releases/{self.sha}'
        require(prepared['compose_sha256'] == digest(base['candidate_compose'].encode()), 'Prepared candidate differs from today’s')
        require(digest(self.read_text(self.compose_path(self.sha)).encode()) == prepared['compose_sha256'],
                'Prepared remote compose changed')
        require(self.file_hashes([target + '/release.env'])[target + '/release.env'] == prepared['release_env_sha256'],
                'Prepared release.env changed')
        require(self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + self.sha) ==
                prepared['image_id'], 'Prepared API image changed')

    def registry_route(self):
        """The new route answers (401 without a manager token), not the 404 of an old API."""
        status, _ = self.http(f'/v1/admin/backoffice/branches/{self.branch_id}/devices', public=False)
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
            um.verify_acl_change(before['acl'], self.acl(), added=EXISTING_TABLE_ACL, new_tables=NEW_TABLES,
                                 exact_new=EXACT_NEW_ACL, present=REQUIRED_ACL)
            um.verify_availability(before['availability'], self.availability_rows())
            require(self.neighbors() == before['neighbors'], 'Neighbour containers changed (QR worker, bank bridge, database)')
            stage = 'api'
            self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.ready()
            require(self.api_image() == prepared['image_id'], 'Running image differs from the prepared image')
            require(self.running_revision() == self.sha, 'Running API revision differs from the candidate')
            verify_pepper_environment(before['environment'], self.runtime_environment(), self.environment[PEPPER])
            require(self.http_json('/v1/capabilities', public=False) == before['capabilities'], 'API capabilities changed')
            require(self.registry_route() in (401, 403), 'Device registry route is not served by the new API')
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
                          'flags': 'unchanged', 'pepper': 'configured', 'backup_restore': 'passed'}), flush=True)

    def rollback_deploy(self, stage):
        """Previous API back (its compose and release.env never had the pepper); schema 051 retained."""
        try:
            if self.remote('readlink -f ' + REMOTE + '/current') != f'{REMOTE}/releases/{BASE_API_SHA}':
                self.switch(REMOTE + '/current', f'{REMOTE}/releases/{self.sha}', f'{REMOTE}/releases/{BASE_API_SHA}')
            self.remote(market.api_compose(BASE_API_SHA) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.ready()
            require(self.running_revision() == BASE_API_SHA, 'Rollback API revision differs')
            require(self.api_image() == self.base_image, 'Rollback API image differs')
            require(PEPPER not in self.runtime_environment(), 'Rollback API still carries the pepper')
            self.save('rollback.json', {'stage': stage, 'api': BASE_API_SHA, 'schema': 'retained 051'})
        except Exception:
            raise market.CommandUncertain('Rollback unverified; deployment lock retained') from None


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('sha')
    p.add_argument('--branch', required=True, help='pushed git branch of the SHA')
    p.add_argument('--branch-id', required=True, help='catalog branch UUID of the restaurant')
    p.add_argument('--base-image', required=True, help='image ID of the installed cf25cb9e API (sha256:...)')
    p.add_argument('--expected-compose-sha256', required=True)
    p.add_argument('--environment', type=Path, required=True,
                   help='private 0600 JSON {"DEVICE_PAIRING_PEPPER": "<64 hex>"} made by the owner')
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
