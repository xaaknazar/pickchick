#!/usr/bin/env python3
"""App-only order-events release on schema019; preserves data, ACL and public overlays."""
import argparse
import json
from pathlib import Path
import re
import sys

# Reuse owned deploy/cleanup locks, encrypted restore rehearsal and immutable guards.
import importlib.util
spec = importlib.util.spec_from_file_location('order_events_mobile_release', Path(__file__).with_name('release-mobile-test.py'))
mobile = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mobile
spec.loader.exec_module(mobile)
market, transport = mobile.market, mobile.transport
require, quote, digest, REMOTE = market.require, market.quote, market.digest, market.REMOTE


def extend_gateway(text, source):
    start = source.index('\t# Bounded event wait:')
    end = source.index('\t@test_post {', start)
    block = source[start:end]
    require(text.count('\t@test_post {') == 1 and '@test_order_watch' not in text,
            'Unexpected watch gateway baseline')
    require(text.count('write 10s') == 1, 'Unexpected gateway write timeout')
    start = text.index('\t@test_post_preflight {')
    end = text.index('\t@test_post {', start)
    preflight = text[start:end]
    require(preflight.count('sessions/continue|quotes|orders|') == 1, 'Unexpected POST preflight')
    patched = preflight.replace('sessions/continue|quotes|orders|', 'sessions/continue|quotes|orders/watch|orders|')
    return text[:start].replace('write 10s', 'write 40s') + patched + block + text[end:]


