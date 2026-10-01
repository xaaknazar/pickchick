#!/usr/bin/env python3
"""Deploy the three-minute invoice flow while preserving the current checkout policy."""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('expiry_all_kaspi', Path(__file__).with_name('release-all-kaspi.py'))
rollout = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rollout
spec.loader.exec_module(rollout)
market, require = rollout.market, rollout.require
BASELINE = '32b28db2aafd0f04a5c134787ded251aff6ca55e'
PUBLIC_BASELINE = 'feb550cea8848454572065981231b59ca11a47fd'


class Release(rollout.Release):
    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == rollout.owner.base.GATEWAY_BASELINE, 'Unreviewed invoice expiry baseline')
        profile = market.ReleaseProfile('kaspi-expiry-schema028', BASELINE, PUBLIC_BASELINE,
            28, (), market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'kaspi-expiry-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        return BASELINE

    def prepare_api(self, target):
        existing = self.validate_checkout(self.remote('cat ' + rollout.owner.base.quote(self.checkout_file)))
        candidate = self.validate_checkout(self.args.checkout_env.read_text())
        require(candidate == existing, 'Invoice expiry must preserve the entire live rollout policy')
        rollout.MobileRelease.prepare_api(self, target)


if __name__ == '__main__':
    rollout.owner.base.Release = Release
    rollout.owner.base.main()
