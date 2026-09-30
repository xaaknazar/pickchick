#!/usr/bin/env python3
"""First kitchen portal installation; preserve actual gateway and all other services."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid
spec = importlib.util.spec_from_file_location('baseline', Path(__file__).parent.parent / 'roadmap/remote-deploy.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
b.SERVICE = 'pickchick-kitchen-portal'
STATE = b.ROOT / 'kitchen-portal'
START = '\t# BEGIN PICKCHICK KITCHEN LIVE\n'
ROUTE = START + '''\t@kitchen_live {
\t\tpath /kitchen/prep /kitchen/assembly /display /kitchen-live/* /kitchen-link/*
\t}
\thandle @kitchen_live {
\t\theader X-PickChick-Data edge
\t\treverse_proxy pickchick-kitchen-portal:4193 {
\t\t\theader_up X-PickChick-Client-IP {remote_host}
\t\t\ttransport http {
\t\t\t\tdial_timeout 2s
\t\t\t\tresponse_header_timeout 30s
\t\t\t}
\t\t}
\t}
\t# END PICKCHICK KITCHEN LIVE
'''
def add_route(source):
    b.require(START not in source and '/kitchen-live/' not in source, 'First installation only')
    expected='path /kiosk /kitchen/prep /kitchen/assembly /display /manager'
    b.require(source.count(expected)==1, 'Operations route changed')
    source=source.replace(expected,'path /kiosk /manager')
    at=source.index('\t@operations')
    return source[:at]+ROUTE+source[at:]

def manifest(package, sha):
    data=json.loads((package/'kitchen-package.json').read_text())
    b.require(data['source_sha']==sha,'Source SHA mismatch')
    required={'infra/kitchen-portal/server.mjs','infra/kitchen-portal/link.mjs','infra/kitchen-portal/compose.yaml','apps/kitchen/server.mjs','apps/kitchen/dist/index.html','apps/kitchen/dist/app.js'}
    b.require(required.issubset(data['files']),'Incomplete package')
    for name,digest in data['files'].items():
        p=Path(name)
        b.require(not p.is_absolute() and '..' not in p.parts and name.startswith(('apps/kitchen/','infra/kitchen-portal/','infra/roadmap/')),'Invalid package path')
        target=package/p
        b.require(target.is_file() and not any(x.is_symlink() for x in [target,*target.parents]) and b.digest(target)==digest,'Package hash mismatch')
    return data

def main():
    p=argparse.ArgumentParser()
    for name in ['package','expected-source-sha','expected-public-release','expected-api-release','expected-gateway-sha256']:p.add_argument('--'+name,required=True)
    p.add_argument('--apply',action='store_true');a=p.parse_args();a.package=Path(a.package).absolute()
    b.require(os.getuid()==1000 and re.fullmatch('[a-f0-9]{40}',a.expected_source_sha),'Run as operator with full source SHA')
    m=manifest(a.package,a.expected_source_sha);old,api,before=b.baseline(a)
    b.require(b.SERVICE not in before and not (STATE/'current').exists(),'First installation only')
    config=STATE/'private/config.json';b.require(config.is_file() and not config.is_symlink() and config.stat().st_uid==1000 and config.stat().st_mode&0o077==0,'Protected portal config required')
    c=json.loads(config.read_text());b.require(c['origin']==b.ORIGIN and re.fullmatch('[a-f0-9]{64}',c['key']) and c['sourceSha']==a.expected_source_sha,'Portal config mismatch')
    add_route((old/'infra/public-staging/gateway.Caddyfile').read_text())
    if not a.apply:print(json.dumps({'status':'inspected','source_sha':a.expected_source_sha}));return
    outcome={'status':'preparing','source_sha':a.expected_source_sha}
    with b.lock(a.expected_source_sha):
        old,api,before=b.baseline(a)
        release=STATE/'releases'/a.expected_source_sha
        new=b.ROOT/'public-https/releases'/a.expected_source_sha
        b.require(not release.exists() and not new.exists(),'Immutable release exists')
        gateway_changed=False;portal_started=False
        try:
            for name in m['files']:
                target=release/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(a.package/name,target);target.chmod(0o644)
            env=release/'portal.env';env.write_text('KITCHEN_RELEASE='+str(release)+'\nKITCHEN_STATE='+str(STATE)+'\n');env.chmod(0o600)
            sidecar=b.compose(release/'infra/kitchen-portal/compose.yaml',env)
            old_manifest=b.public_files(old)
            candidate=new/'infra/public-staging';candidate.mkdir(parents=True)
            shutil.copytree(old/'infra/public-staging/public-web',candidate/'public-web')
            gateway_config=candidate/'gateway.Caddyfile';gateway_config.write_text(add_route((old/'infra/public-staging/gateway.Caddyfile').read_text()));gateway_config.chmod(0o644)
            compose=json.loads(b.run(b.compose(old/'infra/public-staging/compose.yaml')+['config','--format','json']))
            gateway=compose['services']['gateway'];gateway.setdefault('networks',{})['kitchen_ingress']=None
            compose.setdefault('networks',{})['kitchen_ingress']={'name':'pickchick-kitchen_ingress','external':True}
            for v in gateway['volumes']:
                if v['target']=='/etc/caddy/Caddyfile':v['source']=str(gateway_config)
                if v['target']=='/srv/public':v['source']=str(candidate/'public-web')
            b.save(candidate/'compose.yaml',compose)
            b.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges:true','--tmpfs','/tmp','--tmpfs','/config','--tmpfs','/data','-v',str(gateway_config)+':/etc/caddy/Caddyfile:ro',gateway['image'],'caddy','validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
            b.baseline(a);portal_started=True
            b.run(sidecar+['up','-d','--no-deps','--wait','--wait-timeout','60','portal'],timeout=120)
            gateway_changed=True
            b.run(b.compose(candidate/'compose.yaml')+['up','-d','--no-deps','--wait','--wait-timeout','60','gateway'],timeout=120)
            for mode,page in [('prep','/kitchen/prep'),('assembly','/kitchen/assembly'),('display','/display')]:
                status,body,_=b.http(page);b.require(status==200 and b'/kitchen-live/assets/app.js' in body,'Kitchen page not routed')
                status,body,_=b.http('/kitchen-live/'+mode+'/config.json');b.require(status==200 and json.loads(body)['terminalId']==c['terminals'][mode],'Wrong terminal')
                b.require(b.http('/kitchen-live/'+mode+'/edge/v1/fulfillment/kitchen')[0]==401,'Anonymous queue exposed')
            for path in ['/kitchen-link/poll','/kitchen-live/assets/server.mjs','/kitchen-live/private/config.json']:
                b.require(b.http(path)[0] in (401,404),'Private path exposed')
            b.require(json.loads(b.http('/kitchen-live/health')[1])['sourceSha']==a.expected_source_sha,'Wrong release')
            with b.ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(b.verify_public_asset,old_manifest['files'].items()))
            b.unchanged(before);b.require(b.pointer(b.ROOT/'current')==api,'Business API changed')
            b.switch(STATE/'current',release);b.switch(b.ROOT/'public-https/current',new)
            outcome.update(status='deployed',gateway_sha256=b.digest(gateway_config),previous_public_release=str(old),app_release=str(release),public_release=str(new),unchanged_services=[n for n in before if n!=b.GATEWAY])
        except b.Uncertain:
            b.save(STATE/'uncertain.json',outcome);raise
        except BaseException as error:
            if gateway_changed:b.run(b.compose(old/'infra/public-staging/compose.yaml')+['up','-d','--no-deps','--wait','--wait-timeout','60','gateway'],timeout=120)
            if portal_started:b.run(sidecar+['stop','--timeout','15','portal'])
            b.baseline(a);b.unchanged(before)
            outcome.update(status='rolled_back',reason=type(error).__name__)
        b.save(STATE/'deployments'/(a.expected_source_sha+'-'+uuid.uuid4().hex+'.json'),outcome)
    print(json.dumps(outcome));sys.exit(0 if outcome['status']=='deployed' else 1)
if __name__=='__main__':
    try:main()
    except Exception as e:print(json.dumps({'status':'failed','reason':str(e)}),file=sys.stderr);sys.exit(1)
