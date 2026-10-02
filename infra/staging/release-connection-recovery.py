#!/usr/bin/env python3
"""API-only schema032 release. No provision, migrations, bank worker or public bundle changes.

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

spec = importlib.util.spec_from_file_location('connection_feedback_base', Path(__file__).with_name('release-commerce-feedback.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require, quote = base.market, base.require, base.market.quote
transport = base.base.pilot.daily.transport
BASELINE = '9f6696924e90856f3fccde1d5185801100b62123'
GATEWAY_BASELINE = '11eefd7c872593ffc3d566e5e780c07b5907d29526faa42f1aabdad141bd1d7d'
COMPOSE_BASELINE = '80d850e2569719d9c9e5a0756e1e0f40489ccb2fa0a932faa738ad4f723d6bde'
HOURS = {'CUSTOMER_KASPI_OPENING_TIME': '10:00', 'CUSTOMER_KASPI_CLOSING_TIME': '00:00',
         'CUSTOMER_KASPI_TIMEZONE': 'Asia/Almaty'}


def api_compose_candidate(text):
    require(market.digest(text.encode()) == COMPOSE_BASELINE, 'Unreviewed live API compose')
    require(text.count('  api:\n') == 1 and text.count('  provision:\n') == 1,
            'Ambiguous API service boundary')
    start = text.index('  api:\n')
    # A top-level service has exactly two leading spaces, nested entries have more.
    match = re.search(r'^  [A-Za-z][A-Za-z0-9_-]*:', text[start + len('  api:\n'):], re.M)
    end = start + len('  api:\n') + match.start() if match else len(text)
    service = text[start:end]
    require(service.count('      APP_ENV: staging') == 1 and
            not any(key in text for key in HOURS), 'Hours already configured or API anchor differs')
    lines = ''.join('      '+key+': "'+value+'"\n' for key, value in HOURS.items())
    candidate = service.replace('      APP_ENV: staging', lines+'      APP_ENV: staging')
    return text[:start] + candidate + text[end:]


class Release(base.Release):
    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == BASELINE and
                args.expected_gateway_sha256 == GATEWAY_BASELINE, 'Unreviewed connection baseline')
        profile = market.ReleaseProfile('connection-hours-api-schema032', BASELINE, BASELINE,
            32, (), market.TRANSPORT_PROFILE.ci_jobs, frozenset(), 'connection-recovery-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        return BASELINE

    def verify_data(self, before):
        require(self.ledger() == before['ledger'], 'API-only release changed migrations')
        market.compare_existing(before['data'], self.snapshot())
        require(self.acl() == before['acl'], 'API-only release changed permissions')

    def verify_hours(self):
        availability = self.http_json('/v1/customer-checkout/availability')
        require(availability.get('hours') == {'openingTime': '10:00', 'closingTime': '00:00',
                                            'timeZone': 'Asia/Almaty'}, 'Published hours differ')
        require(type(availability.get('orderingOpen')) is bool, 'Hours ordering state missing')

    def api_artifacts(self):
        target = market.REMOTE+'/releases/'+self.sha
        image = json.loads(self.remote('docker image inspect --format '+quote('{{json .}}')+' pickchick-api:'+self.sha))
        require(image['Config']['Labels']['org.opencontainers.image.revision'] == self.sha, 'Image revision differs')
        return {'image_id': image['Id'], 'files': self.file_hashes([target+'/release.env', target+'/infra/staging/compose.yaml']),
                'rollback_files': self.rollback_artifacts(),
                'checkout_policy': self.file_hashes([self.checkout_file, base.base.pilot.AUTH_FILE])}

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
        self.remote('python3 -c '+quote(market.release_env_script(self.profile))+' '+' '.join(map(quote,
            [old+'/release.env', target+'/release.env', self.sha, BASELINE])))
        writer = 'from pathlib import Path;import sys;p=Path(sys.argv[1]);p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)'
        self.remote('python3 -c '+quote(writer)+' '+quote(target+'/infra/staging/compose.yaml'), input=candidate)
        self.remote('! docker image inspect pickchick-api:'+self.sha+' >/dev/null 2>&1')
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} -t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Invalid immutable image')
        self.remote(market.api_compose(self.sha)+' config --quiet')
        artifacts = self.api_artifacts()
        require(artifacts['image_id'] == image and self.rollback_artifacts() == rollback, 'Preparation drift')
        self.save('prepared.json', {'sha': self.sha, 'old_api': BASELINE, 'old_web': BASELINE, 'artifacts': artifacts})
        print('Prepared API only; active services unchanged')

    def apply(self):
        self.source_checks(); self.ci(); self.runtime_old()
        proof = json.loads((self.private/'prepared.json').read_text())
        require((proof['sha'], proof['old_api'], proof['old_web']) == (self.sha, BASELINE, BASELINE), 'Preparation source differs')
        require(self.api_artifacts() == proof['artifacts'], 'Prepared artifacts changed')
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0, 'Protected backup identity required')
        self.maintenance = market.REMOTE+'/maintenance/connection-'+self.lock_owner['id']
        contents = {'owner.json': json.dumps(self.lock_owner), 'maintenance.json': json.dumps(transport.maintenance_config()),
                    'compose.json': json.dumps(transport.maintenance_overlay(self.maintenance))}
        self.remote('python3 -c '+quote(transport.maintenance_write_script())+' '+quote(self.maintenance), input=json.dumps(contents))
        self.remote(transport.caddy_validation_command(self.maintenance+'/maintenance.json'))
        self.cleanup('acquire')
        self.remote(market.web_compose(BASELINE)+' -f '+quote(self.maintenance+'/compose.json')+' up -d --no-deps --wait --wait-timeout 90 gateway', timeout=150)
        self.quiescent()
        self.remote(market.api_compose(BASELINE)+' stop --timeout 30 api', timeout=60)
        require(self.psql(market.DB, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (usename='pickchick_app' OR xact_start IS NOT NULL)") == '0', 'Competing database writer')
        before = {'data': self.snapshot(), 'ledger': self.ledger(), 'acl': self.acl(), 'neighbors': self.fingerprint()}
        expected = [{'version': name, 'scope': 'cloud', 'checksum': market.digest((market.REPO/'db/cloud/migrations'/name).read_bytes())} for name in self.baseline_migrations()]
        require(before['ledger'] == expected, 'Baseline schema differs')
        self.save('before.json', before)
        backup = self.backup_restore(before['data']); self.save('backup.json', backup)
        self.verify_data(before)
        # No provision/migration/grant command, and no public pointer/bundle replacement.
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        require(self.http_json('/health/ready', public=False)['ready'], 'Candidate not ready')
        self.verify_capabilities(self.http_json('/v1/capabilities', public=False))
        env_reader = 'import json,sys; keys=set(json.loads(sys.argv[1])); print(json.dumps([s for s in json.load(sys.stdin) if s.split("=",1)[0] in keys]))'
        env = json.loads(self.remote('docker inspect --format '+quote('{{json .Config.Env}}')+' '+market.API_CONTAINER+' | python3 -c '+quote(env_reader)+' '+quote(json.dumps(list(HOURS)))))
        require({k: [s.split('=', 1)[1] for s in env if s.startswith(k+'=')] for k in HOURS} == {k: [v] for k, v in HOURS.items()}, 'Running hours differ')
        self.verify_data(before)
        require(self.fingerprint() == before['neighbors'] and self.api_artifacts() == proof['artifacts'], 'Unrelated service or artifacts changed')
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == proof['artifacts']['image_id'], 'Running image differs')
        self.switch(market.REMOTE+'/current', market.REMOTE+'/releases/'+BASELINE, market.REMOTE+'/releases/'+self.sha)
        self.remote(market.web_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 90 gateway', timeout=150)
        require(self.remote('readlink -f '+market.REMOTE+'/public-https/current') == market.REMOTE+'/public-https/releases/'+BASELINE, 'Public pointer changed')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == GATEWAY_BASELINE, 'Gateway changed')
        self.verify_public()
        self.verify_hours()
        require(self.fingerprint() == before['neighbors'], 'Unrelated service changed')
        self.cleanup('release')
        self.save('result.json', {'source_sha': self.sha, 'schema': 32, 'api_only': True, 'hours': HOURS,
                                 'backup': backup, 'data_acl_unchanged': True, 'public_sha': BASELINE})
        print('Published API only; database, bank worker and public bundle preserved')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'apply'])
    for name in ['sha', 'branch', 'expected-api-sha', 'expected-public-sha', 'expected-gateway-sha256']:
        parser.add_argument('--'+name, required=True)
    for name in ['ssh-key', 'backup-identity', 'ci-proof']:
        parser.add_argument('--'+name, type=Path, required=name == 'ssh-key')
    parser.add_argument('--ci-run')
    args = parser.parse_args()
    release = Release(args)
    try:
        with release.deployment_lock():
            getattr(release, args.action)()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error, market.GuardFailure) else 'Stopped; owned maintenance retained for inspection.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
