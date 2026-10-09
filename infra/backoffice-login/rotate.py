#!/usr/bin/env python3
"""Apply only a reviewed CEO salt/hash change; default read-only, no password output.

Uses the existing container and bind inode. Any failure after dispatch retains the
owned lock and attempt evidence; an old disclosed password is never auto-restored.
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import uuid

spec = importlib.util.spec_from_file_location('staff_update', Path(__file__).with_name('update.py'))
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
d = u.d
PRIVATE = d.ROOT/'secrets/backoffice-ceo.json'


def private_bytes(path, with_identity=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        before = os.fstat(f.fileno())
        d.require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                  before.st_uid == os.getuid() and stat.S_IMODE(before.st_mode) == 0o600 and
                  before.st_size <= 262144, 'Owned private regular file required')
        raw = f.read(262145)
        after = os.fstat(f.fileno())
        d.require(len(raw) == before.st_size and before.st_mtime_ns == after.st_mtime_ns and
                  before.st_ctime_ns == after.st_ctime_ns, 'Private input changed during read')
        return (raw, (before.st_dev, before.st_ino)) if with_identity else raw


def rotation_only(before, after):
    """No actor, bearer, other account, version, origin or unknown field may change."""
    try:
        old, new = json.loads(before), json.loads(after)
        d.require(old['version'] == new['version'] and old['version'] in (1, 2), 'Format differs')
        expected = copy.deepcopy(old)
        if old['version'] == 1:
            d.require(old['username'] == new['username'] == 'ceo', 'CEO identity differs')
            original, target, replacement = old, expected, new
        else:
            d.require(sum(a.get('username') == 'ceo' for a in old['accounts']) == 1 and
                      sum(a.get('username') == 'ceo' for a in new['accounts']) == 1, 'CEO selection differs')
            original = next(a for a in old['accounts'] if a['username'] == 'ceo')
            target = next(a for a in expected['accounts'] if a['username'] == 'ceo')
            replacement = next(a for a in new['accounts'] if a['username'] == 'ceo')
            salts = [a['salt'] for a in new['accounts']]
            d.require(len(set(salts)) == len(salts), 'Each staff account requires a unique salt')
        for key, length in [('salt', 32), ('hash', 64)]:
            value = replacement[key]
            d.require(isinstance(value, str) and re.fullmatch('[a-f0-9]{'+str(length)+'}', value) and
                      value != original[key], 'A new valid salt/hash is required')
            target[key] = value
        d.require(expected == new, 'Only CEO salt/hash may change')
    except Exception:
        raise RuntimeError('Candidate must change only the existing CEO salt and hash') from None


def replace_in_place(path, expected, candidate, identity):
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'r+b') as f:
        s = os.fstat(f.fileno())
        d.require((s.st_dev, s.st_ino) == identity, 'Private bind inode changed after review')
        d.require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == os.getuid() and
                  stat.S_IMODE(s.st_mode) == 0o600 and s.st_size <= 262144, 'Private target differs')
        current = f.read(262145)
        d.require(d.digest(current) == expected, 'Private config CAS failed')
        rotation_only(current, candidate)
        f.seek(0)
        f.write(candidate)
        f.truncate()
        f.flush()
        os.fsync(f.fileno())
        d.require(path.stat().st_ino == s.st_ino and path.stat().st_dev == s.st_dev,
                  'Private bind inode changed')
    d.require(private_bytes(path) == candidate, 'Private write not confirmed')


def main(a):
    os.umask(0o077)
    for value in [a.source_sha, a.expected_portal_sha, a.expected_api_sha, a.expected_public_sha]:
        d.require(re.fullmatch('[a-f0-9]{40}', value), 'Exact source SHA required')
    for value in [a.expected_private_sha256, a.candidate_sha256, a.expected_front_hash, a.expected_gateway_hash]:
        d.require(re.fullmatch('[a-f0-9]{64}', value), 'Reviewed SHA256 required')
    d.require(re.fullmatch('sha256:[a-f0-9]{64}', a.expected_portal_image), 'Exact image required')
    root = Path(__file__).resolve().parents[2]
    u.portal.verify_ci(json.loads(a.ci_proof.read_text()), a.source_sha)
    u.verify_artifact(root, a.source_sha)
    d.require(not d.LOCK.exists(), 'Another release owns the lock')
    d.require(a.candidate.resolve() != PRIVATE.resolve(), 'Candidate must be a separate file')
    original, bind_identity = private_bytes(PRIVATE, with_identity=True)
    candidate = private_bytes(a.candidate)
    d.require(d.digest(original) == a.expected_private_sha256 and d.digest(candidate) == a.candidate_sha256,
              'Private inputs differ from reviewed hashes')
    rotation_only(original, candidate)
    before, old = u.neighbors(), u.inspect(u.NAME)
    front = d.FRONT.read_bytes()
    neighbors_http = d.baseline_http()
    d.require(d.digest(front) == a.expected_front_hash, 'Ingress changed')
    d.require(old['Config']['Image'] == 'pickchick-staff-login:'+a.expected_portal_sha and
              old['Image'] == a.expected_portal_image and old['State']['Running'] and
              old['State']['Health']['Status'] == 'healthy', 'Staff runtime baseline differs')
    mounts = old['Mounts']
    d.require(len(mounts) == 1 and mounts[0]['Source'] == str(PRIVATE) and
              mounts[0]['Destination'] == '/run/ceo.json' and not mounts[0]['RW'], 'Private bind differs')

    def unchanged(expected):
        d.guards(a)
        d.require(d.FRONT.read_bytes() == front and u.neighbors() == before and
                  d.baseline_http() == neighbors_http, 'Neighbor or ingress changed')
        content, identity = private_bytes(PRIVATE, with_identity=True)
        d.require(d.digest(content) == expected and identity == bind_identity,
                  'Private configuration or bind inode changed')
        live = u.inspect(u.NAME)
        d.require(live['Id'] == old['Id'] and live['Image'] == old['Image'] and
                  live['Config'] == old['Config'] and live['HostConfig'] == old['HostConfig'] and
                  live['Mounts'] == old['Mounts'], 'Staff container configuration changed')

    unchanged(a.expected_private_sha256)
    if not a.apply:
        print(json.dumps({'validated': True, 'target': 'ceo', 'live_changed': False})); return
    release = d.ROOT/'backoffice-login'/('rotation-'+a.source_sha+'-'+a.candidate_sha256[:16])
    d.require(release.parent.is_dir() and not release.parent.is_symlink(), 'Existing private release directory required')
    d.require(not release.exists(), 'An attempt exists; inspect, do not replay')
    owner = {'id': str(uuid.uuid4()), 'task': 'ceo-password-rotation', 'source_sha': a.source_sha}
    d.LOCK.mkdir(mode=0o700)
    (d.LOCK/'owner.json').write_text(json.dumps(owner))
    # No finally-unlock: any unsuccessful dispatched operation needs inspection.
    unchanged(a.expected_private_sha256)
    release.mkdir(mode=0o700)
    d.require(u.backup_and_restore_private(PRIVATE, release/'credentials.before.json') == a.expected_private_sha256,
              'Private backup/restore differs')
    (release/'attempt.json').write_text(json.dumps({'owner': owner, 'container': old['Id'],
                                                  'candidate_sha256': a.candidate_sha256}))
    d.run(['docker', 'stop', u.NAME])
    d.require(not u.inspect(u.NAME)['State']['Running'], 'Staff did not stop')
    unchanged(a.expected_private_sha256)
    replace_in_place(PRIVATE, a.expected_private_sha256, candidate, bind_identity)
    d.run(['docker', 'start', u.NAME])
    u.healthy(u.NAME)
    unchanged(a.candidate_sha256)
    u.portal_http()
    result = {'source_sha': a.source_sha, 'target': 'ceo', 'applied': True, 'same_container': True,
              'other_accounts_preserved': True, 'backup_restore': 'passed', 'owner_login_pending': True}
    (release/'result.json').write_text(json.dumps(result))
    d.require(json.loads((d.LOCK/'owner.json').read_text()) == owner, 'Release lock owner changed')
    (d.LOCK/'owner.json').unlink()
    d.LOCK.rmdir()
    print(json.dumps(result))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ['source-sha', 'expected-portal-sha', 'expected-portal-image', 'expected-api-sha',
                 'expected-public-sha', 'expected-front-hash', 'expected-gateway-hash',
                 'expected-private-sha256', 'candidate-sha256']:
        p.add_argument('--'+name, required=True)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--ci-proof', type=Path, required=True)
    p.add_argument('--apply', action='store_true')
    try:
        main(p.parse_args())
    except Exception:
        print('Rotation stopped. Private details withheld; inspect the protected attempt and lock before continuing.')
        raise SystemExit(1) from None
