#!/usr/bin/env python3
"""Release the checkout kitchen comment on cloud schema031; keep WhatsApp disabled."""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('comment_stops_base', Path(__file__).with_name('release-mobile-stops.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require = base.market, base.require
pilot = base.base.rollout.owner.base.base.pilot
BASELINE = 'e47702add67dff3d2d37462ae51adc693ff81449'
PUBLIC_BASELINE = '5733105b122808192be727b24617f22f558779b7'
GATEWAY_BASELINE = 'd50c27fa23f788972e0e81cfdeeafac1c33ed9fc75f6be7b845faa0e30712569'
MIGRATION = '031_cloud_otp_auto_channel.sql'


class Release(base.Release):
    # The migration adds and backfills only this column on existing OTP rows.
    additions = {'identity_otp_challenges': ['requested_channel']}
    snapshot = pilot.Release.snapshot

    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == GATEWAY_BASELINE, 'Unreviewed checkout-comment baseline')
        profile = market.ReleaseProfile('checkout-order-comment-schema031', BASELINE, PUBLIC_BASELINE,
            30, (MIGRATION,), market.TRANSPORT_PROFILE.ci_jobs, frozenset(),
            'checkout-order-comment-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        # The roadmap overlay advanced the pointer but retained the operations bundle.
        return BASELINE

    def gateway_candidate(self, text):
        return text

    def prepare_api(self, target):
        # The published consent still excludes WhatsApp. The strict auth-file
        # validator rejects every WhatsApp setting until its own approved release.
        pilot.auth_environment(self.args.auth_env.read_text())
        existing = self.validate_checkout(self.remote('cat ' + base.base.rollout.owner.base.quote(self.checkout_file)))
        candidate = self.validate_checkout(self.args.checkout_env.read_text())
        require(candidate == existing, 'Checkout-comment release must preserve the live payment policy')
        base.base.rollout.MobileRelease.prepare_api(self, target)

    def verify_data(self, before):
        expected = before['ledger'] + [{'version': MIGRATION, 'scope': 'cloud',
            'checksum': market.digest((market.REPO/'db/cloud/migrations'/MIGRATION).read_bytes())}]
        require(self.ledger() == expected, 'Unexpected migration delta')
        after = self.snapshot()
        after['tables']['schema_migrations'] = before['data']['tables']['schema_migrations']
        market.compare_existing(before['data'], after)
        require(self.acl() == before['acl'], 'Runtime permissions changed')
        require(self.psql(market.DB, 'SELECT count(*) FROM identity_otp_challenges '
                          'WHERE requested_channel<>delivery_channel') == '0',
                'Existing OTP requested channel changed')


if __name__ == '__main__':
    base.base.rollout.owner.base.Release = Release
    base.base.rollout.owner.base.main()
