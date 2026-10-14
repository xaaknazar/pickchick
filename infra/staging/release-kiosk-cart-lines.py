#!/usr/bin/env python3
"""Narrow kiosk line-count release on installed 5b6f/schema058.

Default is inspection. Immutable source/full green CI, exact live pins, shared
release lock and encrypted backup with isolated restore remain mandatory. Only
API changes; no migration, catalog publication, prices, payment request or bank
worker restart. Old-reader rollback is refused after a >200-line snapshot exists.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

spec = importlib.util.spec_from_file_location('kiosk_cart_parent', Path(__file__).with_name('release-workforce-edit.py'))
e = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = e
spec.loader.exec_module(e)
w, lm, base, market = e.w, e.lm, e.base, e.market
require, digest, quote, REMOTE = e.require, e.digest, e.quote, e.REMOTE
BASELINE = '5b6f846b80785f915e9f8dd7d45fa72fd4bc13ee'
e.BASELINE = w.BASELINE = lm.BASELINE = BASELINE
# Byte-reviewed runtime changes only. Historical release helpers stay unchanged.
SOURCE_HASHES = {'packages/commerce-core/src/kiosk-checkout.ts': '50935811f95574d356cc31db2c76e9df6142ce7addb83b9894b1499f8a73d971', 'packages/catalog-pricing/src/model.ts': '687e7dba8abaefeb0bfe667bdc3fbb07293fcda4477aedc1175e4eb320c82fa9', 'packages/commerce-core/src/model.ts': '8f85e58bb53eb3a021474c0d8d89e3f8a67f2ae58d3226c49eb49e6d2f93cee3', 'packages/contracts/src/customer-commerce.ts': '2dacc05e77e57e09fa6fbc9375bc349618e829295d99676587673f77cc23fa44'}
SOURCE_HASHES['packages/edge-fulfillment/src/model.ts'] = 'fc0534777640a2ffb42d60f057c0981fb010eddef730429a630fec181bd24c08'
SOURCE_HASHES['packages/contracts/openapi.json'] = '14092aedd25f0bc327210bd154890fb70c01971df10d6abcd45f0eeb9271d012'
SUPPORT_PATHS = {
    'packages/edge-fulfillment/tests/postgres.test.mjs',
    'packages/commerce-core/tests/kiosk-checkout.postgres.test.mjs',
    'infra/staging/release-kiosk-cart-lines.py',
    'tests/operations/test_kiosk_cart_lines_release.py',
    'docs/operations/kiosk-cart-lines-api-2026-10-13.md',
}


def validate_source(changed, hashes):
    require(set(changed) <= set(SOURCE_HASHES) | SUPPORT_PATHS, 'Unreviewed release path')
    require(hashes == SOURCE_HASHES, 'Reviewed runtime bytes differ')


class Release(e.Release):
    def __init__(self, args):
        require(args.expected_api_sha == BASELINE, 'Exact installed 5b6f baseline required')
        require(re.fullmatch('[a-f0-9]{40}', args.expected_public_sha), 'Reviewed public SHA required')
        for name in ('expected_compose_sha256', 'expected_gateway_sha256'):
            require(re.fullmatch('[a-f0-9]{64}', getattr(args, name, '')), 'Reviewed hash required')
        require(re.fullmatch('sha256:[a-f0-9]{64}', args.expected_api_image), 'Reviewed API image required')
        profile = market.ReleaseProfile('kiosk-cart-lines-schema058', BASELINE, args.expected_public_sha,
            57, (), base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()),
            frozenset(), 'kiosk-cart-lines-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def source_checks(self):
        market.Release.source_checks(self)
        self.execute(['git', 'merge-base', '--is-ancestor', BASELINE, self.sha])
        changed = self.git('diff', '--name-only', BASELINE, self.sha).splitlines()
        hashes = {name: digest((market.REPO/name).read_bytes()) for name in SOURCE_HASHES}
        validate_source(changed, hashes)

    def baseline_migrations(self):
        names = sorted(Path(p).name for p in self.git('ls-tree', '-r', '--name-only', BASELINE,
            '--', 'db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require([int(n[:3]) for n in names] == list(range(1, 41)) + list(range(42, 59)), 'Exact schema058 required')
        return names

    def current(self, proof, flag=True):
        require(self.running_revision() == self.sha and self.api_image() == proof['artifacts']['image'], 'Installed API differs')
        require(self.remote('readlink -f '+REMOTE+'/current') == REMOTE+'/releases/'+self.sha, 'API pointer differs')
        require(self.ledger() == self.expected_ledger(), 'Migration ledger differs')
        self.verify_acl(proof)
        require(self.neighbors() == proof['before']['neighbors'], 'Neighbor container changed')
        require(self.rollback_artifacts() == proof['before']['rollback'], 'Rollback artifacts changed')
        require(self.artifacts() == proof['artifacts'], 'Candidate bytes changed')
        base.verify_environment_delta(proof['before']['environment'], self.runtime_environment(), {}, release_sha_may_change=True)
        self.runtime_acl()
        self.verify_public()
        require(self.http_json('/v1/capabilities', public=False) == proof['before']['capabilities'], 'Capabilities changed')

    def compatible_rollback(self):
        query = "SELECT count(*)::int AS n FROM (SELECT snapshot FROM commerce_quotes UNION ALL SELECT snapshot FROM commerce_orders) s WHERE jsonb_array_length(snapshot->'lines') > 200"
        result = json.loads(self.psql(market.DB, "SELECT row_to_json(x) FROM ("+query+") x"))
        require(result == {'n': 0}, 'Old reader cannot read large orders; preserve data and use a compatible forward fix')

    def apply(self):
        # Parent retains backup/restore, baseline recheck, no-replay record, CAS,
        # unchanged ACL/compose/environment/neighbors and guarded rollback.
        super().apply()
        if self.args.apply:
            record = json.loads((self.private/'applied.json').read_text())
            record['schema'] = 58
            self.save('applied.json', record)

    def restore(self, proof):
        super().restore(proof)
        record = json.loads((self.private/'rollback.json').read_text())
        record['schema_retained'] = 58
        self.save('rollback.json', record)


def main():
    os.umask(0o077)
    release = Release(w.parse())
    try:
        release.run()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error, market.GuardFailure) else 'Stopped; inspect private evidence and retained lock.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
