#!/usr/bin/env python3
"""Recover persisted checkout commands without changing the current rollout policy."""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('recovery_all_kaspi', Path(__file__).with_name('release-all-kaspi.py'))
rollout = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rollout
spec.loader.exec_module(rollout)
market, require = rollout.market, rollout.require
BASELINE = '8ecdc134839608d388bd5920287777d026d72962'
PUBLIC_BASELINE = '7fbf75969173dd9d9c9ec80bdf3579448802e92c'


class Release(rollout.Release):
    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == rollout.owner.base.GATEWAY_BASELINE, 'Unreviewed checkout recovery baseline')
        profile = market.ReleaseProfile('checkout-recovery-schema028', BASELINE, PUBLIC_BASELINE,
            28, (), market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'checkout-recovery-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        return BASELINE

    def prepare_api(self, target):
        existing = self.validate_checkout(self.remote('cat ' + rollout.owner.base.quote(self.checkout_file)))
        candidate = self.validate_checkout(self.args.checkout_env.read_text())
        require(candidate == existing, 'Checkout recovery must preserve the entire live rollout policy')
        rollout.MobileRelease.prepare_api(self, target)


if __name__ == '__main__':
    rollout.owner.base.Release = Release
    rollout.owner.base.main()
