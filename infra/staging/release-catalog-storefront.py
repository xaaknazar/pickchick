#!/usr/bin/env python3
"""Schema038 mobile catalog rollout. One read-only route and storefront flag only.

No provision, migrations, grants, bank calls or public bundle changes.

Requires exact-source green CI, owned maintenance, encrypted backup/restore,
unchanged database/ACL fingerprints and pointer CAS. Failures retain maintenance
for operator inspection; this tool never restores a production dump.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid

spec = importlib.util.spec_from_file_location('catalog_storefront_base', Path(__file__).with_name('release-farm-pilot.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require, quote = base.market, base.require, base.market.quote
transport = base.transport
BASELINE = 'f39863718f074e923ae24ffecf37d8bf36987cdf'
PUBLIC_BASELINE = '239148bf3329f6ec8e467b9425bcdff6189dd414'
GATEWAY_BASELINE = '1df3d12b60e829081bc90b77256cfc5a84b30064cabe8039cae519a41465ed51'
COMPOSE_BASELINE = 'c62c24cb90418e791b9740352ffcafe4c664a1669887914d79dfea96dbbc5db2'


def api_compose_candidate(text):
    require(market.digest(text.encode()) == COMPOSE_BASELINE, 'Unreviewed live API compose')
    require(text.count('      FARM_ENABLED: "1"') == 1, 'Installed farm flag differs')
    marker = '      CATALOG_MOBILE_STOREFRONT_ENABLED: "false"'
    require(text.count(marker) == 2, 'API/provision storefront boundary differs')
    return text.replace(marker, marker.replace('"false"', '"true"'), 1)


def gateway_candidate(text):
    require(market.digest(text.encode()) == GATEWAY_BASELINE, 'Unreviewed gateway baseline')
    marker = "path('/v1/customer-checkout/config', '/v1/customer-checkout/orders', '/v1/customer-checkout/availability', '/v1/customer-checkout/feedback')"
    require(text.count(marker) == 1 and '/v1/customer-checkout/catalog' not in text,
            'Customer catalog route boundary differs')
    return text.replace(marker, marker[:-1] + ", '/v1/customer-checkout/catalog')", 1)


class Release(base.Release):
    additions = {}
    baseline_migrations = market.Release.baseline_migrations
    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == GATEWAY_BASELINE, 'Unreviewed farm update baseline')
        profile = market.ReleaseProfile('mobile-storefront-schema038', BASELINE, PUBLIC_BASELINE,
            38, (), base.CI_JOBS, frozenset(), 'catalog-storefront-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def source_checks(self):
        market.Release.source_checks(self)

    def web_manifest_source(self):
        return 'e236824b80ee315eae48c371d722f4f6459aac8c'

    def runtime_old(self):
        market.Release.runtime_old(self)
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == GATEWAY_BASELINE, 'Gateway changed')
        require(self.file_hashes([market.REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml']) ==
                {market.REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml':COMPOSE_BASELINE}, 'Installed compose changed')
        expected = [{'version':name,'scope':'cloud','checksum':market.digest((market.REPO/'db/cloud/migrations'/name).read_bytes())} for name in self.baseline_migrations()]
        require(self.ledger() == expected, 'Installed schema038 ledger differs')
        require(self.runtime_environment().get('FARM_ENABLED') == market.digest(b'1'), 'Installed farm disabled')
        require(self.runtime_environment().get('CATALOG_MOBILE_STOREFRONT_ENABLED') == market.digest(b'false'), 'Baseline storefront flag differs')
        require(self.runtime_environment().get('CUSTOMER_KASPI_BRANCH_ID') == market.digest(b'7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'), 'Checkout branch differs from reviewed ABAY publication')
        self.catalog_read_acl()

    def verify_environment(self, before):
        after = self.runtime_environment()
        require(after.get('CATALOG_MOBILE_STOREFRONT_ENABLED') == market.digest(b'true'), 'Storefront flag missing')
        exclude = {'CATALOG_MOBILE_STOREFRONT_ENABLED', 'RELEASE_SHA'}
        require({k:v for k,v in before.items() if k not in exclude} ==
                {k:v for k,v in after.items() if k not in exclude}, 'Other API environment changed')

    def catalog_read_acl(self):
        require(self.psql(market.DB, "SELECT bool_and(has_table_privilege('pickchick_app',t,'SELECT')) FROM unnest(ARRAY['branches','catalog_branch_heads','catalog_publications']) t") == 't',
                'Existing API catalog SELECT privileges missing; separate reviewed grant required')

    def compare_runtime(self, before):
        base.verify_availability(before['availability'],self.availability_rows())
        market.compare_existing(before['runtime_data'],self.runtime_snapshot())

    def verify_data(self, before):
        require(self.ledger() == before['ledger'], 'API-only release changed migrations')
        self.compare_runtime(before)
        require(self.acl() == before['acl'], 'API-only release changed permissions')
        require(self.worker_acl() == before['worker_acl'], 'Bank worker permissions changed')

    def public_artifacts(self, sha=None, mounted=True):
        sha = sha or PUBLIC_BASELINE
        root = market.REMOTE+'/public-https/releases/'+sha+'/infra/public-staging'
        manifest = json.loads(self.remote('cat '+quote(root+'/public-web/.release.json')))
        paths = [root+'/compose.yaml',root+'/gateway.Caddyfile',root+'/public-web/.release.json']
        for name,checksum in manifest['files'].items():
            require(re.fullmatch('[A-Za-z0-9._/-]+',name) and not name.startswith('/') and '..' not in Path(name).parts, 'Invalid manifest path')
            paths.append(root+'/public-web/'+name)
        hashes = self.file_hashes(paths)
        require(all(hashes[root+'/public-web/'+name] == value for name,value in manifest['files'].items()), 'Public asset hash differs')
        mounts = json.loads(self.remote('docker inspect --format '+quote('{{json .Mounts}}')+' '+market.GATEWAY))
        destinations = {row['Destination']:row['Source'] for row in mounts}
        if mounted:
            require(destinations.get('/etc/caddy/Caddyfile') == root+'/gateway.Caddyfile' and destinations.get('/srv/public') == root+'/public-web', 'Gateway public mounts differ')
        return {'manifest':manifest,'hashes':hashes}

    def verify_public(self):
        proof = json.loads((self.private/'prepared.json').read_text())
        active = self.remote('readlink -f '+market.REMOTE+'/public-https/current').rsplit('/',1)[-1]
        require(active in [PUBLIC_BASELINE,self.sha], 'Public pointer drift')
        expected = proof['public_artifacts'] if active == PUBLIC_BASELINE else proof['candidate_public_artifacts']
        require(self.public_artifacts(active) == expected, 'Public assets changed')
        if active == self.sha:
            actual = self.http_json('/v1/customer-checkout/catalog')
            require(actual == proof['baseline_catalog'], 'Published catalog differs from read-only baseline')
        require(self.http_json('/v1/auth/config') == proof['baseline_auth'], 'Auth policy changed')
        require(self.http_json('/v1/customer-checkout/availability').get('hours') == proof['baseline_hours'], 'Checkout hours changed')
        require(self.http_json('/kitchen-live/health')['sourceSha'] == proof['kitchen_sha'], 'Kitchen bridge changed')
        for path,method in [('/v1/customer-farm','GET'),('/v1/customer-farm/commands','POST')]:
            require(self.http(path,method=method)[0] == 401, 'Farm route unavailable or anonymous access accepted')

    def api_artifacts(self):
        target = market.REMOTE+'/releases/'+self.sha
        image = json.loads(self.remote('docker image inspect --format '+quote('{{json .}}')+' pickchick-api:'+self.sha))
        require(image['Config']['Labels']['org.opencontainers.image.revision'] == self.sha, 'Image revision differs')
        old_image = json.loads(self.remote('docker image inspect --format '+quote('{{json .}}')+' pickchick-api:'+BASELINE))
        require(old_image['Config']['Labels']['org.opencontainers.image.revision'] == BASELINE, 'Rollback image revision differs')
        return {'image_id': image['Id'], 'rollback_image_id':old_image['Id'], 'files': self.file_hashes([target+'/release.env', target+'/infra/staging/compose.yaml']),
                'rollback_files': self.rollback_artifacts(),
                'checkout_policy': self.protected_policy()}

    def prepare(self):
        self.source_checks(); self.ci(); self.runtime_old()
        require(not (self.private/'prepared.json').exists(), 'Preparation already exists')
        old = market.REMOTE+'/releases/'+BASELINE
        # Preserve the installed seller/customer/payment/auth policy byte-for-byte.
        self.validate_checkout(self.remote('cat '+quote(self.checkout_file)))
        compose = self.remote('cat '+quote(old+'/infra/staging/compose.yaml'))+'\n'
        candidate = api_compose_candidate(compose)
        rollback = self.rollback_artifacts()
        archive = self.execute(['git', 'archive', '--format=tar', self.sha, *market.ARCHIVE_PATHS])
        target = market.REMOTE+'/releases/'+self.sha
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}', input=archive, timeout=180)
        self.remote('python3 -c '+quote(base.release_env_program())+' '+' '.join(map(quote,
            [old+'/release.env', target+'/release.env', self.sha, BASELINE])))
        writer = 'from pathlib import Path;import sys;p=Path(sys.argv[1]);p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)'
        self.remote('python3 -c '+quote(writer)+' '+quote(target+'/infra/staging/compose.yaml'), input=candidate)
        self.remote('! docker image inspect pickchick-api:'+self.sha+' >/dev/null 2>&1')
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} -t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Invalid immutable image')
        self.remote(market.api_compose(self.sha)+' config --quiet')
        artifacts = self.api_artifacts()
        require(artifacts['image_id'] == image and self.rollback_artifacts() == rollback, 'Preparation drift')
        old_public = market.REMOTE+'/public-https/releases/'+PUBLIC_BASELINE+'/infra/public-staging'
        new_public = market.REMOTE+'/public-https/releases/'+self.sha+'/infra/public-staging'
        raw_gateway = self.remote('cat '+quote(old_public+'/gateway.Caddyfile'))+'\n'
        gateway = gateway_candidate(raw_gateway)
        self.remote('test ! -e '+quote(market.REMOTE+'/public-https/releases/'+self.sha)+' && mkdir -p '+quote(new_public)+' && cp -a '+quote(old_public+'/.')+' '+quote(new_public+'/'),timeout=180)
        web = json.loads(self.remote(market.web_compose(PUBLIC_BASELINE)+' config --format json'))
        relocated = base.director.relocate_public_mounts(web,old_public,new_public)
        self.remote('python3 -c '+quote(writer)+' '+quote(new_public+'/compose.yaml'),input=json.dumps(relocated))
        self.remote('python3 -c '+quote(base.file_writer_program(public_gateway=True))+' '+quote(new_public+'/gateway.Caddyfile'),input=gateway)
        self.remote(market.web_compose(self.sha)+' config --quiet')
        self.remote(base.gateway_validation_command(new_public+'/gateway.Caddyfile'))
        # Read only public catalog fields; no customer or order rows enter this proof.
        catalog = json.loads(self.psql(market.DB, "SELECT json_build_object('branch',json_build_object('id',b.id,'code',b.code,'name',b.name,'timezone',b.timezone,'ordering_enabled',b.ordering_enabled),'channel','mobile','version',p.version,'published_at',to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'payload',p.payload) FROM branches b JOIN catalog_branch_heads h ON h.branch_id=b.id AND h.organization_id=b.organization_id JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.organization_id=h.organization_id AND p.version=h.published_version WHERE b.id='7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'"))
        require(catalog['channel'] == 'mobile' and catalog['version'] > 0, 'No published mobile catalog')
        old_artifacts = self.public_artifacts()
        new_artifacts = self.public_artifacts(self.sha,mounted=False)
        require(old_artifacts['manifest'] == new_artifacts['manifest'], 'Manifest changed')
        old_files = {k.split('/infra/public-staging/',1)[1]:v for k,v in old_artifacts['hashes'].items() if '/public-web/' in k}
        new_files = {k.split('/infra/public-staging/',1)[1]:v for k,v in new_artifacts['hashes'].items() if '/public-web/' in k}
        require(old_files == new_files, 'Public bundle changed')
        self.save('prepared.json', {'sha': self.sha, 'old_api': BASELINE, 'old_web': PUBLIC_BASELINE, 'artifacts': artifacts,
            'baseline_capabilities':self.http_json('/v1/capabilities',public=False),
            'baseline_auth':self.http_json('/v1/auth/config'),
            'baseline_hours':self.http_json('/v1/customer-checkout/availability').get('hours'),
            'baseline_environment':self.runtime_environment(),
            'kitchen_sha':self.http_json('/kitchen-live/health')['sourceSha'],
            'public_artifacts':old_artifacts,'candidate_public_artifacts':new_artifacts,'baseline_catalog':catalog,'gateway_sha256':market.digest(gateway.encode())})
        print('Prepared API only; active services unchanged')

    def apply(self):
        self.source_checks(); self.ci(); self.runtime_old()
        proof = json.loads((self.private/'prepared.json').read_text())
        require((proof['sha'], proof['old_api'], proof['old_web']) == (self.sha, BASELINE, PUBLIC_BASELINE), 'Preparation source differs')
        require(self.api_artifacts() == proof['artifacts'], 'Prepared artifacts changed')
        require(self.runtime_environment() == proof['baseline_environment'], 'Installed environment changed')
        self.verify_public()
        require(self.public_artifacts(self.sha,mounted=False) == proof['candidate_public_artifacts'], 'Candidate public artifacts drift')
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0, 'Protected backup identity required')
        self.maintenance = market.REMOTE+'/maintenance/catalog-storefront-'+self.lock_owner['id']
        contents = {'owner.json': json.dumps(self.lock_owner), 'maintenance.json': json.dumps(transport.maintenance_config()),
                    'compose.json': json.dumps(transport.maintenance_overlay(self.maintenance))}
        self.remote('python3 -c '+quote(transport.maintenance_write_script())+' '+quote(self.maintenance), input=json.dumps(contents))
        self.remote(transport.caddy_validation_command(self.maintenance+'/maintenance.json'))
        self.cleanup('acquire')
        self.remote(market.web_compose(PUBLIC_BASELINE)+' -f '+quote(self.maintenance+'/compose.json')+' up -d --no-deps --wait --wait-timeout 90 gateway', timeout=150)
        require(self.http('/v1/test/orders',method='POST')[0] == 503, 'Ingress did not close')
        self.quiescent()
        self.remote(market.api_compose(BASELINE)+' stop --timeout 30 api', timeout=60)
        require(self.psql(market.DB, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (usename='pickchick_app' OR xact_start IS NOT NULL)") == '0', 'Competing database writer')
        before = {'data': self.snapshot(), 'ledger': self.ledger(), 'acl': self.acl(), 'worker_acl':self.worker_acl(),
                  'runtime_data':self.runtime_snapshot(),'availability':self.availability_rows(), 'neighbors': self.fingerprint()}
        expected = [{'version': name, 'scope': 'cloud', 'checksum': market.digest((market.REPO/'db/cloud/migrations'/name).read_bytes())} for name in self.baseline_migrations()]
        require(before['ledger'] == expected, 'Baseline schema differs')
        self.save('before.json', before)
        backup = self.backup_restore(before['data']); self.save('backup.json', backup)
        self.verify_data(before)
        # Existing SELECT privileges are sufficient; no provision/migration/grant command.
        self.catalog_read_acl()
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        require(self.http_json('/health/ready', public=False)['ready'], 'Candidate not ready')
        self.verify_capabilities(self.http_json('/v1/capabilities', public=False))
        self.verify_environment(proof['baseline_environment'])
        require(self.http_json('/v1/customer-checkout/catalog',public=False) == proof['baseline_catalog'], 'Candidate catalog differs')
        require(self.public_artifacts(self.sha,mounted=False) == proof['candidate_public_artifacts'], 'Candidate public artifacts drift')
        self.verify_data(before)
        require(self.fingerprint() == before['neighbors'] and self.api_artifacts() == proof['artifacts'], 'Unrelated service or artifacts changed')
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == proof['artifacts']['image_id'], 'Running image differs')
        self.switch(market.REMOTE+'/current', market.REMOTE+'/releases/'+BASELINE, market.REMOTE+'/releases/'+self.sha)
        self.switch(market.REMOTE+'/public-https/current',market.REMOTE+'/public-https/releases/'+PUBLIC_BASELINE,market.REMOTE+'/public-https/releases/'+self.sha)
        self.phase = 'reopening'
        self.save('phase.json',{'phase':self.phase,'ingress':'unknown'})
        self.remote(market.web_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 90 gateway', timeout=150)
        self.phase = 'reopened'
        self.save('phase.json',{'phase':self.phase,'ingress':'open'})
        require(self.remote('readlink -f '+market.REMOTE+'/public-https/current') == market.REMOTE+'/public-https/releases/'+self.sha, 'Public pointer changed')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == proof['gateway_sha256'], 'Gateway changed')
        self.verify_public()
        self.verify_capabilities(self.http_json('/v1/capabilities'))
        require(self.fingerprint() == before['neighbors'], 'Unrelated service changed')
        self.cleanup('release')
        self.phase='complete'
        self.save('phase.json',{'phase':self.phase,'ingress':'open'})
        self.save('result.json', {'source_sha': self.sha, 'schema': 38, 'mobile_storefront_enabled': True, 'farm_enabled':True,
                                 'backup': backup, 'data_acl_unchanged': True, 'public_sha': self.sha})
        print('Published mobile catalog route; database, bank worker and public bundle preserved')

    def rollback(self):
        require(self.args.owner_id and str(uuid.UUID(self.args.owner_id)) == self.args.owner_id, 'Original owner UUID required')
        path = self.private/('lock-owner-'+self.args.owner_id+'.json')
        require(path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0, 'Protected original owner evidence required')
        owner = json.loads(path.read_text())
        require(owner == {'id':self.args.owner_id,'sha':self.sha,'action':'apply'}, 'Original apply owner differs')
        require(json.loads(self.remote('cat '+quote(market.DEPLOY_LOCK+'/owner.json'))) == owner, 'Deployment lock owner differs')
        self.lock_owner = owner
        self.maintenance = market.REMOTE+'/maintenance/catalog-storefront-'+owner['id']
        require(json.loads(self.remote('cat '+quote(self.maintenance+'/owner.json'))) == owner, 'Maintenance owner differs')
        self.source_checks(); self.ci(); self.cleanup('status')
        proof = json.loads((self.private/'prepared.json').read_text())
        require((proof['sha'],proof['old_api'],proof['old_web']) == (self.sha,BASELINE,PUBLIC_BASELINE), 'Wrong preparation')
        require(self.api_artifacts() == proof['artifacts'], 'Rollback artifacts changed')
        require(self.remote('readlink -f '+market.REMOTE+'/public-https/current') in [market.REMOTE+'/public-https/releases/'+PUBLIC_BASELINE,market.REMOTE+'/public-https/releases/'+self.sha], 'Public pointer changed')
        self.remote(market.web_compose(PUBLIC_BASELINE)+' -f '+quote(self.maintenance+'/compose.json')+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        require(self.http('/v1/test/orders',method='POST')[0] == 503, 'Rollback ingress not closed')
        self.remote(market.api_compose(self.sha)+' stop --timeout 30 api',timeout=60)
        self.quiescent()
        before = json.loads((self.private/'before.json').read_text())
        self.verify_data(before)
        require(self.fingerprint() == before['neighbors'], 'Rollback neighbors changed')
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == proof['artifacts']['rollback_image_id'], 'Rollback running image differs')
        require(self.http_json('/health/ready',public=False)['ready'], 'Old API not ready')
        self.verify_capabilities(self.http_json('/v1/capabilities',public=False))
        base.Release.verify_environment(self,proof['baseline_environment']); self.verify_data(before)
        actual = self.remote('readlink -f '+market.REMOTE+'/current')
        old,new = market.REMOTE+'/releases/'+BASELINE,market.REMOTE+'/releases/'+self.sha
        require(actual in [old,new], 'Concurrent API pointer change')
        if actual == new:self.switch(market.REMOTE+'/current',new,old)
        actual_public = self.remote('readlink -f '+market.REMOTE+'/public-https/current')
        if actual_public == market.REMOTE+'/public-https/releases/'+self.sha:
            self.switch(market.REMOTE+'/public-https/current',actual_public,market.REMOTE+'/public-https/releases/'+PUBLIC_BASELINE)
        self.phase='rollback_reopening'
        self.remote(market.web_compose(PUBLIC_BASELINE)+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        self.phase='rollback_reopened'
        self.verify_public()
        self.verify_capabilities(self.http_json('/v1/capabilities'))
        require(self.fingerprint() == before['neighbors'], 'Rollback neighbors changed')
        self.cleanup('release')
        program = "import json,os,sys;path,owner=sys.argv[1:];assert json.load(open(path+'/owner.json'))['id']==owner;os.unlink(path+'/owner.json');os.rmdir(path)"
        self.remote('python3 -c '+quote(program)+' '+quote(market.DEPLOY_LOCK)+' '+quote(owner['id']))
        self.phase='complete'
        self.save('rollback.json',{'schema_retained':38,'data_acl_unchanged':True,'live_dump_restored':False,'public_sha':PUBLIC_BASELINE})

    def retain_failure(self, error):
        ingress = 'unknown'
        reclosed = False
        if getattr(self,'phase','before_reopening') in ['reopening','reopened','rollback_reopening','rollback_reopened'] and not isinstance(error,market.CommandUncertain):
            try:
                self.cleanup('status')
                self.remote(market.web_compose(PUBLIC_BASELINE)+' -f '+quote(self.maintenance+'/compose.json')+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
                require(self.http('/v1/test/orders',method='POST')[0] == 503,'Failure maintenance did not close ingress')
                ingress,reclosed='closed',True
            except Exception:
                ingress='unknown'
        self.save('failure-context.json',{'phase':getattr(self,'phase','before_reopening'),'ingress':ingress,'maintenance_reclosed':reclosed,'automatic_rollback_started':False,'deployment_lock_retained':True})
        return ingress


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'apply', 'rollback'])
    for name in ['sha', 'branch', 'expected-api-sha', 'expected-public-sha', 'expected-gateway-sha256']:
        parser.add_argument('--'+name, required=True)
    for name in ['ssh-key', 'backup-identity', 'ci-proof']:
        parser.add_argument('--'+name, type=Path, required=name == 'ssh-key')
    parser.add_argument('--ci-run')
    parser.add_argument('--owner-id',help='Original retained apply owner UUID; rollback only')
    args = parser.parse_args()
    release = Release(args)
    try:
        if args.action == 'rollback':
            release.rollback()
        else:
            require(args.owner_id is None,'Owner UUID is rollback-only')
            with release.deployment_lock():
                getattr(release, args.action)()
    except Exception as error:
        release.record_error(error)
        release.retain_failure(error)
        print(str(error) if isinstance(error, market.GuardFailure) else 'Stopped; owned maintenance retained for inspection.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
