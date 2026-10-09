#!/usr/bin/env python3
"""Operator access to kiosk payment incidents through the loopback API on the VPS.

preview  - read-only list of unresolved kiosk QR payments older than 15 minutes.
accept   - one manager acceptance; the payment result stays unknown and on reconciliation.

The manager credential is that person's own back-office token, read from a private 0600
file and sent over SSH stdin, never on a command line. The bank is never contacted.
"""
import argparse
import json
import os
import shlex
import stat
import subprocess
import sys
import uuid

HOST = 'pickchick-ops@185.129.51.103'
KEY = os.path.expanduser('~/.ssh/pickchick_staging_ed25519')
API = 'http://127.0.0.1:13100'


def private_token(path):
    info = os.stat(path)
    if stat.S_IMODE(info.st_mode) & 0o077:
        sys.exit('Token file must be 0600')
    token = open(path, encoding='utf-8').read().strip()
    if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        sys.exit('Token file must contain one 64-hex manager token')
    return token


def call(method, branch, token, body=None):
    # Token and body travel on stdin; the remote program prints only the HTTP status and JSON.
    remote = (
        "import json,sys,urllib.request,urllib.error\n"
        "d=json.load(sys.stdin)\n"
        "r=urllib.request.Request(d['url'],method=d['method'],data=(json.dumps(d['body']).encode() if d['body'] is not None else None),"
        "headers={'Authorization':'Bearer '+d['token'],'Content-Type':'application/json'})\n"
        "try:\n with urllib.request.urlopen(r,timeout=20) as x: print(json.dumps({'status':x.status,'body':json.load(x)}))\n"
        "except urllib.error.HTTPError as e: print(json.dumps({'status':e.code,'body':json.loads(e.read() or b'null')}))\n"
    )
    payload = {
        'url': f'{API}/v1/admin/backoffice/branches/{branch}/kiosk-payment-incidents',
        'method': method,
        'token': token,
        'body': body,
    }
    out = subprocess.run(
        ['ssh', '-i', KEY, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
         HOST, 'python3 -c ' + shlex.quote(remote)],
        input=json.dumps(payload), text=True, capture_output=True, check=True,
    )
    return json.loads(out.stdout)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['preview', 'accept'])
    p.add_argument('--branch-id', required=True, type=uuid.UUID)
    p.add_argument('--token-file', required=True)
    p.add_argument('--order-id', type=uuid.UUID)
    p.add_argument('--attempt-id', type=uuid.UUID)
    p.add_argument('--reason', choices=['bank_identity_lost', 'bank_result_unknown'], default='bank_identity_lost')
    p.add_argument('--note-file')
    p.add_argument('--request-id', type=uuid.UUID, help='reuse to replay the same acceptance safely')
    a = p.parse_args()
    token = private_token(a.token_file)
    if a.command == 'preview':
        print(json.dumps(call('GET', a.branch_id, token), ensure_ascii=False, indent=2))
        return
    if not (a.order_id and a.attempt_id and a.note_file):
        sys.exit('accept requires --order-id, --attempt-id and --note-file')
    note = open(a.note_file, encoding='utf-8').read().strip()
    typed = input(f'Payment result stays UNKNOWN. Type the order id to accept {a.order_id}: ').strip()
    if typed != str(a.order_id):
        sys.exit('Order id mismatch; nothing sent')
    body = {
        'request_id': str(a.request_id or uuid.uuid4()),
        'order_id': str(a.order_id),
        'attempt_id': str(a.attempt_id),
        'reason': a.reason,
        'note': note,
        'confirm': 'payment_result_remains_unknown',
    }
    print('request_id', body['request_id'], file=sys.stderr)
    print(json.dumps(call('POST', a.branch_id, token, body), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
