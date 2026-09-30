#!/usr/bin/env python3
"""Activate Telegram identity on reviewed schema027; bank and kitchen stay unchanged.

Reuses immutable artifacts, exact-SHA CI, owned maintenance/cleanup locks,
backup + isolated restore, ACL/data fingerprints and pointer CAS from pilot.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys

spec = importlib.util.spec_from_file_location('telegram_identity_pilot', Path(__file__).with_name('release-server-pilot.py'))
pilot = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pilot
spec.loader.exec_module(pilot)
market, require, quote = pilot.market, pilot.require, pilot.quote
BASELINE = '2f3c3f3ddf8e09eea76a5ab4831e297a718572ed'
PUBLIC_BASELINE = 'bda246ffaf04cd99715c0bdb059840ac43b2c49e'
GATEWAY_BASELINE = 'af729c3faa9b4db0c27b70e1cd75a40f835ecb51eff959860ced0b314baa175c'


def gateway_candidate(text, outer_ip):
    marker = 'not path /v1/customer-checkout/* /v1/catalog/* /v1/admin/catalog/* /backoffice /backoffice/*'
    require(text.count(marker) == 1, 'Unexpected schema027 data header boundary')
    result = pilot.extend_gateway(text, outer_ip)
    result = result.replace(marker, marker + ' /v1/auth/* /v1/customers/* /legal/*', 1)
    # Never cache sessions, profiles, channel availability or one-time code responses.
    result = result.replace('\thandle @pilot_auth {\n', '\thandle @pilot_auth {\n\t\theader Cache-Control no-store\n', 1)
    return result


def verify_identity_acl(before, after):
    pilot.verify_acl(before, after)
    require([r for r in after if not r['name'].startswith('identity_')] ==
            [r for r in before if not r['name'].startswith('identity_')],
            'Non-identity privileges changed')


def validate_legal(directory):
    for name in ['terms', 'privacy']:
        p = directory / (name + '.html')
        require(p.is_file() and not p.is_symlink(), 'Published legal artifact missing')
        text = p.read_text()
        require(500 < len(text) < 200000 and pilot.VERSION in text and
                not any(s in text for s in ['{{', '[До публикации', '[после утверждения', 'уточняется перед публикацией']),
                'Legal artifact unfinished')
        require('<html' in text and '</html>' in text, 'Legal page must be complete HTML')


class Release(pilot.Release):
    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == GATEWAY_BASELINE, 'Unreviewed activation baseline')
        profile = market.ReleaseProfile('telegram-auth-schema027', BASELINE, PUBLIC_BASELINE,
            27, (), market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'telegram-auth-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    snapshot = market.Release.snapshot

    def web_manifest_source(self):
        return BASELINE  # Roadmap overlay advances the pointer, not operations provenance.

    def prepare(self):
        validate_legal(self.args.legal_dir)
        super().prepare()

    def prepare_api(self, target):
        super().prepare_api(target)
        program = "from pathlib import Path;import sys;p=Path(sys.argv[1]);s=p.read_text();assert s.count('      APP_ENV: staging')==2;p.write_text(s.replace('      APP_ENV: staging','      CUSTOMER_KASPI_PILOT_ENABLED: \\\"false\\\"\\n      APP_ENV: staging'))"
        self.remote('python3 -c ' + quote(program) + ' ' + quote(target + '/infra/staging/compose.yaml'))

    def gateway_candidate(self, text):
        return gateway_candidate(text, self.outer_ip)

    def verify_data(self, before):
        require(self.ledger() == before['ledger'], 'Identity activation must not migrate schema')
        market.compare_existing(before['data'], self.snapshot())
        verify_identity_acl(before['acl'], self.acl())

    def verify_public(self):
        super().verify_public()
        require(self.http('/v1/customer-checkout/config')[0] == 401, 'Checkout authorization changed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'apply'])
    for name in ['sha', 'branch', 'expected-api-sha', 'expected-public-sha', 'expected-gateway-sha256']:
        parser.add_argument('--' + name, required=True)
    for name in ['ssh-key', 'backup-identity', 'ci-proof', 'auth-env', 'legal-dir']:
        parser.add_argument('--' + name, type=Path, required=name in ['ssh-key', 'auth-env', 'legal-dir'])
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
