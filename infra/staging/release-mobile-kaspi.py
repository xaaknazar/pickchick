#!/usr/bin/env python3
"""Same-schema owner-only Kaspi activation with retained identity, backup and CI gates.

This enables the authenticated checkout and private edge transport. It neither
creates an invoice nor installs the separately privileged bank worker.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('kaspi_activation_base', Path(__file__).with_name('release-telegram-auth.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require, quote = base.market, base.require, base.quote
BASELINE = '83faf7b3dd0cc912b373552181f0419d5515dab9'
PUBLIC_BASELINE = '8030295fe27bd0ec1c79e40ab1d541459a654391'
GATEWAY_BASELINE = '9359358675c93db88ac13f01b68c1c919c5a4f4909a316081f4d893a911be09b'
CHECKOUT_FILE = market.REMOTE + '/secrets/customer-kaspi-pilot.env'
FIELDS = {'CUSTOMER_KASPI_ORGANIZATION_ID', 'CUSTOMER_KASPI_BRANCH_ID',
          'KASPI_REMOTE_ACCOUNT_ID', 'CUSTOMER_KASPI_PILOT_CUSTOMER_IDS',
          'CUSTOMER_KASPI_PILOT_MAX_MINOR', 'CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE'}


def checkout_environment(raw):
    lines = [line for line in raw.splitlines() if line and not line.startswith('#')]
    require(all('=' in line for line in lines), 'Invalid checkout environment')
    env = dict(line.split('=', 1) for line in lines)
    require(len(env) == len(lines) and set(env) == FIELDS, 'Unexpected checkout field or duplicate')
    uuid = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
    for key in ['CUSTOMER_KASPI_ORGANIZATION_ID', 'CUSTOMER_KASPI_BRANCH_ID', 'KASPI_REMOTE_ACCOUNT_ID']:
        require(re.fullmatch(uuid, env[key]), 'Invalid assigned checkout scope')
    customers = env['CUSTOMER_KASPI_PILOT_CUSTOMER_IDS'].split(',')
    require(len(customers) == 1 and all(re.fullmatch(uuid, c) for c in customers), 'Initial pilot is owner only')
    require(env['CUSTOMER_KASPI_PILOT_MAX_MINOR'] == '10000', 'Initial control invoice limit must be 100 KZT')
    reference = env['CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE']
    require(3 <= len(reference) <= 250 and re.fullmatch(r'[a-zA-Z0-9._:/ -]+', reference), 'Explicit fiscal deferral reference required')
    return env


class Release(base.Release):
    snapshot = market.Release.snapshot
    checkout_file = CHECKOUT_FILE
    validate_checkout = staticmethod(checkout_environment)

    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == GATEWAY_BASELINE, 'Unreviewed Kaspi activation baseline')
        profile = market.ReleaseProfile('mobile-kaspi-schema028', BASELINE, PUBLIC_BASELINE,
            28, (), market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'mobile-kaspi-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        return BASELINE

    def gateway_candidate(self, text):
        return text

    def prepare_api(self, target):
        # Preserves exactly the existing auth keys, Telegram config and sessions.
        base.pilot.Release.prepare_api(self, target)
        path = self.args.checkout_env
        require(path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0,
                'Protected owner checkout environment required')
        raw = path.read_text()
        self.validate_checkout(raw)
        self.remote('python3 -c ' + quote('''from pathlib import Path
import os,sys
p=Path(sys.argv[1]);raw=sys.stdin.buffer.read()
if p.exists():
 assert p.is_file() and not p.is_symlink() and p.stat().st_mode&0o077==0 and p.read_bytes()==raw
else:
 with p.open('xb') as f: os.fchmod(f.fileno(),0o600);f.write(raw)
''') + ' ' + quote(self.checkout_file), input=raw)
        program = '''from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
auth=sys.argv[2];checkout=sys.argv[3]
assert s.count('    env_file: ['+auth+']')==1
assert s.count('  provision:\\n')==1
s=s.replace('  provision:\\n','  provision:\\n    env_file: ['+auth+']\\n',1)
s=s.replace('    env_file: ['+auth+']','    env_file: ['+auth+', '+checkout+']')
assert s.count('      APP_ENV: staging')==2
s=s.replace('      APP_ENV: staging','      CUSTOMER_KASPI_PILOT_ENABLED: "true"\\n      APP_ENV: staging')
old='      CLOUD_FULFILLMENT_TRANSPORT_ENABLED: ${CLOUD_FULFILLMENT_TRANSPORT_ENABLED:-false}'
assert s.count(old)==2
s=s.replace(old,'      CLOUD_FULFILLMENT_TRANSPORT_ENABLED: "true"')
p.write_text(s)
'''
        self.remote('python3 -c ' + quote(program) + ' ' + quote(target + '/infra/staging/compose.yaml') +
                    ' ' + quote(base.pilot.AUTH_FILE) + ' ' + quote(self.checkout_file))

    def prepared_artifacts(self, manifest):
        artifacts = super().prepared_artifacts(manifest)
        artifacts['checkout_environment'] = self.file_hashes([self.checkout_file])
        return artifacts

    def verify_data(self, before):
        require(self.ledger() == before['ledger'], 'Activation cannot change migrations')
        market.compare_existing(before['data'], self.snapshot())
        after = self.acl()
        # Derive exact expected ACL from the preserved baseline and reviewed grants,
        # inside a rollback-only transaction. No broad prefix whitelist.
        sql = market.acl_restore_sql(before['acl'], after)
        require(sql.endswith('COMMIT;'), 'ACL restore format differs')
        require({'name': 'bo_records', 'kind': 'r', 'column': None,
                 'privilege': 'INSERT', 'grantable': False} in before['acl'],
                'Existing TEST feedback grant is missing from baseline')
        grants = self.execute(['node', '--input-type=module', '-e', '''
import {fulfillmentTransportGrants as t} from './infra/staging/fulfillment-transport-grants.mjs';
import {cloudPosSyncGrants as p} from './infra/staging/pos-sync-grants.mjs';
import {backofficeGrants as b} from './infra/staging/backoffice-grants.mjs';
import {customerCheckoutGrants as c} from './infra/staging/checkout-grants.mjs';
// provision.mjs restores the existing TEST feedback grant after module grants.
console.log(t('pickchick_app',true)+p('pickchick_app',false)+b('pickchick_app',false)+c('pickchick_app',true)+'GRANT INSERT ON bo_records TO pickchick_app;');
''']).decode()
        expected = market.Release.acl(SimpleNamespace(psql=lambda db, query:
            self.psql(db, sql[:-len('COMMIT;')] + grants + query + ';ROLLBACK;')))
        require(after == expected, 'Unexpected checkout/transport ACL delta')
        require(self.psql(market.DB, "SELECT has_table_privilege('pickchick_app','commerce_captures','INSERT') OR has_column_privilege('pickchick_app','commerce_orders','total_minor','UPDATE')") == 'f',
                'HTTP application acquired bank or price mutation authority')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'apply'])
    for name in ['sha', 'branch', 'expected-api-sha', 'expected-public-sha', 'expected-gateway-sha256']:
        parser.add_argument('--'+name, required=True)
    for name in ['ssh-key', 'backup-identity', 'ci-proof', 'auth-env', 'legal-dir', 'checkout-env']:
        parser.add_argument('--'+name, type=Path, required=name in ['ssh-key','auth-env','legal-dir','checkout-env'])
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
