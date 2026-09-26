#!/usr/bin/env python3
"""Guarded 014 -> 019 staging TEST release. Preserves live edge/roadmap overlays.

prepare is read-only for active services. apply requires exact green CI, encrypted
backup + isolated restore, maintenance/cleanup locks and unchanged row digests.
Never restores a dump over the live database or enables commercial integrations.
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import time


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value

market = module('mobile_test_market', 'release-market.py')
transport = module('mobile_test_transport', 'release-transport.py')
require, quote, digest = market.require, market.quote, market.digest
REMOTE = market.REMOTE
BASELINE = '93b14e7f8491645dcf8ed2aabdd501afc6481a90'
MIGRATIONS = ('015_cloud_unpaid_cancellation.sql', '016_cloud_pos_order_sync.sql',
              '017_cloud_backoffice.sql', '018_pos_kitchen_sync.sql', '019_cloud_unpaid_test_orders.sql')
ADDITIONS = {'devices': {'pos_sync_lock_anchor': False},
             'device_credentials': {'pos_sync_lock_anchor': False},
             'test_orders': {'execution_mode': 'simulated_payment'}}
TEST_PATHS = '/test/kitchen/prep /test/kitchen/assembly /test/display'
# cloud017's recipe-pinning trigger needs these even with backoffice UI disabled.
RECIPE_ACL = [
    {'name': 'bo_order_recipes', 'kind': 'r', 'column': None, 'privilege': 'INSERT', 'grantable': False},
    {'name': 'bo_records', 'kind': 'r', 'column': None, 'privilege': 'SELECT', 'grantable': False},
]


def verify_runtime_acl(before, after):
    require(all(row in after for row in before), 'Existing runtime privilege removed')
    additions = [row for row in after if row not in before]
    require(len(additions) == len(RECIPE_ACL) and all(row in additions for row in RECIPE_ACL),
            'Runtime authority differs from the two reviewed recipe grants')


def relocate_public_mounts(config, old, new):
    result = copy.deepcopy(config)
    volumes = result['services']['gateway']['volumes']
    expected = {'/etc/caddy/Caddyfile': 'gateway.Caddyfile', '/srv/public': 'public-web'}
    require(len(volumes) == 2 and {v['target'] for v in volumes} == set(expected),
            'Unexpected gateway mount set')
    for volume in volumes:
        require(volume['type'] == 'bind' and volume['read_only'] is True
                and volume['source'] == old + '/' + expected[volume['target']],
                'Unexpected gateway bind source or permissions')
        volume['source'] = new + '/' + expected[volume['target']]
    return result


def extend_gateway(text):
    candidates = ['path /kiosk /kitchen/prep /kitchen/assembly /display /manager', 'path /kiosk /manager']
    matched = [value for value in candidates if value in text]
    require(len(matched) == 1, 'Unexpected operations route baseline')
    needle = matched[0]
    require(text.count(needle) == 1 and TEST_PATHS not in text, 'Unexpected operations route baseline')
    return text.replace(needle, needle + ' ' + TEST_PATHS)


def profile(web):
    require(re.fullmatch('[a-f0-9]{40}', web), 'Expected public SHA required')
    return market.ReleaseProfile('mobile-unpaid-test-014-019', BASELINE, web, 14, MIGRATIONS,
        market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'mobile-test-release',
        (('TEST_ORDER_FLOW_ENABLED', 'true'), ('CATALOG_ADMIN_ENABLED', 'true'),
         ('CUSTOMER_AUTH_ENABLED', 'false'), ('BACKOFFICE_ENABLED', 'false'),
         ('CLOUD_POS_ORDER_SYNC_ENABLED', 'false'), ('CLOUD_FULFILLMENT_TRANSPORT_ENABLED', 'false')),
        exact_ci_jobs=True)


class Release(market.Release):
    def __init__(self, args):
        super().__init__(args, profile(args.expected_public_sha))

    def runtime_old(self):
        # Roadmap/kitchen releases clone the public bundle while advancing its pointer.
        # Its operations provenance remains bc1 until this explicit operations update.
        require(self.remote('readlink -f '+REMOTE+'/current')==f'{REMOTE}/releases/{BASELINE}', 'API pointer changed')
        require(self.remote('readlink -f '+REMOTE+'/public-https/current')==f'{REMOTE}/public-https/releases/{self.profile.old_web}', 'Public pointer changed')
        require(self.remote('docker inspect --format '+quote('{{index .Config.Labels "org.opencontainers.image.revision"}}')+' '+market.API_CONTAINER)==BASELINE, 'Running API changed')
        manifest=json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json'))
        require(manifest['source_sha']=='bc1d1d55594fff40f64cdd0c6065631133be5370','Operations bundle baseline changed')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0]==self.args.expected_gateway_sha256,'Mounted gateway changed')
        require(self.remote('docker image inspect --format '+quote('{{index .Config.Labels "org.opencontainers.image.revision"}}')+' pickchick-api:'+BASELINE)==BASELINE,'Rollback image missing')
        role=json.loads(self.psql(market.DB,"SELECT json_build_object('superuser',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'bypassrls',rolbypassrls,'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=r.oid)) FROM pg_roles r WHERE rolname='pickchick_app'"))
        require(role=={'superuser':False,'createdb':False,'createrole':False,'replication':False,'bypassrls':False,'memberships':0},'Runtime authority changed')

    def prepare(self):
        self.source_checks()
        self.runtime_old()
        require(not (self.private/'prepared.json').exists(), 'Preparation already exists')
        old = f'{REMOTE}/public-https/releases/{self.profile.old_web}/infra/public-staging'
        self.old_gateway = self.remote('cat ' + old + '/gateway.Caddyfile') + '\n'
        require(digest(self.old_gateway.encode()) == self.args.expected_gateway_sha256, 'Gateway baseline changed')
        rollback = self.rollback_artifacts()
        archive = self.execute(['git', 'archive', '--format=tar', self.sha, *market.ARCHIVE_PATHS])
        target = f'{REMOTE}/releases/{self.sha}'
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}', input=archive, timeout=180)
        self.remote('python3 -c ' + quote(market.release_env_script(self.profile)) + ' ' + ' '.join(map(quote, [
            f'{REMOTE}/releases/{BASELINE}/release.env', target+'/release.env', self.sha, BASELINE])))
        self.remote('! docker image inspect pickchick-api:'+self.sha+' >/dev/null 2>&1')
        print('Building immutable TEST API image', flush=True)
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} -t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Image identity invalid')
        self.execute(['pnpm', '--filter', '@pickchick/operations...', 'build'], timeout=180)
        bundle = self.private/'operations.tar'
        with tarfile.open(bundle, 'w') as tar:
            for file in (market.REPO/'apps/operations/dist').rglob('*'):
                if file.is_file():
                    require(not file.is_symlink() and file.suffix in ['.html','.js','.css','.svg','.png','.jpg','.jpeg','.webp','.avif','.ico','.woff','.woff2','.ttf','.mp4'], 'Unexpected web asset')
                    tar.add(file, arcname='operations/'+str(file.relative_to(market.REPO/'apps/operations/dist')))
        new = f'{REMOTE}/public-https/releases/{self.sha}/infra/public-staging'
        self.remote(f'test ! -e {REMOTE}/public-https/releases/{self.sha} && mkdir -p {new} && cp -a {old}/. {new}/ && tar -xf - -C {new}/public-web',input=bundle.read_bytes(),timeout=180)
        compose = json.loads(self.remote(market.web_compose(self.profile.old_web)+' config --format json'))
        relocated = relocate_public_mounts(compose, old, new)
        self.remote('python3 -c '+quote('from pathlib import Path;import sys;Path(sys.argv[1]).write_text(sys.stdin.read())')+' '+quote(new+'/compose.yaml'), input=json.dumps(relocated))
        gateway = extend_gateway(self.old_gateway)
        self.remote('python3 -c '+quote('from pathlib import Path;import sys;Path(sys.argv[1]).write_text(sys.stdin.read())')+' '+quote(new+'/gateway.Caddyfile'), input=gateway)
        update = '''from pathlib import Path
import json,hashlib,sys
root=Path(sys.argv[1]);sha=sys.argv[2];p=root/'public-web/.release.json'
m=json.loads(p.read_text());m['source_sha']=sha
m.setdefault('component_sources',{})['operations']=sha
for f in (root/'public-web/operations').rglob('*'):
 if f.is_file():
  f.chmod(0o644);m['files'][str(f.relative_to(root/'public-web'))]=hashlib.sha256(f.read_bytes()).hexdigest()
p.write_text(json.dumps(m,indent=2)+'\\n');p.chmod(0o644)
for f in (root/'public-web/operations').rglob('*'):
 if f.is_dir(): f.chmod(0o755)
print(json.dumps(m))
'''
        manifest=json.loads(self.remote('python3 -c '+quote(update)+' '+quote(new)+' '+self.sha))
        self.remote(market.web_compose(self.sha)+' config --quiet')
        self.remote('docker run --rm --network none --entrypoint caddy -v '+new+'/gateway.Caddyfile:/tmp/Caddyfile:ro '+transport.CADDY+' validate --config /tmp/Caddyfile --adapter caddyfile')
        prepared={'sha':self.sha,'old_web':self.profile.old_web,'image_id':image,'public_manifest':manifest,
                  'gateway_sha256':digest(gateway.encode()),'rollback_files':rollback}
        prepared['artifacts']=self.prepared_artifacts(manifest)
        require(self.rollback_artifacts()==rollback,'Baseline changed during preparation')
        self.save('prepared.json',prepared)
        print('Prepared; active services unchanged',flush=True)

    def snapshot(self, database=market.DB):
        tables=json.loads(self.psql(database,"SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'"))
        parts=[]
        for table in tables:
            require(re.fullmatch('[a-z][a-z0-9_]*',table),'Unexpected table')
            expression='to_jsonb(t)'
            for key in ADDITIONS.get(table,{}): expression+="-'"+key+"'"
            parts.append("SELECT '"+table+"' AS name,count(*) AS rows,encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex') AS sha256 FROM (SELECT encode(sha256(convert_to(("+expression+")::text,'UTF8')),'hex') h FROM public.\""+table+'\" t) hashes')
        return json.loads(self.psql(database,"SELECT json_build_object('tables',(SELECT json_object_agg(name,json_build_object('rows',rows,'sha256',sha256)) FROM ("+' UNION ALL '.join(parts)+") h),'sequences',(SELECT coalesce(json_agg(row_to_json(s) ORDER BY sequencename),'[]') FROM (SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences WHERE schemaname='public') s))"))

    def verify_data(self,before):
        self.migration_delta(before['ledger'],before['data'])
        verify_runtime_acl(before['acl'], self.acl())
        for table, columns in ADDITIONS.items():
            for key,value in columns.items():
                literal="'simulated_payment'" if value=='simulated_payment' else 'false'
                require(self.psql(market.DB,f'SELECT count(*) FROM {table} WHERE {key} IS DISTINCT FROM {literal}')=='0','New column changed pre-existing data')

    def cleanup(self,action):
        runner=f'{REMOTE}/releases/{self.sha}/infra/staging/release-maintenance-lock.py'
        result=json.loads(self.remote('python3 '+runner+' '+action+' '+quote(self.maintenance)+' '+quote(transport.CLEANUP_LOCK)+' '+quote(self.lock_owner['id'])))
        require(result['owner']==self.lock_owner['id'],'Cleanup ownership changed')

    def journal(self, phase, **details):
        self.save('phase-'+str(time.time_ns())+'.json', {'phase':phase, **details})

    def quiescent(self):
        self.cleanup('status')
        require(self.http('/v1/test/orders', method='POST')[0]==503, 'Public ingress reopened during backup')

    # On an uncertain restore keep the drill database and locks for inspection.
    backup_restore = transport.TransportRelease.backup_restore

    def apply(self):
        self.source_checks()
        self.ci()
        self.runtime_old()
        proof=json.loads((self.private/'prepared.json').read_text())
        require(proof['sha']==self.sha and proof['old_web']==self.profile.old_web,'Wrong preparation')
        require(self.prepared_artifacts(proof['public_manifest'])==proof['artifacts'],'Prepared artifacts changed')
        require(self.rollback_artifacts()==proof['rollback_files'],'Rollback artifacts changed')
        key=self.args.backup_identity
        require(key.is_file() and not key.is_symlink() and key.stat().st_mode&0o077==0,'Private backup identity required')
        self.maintenance=f'{REMOTE}/maintenance/mobile-test-{self.lock_owner["id"]}'
        contents={'owner.json':json.dumps(self.lock_owner),'maintenance.json':json.dumps(transport.maintenance_config()),
                  'compose.json':json.dumps(transport.maintenance_overlay(self.maintenance))}
        self.remote('python3 -c '+quote(transport.maintenance_write_script())+' '+quote(self.maintenance),input=json.dumps(contents))
        self.remote(transport.caddy_validation_command(self.maintenance+'/maintenance.json'))
        self.cleanup('acquire')
        self.remote(market.web_compose(self.profile.old_web)+' -f '+quote(self.maintenance+'/compose.json')+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        require(self.http('/v1/test/orders',method='POST')[0]==503,'Ingress did not close')
        self.remote(market.api_compose(BASELINE)+' stop --timeout 30 api',timeout=60)
        require(self.psql(market.DB,"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (usename='pickchick_app' OR xact_start IS NOT NULL)")=='0','Competing database writer')
        before={'data':self.snapshot(),'ledger':self.ledger(),'acl':self.acl(),'neighbors':self.fingerprint()}
        expected=[{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in self.baseline_migrations()]
        require(before['ledger']==expected,'Baseline migration ledger differs')
        self.save('before.json',before)
        backup=self.backup_restore(before['data'])
        self.save('backup.json',backup)
        for _ in range(2):
            self.cleanup('status')
            self.remote(market.api_compose(self.sha)+' run --rm --no-deps provision',timeout=180)
            self.verify_data(before)
        # Confirm old image can still serve retained additive schema, without running old provision.
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'],'Rollback image incompatible')
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'],'Candidate not ready')
        caps=self.http_json('/v1/capabilities',public=False)
        require(caps['features'].get('unpaid_test_orders') is True and caps['ordering_enabled'] is False,'Wrong TEST capability')
        require(all(caps['features'][name] is False for name in ['phone_auth','checkout','payments','fiscal','loyalty']),'Commercial feature enabled')
        self.verify_data(before)
        require(self.fingerprint()==before['neighbors'],'Unrelated container changed')
        require(self.prepared_artifacts(proof['public_manifest'])==proof['artifacts'],'Artifacts changed before reopening')
        self.switch(REMOTE+'/current',f'{REMOTE}/releases/{BASELINE}',f'{REMOTE}/releases/{self.sha}')
        self.switch(REMOTE+'/public-https/current',f'{REMOTE}/public-https/releases/{self.profile.old_web}',f'{REMOTE}/public-https/releases/{self.sha}')
        self.remote(market.web_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        mounts = json.loads(self.remote('docker inspect --format '+quote('{{json .Mounts}}')+' '+market.GATEWAY))
        mounted = {row['Destination']: row['Source'] for row in mounts}
        public = f'{REMOTE}/public-https/releases/{self.sha}/infra/public-staging'
        require(mounted.get('/etc/caddy/Caddyfile') == public+'/gateway.Caddyfile'
                and mounted.get('/srv/public') == public+'/public-web', 'Actual gateway mounts differ')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0]
                == proof['gateway_sha256'], 'Mounted gateway config differs')
        require(self.http_json('/v1/capabilities')==caps,'Public capability mismatch')
        for path in TEST_PATHS.split(): require(self.http(path)[0]==200,'TEST screen unavailable')
        require(self.http_json('/kitchen-live/health')['edgeConnected'] is True,'Existing kitchen link disconnected')
        require(self.fingerprint()==before['neighbors'],'Unrelated container changed after reopening')
        self.cleanup('release')
        self.save('result.json',{'source_sha':self.sha,'backup':backup,'schema':19,'commercial_enabled':False,'existing_data_preserved':True,'old_image_compatible':True,'reviewed_acl_additions':RECIPE_ACL,'web_mounts_verified':True})
        print('Published TEST ordering, preserved edge kitchen and unrelated services',flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['prepare','apply'])
    parser.add_argument('--sha',required=True)
    parser.add_argument('--branch',required=True)
    parser.add_argument('--expected-public-sha',required=True)
    parser.add_argument('--expected-gateway-sha256',required=True)
    parser.add_argument('--ssh-key',required=True,type=Path)
    parser.add_argument('--backup-identity',type=Path)
    parser.add_argument('--ci-proof',type=Path)
    parser.add_argument('--ci-run')
    args=parser.parse_args()
    release=Release(args)
    try:
        with release.deployment_lock(): getattr(release,args.action)()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error,market.GuardFailure) else 'Release stopped; inspect private diagnostics. Lock retained.',file=sys.stderr)
        raise SystemExit(1)

if __name__=='__main__': main()
