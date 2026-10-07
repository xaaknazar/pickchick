#!/usr/bin/env python3
"""Atomic finance corrections and visible history; API368/publicbc21, schema044.

Uses the existing finance backup/isolated restore, maintenance, lock/CAS and
fail-closed rollback procedures. No migration, ACL, payment or gateway change.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys

spec = importlib.util.spec_from_file_location('finance_history_dashboard', Path(__file__).with_name('release-finance-dashboard.py'))
dashboard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = dashboard
spec.loader.exec_module(dashboard)
finance, market, base = dashboard.finance, dashboard.market, dashboard.base
require, digest = dashboard.require, dashboard.digest
API = '368c4e8f56b4285712537a24207ad55907537e43'
PUBLIC = 'bc21c96c533122427bc6ec92e6d1d0ce6d767ba3'
DEVELOPMENT = '926c75301f4e93ccfa607908db8760dc6dcb6e49'
GATEWAY = dashboard.GATEWAY

# These modules are private instances; historical profiles on disk stay intact.
dashboard.BASELINE = finance.BASELINE = API
finance.PUBLIC_BASELINE = PUBLIC


def verify_changed_paths(paths):
    exact = {'packages/backoffice-core/src/finance.ts',
             'apps/backoffice/src/finance.ts', 'apps/backoffice/src/finance-model.ts',
             'apps/backoffice/src/styles.css', 'infra/staging/release-finance-history.py',
             'tests/operations/test_finance_history_release.py', 'docs/operations/finance-history.md'}
    require(all(p in exact or p.startswith(('tests/backoffice/finance', 'docs/operations/images/finance-history/'))
                for p in paths), 'Only reviewed finance history changes may ship')


class Release(dashboard.Release):
    def __init__(self, args):
        require(sys.version_info >= (3, 12), 'Python 3.12 required')
        require((args.expected_api_sha, args.expected_public_sha, args.expected_gateway_sha256) ==
                (API, PUBLIC, GATEWAY), 'Exact API368/publicbc21 baseline required')
        self.baseline_schema = 43
        profile = market.ReleaseProfile('finance-history-schema044', API, PUBLIC, 43, (),
            base.CI_JOBS, frozenset(), 'finance-history-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        return PUBLIC

    def source_checks(self):
        market.Release.source_checks(self)
        self.git('merge-base', '--is-ancestor', DEVELOPMENT, self.sha)
        verify_changed_paths(self.git('diff', '--name-only', DEVELOPMENT, self.sha).splitlines())
        # The shared baseline additionally contains the other Mac's kiosk UI and
        # build dependencies. Its server/domain/database sources equal installed API.
        require(not self.git('diff', '--name-only', API, DEVELOPMENT, '--',
                             'services', 'packages', 'db', 'infra/staging/Dockerfile').strip(),
                'Shared baseline contains an unreviewed server/domain change')
        package = json.loads((market.REPO/'package.json').read_text())
        require(self.execute(['pnpm', '--version']).decode().strip() == package['packageManager'].split('@')[1],
                'Pinned pnpm required')
        require(self.execute(['node', '--version']).decode().strip().lstrip('v') == (market.REPO/'.node-version').read_text().strip(),
                'Pinned Node required')
        key = self.args.backup_identity
        require(key and key.is_file() and not any(p.is_symlink() for p in [key, *key.parents])
                and key.stat().st_mode & 0o077 == 0, 'Protected local backup identity required')
        self.backup_recipient = self.execute(['age-keygen', '-y', str(key)]).decode().strip()
        require(re.fullmatch('age1[0-9a-z]{58}', self.backup_recipient) is not None, 'Native age recipient required')

    def save(self, name, value):
        if name == 'prepared.json':
            value = {**value, 'finance_backup_recipient': self.backup_recipient}
        if name in {'result.json', 'preflight.json'}:
            value = {**value, 'baseline_api': API, 'baseline_public': PUBLIC,
                     'migration_files': 43, 'last_migration': 44, 'migrations_applied': 0,
                     'qr_worker_enabled': False, 'gateway_routes_preserved': True,
                     'finance_corrections_enabled': True}
        return finance.Release.save(self, name, value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'prepare', 'apply', 'rollback'])
    for name in ['sha', 'branch', 'expected-api-sha', 'expected-public-sha', 'expected-gateway-sha256']:
        parser.add_argument('--'+name, required=True)
    for name in ['ssh-key', 'backup-identity', 'ci-proof']:
        parser.add_argument('--'+name, type=Path, required=name != 'ci-proof')
    parser.add_argument('--ci-run'); parser.add_argument('--owner-id')
    args = parser.parse_args(); release = Release(args)
    try:
        if args.action == 'rollback': release.resume_owned_rollback()
        else:
            require(args.owner_id is None, 'Owner UUID is rollback-only')
            if args.action == 'preflight': release.preflight()
            else:
                with release.deployment_lock(): getattr(release, args.action)()
    except Exception as error:
        release.record_error(error)
        if args.action == 'preflight':
            print('Read-only preflight stopped; inspect private diagnostics.', file=sys.stderr)
        else:
            ingress = release.retain_failure(error)
            print('Finance release stopped; deployment lock retained; ingress: '+ingress, file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__': main()
