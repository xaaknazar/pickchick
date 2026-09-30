#!/usr/bin/env python3
"""Guarded Telegram four-digit update, schema027 -> 028. Preserve sessions and payment settings."""
import argparse
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('auth_four_base', Path(__file__).with_name('release-telegram-auth.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require = base.market, base.require
BASELINE = '2661877b981ed5ecc77f265892c836f10d4bd3ee'
PUBLIC_BASELINE = '14e95c4fdb72f58d700a6fc61638e57133dfeef7'
GATEWAY_BASELINE = '9359358675c93db88ac13f01b68c1c919c5a4f4909a316081f4d893a911be09b'
MIGRATION = '028_cloud_otp_code_length.sql'

class Release(base.Release):
    additions = {'identity_otp_challenges': ['code_length']}
    snapshot = base.pilot.Release.snapshot

    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == GATEWAY_BASELINE, 'Unreviewed four-digit baseline')
        profile = market.ReleaseProfile('auth-four-digit-027-028', BASELINE, PUBLIC_BASELINE,
            27, (MIGRATION,), market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'auth-four-digit-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        return BASELINE

    def gateway_candidate(self, text):
        return text

    def verify_data(self, before):
        expected = before['ledger'] + [{'version': MIGRATION, 'scope': 'cloud',
            'checksum': market.digest((market.REPO/'db/cloud/migrations'/MIGRATION).read_bytes())}]
        require(self.ledger() == expected, 'Unexpected migration delta')
        after = self.snapshot()
        after['tables']['schema_migrations'] = before['data']['tables']['schema_migrations']
        market.compare_existing(before['data'], after)
        require(self.acl() == before['acl'], 'Runtime permissions changed')
        # No login traffic during maintenance; every pre-existing challenge was six-digit.
        require(self.psql(market.DB, 'SELECT count(*) FROM identity_otp_challenges WHERE code_length<>6') == '0',
                'Existing OTP length changed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'apply'])
    for name in ['sha', 'branch', 'expected-api-sha', 'expected-public-sha', 'expected-gateway-sha256']:
        parser.add_argument('--'+name, required=True)
    for name in ['ssh-key', 'backup-identity', 'ci-proof', 'auth-env', 'legal-dir']:
        parser.add_argument('--'+name, type=Path, required=name in ['ssh-key', 'auth-env', 'legal-dir'])
    parser.add_argument('--ci-run')
    args = parser.parse_args()
    release = Release(args)
    try:
        with release.deployment_lock():
            getattr(release, args.action)()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error, market.GuardFailure) else
              'Stopped; private diagnostics and owned lock retained.', file=sys.stderr)
        raise SystemExit(1)

if __name__ == '__main__':
    main()
