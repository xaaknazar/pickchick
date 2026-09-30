#!/usr/bin/env python3
"""Enable app checkout for every verified customer, preserving the owner rollout.

No identity, seller, prices, fiscal state, bank session or kitchen changes.
Retains exact-source CI, maintenance, backup/restore and data/ACL checks.
"""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('all_kaspi_owner', Path(__file__).with_name('release-owner-kaspi.py'))
owner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = owner
spec.loader.exec_module(owner)
market, require = owner.market, owner.require
MobileRelease = owner.base.Release
BASELINE = 'e752c8ea92784ecf5716a3e26c384a39ab3e63bc'
PUBLIC_BASELINE = '0c60024172403996b7195a4924cd976dac566833'
AUDIENCE = 'CUSTOMER_KASPI_ALL_VERIFIED_CUSTOMERS'
APPROVAL = 'owner-approved-all-app-customers-2026-09-30'


def checkout_environment(raw):
    lines = [line for line in raw.splitlines() if line and not line.startswith('#')]
    require(all('=' in line for line in lines), 'Invalid checkout environment')
    env = dict(line.split('=', 1) for line in lines)
    require(len(env) == len(lines) and env.get(AUDIENCE) == 'true', 'Explicit verified-customer audience required')
    require(env.get('CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE') == APPROVAL, 'All-customer approval required')
    owner.checkout_environment('\n'.join(k+'='+v for k, v in env.items() if k != AUDIENCE))
    return env


class Release(owner.Release):
    checkout_file = market.REMOTE + '/secrets/customer-kaspi-all.env'
    validate_checkout = staticmethod(checkout_environment)

    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == owner.base.GATEWAY_BASELINE, 'Unreviewed app-wide rollout baseline')
        profile = market.ReleaseProfile('all-kaspi-schema028', BASELINE, PUBLIC_BASELINE,
            28, (), market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'all-kaspi-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        return BASELINE

    def prepare_api(self, target):
        existing = owner.checkout_environment(self.remote('cat ' + owner.base.quote(owner.Release.checkout_file)))
        candidate = self.validate_checkout(self.args.checkout_env.read_text())
        for key in existing.keys() - {'CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE'}:
            require(candidate[key] == existing[key], 'Audience rollout cannot change seller, bank, price limit or repeat policy')
        MobileRelease.prepare_api(self, target)


if __name__ == '__main__':
    owner.base.Release = Release
    owner.base.main()
