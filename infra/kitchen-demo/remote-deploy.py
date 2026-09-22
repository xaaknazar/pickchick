#!/usr/bin/env python3
"""Publish the static kitchen rehearsal; only the public gateway may restart."""
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
b.SERVICE = 'no-demo-service'
START = '\t# BEGIN PICKCHICK KITCHEN DEMO\n'
ROUTE = START + '''\t@kitchen_demo {
\t\tmethod GET HEAD
\t\tpath /kitchen-demo /kitchen-demo/*
\t}
\thandle @kitchen_demo {
\t\tredir /kitchen-demo /kitchen-demo/ 308
\t\theader X-PickChick-Data demo
\t\theader Cache-Control "no-store"
\t\theader Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
\t\troot * /srv/public
\t\tfile_server
\t}
\t# END PICKCHICK KITCHEN DEMO
'''

def add_route(source):
    b.require(START not in source, 'Demo already installed; inspect before updating')
    b.require(source.count('\t@operations {') == 1, 'Operations anchor changed')
    return source.replace('\t@operations {', ROUTE + '\n\t@operations {', 1)

def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ['package', 'expected-source-sha', 'expected-public-release', 'expected-api-release', 'expected-gateway-sha256']:
        p.add_argument('--' + name, required=True)
    p.add_argument('--apply', action='store_true')
    a = p.parse_args(); a.package = Path(a.package).absolute()
    b.require(os.getuid() == 1000 and re.fullmatch('[a-f0-9]{40}', a.expected_source_sha), 'Use operator and committed SHA')
    manifest = json.loads((a.package / 'demo-package.json').read_text())
    b.require(manifest['source_sha'] == a.expected_source_sha, 'Wrong source')
    for name, sha in manifest['files'].items():
        relative = Path(name)
        b.require(not relative.is_absolute() and '..' not in relative.parts and name.startswith(('apps/kitchen/demo-dist/', 'infra/kitchen-demo/', 'infra/roadmap/')), 'Unexpected package input')
        f = a.package / name
        b.require(f.is_file() and not any(p.is_symlink() for p in [f, *f.parents]) and b.digest(f) == sha, 'Package hash mismatch')
    dist = a.package / 'apps/kitchen/demo-dist'
    b.require((dist / 'index.html').is_file() and (dist / 'demo.js').is_file(), 'Incomplete demo')
    old, api, before = b.baseline(a)
    add_route((old / 'infra/public-staging/gateway.Caddyfile').read_text())
    if not a.apply:
        print(json.dumps({'status': 'inspected', 'source_sha': a.expected_source_sha})); return
    outcome = {'status': 'preparing', 'source_sha': a.expected_source_sha}
    with b.lock(a.expected_source_sha):
        old, api, before = b.baseline(a)
        new = b.ROOT / 'public-https/releases' / a.expected_source_sha
        b.require(not new.exists(), 'Immutable release exists')
        changed = False
        try:
            old_manifest = b.public_files(old)
            target = new / 'infra/public-staging'
            target.mkdir(parents=True)
            web = target / 'public-web'
            shutil.copytree(old / 'infra/public-staging/public-web', web)
            shutil.copytree(dist, web / 'kitchen-demo')
            for f in (web / 'kitchen-demo').rglob('*'):
                f.chmod(0o755 if f.is_dir() else 0o644)
            (web / 'kitchen-demo').chmod(0o755)
            result = json.loads(json.dumps(old_manifest))
            result.setdefault('component_sources', {})['kitchen-demo'] = a.expected_source_sha
            additions = {str(f.relative_to(web)): b.digest(f) for f in (web / 'kitchen-demo').rglob('*') if f.is_file()}
            result['files'].update(additions)
            (web / '.release.json').write_text(json.dumps(result, indent=2) + '\n')
            gateway_config = target / 'gateway.Caddyfile'
            gateway_config.write_text(add_route((old / 'infra/public-staging/gateway.Caddyfile').read_text()))
            compose = json.loads(b.run(b.compose(old / 'infra/public-staging/compose.yaml') + ['config', '--format', 'json']))
            gateway = compose['services']['gateway']
            for v in gateway['volumes']:
                if v['target'] == '/etc/caddy/Caddyfile': v['source'] = str(gateway_config)
                if v['target'] == '/srv/public': v['source'] = str(web)
            b.save(target / 'compose.yaml', compose)
            b.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp', '--tmpfs', '/config', '--tmpfs', '/data', '-v', str(gateway_config) + ':/etc/caddy/Caddyfile:ro', gateway['image'], 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
            b.baseline(a); changed = True
            b.run(b.compose(target / 'compose.yaml') + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'gateway'], timeout=120)
            with b.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(b.verify_public_asset, result['files'].items()))
            status, body, headers = b.http('/kitchen-demo/')
            b.require(status == 200 and b'/kitchen-demo/app.js' in body and "connect-src 'none'" in headers.get('Content-Security-Policy', ''), 'Demo smoke failed')
            b.require(b.http('/kitchen-live/prep/edge/v1/fulfillment/kitchen')[0] == 401, 'Live authorization changed')
            b.unchanged(before)
            b.require(b.pointer(b.ROOT / 'current') == api, 'Business API changed')
            b.switch(b.ROOT / 'public-https/current', new)
            outcome.update(status='deployed', public_release=str(new), previous_public_release=str(old), preserved_files=len(old_manifest['files']), demo_files=len(additions))
        except b.Uncertain:
            b.save(b.ROOT / 'kitchen-demo/uncertain.json', outcome); raise
        except BaseException as error:
            if changed:
                b.run(b.compose(old / 'infra/public-staging/compose.yaml') + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'gateway'], timeout=120)
            b.baseline(a); b.unchanged(before)
            outcome.update(status='rolled_back', reason=type(error).__name__)
        b.save(b.ROOT / 'kitchen-demo/deployments' / (a.expected_source_sha + '-' + uuid.uuid4().hex + '.json'), outcome)
    print(json.dumps(outcome))
    sys.exit(0 if outcome['status'] == 'deployed' else 1)
if __name__ == '__main__':
    main()
