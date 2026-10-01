#!/usr/bin/env python3
"""Deploy the readable Kaspi invoice message while preserving the current checkout policy."""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('readable_all_kaspi', Path(__file__).with_name('release-all-kaspi.py'))
rollout = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rollout
spec.loader.exec_module(rollout)
market, require = rollout.market, rollout.require
BASELINE = 'e393c3c8045d175799b87582af339f39d1c70248'
PUBLIC_BASELINE = 'aa54f6e4958c8d928667bf6a8d0a50845f4c3d34'
MIGRATION = '029_cloud_kaspi_invoice_comment.sql'


class Release(rollout.Release):
    additions = {"commerce_kaspi_invoices": ["invoice_comment"]}
    snapshot = rollout.owner.base.base.pilot.Release.snapshot

    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == rollout.owner.base.GATEWAY_BASELINE, 'Unreviewed readable invoice baseline')
        profile = market.ReleaseProfile('kaspi-readable-schema029', BASELINE, PUBLIC_BASELINE,
            28, (MIGRATION,), market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'kaspi-readable-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        return BASELINE

    def prepare_api(self, target):
        existing = self.validate_checkout(self.remote('cat ' + rollout.owner.base.quote(self.checkout_file)))
        candidate = self.validate_checkout(self.args.checkout_env.read_text())
        require(candidate == existing, 'Readable invoices must preserve the entire live rollout policy')
        rollout.MobileRelease.prepare_api(self, target)

    def verify_data(self, before):
        expected = before['ledger'] + [{'version': MIGRATION, 'scope': 'cloud',
            'checksum': market.digest((market.REPO/'db/cloud/migrations'/MIGRATION).read_bytes())}]
        require(self.ledger() == expected, 'Unexpected migration delta')
        after = self.snapshot()
        after['tables']['schema_migrations'] = before['data']['tables']['schema_migrations']
        market.compare_existing(before['data'], after)
        require(self.acl() == before['acl'], 'API permissions changed')
        require(self.psql(market.DB, 'SELECT count(*) FROM commerce_kaspi_invoices WHERE invoice_comment IS NOT NULL') == '0',
                'Existing invoice message changed during maintenance')


if __name__ == '__main__':
    rollout.owner.base.Release = Release
    rollout.owner.base.main()
