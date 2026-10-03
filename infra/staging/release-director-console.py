#!/usr/bin/env python3
"""Guarded director console 032 -> 033; retain payment policy and every non-BO public asset.

No automatic rollback after uncertain completion. Explicit rollback stays behind
maintenance until retained-schema compatibility, exact old ACL and data checks pass.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import tarfile

spec = importlib.util.spec_from_file_location('director_connection_base', Path(__file__).with_name('release-connection-recovery.py'))
connection = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = connection
spec.loader.exec_module(connection)
base, market, transport = connection.base, connection.market, connection.transport
require, quote, digest, REMOTE = market.require, market.quote, market.digest, market.REMOTE
BASELINE = 'f83794ce68c10906d2924a3a04351f7550d62b40'
PUBLIC_BASELINE = '88aa799eba6ebde226e9e25eaa595a2a2d41bfb1'
GATEWAY_BASELINE = '11eefd7c872593ffc3d566e5e780c07b5907d29526faa42f1aabdad141bd1d7d'
COMPOSE_BASELINE = '3d4116f9d6f833bbdca5d4da9740959407cfaa9ca2831ff1ea5d0d799d0f240a'
MIGRATION = '033_cloud_cashier_reports.sql'
NEW_TABLES = {'cloud_cashier_report_inbox', 'cloud_cashier_shifts', 'cloud_cashier_orders'}
CI_JOBS = frozenset(market.TRANSPORT_PROFILE.ci_jobs | {
 'Foundation static checks and transaction invariants', 'Foundation POS and backoffice integration',
 'Foundation mobile bundles and checkout recovery', 'Foundation simulator browser regressions',
 'Foundation server account and Kaspi fixtures'})


def compose_candidate(raw):
    require(digest(raw.encode()) == COMPOSE_BASELINE, 'Unreviewed live compose')
    require(raw.count('      APP_ENV: staging') == 2 and 'CATALOG_MOBILE_STOREFRONT_ENABLED' not in raw,
            'Unexpected API/provision boundary')
    return raw.replace('      APP_ENV: staging', '      CATALOG_MOBILE_STOREFRONT_ENABLED: "false"\n      APP_ENV: staging')


def verify_manifest(before, after, sha):
    require(after['source_sha'] == sha and after.get('component_sources', {}).get('backoffice') == sha,
            'Backoffice provenance missing')
    untouched = lambda m: {k:v for k,v in m['files'].items() if not k.startswith('backoffice/')}
    require(untouched(before) == untouched(after), 'Non-backoffice public assets changed')
    require('backoffice/app.js' in after['files'] and 'backoffice/operations.js' in after['files'],
            'Director bundle incomplete')


def expected_acl(before, sql):
    """Interpret only the checked helper's bounded canonical GRANT/REVOKE grammar."""
    rows = [dict(row) for row in before]
    for statement in sql.split(';'):
        if not statement.strip(): continue
        match = re.fullmatch(r'\s*(GRANT|REVOKE) (.*?) ON (.*?) (?:TO|FROM) pickchick_app\s*', statement, re.S)
        require(match is not None, 'Unsupported permission statement')
        action, privileges, objects = match.groups()
        kind = 'S' if objects.startswith('SEQUENCE ') else 'r'
        objects = objects.removeprefix('SEQUENCE ')
        names = objects.split(',')
        require(all(re.fullmatch('[a-z][a-z0-9_]*', n) for n in names), 'Unsafe ACL object')
        column = re.fullmatch(r'([A-Z]+)\(([^)]+)\)', privileges)
        effects = [(c, column[1]) for c in column[2].split(',')] if column else [(None,p) for p in privileges.split(',')]
        for name in names:
            if action == 'REVOKE':
                rows = [r for r in rows if not (r['name'] == name and (privileges == 'ALL' and r['column'] is None or (r['column'], r['privilege']) in effects))]
            else:
                for col, privilege in effects:
                    item = {'name':name,'kind':kind,'column':col,'privilege':privilege,'grantable':False}
                    if item not in rows: rows.append(item)
    return rows


