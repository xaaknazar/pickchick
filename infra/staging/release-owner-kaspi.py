#!/usr/bin/env python3
"""Repeated owner checkout after the completed 100 KZT control payment.

Keeps exact CI, encrypted backup/restore, ACL checks and release locks.
Uses a separate immutable environment file so rollback retains the first pilot.
"""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('owner_kaspi_base', Path(__file__).with_name('release-mobile-kaspi.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require = base.market, base.require
BASELINE = '1c9d9d4a5f5c8e89550fe5d29f129e9add95a826'
PUBLIC_BASELINE = 'eeff0003d2a8bae22d0e3ff35c840bacb6cace2c'
MAX_MINOR = '10000000'  # 100,000 KZT per order; menu prices are never discounted here.


def checkout_environment(raw):
    lines = [line for line in raw.splitlines() if line and not line.startswith('#')]
    require(all('=' in line for line in lines), 'Invalid checkout environment')
    env = dict(line.split('=', 1) for line in lines)
    require(len(env) == len(lines) and set(env) == base.FIELDS | {'CUSTOMER_KASPI_PILOT_REPEAT_ORDERS'},
            'Unexpected owner checkout field or duplicate')
    require(env['CUSTOMER_KASPI_PILOT_REPEAT_ORDERS'] == 'true' and
            env['CUSTOMER_KASPI_PILOT_MAX_MINOR'] == MAX_MINOR, 'Unreviewed repeat/amount policy')
    original = {k: v for k, v in env.items() if k in base.FIELDS}
    original['CUSTOMER_KASPI_PILOT_MAX_MINOR'] = '10000'
    base.checkout_environment('\n'.join(k+'='+v for k, v in original.items()))
    return env


class Release(base.Release):
    checkout_file = market.REMOTE + '/secrets/customer-kaspi-repeat.env'
    validate_checkout = staticmethod(checkout_environment)

    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == base.GATEWAY_BASELINE, 'Unreviewed owner rollout baseline')
        profile = market.ReleaseProfile('owner-kaspi-schema028', BASELINE, PUBLIC_BASELINE,
            28, (), market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'owner-kaspi-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        return BASELINE

    def prepare_api(self, target):
        # Scope must equal the already approved first pilot; no new customer or seller.
        existing = base.checkout_environment(self.remote('cat ' + base.quote(base.CHECKOUT_FILE)))
        candidate = self.validate_checkout(self.args.checkout_env.read_text())
        for key in base.FIELDS - {'CUSTOMER_KASPI_PILOT_MAX_MINOR', 'CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE'}:
            require(candidate[key] == existing[key], 'Owner rollout cannot change assigned scope')
        require(self.psql(market.DB, "SELECT count(*) FROM commerce_captures WHERE amount_minor=10000") == '1',
                'Initial control capture must be reconciled first')
        super().prepare_api(target)


if __name__ == '__main__':
    base.Release = Release
    base.main()
