#!/usr/bin/env python3
"""CEO portal only. Run from a verified immutable source archive on VPS.

No API/public pointer, DB, ACL, gateway container or neighbor route changes.
Exact Foundation CI, config backup, CAS, shared release lock and TLS required.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import time
import uuid
import urllib.request

spec = importlib.util.spec_from_file_location('domain_release', Path(__file__).parents[1]/'domains/release-alias.py')
domain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(domain)
require, run, digest = domain.require, domain.run, domain.digest
BASELINE = '778a718ffe916520fc177aaa663546e863a8574a'
FRONT_HASH = '26847635de2d3eea9a1fda848386e5cbe3a743e7ea1a344b6e0fd7a0584dcbcd'
GATEWAY_HASH = '0bb039bde008cd3a25aeec3d4e06d15f3ad5e8dc3f6eda2e8373fd004264d3ff'
JOBS = {'Foundation static checks and transaction invariants', 'Foundation POS and backoffice integration',
        'Foundation mobile bundles and checkout recovery', 'Foundation simulator browser regressions',
        'Foundation server account and Kaspi fixtures', 'Build, contracts and PostgreSQL integration',
        'iPad kiosk state, bundles and browser recovery', 'Private staging image and restricted database role',
        'Local kitchen UI and recovery', 'Cloud-edge fulfillment transport and recovery', 'Design screens and interaction smoke'}


def verify_ci(proof, sha):
    original = domain.JOBS
    try:
        domain.JOBS = JOBS
        domain.verify_ci(proof, sha)
    finally:
        domain.JOBS = original


def main(args):
    os.umask(0o077)
    require(re.fullmatch('[a-f0-9]{40}', args.source_sha), 'Invalid source SHA')
    verify_ci(json.loads(args.ci_proof.read_text()), args.source_sha)
    root = Path(__file__).resolve().parents[2]
    require(json.loads((root/'portal-manifest.json').read_text())['source_sha'] == args.source_sha, 'Source manifest mismatch')
    manifest = json.loads((root/'portal-manifest.json').read_text())
    for path, expected in manifest['files'].items():
        require(not Path(path).is_absolute() and '..' not in Path(path).parts, 'Invalid manifest path')
        require(digest((root/path).read_bytes()) == expected, 'Artifact changed: '+path)
    args.expected_api_sha = args.expected_public_sha = BASELINE
    args.expected_gateway_hash = GATEWAY_HASH
    domain.guards(args)
    require(not domain.LOCK.exists(), 'Another deployment owns the lock')
    original = domain.FRONT.read_bytes()
    require(digest(original) == FRONT_HASH, 'Front changed; reassess baseline')
    before = domain.containers()
    neighbor = domain.baseline_http()
    private = args.private_config
    require(private.is_absolute() and private.is_file() and not private.is_symlink() and private.stat().st_mode & 0o077 == 0, 'Private configuration must be a protected regular file')
    cfg = json.loads(private.read_text())
    require(cfg['origin'] == 'https://pickchick.kz' and cfg['username'] == 'ceo', 'CEO-only canonical origin required')
    req = urllib.request.Request('http://127.0.0.1:13100/v1/admin/catalog/branches', headers={'Authorization':'Bearer '+cfg['token']})
    with urllib.request.urlopen(req,timeout=10) as response: scope=json.load(response)
    require(scope['actor']['id'] == cfg['actor_id'] and len(scope['branches']) > 0, 'CEO identity or scope differs')
    branch=scope['branches'][0]['id']
    require(re.fullmatch('[a-f0-9-]{36}',branch), 'Invalid scope branch')
    req=urllib.request.Request('http://127.0.0.1:13100/v1/admin/backoffice/branches/'+branch+'/finance?start_date=2026-10-01&end_date=2026-10-31', headers={'Authorization':'Bearer '+cfg['token']})
    with urllib.request.urlopen(req,timeout=10) as response: finance=json.load(response)
    require(finance.get('role')=='manager','CEO finance write permission missing')
    block = (root/'infra/backoffice-login/pickchick.Caddyfile').read_bytes()
    candidate = domain.candidate(original, block)
    domain.caddy('validate', candidate)
    if not args.apply:
        print(json.dumps({'validated':True,'applied':False,'source_sha':args.source_sha,'existing_actor_verified':True})); return
    owner = {'id':str(uuid.uuid4()),'source_sha':args.source_sha,'task':'ceo-login'}
    domain.LOCK.mkdir(mode=0o700)
    (domain.LOCK/'owner.json').write_text(json.dumps(owner))
    release = domain.ROOT/'backoffice-login'/args.source_sha
    changed = False
    created = False
    release_lock = True
    try:
        domain.guards(args)
        require(domain.FRONT.read_bytes() == original and domain.containers() == before, 'Baseline changed after lock')
        release.mkdir(parents=True,exist_ok=False)
        for name, data in [('front.before',original),('front.after',candidate),('ci-proof.json',args.ci_proof.read_bytes()),('portal-manifest.json',(root/'portal-manifest.json').read_bytes())]:
            (release/name).write_bytes(data)
        require((release/'front.before').read_bytes() == original,'Backup mismatch')
        image = 'pickchick-staff-login:'+args.source_sha
        run(['docker','build','--build-arg','RELEASE_SHA='+args.source_sha,'-t',image,'-f',str(root/'infra/backoffice-login/Dockerfile'),str(root/'apps/backoffice')])
        run(['docker','create','--name','pickchick-staff-login','--restart','unless-stopped',
             '--network','deploy_default','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
             '--memory','512m','--cpus','1','--pids-limit','64', '--user',f'{private.stat().st_uid}:{private.stat().st_gid}',
             '--mount',f'type=bind,src={private},dst=/run/ceo.json,readonly',
             '-e','BACKOFFICE_STAFF_FILE=/run/ceo.json','-e','BACKOFFICE_API_PORT=3100',
             '--health-cmd', 'node -e "fetch(\'http://127.0.0.1:4177/backoffice/auth/session\',{headers:{Host:\'pickchick.kz\'}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"',
             '--health-interval','10s','--health-timeout','5s','--health-retries','3',image])
        created = True
        run(['docker','network','connect','pickchick-staging_ingress','pickchick-staff-login'])
        run(['docker','start','pickchick-staff-login'])
        for attempt in range(25):
            status=run(['docker','inspect','--format','{{.State.Health.Status}}','pickchick-staff-login']).decode().strip()
            if status=='healthy':break
            require(status!='unhealthy','New staff service unhealthy')
            time.sleep(1)
        require(status=='healthy','New staff service did not become healthy')
        domain.guards(args)
        require(domain.FRONT.read_bytes() == original,'Front changed before CAS')
        changed=True
        domain.write_front(candidate)
        require(domain.FRONT.read_bytes() == candidate,'Candidate write mismatch')
        domain.caddy('reload',candidate)
        for attempt in range(30):
            try:
                status,_,body=domain.http('https://pickchick.kz/backoffice/auth/session')
                require(status==200 and json.loads(body)=={'enabled':True,'authenticated':False},'Anonymous session mismatch')
                require(domain.http('https://pickchick.kz/backoffice/')[0]==200,'Portal unavailable')
                require(domain.http('https://pickchick.kz/backoffice/api/v1/admin/catalog/branches')[0]==401,'Protected data exposed')
                require(domain.http('https://api.pickchick.kz/backoffice/')[0]==308,'Canonical redirect absent')
                require(domain.http('https://www.pickchick.kz/')[0]==308,'www redirect absent')
                require(domain.http('https://pickchick.kz/v1/integrations/tiptoppay/pay')[0]==503,'Payment guard absent')
                break
            except (OSError,RuntimeError):
                if attempt==29:raise
                time.sleep(2)
        domain.guards(args)
        require(domain.containers()==before and domain.baseline_http()==neighbor,'Existing service changed')
        result={'source_sha':args.source_sha,'url':'https://pickchick.kz/backoffice/','https_verified':True,
                'existing_containers_preserved':True,'api_and_database_unchanged':True,
                'front_before_sha256':digest(original),'front_after_sha256':digest(candidate),'account_count':1}
        (release/'result.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result))
    except domain.Uncertain:
        release_lock=False
        raise
    except Exception:
        if changed:
            try:
                require(domain.FRONT.read_bytes()==candidate,'Front changed externally; preserve lock')
                domain.write_front(original);domain.caddy('reload',original)
                require(domain.FRONT.read_bytes()==original and domain.baseline_http()==neighbor,'Rollback unverified')
            except Exception:
                release_lock=False
                raise RuntimeError('Rollback unverified; lock retained') from None
        if created:
            run(['docker','rm','-f','pickchick-staff-login'])
        raise
    finally:
        if release_lock:
            require(json.loads((domain.LOCK/'owner.json').read_text())==owner,'Lock owner changed')
            (domain.LOCK/'owner.json').unlink();domain.LOCK.rmdir()


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-sha',required=True)
    p.add_argument('--ci-proof',type=Path,required=True)
    p.add_argument('--private-config',type=Path,required=True)
    p.add_argument('--apply',action='store_true')
    try: main(p.parse_args())
    except Exception as e:
        print('CEO release stopped: '+str(e))
        raise SystemExit(1)
