#!/usr/bin/env python3
"""Enable one protected App Review login on the existing API, without changing its image.

Run on VPS from a verified source archive. Input is private JSON on stdin containing
phone and code_digest (never the clear code). Default is a read-only preflight.
The dedicated phone must have no customer record. Disable keeps the payment bar.
No migrations, grants, prices, workers, orders or bank requests are performed.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

ROOT = Path('/opt/pickchick-staging')
API = 'pickchick-staging-api-1'
KEYS = {'CUSTOMER_REVIEW_ACCOUNT_ENABLED', 'CUSTOMER_REVIEW_ACCOUNT_PHONE',
        'CUSTOMER_REVIEW_ACCOUNT_CODE_SHA256'}


class Refused(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise Refused(message)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sha(data):
    return hashlib.sha256(data).hexdigest()


def desired(private, action):
    require(set(private) == {'phone', 'code_digest'}, 'Private input must contain only phone and code_digest')
    require(re.fullmatch(r'\+7[0-9]{10}', private['phone']) and
            re.fullmatch('[a-f0-9]{64}', private['code_digest']), 'Invalid private input')
    require(action in ('enable', 'disable'), 'Invalid action')
    return {'CUSTOMER_REVIEW_ACCOUNT_ENABLED': 'true' if action == 'enable' else 'false',
            'CUSTOMER_REVIEW_ACCOUNT_PHONE': private['phone'],
            'CUSTOMER_REVIEW_ACCOUNT_CODE_SHA256': private['code_digest']}


def candidate(config, wanted):
    require(set(wanted) == KEYS, 'Review keys only')
    result = copy.deepcopy(config)
    environment = result['services']['api']['environment']
    require(isinstance(environment, dict), 'Resolved environment required')
    prior = environment.get('CUSTOMER_REVIEW_ACCOUNT_PHONE')
    require(prior in (None, '', wanted['CUSTOMER_REVIEW_ACCOUNT_PHONE']), 'A different review account exists')
    if wanted['CUSTOMER_REVIEW_ACCOUNT_ENABLED'] == 'false':
        require(prior == wanted['CUSTOMER_REVIEW_ACCOUNT_PHONE'], 'Disable requires the configured review phone')
    environment.update(wanted)
    check = copy.deepcopy(result)
    check['services']['api']['environment'] = copy.deepcopy(config['services']['api']['environment'])
    require(check == config, 'Unrelated compose configuration changed')
    return result


def verify_environment(before, after, wanted):
    require({k: v for k, v in before.items() if k not in KEYS} ==
            {k: v for k, v in after.items() if k not in KEYS}, 'Unrelated runtime environment changed')
    require({k: after.get(k) for k in KEYS} == wanted, 'Runtime review configuration differs')


def verify_revision(container, environment, expected):
    # The installed API records source in the OCI revision label, not RELEASE_SHA.
    require(container['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == expected,
            'Running source differs')
    require(environment.get('RELEASE_SHA', expected) == expected, 'Runtime source marker conflicts')


def compose_literals(value):
    """A resolved Compose model may contain literal dollars in existing secrets."""
    if isinstance(value, str):
        return value.replace('$', '$$')
    if isinstance(value, list):
        return [compose_literals(v) for v in value]
    if isinstance(value, dict):
        return {k: compose_literals(v) for k, v in value.items()}
    return value


def verify_manifest(root, expected):
    m = json.loads((root/'app-review-source.json').read_text())
    require(m.get('source_sha') == expected, 'Source manifest differs')
    required = {'infra/staging/app-review-access.py', 'infra/backoffice-login/release.py',
                'infra/domains/release-alias.py', 'infra/roadmap/remote-deploy.py'}
    require(set(m['files']) == required, 'Unexpected source files')
    for name, digest in m['files'].items():
        p = root/name
        require(p.is_file() and not p.is_symlink() and sha(p.read_bytes()) == digest, 'Source integrity failed')


def private_run(argv, data=None, timeout=45):
    try:
        r = subprocess.run(argv, input=data, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Refused('Command timed out; retain the owned lock and inspect actual state') from None
    require(r.returncode == 0, 'Command failed; private output withheld')
    return r.stdout.strip()


# Validation uses the installed application's parser and HMAC domain. The transaction
# is read-only and returns only a count, never an identity, ciphertext or phone lookup.
PREFLIGHT = r"""
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {createCustomerIdentityOptions} from '@pickchick/customer-identity';
import {createPool} from '@pickchick/database';
const patch=JSON.parse(readFileSync(0,'utf8'));
const options=createCustomerIdentityOptions({...process.env,...patch});
if(!options.enabled || options.reviewAccount.phone!==patch.CUSTOMER_REVIEW_ACCOUNT_PHONE)process.exit(2);
const lookup=createHmac('sha256',options.lookupKey).update('phone').update('\0').update(options.reviewAccount.phone).digest('hex');
const pool=createPool(process.env.CLOUD_DATABASE_URL,1);
const db=await pool.connect();
try {
 await db.query('BEGIN READ ONLY');
 const r=await db.query('SELECT count(*)::int n FROM identity_customers WHERE phone_lookup=$1',[lookup]);
 await db.query('ROLLBACK');
 console.log(JSON.stringify({valid:true,customers:r.rows[0].n}));
} finally {db.release();await pool.end();}
"""


def snapshot(run):
    a = json.loads(run(['docker', 'inspect', API]))[0]
    env = dict(v.split('=', 1) for v in a['Config']['Env'])
    return a, env


def main(a):
    os.umask(0o077)
    root = Path(__file__).resolve().parents[2]
    for s in (a.source_sha, a.expected_api_sha):
        require(re.fullmatch('[a-f0-9]{40}', s or ''), 'Exact source and API SHA required')
    require(re.fullmatch('sha256:[a-f0-9]{64}', a.expected_image or '') and
            re.fullmatch('[a-f0-9]{64}', a.expected_compose_hash or ''), 'Exact image and compose pins required')
    verify_manifest(root, a.source_sha)
    if a.apply:
        require(a.ci_proof is not None, 'Full CI proof required')
        ci = load('review_ci', root/'infra/backoffice-login/release.py')
        ci.verify_ci(json.loads(a.ci_proof.read_text()), a.source_sha)
    r = load('review_remote', root/'infra/roadmap/remote-deploy.py')
    wanted = desired(json.load(sys.stdin), a.action)
    release = ROOT/'releases'/a.expected_api_sha
    compose = release/'infra/staging/compose.yaml'
    command = ['docker', 'compose', '--env-file', str(ROOT/'secrets/staging.env'),
               '--env-file', str(release/'release.env'), '-f', str(compose)]
    require((ROOT/'current').resolve() == release, 'API pointer changed')
    original = compose.read_bytes()
    require(sha(original) == a.expected_compose_hash, 'Compose changed')
    before, before_env = snapshot(private_run)
    require(before['Image'] == a.expected_image and before['State']['Health']['Status'] == 'healthy',
            'API image or readiness changed')
    verify_revision(before, before_env, a.expected_api_sha)
    require(before_env.get('CUSTOMER_AUTH_ENABLED') == 'true', 'Customer identity is not enabled')
    config = json.loads(private_run(command + ['config', '--format', 'json']))
    updated = candidate(config, wanted)
    collision = json.loads(private_run(['docker', 'exec', '-i', API, 'node', '--input-type=module', '-e', PREFLIGHT],
                                     data=json.dumps(wanted)))
    require(collision.get('valid') is True, 'Installed validation failed')
    if a.action == 'enable' and before_env.get('CUSTOMER_REVIEW_ACCOUNT_PHONE') != wanted['CUSTOMER_REVIEW_ACCOUNT_PHONE']:
        require(collision.get('customers') == 0, 'Dedicated review number is already a customer; choose another number')
    else:
        require(before_env.get('CUSTOMER_REVIEW_ACCOUNT_PHONE') == wanted['CUSTOMER_REVIEW_ACCOUNT_PHONE'],
                'Existing configured review phone required')
    outcome = {'source_sha': a.source_sha, 'api_sha': a.expected_api_sha, 'action': a.action,
               'validated': True, 'applied': False, 'customer_collision': collision['customers'] != 0}
    if not a.apply:
        print(json.dumps(outcome)); return
    neighbors = r.containers()
    public_pointer = (ROOT/'public-https/current').resolve()
    public_hash = r.digest(public_pointer/'infra/public-staging/gateway.Caddyfile')
    env_hashes = [sha(p.read_bytes()) for p in (ROOT/'secrets/staging.env', release/'release.env')]
    # The shared lock refuses foreign work. Failure deliberately retains this owned lock.
    owner = {'id': str(uuid.uuid4()), 'sha': a.source_sha, 'action': 'app-review-'+a.action}
    r.LOCK.mkdir(mode=0o700)
    r.save(r.LOCK/'owner.json', owner)
    journal = ROOT/'app-review'/owner['id']
    journal.mkdir(parents=True, mode=0o700)
    r.save(journal/'owner.json', owner)
    (journal/'compose.before').write_bytes(original)
    r.save(journal/'ci-proof.json', json.loads(a.ci_proof.read_text()))
    require(compose.read_bytes() == original and r.containers() == neighbors and
            (ROOT/'current').resolve() == release, 'Baseline drift after lock')
    collision_now = json.loads(private_run(['docker', 'exec', '-i', API, 'node', '--input-type=module', '-e', PREFLIGHT],
                                          data=json.dumps(wanted)))
    require(collision_now == collision, 'Customer state changed during preflight')
    temporary = compose.with_name('.review-'+owner['id']+'.json')
    r.save(temporary, compose_literals(updated))
    resolved = json.loads(private_run(command[:-1]+[str(temporary), 'config', '--format', 'json']))
    require(resolved == updated, 'Compose round-trip changed resolved configuration')
    temporary.replace(compose)
    r.save(journal/'attempt.json', {**outcome, 'compose_after_sha256': r.digest(compose)})
    private_run(command + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'api'], timeout=180)
    after, after_env = snapshot(private_run)
    verify_revision(after, after_env, a.expected_api_sha)
    require(after['Image'] == before['Image'] and after['State']['Health']['Status'] == 'healthy', 'Image or health differs')
    verify_environment(before_env, after_env, wanted)
    for key in ('Cmd', 'Entrypoint', 'User', 'WorkingDir'):
        require(after['Config'][key] == before['Config'][key], 'API process configuration changed')
    require(after['Mounts'] == before['Mounts'], 'API mounts changed')
    require({k:v for k,v in r.containers().items() if k != API} ==
            {k:v for k,v in neighbors.items() if k != API}, 'Neighbor changed')
    require((ROOT/'current').resolve() == release and (ROOT/'public-https/current').resolve() == public_pointer
            and r.digest(public_pointer/'infra/public-staging/gateway.Caddyfile') == public_hash,
            'Release pointers or gateway changed')
    require([sha(p.read_bytes()) for p in (ROOT/'secrets/staging.env', release/'release.env')] == env_hashes,
            'Original secret files changed')
    private_run(['curl', '--fail', '--silent', '--max-time', '10', 'http://127.0.0.1:13100/health/ready'])
    outcome.update(applied=True, image_unchanged=True, environment_delta_only_review=True,
                   neighbors_preserved=True, compose_after_sha256=r.digest(compose), journal=str(journal))
    r.save(journal/'result.json', outcome)
    require(json.loads((r.LOCK/'owner.json').read_text()) == owner, 'Lock owner changed')
    (r.LOCK/'owner.json').unlink(); r.LOCK.rmdir()
    print(json.dumps(outcome))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['enable', 'disable'])
    for field in ('source-sha', 'expected-api-sha', 'expected-image', 'expected-compose-hash'):
        p.add_argument('--'+field, required=True)
    p.add_argument('--ci-proof', type=Path)
    p.add_argument('--apply', action='store_true')
    try:
        main(p.parse_args())
    except BaseException as e:
        if isinstance(e, SystemExit):
            raise
        print(json.dumps({'status': 'refused', 'reason': str(e) if isinstance(e, Refused)
                          else 'Operation failed; private diagnostics withheld; inspect owned lock'}))
        sys.exit(1)
