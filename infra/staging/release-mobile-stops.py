#!/usr/bin/env python3
"""Release cashier availability projection without changing payment policy or existing data."""
import importlib.util
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location('stops_readable', Path(__file__).with_name('release-kaspi-readable.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require = base.market, base.require
BASELINE = '289da31b47915b2d5cc3bb1813a4df613eb265b2'
PUBLIC_BASELINE = '0c8f5f189bef8da5eb50c751d71a8ede12e0de82'
MIGRATION = '030_cloud_branch_availability.sql'

class Release(base.Release):
    snapshot = market.Release.snapshot
    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == base.rollout.owner.base.GATEWAY_BASELINE, 'Unreviewed availability baseline')
        profile = market.ReleaseProfile('mobile-stops-schema030', BASELINE, PUBLIC_BASELINE,
            29, (MIGRATION,), market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'mobile-stops-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)
    def web_manifest_source(self):
        return BASELINE
    def gateway_candidate(self, text):
        old = "path('/v1/customer-checkout/config', '/v1/customer-checkout/orders')"
        require(text.count(old) == 1 and '/v1/customer-checkout/availability' not in text, 'Unexpected availability gateway baseline')
        return text.replace(old, "path('/v1/customer-checkout/config', '/v1/customer-checkout/orders', '/v1/customer-checkout/availability')")
    def verify_data(self, before):
        expected = before['ledger'] + [{'version':MIGRATION,'scope':'cloud','checksum':market.digest((market.REPO/'db/cloud/migrations'/MIGRATION).read_bytes())}]
        require(self.ledger() == expected, 'Unexpected migration delta')
        market.compare_existing(before['data'],self.snapshot(),additions=True,new_tables={'cloud_branch_availability'})
        after = self.acl()
        added = [r for r in after if r['name']=='cloud_branch_availability']
        require([r for r in after if r['name']!='cloud_branch_availability'] == before['acl'], 'Existing API permissions changed')
        require(added == [{'name':'cloud_branch_availability','kind':'r','column':None,'privilege':p,'grantable':False} for p in ['INSERT','SELECT','UPDATE']], 'Unexpected availability ACL')

if __name__ == '__main__':
    base.rollout.owner.base.Release = Release
    base.rollout.owner.base.main()
