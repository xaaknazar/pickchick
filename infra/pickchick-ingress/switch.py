#!/usr/bin/env python3
"""Server-local guarded cutover. Not usable before verified stage2 and Telegram observation.

Requires an operator-reviewed private receipt and a fully prepared candidate, including
server-local TLS copies. Does not copy certificates, request certificates, edit routes,
remove the old container or touch databases. A failed switch restores the old ingress.
"""
import argparse
from datetime import datetime,timezone
import hashlib
import http.client
import socket
import ssl
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
from zoneinfo import ZoneInfo

BASELINE='5993997a230ae099d9cb9b93c3a6cdf22f691ff1e1df35ac97a16d00ac6e0e52'
OLD='deploy-caddy-1'
NEW='pickchick-ingress'
ROOT=Path('/opt/pickchick-ingress')

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()

def run(args,check=True,timeout=20):
    r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    if check and r.returncode:raise RuntimeError('Ingress command failed; details withheld')
    return r.stdout.strip()

def receipt_guard(proof,now):
    if proof.get('schema')!=1 or proof.get('stage2_verified') is not True or proof.get('watchdog_test_received') is not True:raise ValueError('Completed stage2/watchdog receipt required')
    since=datetime.fromisoformat(proof['telegram_enabled_at'])
    if since.tzinfo is None or (now-since).total_seconds()<86400:raise ValueError('24h Telegram observation required')
    if proof.get('watchdog_false_alarms')!=0 or proof.get('cashier_window') is not False:raise ValueError('Observation/cashier gate not satisfied')
    local=now.astimezone(ZoneInfo('Asia/Almaty'))
    if local.date().isoformat()!=proof.get('cutover_date_almaty') or local.hour!=1:raise ValueError('Separate 01:00-02:00 window required')

