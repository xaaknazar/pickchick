#!/usr/bin/env python3
"""Append verified DNS aliases to shared ingress without restarting any service.

Run on the VPS with an exact successful CI proof obtained through GitHub API.
Default is read-only inspect/validate. Never deploy an API, secret, schema or payment.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path('/opt/pickchick-staging')
FRONT = Path('/opt/idrink/deploy/Caddyfile')
LOCK = ROOT / '.market-release.lock'
OLD = 'https://pickchick.185.129.51.103.nip.io'
NAMES = ['deploy-caddy-1', 'deploy-server-1', 'deploy-db-1', 'pickchick-public-gateway',
         'pickchick-staging-api-1', 'pickchick-staging-cloud-db-1',
         'pickchick-staging-redis-cache-1', 'pickchick-kitchen-portal', 'pickchick-roadmap']
JOBS = {
    'Build, contracts and PostgreSQL integration',
    'Cloud-edge fulfillment transport and recovery',
    'Design screens and interaction smoke',
    'Foundation POS and backoffice integration',
    'Foundation mobile bundles and checkout recovery',
    'Foundation server account and Kaspi fixtures',
    'Foundation simulator browser regressions',
    'Foundation static checks and transaction invariants',
    'Local kitchen UI and recovery',
    'Private staging image and restricted database role',
    'iPad kiosk state, bundles and browser recovery',
}
DEFAULT_BLOCK_SHA256 = '95606e088bfc2c2fc2d10212c42bc2228bfb126bdfc01ee90fbe173ebd2e9042'
TEST_BLOCK_SHA256 = 'a8c109b03fbba06960c7112fb6d8a3afc1b07652d5e886bb7e05b29ccd3a5834'
MARKER = b'\n# BEGIN PICKCHICK DOMAIN ALIASES\n'


def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_ci(proof, sha):
    run, jobs = proof['run'], proof['jobs']
    require(run.get('head_sha') == sha and run.get('conclusion') == 'success'
            and run.get('status') == 'completed' and run.get('path') == '.github/workflows/ci.yml'
            and run.get('head_repository', {}).get('full_name') == 'xaaknazar/pickchick',
            'Full successful canonical CI for exact source SHA required')
    rows = jobs.get('jobs', [])
    require(jobs.get('total_count') == len(JOBS) == len(rows)
            and {j.get('name') for j in rows} == JOBS
            and all(j.get('head_sha') == sha and j.get('status') == 'completed'
                    and j.get('conclusion') == 'success' for j in rows), 'CI jobs incomplete or failed')


class Uncertain(RuntimeError):
    pass


def run(argv, data=None):
    try:
        r = subprocess.run(argv, input=data, capture_output=True, timeout=45)
    except subprocess.TimeoutExpired:
        raise Uncertain('Command timed out; inspect actual state, retained lock') from None
    require(r.returncode == 0, 'Command failed (private output withheld): ' + argv[0])
    return r.stdout


def containers():
    result = {}
    for c in json.loads(run(['docker', 'inspect', *NAMES])):
        require(c['State']['Running'], 'Container not running: ' + c['Name'])
        require(c['State'].get('Health', {}).get('Status', 'healthy') == 'healthy', 'Unhealthy service')
        result[c['Name']] = {'id': c['Id'], 'started': c['State']['StartedAt'], 'image': c['Image']}
    return result


def guards(args):
    require((ROOT/'current').resolve().name == args.expected_api_sha, 'API pointer changed')
    require((ROOT/'public-https/current').resolve().name == args.expected_public_sha, 'Public pointer changed')
    require(digest(run(['docker', 'exec', 'pickchick-public-gateway', 'cat', '/etc/caddy/Caddyfile']))
            == args.expected_gateway_hash, 'Mounted gateway changed')
    ready = json.loads(run(['curl', '--fail', '--silent', '--max-time', '8', 'http://127.0.0.1:13100/health/ready']))
    require(ready.get('ready') is True and ready.get('degraded') is False, 'API not ready')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http(url, *, method=None, data=None, headers=None):
    try:
        r = urllib.request.build_opener(NoRedirect()).open(
            urllib.request.Request(url, method=method, data=data, headers=headers or {}), timeout=8)
    except urllib.error.HTTPError as e:
        r = e
    with r:
        return r.status, dict(r.headers), r.read()


def baseline_http(allow_test=False):
    code, _, body = http('https://185.129.51.103.nip.io/')
    require(code == 200, 'Neighbor HTTPS unavailable')
    status, _, cap = http(OLD+'/v1/capabilities')
    require(status == 200 and isinstance(json.loads(cap).get('features'), dict)
            and (allow_test or json.loads(cap)['features']['payments'] is False), 'Unexpected payment baseline')
    return digest(body), cap


def verify_payment_routes(origin, allow_test):
    for event in ['check', 'pay', 'fail', 'checkout']:
        method = 'GET' if event == 'checkout' else 'POST'
        require(http(origin+'/v1/integrations/tiptoppay/'+event, method=method)[0] == 503,
                'Commercial TipTopPay guard missing')
    require(http(origin+'/v1/integrations/tiptoppay/test-checkout')[0] == (200 if allow_test else 503),
            'Hosted TEST route differs from selected mode')
    for event in ['check', 'pay', 'fail']:
        status = http(origin+'/v1/integrations/tiptoppay/test-'+event, method='POST',
                      data=b'TestMode=1', headers={'Content-Type': 'application/x-www-form-urlencoded'})[0]
        require(status == (401 if allow_test else 503), 'Unsigned TEST webhook guard differs')
    require(http(origin+'/v1/integrations/tiptoppay/test-pay')[0] == 503,
            'Wrong-method TEST callback exposed')


def candidate(original, block, allow_tiptoppay_test=False):
    require(digest(block) == (TEST_BLOCK_SHA256 if allow_tiptoppay_test else DEFAULT_BLOCK_SHA256),
            'Unreviewed domain block or TEST forwarding not explicitly authorized')
    require(MARKER not in original and b'pickchick.kz' not in original, 'Domain aliases already exist')
    require(block and b'pickchick.kz {' in block and b'api.pickchick.kz {' in block
            and b'www.pickchick.kz {' in block, 'Missing domain block')
    return original + MARKER + block + b'\n# END PICKCHICK DOMAIN ALIASES\n'


def write_front(data):
    # The shared file is owned by another deployment user. Bind only this file,
    # use its existing UID/GID and retain its inode; no Docker restart or chown.
    st = FRONT.stat()
    run(['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
         '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
         '--user', f'{st.st_uid}:{st.st_gid}', '--mount', f'type=bind,src={FRONT},dst=/target',
         'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
         'sh', '-ec', 'cat > /target; sync /target'], data)


def caddy(action, data):
    run(['docker', 'exec', '-i', 'deploy-caddy-1', 'caddy', action, '--config', '-', '--adapter', 'caddyfile'], data)


def main(args):
    require(re.fullmatch('[a-f0-9]{40}', args.source_sha), 'Invalid source SHA')
    verify_ci(json.loads(args.ci_proof.read_text()), args.source_sha)
    original = FRONT.read_bytes()
    require(digest(original) == args.expected_front_hash, 'Front configuration changed')
    block = args.block.read_bytes()
    require(digest(block) == args.block_sha256, 'Block digest mismatch')
    new = candidate(original, block, args.allow_tiptoppay_test)
    guards(args)
    before = containers()
    neighbor, capabilities = baseline_http(args.allow_tiptoppay_test)
    caddy('validate', new)
    if not args.apply:
        print(json.dumps({'validated': True, 'applied': False, 'candidate_sha256': digest(new)}))
        return
    owner = {'id': str(uuid.uuid4()), 'source_sha': args.source_sha, 'task': 'domain-https-rollout'}
    LOCK.mkdir(mode=0o700)  # Never steal or delete someone else's lock.
    owned = LOCK/'owner.json'
    owned.write_text(json.dumps(owner)); owned.chmod(0o600)
    release = ROOT/'domains'/('release-'+args.source_sha+'-'+owner['id'])
    changed = False
    release_lock = True
    try:
        guards(args)
        require(containers() == before and FRONT.read_bytes() == original, 'Baseline changed after inspect')
        release.mkdir(parents=True, mode=0o700)
        for name, content in [('front.before', original), ('front.after', new),
                              ('ci-proof.json', args.ci_proof.read_bytes())]:
            p = release/name
            p.write_bytes(content); p.chmod(0o600)
        require((release/'front.before').read_bytes() == original, 'Backup verification failed')
        caddy('validate', new)
        # Keep host inode intact. Existing container may have an older bind inode:
        # reload receives the exact validated bytes via stdin in either case.
        changed = True
        write_front(new)
        require(FRONT.read_bytes() == new, 'Host write verification failed')
        caddy('reload', new)
        for attempt in range(30):
            try:
                for host in ['pickchick.kz', 'api.pickchick.kz']:
                    status, headers, body = http('https://'+host+'/v1/capabilities')
                    require(status == 200 and body == capabilities, 'Alias API differs')
                    require(headers.get('Strict-Transport-Security') == 'max-age=86400', 'HSTS absent')
                    require(http('https://'+host+'/v1/integrations/tiptoppay/pay')[0] == 503, 'Payment guard missing')
                    verify_payment_routes('https://'+host, args.allow_tiptoppay_test)
                    require(http('https://'+host+'/roadmap/')[0] == 308, 'Staff redirect missing')
                status, headers, _ = http('https://www.pickchick.kz/')
                require(status == 308 and headers.get('Location') == 'https://pickchick.kz/', 'www redirect differs')
                break
            except (OSError, RuntimeError):
                if attempt == 29:
                    raise
                time.sleep(2)
        guards(args)
        require(containers() == before, 'Existing container restarted or changed')
        require(baseline_http(args.allow_tiptoppay_test) == (neighbor, capabilities), 'Original public responses changed')
        record = {'source_sha': args.source_sha, 'front_before_sha256': digest(original),
                  'front_after_sha256': digest(new), 'trusted_https_verified': True,
                  'containers_unchanged': True, 'api_deployed': False, 'commercial_tiptoppay_enabled': False,
                  'tiptoppay_test_forwarded': args.allow_tiptoppay_test}
        (release/'result.json').write_text(json.dumps(record, indent=2)+'\n')
        print(json.dumps(record))
    except Uncertain:
        release_lock = False
        raise
    except Exception:
        if changed:
            try:
                require(FRONT.read_bytes() == new, 'Front changed externally; cannot roll back automatically')
                write_front(original)
                caddy('reload', original)
                require(FRONT.read_bytes() == original and containers() == before
                        and baseline_http(args.allow_tiptoppay_test) == (neighbor, capabilities), 'Rollback unverified')
            except Exception:
                release_lock = False
                raise RuntimeError('Rollback unverified; lock retained for inspection') from None
        raise
    finally:
        if release_lock:
            require(json.loads(owned.read_text()) == owner, 'Lock owner changed')
            owned.unlink(); LOCK.rmdir()


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ['source-sha', 'expected-api-sha', 'expected-public-sha', 'expected-front-hash',
                 'expected-gateway-hash', 'block-sha256']:
        p.add_argument('--'+name, required=True)
    p.add_argument('--ci-proof', type=Path, required=True)
    p.add_argument('--block', type=Path, required=True)
    p.add_argument('--allow-tiptoppay-test', action='store_true',
                   help='Forward only reviewed isolated TEST endpoints to the installed gateway')
    p.add_argument('--apply', action='store_true')
    try:
        main(p.parse_args())
    except Exception as error:
        raise SystemExit(type(error).__name__+': '+str(error)) from None
