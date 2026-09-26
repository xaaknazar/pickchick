#!/usr/bin/env python3
"""Guarded schema019 -> 020 daily-number release; preserves orders and gateway overlays."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import tarfile
spec=importlib.util.spec_from_file_location('daily_number_events',Path(__file__).with_name('release-order-events.py'))
events=importlib.util.module_from_spec(spec);sys.modules[spec.name]=events;spec.loader.exec_module(events)
mobile,market,transport=events.mobile,events.market,events.transport
require,quote,digest,REMOTE=market.require,market.quote,market.digest,market.REMOTE
relocate_public_mounts=mobile.relocate_public_mounts
BASELINE='a0e198e5e682c7997c39a6e2be2b2387bb98fad7'
MIGRATION='020_cloud_daily_test_numbers.sql'
TEST_PATHS=mobile.TEST_PATHS
NUMBER_TABLES={'test_order_numbers','test_order_day_counters'}
NUMBER_ACL=[{'name':name,'kind':'r','column':None,'privilege':'SELECT','grantable':False} for name in sorted(NUMBER_TABLES)]

def verify_number_acl(before,after):
    require(all(row in after for row in before),'Existing runtime privilege removed')
    added=[row for row in after if row not in before]
    require(len(added)==2 and all(row in NUMBER_ACL for row in added),'Unexpected runtime privilege delta')

class Release(events.Release):
    def __init__(self,args):
        require(args.expected_api_sha==BASELINE,'Unexpected daily-number baseline')
        profile=market.ReleaseProfile('daily-test-numbers-019-020',BASELINE,args.expected_public_sha,
            19,(MIGRATION,),market.TRANSPORT_PROFILE.ci_jobs,frozenset(),'daily-number-release',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    # No outer-front candidate or overlay: the installed event gateway is copied exactly.
    prepared_artifacts=market.Release.prepared_artifacts
    snapshot=market.Release.snapshot

    def verify_data(self,before):
        expected=before['ledger']+[{'version':MIGRATION,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/MIGRATION).read_bytes())}]
        require(self.ledger()==expected,'Unexpected migration delta')
        after=self.snapshot()
        require(set(after['tables'])-set(before['data']['tables'])==NUMBER_TABLES,'Unexpected table delta')
        preserved={'tables':{k:v for k,v in after['tables'].items() if k not in NUMBER_TABLES},'sequences':after['sequences']}
        preserved['tables']['schema_migrations']=before['data']['tables']['schema_migrations']
        market.compare_existing(before['data'],preserved)
        verify_number_acl(before['acl'],self.acl())
        mismatch=self.psql(market.DB,"""WITH expected AS (
          SELECT o.id,o.branch_id,(o.created_at AT TIME ZONE b.timezone)::date AS day,
          row_number() OVER(PARTITION BY o.branch_id,(o.created_at AT TIME ZONE b.timezone)::date ORDER BY o.sequence) AS n
          FROM test_orders o JOIN branches b ON b.id=o.branch_id)
          SELECT count(*) FROM expected e FULL JOIN test_order_numbers n ON n.order_id=e.id
          WHERE e.id IS NULL OR n.order_id IS NULL OR (e.branch_id,e.day,e.n) IS DISTINCT FROM (n.branch_id,n.business_date,n.number)""")
        require(mismatch=='0','Historical number backfill differs')
        counters=self.psql(market.DB,"""SELECT count(*) FROM test_order_day_counters c FULL JOIN
          (SELECT branch_id,business_date,max(number) n FROM test_order_numbers GROUP BY branch_id,business_date) e
          USING(branch_id,business_date) WHERE c.last_number IS DISTINCT FROM e.n""")
        require(counters=='0','Daily counters differ from preserved history')

    # Extension points retain the same immutable prepare/apply and owned-lock protocol.
    def prepare_api(self, target): pass
    def gateway_candidate(self, gateway): return gateway
    def prepare_public(self, target, manifest): return manifest
    def verify_capabilities(self, caps):
        require(caps['features'].get('unpaid_test_orders') is True and caps['ordering_enabled'] is False,'Wrong TEST capability')
        require(all(caps['features'][name] is False for name in ['phone_auth','checkout','payments','fiscal','loyalty']),'Commercial feature enabled')
    def verify_public(self):
        require(self.http_json('/kitchen-live/health')['edgeConnected'] is True,'Existing kitchen link disconnected')

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
            f'{REMOTE}/releases/{self.profile.old_api}/release.env', target+'/release.env', self.sha, self.profile.old_api])))
        self.prepare_api(target)
        self.remote('! docker image inspect pickchick-api:'+self.sha+' >/dev/null 2>&1')
        print('Building immutable TEST API image', flush=True)
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} -t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Image identity invalid')
        self.execute(['npx','--yes','pnpm@11.19.0', '--filter', '@pickchick/operations...', 'build'], timeout=180)
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
        gateway = self.gateway_candidate(self.old_gateway)
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
        manifest = self.prepare_public(new, manifest)
        self.remote(market.web_compose(self.sha)+' config --quiet')
        self.remote('docker run --rm --network none --entrypoint caddy -v '+new+'/gateway.Caddyfile:/tmp/Caddyfile:ro '+transport.CADDY+' validate --config /tmp/Caddyfile --adapter caddyfile')
        prepared={'sha':self.sha,'old_web':self.profile.old_web,'image_id':image,'public_manifest':manifest,
                  'gateway_sha256':digest(gateway.encode()),'rollback_files':rollback}
        prepared['artifacts']=self.prepared_artifacts(manifest)
        require(self.rollback_artifacts()==rollback,'Baseline changed during preparation')
        self.save('prepared.json',prepared)
        print('Prepared; active services unchanged',flush=True)


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
        self.remote(market.api_compose(self.profile.old_api)+' stop --timeout 30 api',timeout=60)
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
        self.remote(market.api_compose(self.profile.old_api)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'],'Rollback image incompatible')
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'],'Candidate not ready')
        caps=self.http_json('/v1/capabilities',public=False)
        self.verify_capabilities(caps)
        self.verify_data(before)
        require(self.fingerprint()==before['neighbors'],'Unrelated container changed')
        require(self.prepared_artifacts(proof['public_manifest'])==proof['artifacts'],'Artifacts changed before reopening')
        self.switch(REMOTE+'/current',f'{REMOTE}/releases/{self.profile.old_api}',f'{REMOTE}/releases/{self.sha}')
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
        self.verify_public()
        require(self.fingerprint()==before['neighbors'],'Unrelated container changed after reopening')
        self.cleanup('release')
        self.save('result.json',{'source_sha':self.sha,'backup':backup,'schema':self.profile.baseline_count+len(self.profile.migrations),'commercial_enabled':False,'existing_data_preserved':True,'old_image_compatible':True,'runtime_acl_verified':True,'web_mounts_verified':True})
        print('Published TEST ordering, preserved edge kitchen and unrelated services',flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['prepare','apply'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']:
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--ssh-key',type=Path,required=True)
    parser.add_argument('--backup-identity',type=Path)
    parser.add_argument('--ci-proof',type=Path)
    parser.add_argument('--ci-run')
    args=parser.parse_args();release=Release(args)
    try:
        with release.deployment_lock():getattr(release,args.action)()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error,market.GuardFailure) else 'Stopped; private diagnostics and owned lock retained.',file=sys.stderr)
        raise SystemExit(1)
if __name__=='__main__':main()