class Release(base.Release):
    snapshot = market.Release.snapshot
    def __init__(self, args):
        require((args.expected_api_sha,args.expected_public_sha,args.expected_gateway_sha256) ==
                (BASELINE,PUBLIC_BASELINE,GATEWAY_BASELINE), 'Unreviewed director baseline')
        profile = market.ReleaseProfile('director-console-schema033',BASELINE,PUBLIC_BASELINE,32,
            (MIGRATION,),CI_JOBS,frozenset(),'director-console-release',
            (('BACKOFFICE_ENABLED','true'),('CATALOG_MOBILE_STOREFRONT_ENABLED','false')),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    def source_checks(self):
        super().source_checks()
        text=(market.REPO/'db/cloud/migrations'/MIGRATION).read_text()
        require(set(re.findall(r'CREATE\s+TABLE\s+([a-z][a-z0-9_]*)',text,re.I))==NEW_TABLES,'Unreviewed033 tables')
        require(not re.search(r'\b(?:ALTER|UPDATE|INSERT|DELETE|TRUNCATE)\b|CREATE\s+SEQUENCE|\b(?:BIG)?SERIAL\b',re.sub(r'--[^\n]*','',text),re.I),'033 must be additive empty tables only')

    def web_manifest_source(self): return '9f6696924e90856f3fccde1d5185801100b62123'
    def gateway_candidate(self, text): return text
    def prepare_public(self, target, manifest): return manifest
    def prepare_api(self, target):
        old = REMOTE+'/releases/'+BASELINE
        candidate = compose_candidate(self.remote('cat '+quote(old+'/infra/staging/compose.yaml'))+'\n')
        writer = 'from pathlib import Path;import sys;Path(sys.argv[1]).write_text(sys.stdin.read())'
        self.remote('python3 -c '+quote(writer)+' '+quote(target+'/infra/staging/compose.yaml'), input=candidate)
        require(self.remote("awk '/^BACKOFFICE_ENABLED=/{print}' "+quote(target+'/release.env')) == 'BACKOFFICE_ENABLED=true', 'BO flag missing')

    def protected_policy(self):
        return self.file_hashes([self.checkout_file,base.base.pilot.AUTH_FILE])

    def worker_acl(self):
        sql = """SELECT coalesce(json_agg(row_to_json(a) ORDER BY name,column_name,privilege),'[]') FROM (
        SELECT c.relname name,NULL::text column_name,x.privilege_type privilege,x.is_grantable grantable
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) x JOIN pg_roles r ON r.oid=x.grantee
        WHERE n.nspname='public' AND r.rolname='pickchick_kaspi_worker'
        UNION ALL SELECT c.relname,t.attname,x.privilege_type,x.is_grantable
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute t ON t.attrelid=c.oid
        CROSS JOIN LATERAL aclexplode(t.attacl) x JOIN pg_roles r ON r.oid=x.grantee
        WHERE n.nspname='public' AND r.rolname='pickchick_kaspi_worker') a"""
        return json.loads(self.psql(market.DB,sql))

    def prepared_artifacts(self, manifest):
        result = super().prepared_artifacts(manifest)
        result['preserved_policy'] = self.protected_policy()
        result['bank_worker_acl'] = self.worker_acl()
        result['neighbors'] = self.fingerprint()
        return result

    def verify_data(self, before):
        expected = before['ledger']+[{'version':MIGRATION,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/MIGRATION).read_bytes())}]
        require(self.ledger() == expected, 'Unexpected migration delta')
        market.compare_existing(before['data'],self.snapshot(),additions=True,new_tables=NEW_TABLES)
        program = "import {backofficeGrants} from './infra/staging/backoffice-grants.mjs';console.log(backofficeGrants('pickchick_app',true))"
        sql = self.execute(['node','--input-type=module','-e',program]).decode()
        wanted = expected_acl(before['acl'],sql)
        for table in NEW_TABLES:
            privileges = ['SELECT','INSERT'] if table=='cloud_cashier_report_inbox' else ['SELECT','INSERT','UPDATE']
            for privilege in privileges:
                item = {'name':table,'kind':'r','column':None,'privilege':privilege,'grantable':False}
                if item not in wanted: wanted.append(item)
        key = lambda row: (row['name'],row['kind'],row['column'] or '',row['privilege'],row['grantable'])
        require(sorted(map(key,self.acl())) == sorted(map(key,wanted)), 'Runtime ACL differs from reviewed BO delta')

    def verify_capabilities(self, caps):
        proof=json.loads((self.private/'prepared.json').read_text())
        require(caps == proof['baseline_capabilities'], 'Existing commercial capabilities changed')

    def verify_public(self):
        proof=json.loads((self.private/'prepared.json').read_text())
        require(self.http_json('/v1/auth/config') == proof['baseline_auth'], 'Auth delivery policy changed')
        require(self.http_json('/kitchen-live/health')['sourceSha'] == self.kitchen_before['sourceSha'], 'Kitchen bridge changed')
        require(self.http('/v1/admin/backoffice/branches/00000000-0000-4000-8000-000000000000')[0] == 401,
                'BO route missing or anonymous access accepted')
        require(self.http('/v1/customer-checkout/catalog')[0] == 404, 'Mobile storefront unexpectedly enabled')
        require(json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json')) == proof['public_manifest'], 'Published manifest differs')
        code,body=self.http('/backoffice/app.js')
        require(code==200 and digest(body)==proof['public_manifest']['files']['backoffice/app.js'], 'Actual BO bundle differs')

    def prepare(self):
        self.source_checks()
        self.ci()
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
        print('Building immutable director API image', flush=True)
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} -t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Image identity invalid')
        self.execute(['npx','--yes','pnpm@11.19.0', '--filter', '@pickchick/backoffice...', 'build'], timeout=180)
        bundle = self.private/'backoffice.tar'
        with tarfile.open(bundle, 'w') as tar:
            for file in (market.REPO/'apps/backoffice/dist').rglob('*'):
                if file.is_file():
                    require(not file.is_symlink() and file.suffix in ['.html','.js','.css','.svg','.png','.jpg','.jpeg','.webp','.avif','.ico','.woff','.woff2','.ttf','.mp4'], 'Unexpected web asset')
                    tar.add(file, arcname='backoffice/'+str(file.relative_to(market.REPO/'apps/backoffice/dist')))
        new = f'{REMOTE}/public-https/releases/{self.sha}/infra/public-staging'
        self.remote(f'test ! -e {REMOTE}/public-https/releases/{self.sha} && mkdir -p {new} && cp -a {old}/. {new}/ && rm -rf {new}/public-web/backoffice && tar -xf - -C {new}/public-web',input=bundle.read_bytes(),timeout=180)
        compose = json.loads(self.remote(market.web_compose(self.profile.old_web)+' config --format json'))
        relocated = relocate_public_mounts(compose, old, new)
        self.remote('python3 -c '+quote('from pathlib import Path;import sys;Path(sys.argv[1]).write_text(sys.stdin.read())')+' '+quote(new+'/compose.yaml'), input=json.dumps(relocated))
        gateway = self.gateway_candidate(self.old_gateway)
        self.remote('python3 -c '+quote('from pathlib import Path;import sys;Path(sys.argv[1]).write_text(sys.stdin.read())')+' '+quote(new+'/gateway.Caddyfile'), input=gateway)
        update = '''from pathlib import Path
import json,hashlib,sys
root=Path(sys.argv[1]);sha=sys.argv[2];p=root/'public-web/.release.json'
m=json.loads(p.read_text());m['files']={k:v for k,v in m['files'].items() if not k.startswith('backoffice/')};m['source_sha']=sha
m.setdefault('component_sources',{})['backoffice']=sha
for f in (root/'public-web/backoffice').rglob('*'):
 if f.is_file():
  f.chmod(0o644);m['files'][str(f.relative_to(root/'public-web'))]=hashlib.sha256(f.read_bytes()).hexdigest()
p.write_text(json.dumps(m,indent=2)+'\\n');p.chmod(0o644)
for f in (root/'public-web/backoffice').rglob('*'):
 if f.is_dir(): f.chmod(0o755)
print(json.dumps(m))
'''
        manifest=json.loads(self.remote('python3 -c '+quote(update)+' '+quote(new)+' '+self.sha))
        previous=json.loads(self.remote('cat '+quote(old+'/public-web/.release.json')))
        verify_manifest(previous,manifest,self.sha)
        manifest = self.prepare_public(new, manifest)
        self.remote(market.web_compose(self.sha)+' config --quiet')
        self.remote('docker run --rm --network none --entrypoint caddy -v '+new+'/gateway.Caddyfile:/tmp/Caddyfile:ro '+transport.CADDY+' validate --config /tmp/Caddyfile --adapter caddyfile')
        prepared={'sha':self.sha,'old_web':self.profile.old_web,'image_id':image,'public_manifest':manifest,
                  'gateway_sha256':digest(gateway.encode()),'rollback_files':rollback,
                  'baseline_capabilities':self.http_json('/v1/capabilities',public=False),
                  'baseline_auth':self.http_json('/v1/auth/config')}
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
        for path in '/test/kitchen/prep /test/kitchen/assembly /test/display'.split(): require(self.http(path)[0]==200,'TEST screen unavailable')
        self.verify_public()
        require(self.fingerprint()==before['neighbors'],'Unrelated container changed after reopening')
        self.cleanup('release')
        self.save('result.json',{'source_sha':self.sha,'backup':backup,'schema':self.profile.baseline_count+len(self.profile.migrations),'backoffice_enabled':True,'mobile_storefront_enabled':False,'manager_issued':False,'non_backoffice_assets_preserved':True,'existing_data_preserved':True,'old_image_compatible':True,'runtime_acl_verified':True,'web_mounts_verified':True})
        print('Published director bundle and schema033; manager access still requires a separate scoped grant',flush=True)


    def rollback_closed(self):
        self.source_checks(); self.ci()
        require(hasattr(self,'maintenance') and hasattr(self,'lock_owner'), 'Original owner maintenance context required')
        before=json.loads((self.private/'before.json').read_text())
        proof=json.loads((self.private/'prepared.json').read_text())
        require(self.rollback_artifacts()==proof['rollback_files'],'Rollback artifacts changed')
        require(self.fingerprint()==before['neighbors'],'Neighbor changed; inspect before rollback')
        self.cleanup('status')
        require(self.http('/v1/test/orders',method='POST')[0]==503,'Rollback requires retained maintenance')
        self.remote(market.api_compose(self.sha)+' stop --timeout 30 api',timeout=60)
        require(self.psql(market.DB,"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (usename='pickchick_app' OR xact_start IS NOT NULL)")=='0','Competing writer')
        market.compare_existing(before['data'],self.snapshot(),additions=True,new_tables=NEW_TABLES)
        self.psql(market.DB,market.acl_restore_sql(before['acl'],self.acl()))
        require(self.acl()==before['acl'],'Old ACL not restored exactly')
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'],'Old API incompatible with retained033')
        for path,old,new in [(REMOTE+'/current',REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha),
            (REMOTE+'/public-https/current',REMOTE+'/public-https/releases/'+PUBLIC_BASELINE,REMOTE+'/public-https/releases/'+self.sha)]:
            actual=self.remote('readlink -f '+path)
            require(actual in [old,new],'Concurrent pointer change')
            if actual==new:self.switch(path,new,old)
        require(self.fingerprint()==before['neighbors'],'Neighbor changed during rollback')
        self.remote(market.web_compose(PUBLIC_BASELINE)+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        self.cleanup('release')
        self.save('rollback.json',{'schema_retained':33,'acl_restored':True,'live_dump_restored':False})


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','apply'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']:
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--ssh-key',type=Path,required=True)
    parser.add_argument('--backup-identity',type=Path)
    parser.add_argument('--ci-proof',type=Path)
    parser.add_argument('--ci-run')
    args=parser.parse_args(); release=Release(args)
    try:
        with release.deployment_lock():getattr(release,args.action)()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error,market.GuardFailure) else 'Stopped; owned maintenance retained.',file=sys.stderr)
        raise SystemExit(1)
if __name__=='__main__':main()
