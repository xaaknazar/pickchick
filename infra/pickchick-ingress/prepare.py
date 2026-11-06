#!/usr/bin/env python3
"""Build a private ingress candidate from a pinned live snapshot; never stop/start services.

The original unrelated site stays opaque. Full original bytes can be reconstructed by
concatenating the two extracted files. TLS storage must be copied only on the VPS during
its separate window; no new certificate issuance or deletion is performed by this tool.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

MARKER=b'pickchick.185.129.51.103.nip.io {\n'
EXPECTED='5993997a230ae099d9cb9b93c3a6cdf22f691ff1e1df35ac97a16d00ac6e0e52'
SITE_HASH='d52d0f429fba0810b3ff99895b89139dcf98dc66f8131fabe9194393758afce6'


def digest(raw):return hashlib.sha256(raw).hexdigest()


def split(raw, sites, expected):
    if expected!=EXPECTED or digest(raw)!=expected:raise ValueError('Live ingress baseline differs')
    if raw.count(MARKER)!=1 or digest(sites)!=SITE_HASH:raise ValueError('PickChick sites differ')
    i=raw.index(MARKER)
    if raw[i:]!=sites:raise ValueError('PickChick sites are not byte-identical')
    opaque=raw[:i]
    if opaque+sites!=raw:raise ValueError('Unrelated bytes changed')
    return opaque


def compose(image, networks, environment=None):
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):raise ValueError('Pinned local Caddy image required')
    if not networks or len(networks)!=len(set(networks)) or any(not re.fullmatch(r'[a-zA-Z0-9_.-]+',n) for n in networks):raise ValueError('Exact existing networks required')
    return {'name':'pickchick-ingress','services':{'caddy':{
      'container_name':'pickchick-ingress','image':image,'pull_policy':'never',
      'environment':environment or [],'restart':'unless-stopped','ports':['80:80/tcp','443:443/tcp'],
      'volumes':['./Caddyfile:/etc/caddy/Caddyfile:ro','./sites.Caddyfile:/etc/caddy/sites.Caddyfile:ro',
        './private:/etc/caddy/private:ro','./data:/data','./config:/config'],
      'networks':networks}},'networks':{n:{'external':True,'name':n} for n in networks}}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--live-copy',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--expected-sha256',required=True);p.add_argument('--image',required=True)
    p.add_argument('--network',action='append',required=True)
    p.add_argument('--container-inspect',type=Path,required=True);a=p.parse_args()
    if a.live_copy.is_symlink() or not a.live_copy.is_file() or a.live_copy.stat().st_mode&0o077:raise ValueError('Protected input required')
    here=Path(__file__).resolve().parent;sites=(here/'sites.Caddyfile').read_bytes()
    opaque=split(a.live_copy.read_bytes(),sites,a.expected_sha256)
    if a.container_inspect.is_symlink() or not a.container_inspect.is_file() or a.container_inspect.stat().st_mode&0o077:raise ValueError('Protected inspect required')
    old=json.loads(a.container_inspect.read_bytes())
    if len(old)!=1 or old[0]['Name']!='/deploy-caddy-1':raise ValueError('Wrong ingress container')
    old=old[0]
    if old['Image']!=a.image or sorted(old['NetworkSettings']['Networks'])!=sorted(a.network):raise ValueError('Image/network drift')
    if old['State']['Status']!='running':raise ValueError('Old ingress not running')
    config=compose(a.image,a.network,old['Config']['Env'])
    config['services']['caddy']['command']=old['Config']['Cmd']
    a.output.mkdir(mode=0o700);(a.output/'private').mkdir(mode=0o700)
    files={'private/legacy.Caddyfile':opaque,'sites.Caddyfile':sites,
       'Caddyfile':(here/'Caddyfile').read_bytes(),
       'compose.json':(json.dumps(config,indent=2)+'\n').encode()}
    for name,data in files.items():
        fd=os.open(a.output/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as f:f.write(data)
    print(json.dumps({'prepared':True,'live_changes':False,'baseline_sha256':a.expected_sha256,
      'pickchick_sites_sha256':digest(sites),'legacy_bytes_preserved':True,'ready_to_cutover':False}))


if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('Stopped: ingress preparation guard failed; private configuration withheld.') from None
