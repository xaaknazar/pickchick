#!/usr/bin/env python3
"""Read-only inspection and local release plan for the observed 014 VPS baseline.

This deliberately has no apply action. A plan is not a deployment/backup proof.
The historical 013->014 apply helper must not be used with this profile.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

spec = importlib.util.spec_from_file_location('pos_pilot_market', Path(__file__).with_name('release-market.py'))
market = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = market
spec.loader.exec_module(market)
BASELINE_API = '93b14e7f8491645dcf8ed2aabdd501afc6481a90'
BASELINE_WEB = 'bc1d1d55594fff40f64cdd0c6065631133be5370'
BRANCH_ID = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'
PROFILE = market.ReleaseProfile(
    'pos-unpaid-pilot-014-018', BASELINE_API, BASELINE_WEB, 14,
    ('015_cloud_unpaid_cancellation.sql', '016_cloud_pos_order_sync.sql',
     '017_cloud_backoffice.sql', '018_pos_kitchen_sync.sql'),
    market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'pos-pilot-release',
    (('TEST_ORDER_FLOW_ENABLED', 'true'), ('CATALOG_ADMIN_ENABLED', 'true'),
     ('CUSTOMER_AUTH_ENABLED', 'false'), ('BACKOFFICE_ENABLED', 'true'),
     ('CLOUD_POS_ORDER_SYNC_ENABLED', 'true'),
     ('CLOUD_FULFILLMENT_TRANSPORT_ENABLED', 'false'),
     ('EDGE_FULFILLMENT_ENABLED', 'false'), ('EDGE_FULFILLMENT_TRANSPORT_ENABLED', 'false')),
    exact_ci_jobs=True,
)
# New columns on old tables are the only allowed difference in existing row shape.
OLD_TABLE_ADDITIONS = {'devices': {'pos_sync_lock_anchor': False},
                       'device_credentials': {'pos_sync_lock_anchor': False}}
NEW_TABLES = frozenset({
    'commerce_cancellation_intents', 'commerce_cancellation_results',
    'pos_order_sync_bindings', 'pos_order_sync_inbox', 'pos_order_sync_projection',
    'bo_records', 'bo_audit', 'bo_commands', 'bo_stock_balances', 'bo_stock_documents',
    'bo_stock_movements', 'bo_publications', 'bo_delivery_outbox', 'bo_access_grants',
    'bo_order_recipes', 'bo_access_audit', 'pos_kitchen_sync_inbox', 'pos_kitchen_sync_projection',
})


def local_sources(root=market.REPO):
    names = sorted(path.name for path in (root / 'db/cloud/migrations').glob('*.sql'))
    old = subprocess.run(['git', 'ls-tree', '-r', '--name-only', BASELINE_API, '--',
                          'db/cloud/migrations'], cwd=root, check=True, capture_output=True, text=True)
    baseline = sorted(Path(path).name for path in old.stdout.splitlines())
    market.require(len(baseline) == 14 and names == baseline + list(PROFILE.migrations),
                   'Migration set differs from the observed 014 -> 018 profile')
    for name in baseline:
        previous = subprocess.run(['git', 'show', BASELINE_API + ':db/cloud/migrations/' + name],
                                  cwd=root, capture_output=True, check=True).stdout
        market.require(previous == (root / 'db/cloud/migrations' / name).read_bytes(),
                       'Previously deployed migration changed: ' + name)
    additions = ''.join((root / 'db/cloud/migrations' / name).read_text() for name in PROFILE.migrations)
    market.require(set(re.findall(r'CREATE\s+TABLE\s+([a-z][a-z0-9_]*)', additions, re.I)) == NEW_TABLES,
                   'New tables differ from the reviewed 18-table set')
    market.require(not re.search(r'CREATE\s+SEQUENCE|\b(?:BIG)?SERIAL\b|GENERATED\s+.*IDENTITY', additions, re.I),
                   'Unexpected new domain sequence')
    return [{'version': name, 'scope': 'cloud',
             'checksum': market.digest((root / 'db/cloud/migrations' / name).read_bytes())}
            for name in baseline]


def preserve_row(table, old, new):
    """Portable proof predicate; don't compare raw row_to_json across ADD COLUMN."""
    extra = OLD_TABLE_ADDITIONS.get(table, {})
    market.require(set(new) == set(old) | set(extra), 'Unexpected existing row shape change')
    market.require(all(new[key] == value for key, value in extra.items()),
                   'New lock column is not its inert false value')
    market.require({key: value for key, value in new.items() if key not in extra} == old,
                   'Existing row value changed')


def snapshot_expression(table):
    market.require(re.fullmatch('[a-z][a-z0-9_]{0,62}', table), 'Invalid table identifier')
    keys = list(OLD_TABLE_ADDITIONS.get(table, {}))
    return 'to_jsonb(t)' + ("-ARRAY[" + ','.join("'" + key + "'" for key in keys) + ']::text[]' if keys else '')


