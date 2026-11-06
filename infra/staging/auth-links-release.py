#!/usr/bin/env python3
"""Prepare exactly two URL replacements in the installed JSON compose. No deployment.

Run on a protected copy during the owner-approved window. Never print the input,
other environment values, or the candidate. Deployment still needs the shared lock,
no active orders/payments, backup/hash, API-only recreate and postchecks in the runbook.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path

KEYS = {'CUSTOMER_AUTH_TERMS_URL': 'terms', 'CUSTOMER_AUTH_PRIVACY_URL': 'privacy'}
OLD = 'https://pickchick.185.129.51.103.nip.io/legal/'
NEW = 'https://pickchick.kz/legal/'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def candidate(original, expected_hash):
    if digest(original) != expected_hash:
        raise ValueError('Compose baseline hash differs')
    before = json.loads(original, object_pairs_hook=unique)
    expected = copy.deepcopy(before)
    env = expected['services']['api']['environment']
    result = original
    for key, suffix in KEYS.items():
        if env.get(key) != OLD + suffix:
            raise ValueError('Document link baseline differs')
        old = json.dumps(OLD + suffix).encode()
        new = json.dumps(NEW + suffix).encode()
        if original.count(old) != 1:
            raise ValueError('Link is not unique to API')
        result = result.replace(old, new)
        env[key] = NEW + suffix
    if json.loads(result, object_pairs_hook=unique) != expected:
        raise ValueError('Unrelated compose change')
    left, right = original.splitlines(keepends=True), result.splitlines(keepends=True)
    if len(left) != len(right) or sum(a != b for a, b in zip(left, right)) != 2:
        raise ValueError('Expected exactly two changed lines')
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--expected-sha256', required=True)
    a = p.parse_args()
    if a.input.is_symlink() or not a.input.is_file() or a.input.stat().st_mode & 0o077:
        raise ValueError('Protected regular input required')
    result = candidate(a.input.read_bytes(), a.expected_sha256)
    fd = os.open(a.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(result)
    print(json.dumps({'changed_lines': 2, 'before_sha256': a.expected_sha256,
                      'candidate_sha256': digest(result), 'deployment_performed': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Stopped: candidate guard failed; configuration withheld.') from None
