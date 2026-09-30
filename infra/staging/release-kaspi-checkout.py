#!/usr/bin/env python3
"""Guarded schema020 -> 027, authenticated checkout routes; invoicing stays disabled.

Reuses verified maintenance, encrypted backup/restore, immutable artifacts, least
privilege validation and exact-SHA CI. Does not provision bank/customer/edge IDs.
"""
import argparse
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('checkout_pilot', Path(__file__).with_name('release-server-pilot.py'))
pilot = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pilot
spec.loader.exec_module(pilot)
market, require = pilot.market, pilot.require
MIGRATIONS = pilot.MIGRATIONS + ('026_cloud_kaspi_remote.sql', '027_cloud_deferred_fiscal_pilot.sql')


def extend_checkout(text):
    require('@customer_checkout' not in text and text.count('\t@health {') == 1, 'Checkout gateway baseline differs')
    marker = 'not path /v1/auth/*' if 'not path /v1/auth/*' in text else 'not path /v1/content/*'
    require(text.count(marker) == 1, 'Data header boundary differs')
    text = text.replace(marker, marker.replace('not path ', 'not path /v1/customer-checkout/* '), 1)
    block = '''
\t@customer_checkout_preflight {
\t\tmethod OPTIONS
\t\tpath /v1/customer-checkout/*
\t}
\thandle @customer_checkout_preflight {
\t\theader Access-Control-Allow-Origin *
\t\theader Access-Control-Allow-Methods GET,POST
\t\theader Access-Control-Allow-Headers Authorization,Content-Type
\t\theader Cache-Control no-store
\t\trespond "" 204
\t}
\t@customer_checkout {
\t\texpression `(method('GET') && path('/v1/customer-checkout/config', '/v1/customer-checkout/orders')) || (method('POST') && path('/v1/customer-checkout/quotes', '/v1/customer-checkout/orders')) || (method('GET') && path_regexp('^/v1/customer-checkout/orders/[a-f0-9-]{36}(/watch)?$')) || (method('POST') && path_regexp('^/v1/customer-checkout/orders/[a-f0-9-]{36}/payment$'))`
\t}
\thandle @customer_checkout {
\t\theader X-PickChick-Data customer
\t\theader Cache-Control no-store
\t\theader Access-Control-Allow-Origin *
\t\treverse_proxy pickchick-staging-api-1:3100 {
\t\t\theader_up -Cookie
\t\t\theader_up -X-Device-Id
\t\t\theader_up X-Forwarded-For {client_ip}
\t\t\ttransport http {
\t\t\t\tdial_timeout 2s
\t\t\t\tresponse_header_timeout 25s
\t\t\t}
\t\t}
\t}
'''
    return text.replace('\t@health {', block+'\n\t@health {', 1)


class Release(pilot.Release):
    migrations = MIGRATIONS
    new_tables = pilot.NEW_TABLES | {'commerce_kaspi_invoices'}
    additions = {**pilot.ADDITIONS, 'commerce_orders': ['fiscal_policy', 'fiscal_deferral_reference']}

    def __init__(self, args):
        require(args.expected_api_sha == pilot.BASELINE, 'Unexpected schema020 baseline')
        profile = market.ReleaseProfile('kaspi-checkout-020-027', pilot.BASELINE,
            args.expected_public_sha, 20, MIGRATIONS, market.TRANSPORT_PROFILE.ci_jobs,
            frozenset({'test_service_shifts_sequence_seq'}), 'kaspi-checkout-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        # bcf4fe6 is the reviewed public overlay (kitchen/roadmap); its preserved
        # base bundle is 4ee0b80. Do not equate overlay provenance with old assets.
        require(self.profile.old_web == 'bcf4fe624ba587208afb37e212bc8a49df6f6dea', 'Unreviewed public overlay')
        return pilot.BASELINE

    def prepare_api(self, target):
        if self.args.enable_customer_auth:
            super().prepare_api(target)
        else:
            # Preserve disabled identity; do not publish unfinished legal documents.
            source=(market.REPO/'infra/staging/compose.yaml').read_text()
            self.remote('python3 -c '+pilot.quote('from pathlib import Path;import sys;Path(sys.argv[1]).write_text(sys.stdin.read())')+' '+pilot.quote(target+'/infra/staging/compose.yaml'),input=source)
        # Explicitly disabled until a separately reviewed owner/merchant/edge activation.
        command = "from pathlib import Path;import sys;p=Path(sys.argv[1]);s=p.read_text();assert s.count('      APP_ENV: staging')==2;p.write_text(s.replace('      APP_ENV: staging','      CUSTOMER_KASPI_PILOT_ENABLED: \\\"false\\\"\\n      APP_ENV: staging'))"
        self.remote('python3 -c '+pilot.quote(command)+' '+pilot.quote(target+'/infra/staging/compose.yaml'))

    def gateway_candidate(self, text):
        return extend_checkout(super().gateway_candidate(text) if self.args.enable_customer_auth else text)

    def prepare_public(self, target, manifest):
        return super().prepare_public(target, manifest) if self.args.enable_customer_auth else manifest

    def prepared_artifacts(self, manifest):
        return super().prepared_artifacts(manifest) if self.args.enable_customer_auth else market.Release.prepared_artifacts(self, manifest)

    def verify_runtime_acl(self, before, after):
        pilot.verify_acl(before, after, self.args.enable_customer_auth)

    def verify_capabilities(self, caps):
        if self.args.enable_customer_auth:
            super().verify_capabilities(caps)
        else:
            pilot.daily.Release.verify_capabilities(self, caps)

    def verify_data(self, before):
        super().verify_data(before)
        require(self.psql(market.DB, 'SELECT count(*) FROM commerce_kaspi_invoices') == '0', 'Unexpected bank invoice during installation')
        require(self.psql(market.DB, "SELECT count(*) FROM commerce_orders WHERE fiscal_policy<>'required' OR fiscal_deferral_reference IS NOT NULL") == '0', 'Existing fiscal protection changed')

    def verify_public(self):
        if self.args.enable_customer_auth:
            super().verify_public()
        else:
            require(self.http_json('/kitchen-live/health')['sourceSha']==self.kitchen_before['sourceSha'],'Kitchen bridge was replaced')
        for path in ['/v1/customer-checkout/config', '/v1/customer-checkout/orders']:
            require(self.http(path)[0] == 401, 'Anonymous checkout access or missing route')
        require(self.http('/v1/customer-checkout/orders', method='POST')[0] == 401, 'Anonymous order accepted')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare','apply'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']:
        parser.add_argument('--'+name, required=True)
    for name in ['ssh-key','backup-identity','ci-proof','auth-env','legal-dir']:
        parser.add_argument('--'+name, type=Path, required=name == 'ssh-key')
    parser.add_argument('--ci-run')
    parser.add_argument('--enable-customer-auth', action='store_true', help='Requires completed approved legal pages; off by default')
    args = parser.parse_args()
    if args.enable_customer_auth:
        require(args.auth_env is not None and args.legal_dir is not None, 'Identity needs approved documents and protected settings')
    release = Release(args)
    try:
        with release.deployment_lock():
            getattr(release, args.action)()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error, market.GuardFailure) else 'Stopped; private diagnostics and owned lock retained.', file=sys.stderr)
        raise SystemExit(1)

if __name__ == '__main__':
    main()
