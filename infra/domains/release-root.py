#!/usr/bin/env python3
"""Add only GET/HEAD / -> /backoffice/ on pickchick.kz. Dry run by default.

Preserve all other ingress bytes, runtime identities, API and credential data.
Use the portal artifact/CI verification and existing shared release lock.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import uuid

spec = importlib.util.spec_from_file_location('portal_update', Path(__file__).parents[1]/'backoffice-login/update.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
d = u.d
ANCHOR = b'\npickchick.kz {\n'
ROUTE = b'\t@cabinet_entry {\n\t\tpath /\n\t\tmethod GET HEAD\n\t}\n\thandle @cabinet_entry {\n\t\tredir /backoffice/ 302\n\t}\n'


def candidate(original):
    d.require(original.count(ANCHOR) == 1, 'Expected one canonical host block')
    d.require(b'@cabinet_entry' not in original, 'Root route already installed')
    start = original.index(ANCHOR) + len(ANCHOR)
    # Preserve everything except this insertion, including current bank routes.
    return original[:start] + ROUTE + original[start:]


def runtime():
    result = u.neighbors()
    portal = u.inspect(u.NAME)
    d.require(portal['State'].get('Health', {}).get('Status') == 'healthy', 'Portal unhealthy')
    result[u.NAME] = {key: portal[key] for key in ['Id', 'Image']}
    result[u.NAME]['started'] = portal['State']['StartedAt']
    return result


def signature(status, headers, body):
    if status == 401:
        payload = json.loads(body)
        d.require(payload.get('code') == 'UNAUTHORIZED', 'Unexpected authentication error')
        # The API generates a fresh trace ID for each rejected request. Compare
        # the error semantics and status, not this per-request diagnostic ID.
        payload.pop('trace_id', None)
        body = json.dumps(payload, sort_keys=True).encode()
    return [status, headers.get('Location'), d.digest(body)]


def responses():
    # Read-only stable probes; never call a payment action or authenticated data.
    urls = [
        'https://185.129.51.103.nip.io/',
        'https://pickchick.kz/v1/capabilities',
        'https://api.pickchick.kz/v1/capabilities',
        'https://api.pickchick.kz/',
        'https://pickchick.kz/backoffice/',
        'https://pickchick.kz/backoffice/auth/session',
        'https://pickchick.kz/backoffice/api/v1/admin/catalog/branches',
        'https://www.pickchick.kz/',
    ]
    result = {}
    for url in urls:
        status, headers, body = d.http(url)
        d.require(status < 500, 'Existing public route unavailable')
        result[url] = signature(status, headers, body)
    u.portal_http()
    return result


def root_response():
    status, headers, body = d.http('https://pickchick.kz/')
    return status, headers.get('Location'), d.digest(body)


def apply_front(original, new, unchanged, baseline, result_path):
    changed = False
    try:
        unchanged()
        d.require(d.FRONT.read_bytes() == original, 'Ingress changed before CAS')
        d.caddy('validate', new)
        changed = True
        d.write_front(new)
        d.require(d.FRONT.read_bytes() == new, 'Ingress write mismatch')
        d.caddy('reload', new)
        d.require(root_response()[:2] == (302, '/backoffice/'), 'Root redirect not active')
        unchanged()
        d.require(d.FRONT.read_bytes() == new, 'Ingress changed after reload')
        result_path.write_text(json.dumps({'status': 'deployed', 'front_before_sha256': d.digest(original),
                                         'front_after_sha256': d.digest(new), 'runtime_unchanged': True})+'\n')
    except d.Uncertain:
        raise  # Keep lock and evidence: lost answer is not proof of failure.
    except Exception:
        if changed:
            try:
                d.require(d.FRONT.read_bytes() == new, 'Ingress changed externally')
                d.write_front(original)
                d.caddy('reload', original)
                unchanged()
                d.require(d.FRONT.read_bytes() == original and root_response() == baseline,
                          'Rollback unverified')
            except Exception:
                raise d.Uncertain('Rollback uncertain; preserve lock and inspect') from None
        raise


def main(a):
    os.umask(0o077)
    d.require(re.fullmatch('[a-f0-9]{40}', a.source_sha), 'Invalid source SHA')
    u.portal.verify_ci(json.loads(a.ci_proof.read_text()), a.source_sha)
    u.verify_artifact(Path(__file__).resolve().parents[2], a.source_sha)
    d.guards(a)
    original = d.FRONT.read_bytes()
    d.require(d.digest(original) == a.expected_front_hash, 'Ingress changed')
    new = candidate(original)
    before, probes, baseline = runtime(), responses(), root_response()
    def unchanged():
        d.guards(a)
        d.require(runtime() == before and responses() == probes, 'Neighbor or protected route changed')
    d.caddy('validate', new)
    if not a.apply:
        print(json.dumps({'validated': True, 'applied': False, 'candidate_sha256': d.digest(new)}))
        return
    owner = {'id': str(uuid.uuid4()), 'task': 'cabinet-entry', 'source_sha': a.source_sha}
    d.LOCK.mkdir(mode=0o700)
    lock_owner = d.LOCK/'owner.json'
    lock_owner.write_text(json.dumps(owner))
    unlock = True
    try:
        release = d.ROOT/'domains'/('root-'+a.source_sha+'-'+owner['id'])
        release.mkdir(parents=True, mode=0o700)
        for name, content in [('front.before', original), ('front.after', new), ('ci-proof.json', a.ci_proof.read_bytes())]:
            (release/name).write_bytes(content)
        d.require((release/'front.before').read_bytes() == original, 'Backup differs')
        apply_front(original, new, unchanged, baseline, release/'result.json')
        print((release/'result.json').read_text())
    except d.Uncertain:
        unlock = False
        raise
    finally:
        if unlock:
            d.require(json.loads(lock_owner.read_text()) == owner, 'Lock owner changed')
            lock_owner.unlink()
            d.LOCK.rmdir()


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ['source-sha', 'expected-api-sha', 'expected-public-sha', 'expected-front-hash', 'expected-gateway-hash']:
        p.add_argument('--'+name, required=True)
    p.add_argument('--ci-proof', type=Path, required=True)
    p.add_argument('--apply', action='store_true')
    main(p.parse_args())