def switch(start_new,probe,command=run):
    """Always restore OLD after any failure following its stop, without deleting it."""
    try:
        command(['docker','stop','--time','5',OLD])
        start_new()
        probe()
    except BaseException:
        started=time.monotonic()
        try:
            command(['docker','stop','--time','5',NEW],check=False)
        finally:
            # Even a Docker timeout while stopping NEW must attempt to restore OLD.
            command(['docker','start',OLD])
        elapsed=time.monotonic()-started
        if elapsed>=60:raise RuntimeError('Rollback exceeded one minute; inspect immediately') from None
        raise

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate',type=Path,required=True)
    p.add_argument('--receipt',type=Path,required=True)
    p.add_argument('--apply',action='store_true');a=p.parse_args()
    if not Path('/opt/pickchick-staging').is_dir():raise ValueError('VPS-local tool only')
    candidate=a.candidate.resolve()
    if not re.fullmatch(r'/opt/pickchick-ingress/releases/[a-f0-9]{40}',str(candidate)):raise ValueError('Protected release directory required')
    for path in [a.receipt,candidate/'compose.json',candidate/'private/legacy.Caddyfile']:
        if path.is_symlink() or not path.is_file() or path.stat().st_mode&0o077:raise ValueError('Private regular evidence/config required')
    proof=json.loads(a.receipt.read_text());receipt_guard(proof,datetime.now(timezone.utc))
    live=Path('/opt/idrink/deploy/Caddyfile')
    if sha(live)!=BASELINE:raise ValueError('Ingress baseline drift')
    files=proof.get('candidate_files',{})
    required={'Caddyfile','sites.Caddyfile','private/legacy.Caddyfile','compose.json'}
    if set(files)!=required or any(sha(candidate/n)!=h for n,h in files.items()):raise ValueError('Candidate files differ from reviewed receipt')
    if (candidate/'private/legacy.Caddyfile').read_bytes()+(candidate/'sites.Caddyfile').read_bytes()!=live.read_bytes():raise ValueError('Site bytes differ')
    old=json.loads(run(['docker','inspect',OLD]))[0]
    if old['Id']!=proof.get('old_container_id') or old['State']['Status']!='running':raise ValueError('Old ingress changed')
    config=json.loads((candidate/'compose.json').read_text());service=config['services']['caddy']
    if service['image']!=old['Image'] or service['environment']!=old['Config']['Env'] or service['command']!=old['Config']['Cmd']:raise ValueError('Image/environment/command drift')
    if sorted(service['networks'])!=sorted(old['NetworkSettings']['Networks']):raise ValueError('Network drift')
    for name in ['data','config']:
        folder=candidate/name
        if folder.is_symlink() or not folder.is_dir() or folder.stat().st_mode&0o777!=0o700:raise ValueError('Private server-local TLS copy required')
        if any(f.is_symlink() for f in folder.rglob('*')):raise ValueError('TLS copy must not contain symlinks')
        actual={str(f.relative_to(folder)):sha(f) for f in folder.rglob('*') if f.is_file() and not f.is_symlink()}
        if not actual or actual!=proof.get('tls_files',{}).get(name):raise ValueError('TLS copy receipt differs')
        live_hashes=run(['docker','exec',OLD,'sh','-c','cd /'+name+' && find . -type f -exec sha256sum {} +'])
        live_files={line.split(None,1)[1].removeprefix('./'):line.split(None,1)[0] for line in live_hashes.splitlines()}
        if actual!=live_files:raise ValueError('Live TLS storage changed after copy')
    # Probe specification contains only HTTP status/body digests and public URL paths.
    checks=proof.get('http_checks',[])
    hosts={x.get('host') for x in checks}
    if not {'api.pickchick.kz','pickchick.kz','www.pickchick.kz','pickchick.185.129.51.103.nip.io','185.129.51.103.nip.io'}<=hosts:raise ValueError('Every old public host must have a probe')
    if any(not re.fullmatch(r'[A-Za-z0-9.-]+',x['host']) or not x['path'].startswith('/') or '\n' in x['path'] for x in checks):raise ValueError('Invalid probe')
    paths={x.get('path','').split('?')[0] for x in checks}
    if not {'/health/ready','/v1/auth/config','/v1/customer-checkout/availability','/backoffice/','/kitchen/','/display/'}<=paths:raise ValueError('Required application routes missing')
    if not any(x['host']=='pickchick.185.129.51.103.nip.io' and x['path'].startswith('/v1/customer-checkout/availability?after=') for x in checks):raise ValueError('Long-poll baseline missing')
    if any('hsts' not in x or 'location' not in x for x in checks):raise ValueError('Expected response headers missing')
    def probe():
        for x in checks:
            conn=http.client.HTTPSConnection(x['host'],timeout=35)
            start=time.monotonic()
            try:
                conn.sock=ssl.create_default_context().wrap_socket(socket.create_connection(('127.0.0.1',443),timeout=35),server_hostname=x['host'])
                conn.request('GET',x['path']);response=conn.getresponse();body=response.read()
                if response.status!=x['status'] or response.getheader('Strict-Transport-Security')!=x['hsts'] or response.getheader('Location')!=x['location']:raise ValueError('Public HTTP/header behavior differs')
                if x.get('body_sha256') and hashlib.sha256(body).hexdigest()!=x['body_sha256']:raise ValueError('Public body differs')
                if '?after=' in x['path'] and not 18<=time.monotonic()-start<=33:raise ValueError('Long-poll timing differs; inspect before retry')
            finally:conn.close()
    if run(['docker','inspect',NEW],check=False):raise ValueError('New ingress container already exists; inspect before retry')
    prefix=['docker','compose','-f',str(candidate/'compose.json')]
    run(prefix+['config','--quiet'])
    run(prefix+['run','--rm','--no-deps','caddy','caddy','validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
    if not a.apply:print('Prepared candidate verified; no live switch.');return
    lock=Path('/opt/pickchick-staging/.market-release.lock')
    lock.mkdir(mode=0o700)
    # Retain the owned lock on failure; never remove a foreign lock or old container.
    owner={'id':str(uuid.uuid4()),'action':'pickchick-ingress','pid':os.getpid()}
    with (lock/'owner.json').open('x') as f:
        os.chmod(lock/'owner.json',0o600);json.dump(owner,f)
    if sha(live)!=BASELINE or json.loads(run(['docker','inspect',OLD]))[0]['Id']!=old['Id']:raise ValueError('Drift after lock')
    switch(lambda:run(prefix+['up','-d','--no-deps','caddy']),probe)
    if json.loads((lock/'owner.json').read_text())!=owner:raise ValueError('Lock ownership changed')
    (lock/'owner.json').unlink();lock.rmdir()
    print('Ingress switched and HTTP probes passed. Old container retained for rollback.')

if __name__=='__main__':
    try:main()
    except BaseException:raise SystemExit('Stopped: ingress gate or switch failed. Inspect protected evidence and owned lock; no configuration printed.') from None