class Release(mobile.Release):
    def __init__(self, args):
        require(all(re.fullmatch('[a-f0-9]{40}', v) for v in [args.expected_api_sha, args.expected_public_sha]), 'Exact baseline SHAs required')
        profile = market.ReleaseProfile('order-events-schema019', args.expected_api_sha,
            args.expected_public_sha, 19, (), market.TRANSPORT_PROFILE.ci_jobs, frozenset(),
            'order-events-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    snapshot = market.Release.snapshot

    def runtime_old(self):
        require(self.remote('readlink -f '+REMOTE+'/current') == REMOTE+'/releases/'+self.profile.old_api, 'API pointer changed')
        require(self.remote('readlink -f '+REMOTE+'/public-https/current') == REMOTE+'/public-https/releases/'+self.profile.old_web, 'Public pointer changed')
        revision = '{{index .Config.Labels "org.opencontainers.image.revision"}}'
        require(self.remote('docker inspect --format '+quote(revision)+' '+market.API_CONTAINER) == self.profile.old_api, 'API image differs')
        require(self.remote('docker image inspect --format '+quote(revision)+' pickchick-api:'+self.profile.old_api) == self.profile.old_api, 'Rollback image differs')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == self.args.expected_gateway_sha256, 'Mounted gateway differs')
        web = REMOTE+'/public-https/releases/'+self.profile.old_web+'/infra/public-staging'
        require(json.loads(self.remote('cat '+web+'/public-web/.release.json')) == json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json')), 'Mounted assets differ')
        expected = [{'version': n, 'scope': 'cloud', 'checksum': digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in self.baseline_migrations()]
        require(self.ledger() == expected, 'Schema019 baseline differs')

    def prepare(self):
        self.source_checks(); self.runtime_old()
        require(not (self.private/'prepared.json').exists(), 'Already prepared')
        rollback = self.rollback_artifacts()
        target = REMOTE+'/releases/'+self.sha
        archive = self.execute(['git','archive','--format=tar',self.sha,*market.ARCHIVE_PATHS])
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}',input=archive,timeout=180)
        self.remote('python3 -c '+quote(market.release_env_script(self.profile))+' '+' '.join(map(quote,[REMOTE+'/releases/'+self.profile.old_api+'/release.env',target+'/release.env',self.sha,self.profile.old_api])))
        self.remote('! docker image inspect pickchick-api:'+self.sha+' >/dev/null 2>&1')
        print('Building immutable API; active services unchanged',flush=True)
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} -t pickchick-api:{self.sha} .',timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}',image), 'Invalid image ID')
        old = REMOTE+'/public-https/releases/'+self.profile.old_web+'/infra/public-staging'
        new = REMOTE+'/public-https/releases/'+self.sha+'/infra/public-staging'
        self.remote(f'test ! -e {REMOTE}/public-https/releases/{self.sha} && mkdir -p {new} && cp -a {old}/. {new}/')
        compose = json.loads(self.remote(market.web_compose(self.profile.old_web)+' config --format json'))
        compose = mobile.relocate_public_mounts(compose,old,new)
        old_gateway = self.remote('cat '+old+'/gateway.Caddyfile')+'\n'
        require(digest(old_gateway.encode()) == self.args.expected_gateway_sha256, 'Gateway source differs')
        gateway = extend_gateway(old_gateway,(market.REPO/'infra/public-staging/gateway.Caddyfile').read_text())
        writer = 'from pathlib import Path;import sys;Path(sys.argv[1]).write_text(sys.stdin.read())'
        for name,value in [('compose.yaml',json.dumps(compose)),('gateway.Caddyfile',gateway)]:
            self.remote('python3 -c '+quote(writer)+' '+quote(new+'/'+name),input=value)
        self.remote(market.web_compose(self.sha)+' config --quiet')
        self.remote('docker run --rm --network none --entrypoint caddy -v '+new+'/gateway.Caddyfile:/tmp/Caddyfile:ro '+transport.CADDY+' validate --config /tmp/Caddyfile --adapter caddyfile')
        manifest = json.loads(self.remote('cat '+new+'/public-web/.release.json'))
        proof = {'sha':self.sha,'old_api':self.profile.old_api,'old_web':self.profile.old_web,
                 'image_id':image,'public_manifest':manifest,'gateway_sha256':digest(gateway.encode()),
                 'rollback_files':rollback,'artifacts':self.prepared_artifacts(manifest)}
        require(self.rollback_artifacts()==rollback, 'Baseline changed during preparation')
        self.save('prepared.json',proof)
        print('Prepared API and minimal gateway overlay',flush=True)

    def apply(self):
        self.source_checks(); self.ci(); self.runtime_old()
        proof = json.loads((self.private/'prepared.json').read_text())
        require((proof['sha'],proof['old_api'],proof['old_web']) == (self.sha,self.profile.old_api,self.profile.old_web), 'Preparation differs')
        require(self.prepared_artifacts(proof['public_manifest'])==proof['artifacts'], 'Immutable artifacts changed')
        key=self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode&0o077==0, 'Protected backup identity required')
        self.maintenance = REMOTE+'/maintenance/order-events-'+self.lock_owner['id']
        contents = {'owner.json':json.dumps(self.lock_owner),'maintenance.json':json.dumps(transport.maintenance_config()),'compose.json':json.dumps(transport.maintenance_overlay(self.maintenance))}
        self.remote('python3 -c '+quote(transport.maintenance_write_script())+' '+quote(self.maintenance),input=json.dumps(contents))
        self.remote(transport.caddy_validation_command(self.maintenance+'/maintenance.json'))
        self.cleanup('acquire')
        self.remote(market.web_compose(self.profile.old_web)+' -f '+quote(self.maintenance+'/compose.json')+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        self.quiescent()
        self.remote(market.api_compose(self.profile.old_api)+' stop --timeout 30 api',timeout=60)
        require(self.psql(market.DB,"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (usename='pickchick_app' OR xact_start IS NOT NULL)")=='0','Competing writer')
        before = {'data':self.snapshot(),'acl':self.acl(),'ledger':self.ledger(),'neighbors':self.fingerprint()}
        self.save('before.json',before)
        backup = self.backup_restore(before['data']); self.save('backup.json',backup)
        # No provision/migration/grant operation. Rollback is the previous API image.
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Candidate not ready')
        caps = self.http_json('/v1/capabilities',public=False)
        require(caps['features'].get('unpaid_test_orders') is True and caps['ordering_enabled'] is False, 'TEST gate differs')
        require(all(caps['features'][name] is False for name in ['phone_auth','checkout','payments','fiscal','loyalty']), 'Commercial feature enabled')
        require(self.snapshot()==before['data'] and self.acl()==before['acl'] and self.ledger()==before['ledger'], 'Database or permissions changed')
        require(self.fingerprint()==before['neighbors'], 'Unrelated service changed')
        require(self.prepared_artifacts(proof['public_manifest'])==proof['artifacts'], 'Artifacts changed')
        self.switch(REMOTE+'/current',REMOTE+'/releases/'+self.profile.old_api,REMOTE+'/releases/'+self.sha)
        self.switch(REMOTE+'/public-https/current',REMOTE+'/public-https/releases/'+self.profile.old_web,REMOTE+'/public-https/releases/'+self.sha)
        self.remote(market.web_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0]==proof['gateway_sha256'], 'Mounted gateway differs')
        require(json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json'))==proof['public_manifest'], 'Mounted assets differ')
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER)==proof['image_id'], 'Running image differs')
        require(self.http_json('/v1/capabilities')==caps, 'Public capabilities differ')
        require(self.http('/v1/test/orders/watch',method='POST')[0]==400, 'Watch allowlist is not active')
        require(self.http_json('/kitchen-live/health')['edgeConnected'] is True, 'Cashier kitchen disconnected')
        require(self.fingerprint()==before['neighbors'], 'Unrelated service changed')
        self.cleanup('release')
        self.save('result.json',{'source_sha':self.sha,'schema':19,'database_unchanged':True,'acl_unchanged':True,'neighbors_unchanged':True,'backup':backup,'public_watch_enabled':True})
        print('Published event-driven TEST status; data and other services preserved',flush=True)


def main():
    p=argparse.ArgumentParser()
    p.add_argument('action',choices=['prepare','apply'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']: p.add_argument('--'+name,required=True)
    p.add_argument('--ssh-key',type=Path,required=True)
    p.add_argument('--backup-identity',type=Path)
    p.add_argument('--ci-proof',type=Path)
    p.add_argument('--ci-run')
    args=p.parse_args();release=Release(args)
    try:
        with release.deployment_lock(): getattr(release,args.action)()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error,market.GuardFailure) else 'Release stopped; inspect private diagnostics. Lock retained.',file=sys.stderr)
        raise SystemExit(1)
if __name__=='__main__': main()