def validate_observed(data, expected_ledger):
    market.require(data['api_sha'] == BASELINE_API and data['api_pointer'] == BASELINE_API,
                   'Live API baseline changed')
    market.require(data['web_sha'] == BASELINE_WEB and data['web_pointer'] == BASELINE_WEB,
                   'Live public bundle baseline changed')
    market.require(data['api_ports'] == '3100/tcp -> 127.0.0.1:13100', 'Private API port changed')
    market.require(data['ledger'] == expected_ledger, 'Live migration ledger/checksums differ')
    market.require(data['role'] == {'superuser': False, 'createdb': False, 'createrole': False,
                                    'replication': False, 'bypassrls': False, 'memberships': 0},
                   'Existing API role authority changed')
    return data


def inspect_ssh(key, expected_ledger):
    ssh = ['ssh', '-i', str(key.expanduser()), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
           '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
           'pickchick-ops@' + market.IP]
    # Only static, read-only commands. Never inspect container Env or credential rows.
    def read(command):
        result = subprocess.run(ssh + [command], check=True, capture_output=True, timeout=45)
        return result.stdout.decode().strip()
    def sql(query):
        return json.loads(read('docker exec ' + market.DB_CONTAINER + ' psql -X -qAt -U postgres -d '
                               + market.DB + ' -c ' + market.quote(query)))
    value = {
        'api_sha': read('docker inspect --format ' + market.quote('{{index .Config.Labels "org.opencontainers.image.revision"}}') + ' ' + market.API_CONTAINER),
        'api_pointer': Path(read('readlink -f ' + market.REMOTE + '/current')).name,
        'web_pointer': Path(read('readlink -f ' + market.REMOTE + '/public-https/current')).name,
        'web_sha': json.loads(read('docker exec ' + market.GATEWAY + ' cat /srv/public/.release.json'))['source_sha'],
        'api_ports': read('docker port ' + market.API_CONTAINER),
        'ledger': sql("SELECT json_agg(json_build_object('version',version,'scope',scope,'checksum',checksum) ORDER BY version) FROM schema_migrations"),
        'role': sql("SELECT json_build_object('superuser',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'bypassrls',rolbypassrls,'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=r.oid)) FROM pg_roles r WHERE rolname='pickchick_app'"),
    }
    return validate_observed(value, expected_ledger)


def plan(sha, observed, ledger):
    market.require(re.fullmatch('[a-f0-9]{40}', sha), 'Expected exact reviewed source SHA')
    validate_observed(observed, ledger)
    return {
        'profile': PROFILE.name, 'candidate_sha': sha, 'observed': observed,
        'settings': dict(PROFILE.settings), 'new_migrations': list(PROFILE.migrations),
        'expected_empty_new_tables': sorted(NEW_TABLES), 'expected_new_sequences': [],
        'old_table_added_columns': OLD_TABLE_ADDITIONS,
        'private_transport': {'vps': market.IP, 'ssh_port': 22, 'permit_open': '127.0.0.1:13100',
                              'public_internal_routes': 'remain_404'},
        'physical_branch_id': BRANCH_ID,
        'migration_applied': False, 'backup_restored': False, 'deployable': False,
        'required_before_apply': [
            'Exact candidate SHA pushed with all six canonical CI jobs successful',
            'Reviewed maintenance apply for 014->018 with cleanup flock, drained API and no pending tunnel writers',
            'Fresh encrypted backup restored into an owned temporary database; no restore over live data',
            'Every previous row/column/sequence/ledger timestamp preserved; only listed inert columns added',
            'Exact reviewed additive API ACL plus denied credential/role/money-effect authority checks',
            'Old API and old web compatibility proven with retained schema before public reopening',
            'Public private-route 404 checks, scoped BO auth checks and unknown-result recovery rehearsal',
            'Owner assigns existing cloud organization/legal-entity scope, physical device and separate producers',
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inspect', 'plan'])
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--ssh-key', type=Path, default=Path.home()/'.ssh/pickchick_staging_ed25519')
    parser.add_argument('--observed', type=Path)
    parser.add_argument('--sha')
    args = parser.parse_args()
    os.umask(0o077)
    ledger = local_sources()
    if args.action == 'inspect':
        value = inspect_ssh(args.ssh_key, ledger)
    else:
        market.require(args.observed is not None and args.sha is not None, 'Plan needs --observed and --sha')
        value = plan(args.sha, json.loads(args.observed.read_text()), ledger)
    path = args.output.resolve()
    market.require(not args.output.is_symlink() and not path.exists(), 'Fresh private output path required')
    with open(path, 'x', encoding='utf8') as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(value, output, indent=2, sort_keys=True)
        output.write('\n')
    print(json.dumps({'profile': PROFILE.name, 'action': args.action, 'saved': True,
                      'remote_mutations': False, 'deployment_completed': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # SSH/SQL exception text may contain data; only curated guard messages are printed.
        print(str(error) if isinstance(error, market.GuardFailure) else
              'Profile inspection failed; no deployment was attempted', file=sys.stderr)
        sys.exit(1)
