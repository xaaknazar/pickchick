#!/usr/bin/env python3
"""Publish only three public help pages using the already-public restaurant contact.

Exact CI/source hashes, baseline pins, shared release lock and an immutable gateway
release are required. All existing assets/routes and neighboring services survive.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


r = load('support_remote', ROOT/'infra/roadmap/remote-deploy.py')
p = load('support_ci', ROOT/'infra/backoffice-login/release.py')
d = load('support_gateway', ROOT/'infra/public-staging/device-center-gateway.py')
render = load('support_render', ROOT/'infra/public-staging/support/render.py').render
BLOCK = '''\t# BEGIN PICKCHICK SUPPORT
\t@pickchick_support {
\t\tmethod GET HEAD
\t\tpath /support /support/ /support/ru.html /support/kk.html /support/en.html /support/style.css
\t}
\thandle @pickchick_support {
\t\theader X-PickChick-Data support
\t\theader Referrer-Policy no-referrer
\t\theader X-Frame-Options DENY
\t\theader Content-Security-Policy "default-src 'self'; script-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
\t\t@support_root path /support /support/
\t\trewrite @support_root /support/ru.html
\t\turi strip_prefix /support
\t\troot * /srv/public/support
\t\tfile_server
\t}
\t# END PICKCHICK SUPPORT
'''


def candidate(original):
    anchor = '\t@backoffice_get {'
    r.require(original.count(anchor) == 1 and '/support' not in original, 'Support route exists or gateway boundary changed')
    result = original.replace(anchor, BLOCK+'\n'+anchor, 1)
    r.require(result.replace(BLOCK+'\n', '', 1) == original, 'Unrelated route changed')
    return result


def public_contact(legal):
    text = re.sub('<[^>]+>', ' ', legal)
    phones = re.findall(r'\+7[\d ()-]{10,18}', text)
    r.require(len(phones) == 1, 'Exactly one existing public restaurant contact required')
    phone = '+'+re.sub(r'\D', '', phones[0])
    r.require(re.fullmatch(r'\+7[0-9]{10}', phone), 'Public restaurant contact format changed')
    return phone


def verify_source(a):
    m = json.loads((ROOT/'support-source.json').read_text())
    r.require(m.get('source_sha') == a.source_sha, 'Source manifest differs')
    needed = {'infra/public-staging/support-page-release.py', 'infra/public-staging/support/render.py',
              'infra/public-staging/support/content.json', 'infra/public-staging/support/style.css',
              'infra/roadmap/remote-deploy.py', 'infra/backoffice-login/release.py',
              'infra/domains/release-alias.py', 'infra/public-staging/device-center-gateway.py'}
    r.require(set(m['files']) == needed, 'Source files differ')
    for path, digest in m['files'].items():
        f = ROOT/path
        r.require(f.is_file() and not f.is_symlink() and r.digest(f) == digest, 'Source file changed')


def verify(manifest, before, api, old, release, baseline):
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(r.verify_public_asset, manifest['files'].items()))
    for path, expected in baseline.items():
        r.require(r.http(path)[:2] == expected, 'Existing endpoint changed')
    r.require(r.http('/support/')[0] == 200 and r.http('/health/live')[0] == 200
              and r.http('/kitchen-live/health')[0] == 200, 'Public readiness failed')
    d.neighbors(before)
    r.require(r.pointer(r.ROOT/'current') == api and r.pointer(r.ROOT/'public-https/current') in (old, release),
              'Release pointer changed')


def main(a):
    os.umask(0o077)
    for value in (a.source_sha, a.expected_api_sha, a.expected_public_sha):
        r.require(re.fullmatch('[a-f0-9]{40}', value), 'Exact commits required')
    verify_source(a)
    p.verify_ci(json.loads(a.ci_proof.read_text()), a.source_sha)
    a.expected_api_release = str(r.ROOT/'releases'/a.expected_api_sha)
    a.expected_public_release = str(r.ROOT/'public-https/releases'/a.expected_public_sha)
    old, api, before = r.baseline(a)
    original = old/'infra/public-staging/gateway.Caddyfile'
    new_text = candidate(original.read_text())
    manifest = r.public_files(old)
    legal = old/'infra/public-staging/public-web/legal/privacy.html'
    phone = public_contact(legal.read_text())
    pages = {'support/'+lang+'.html': render(lang, phone) for lang in ('ru', 'kk', 'en')}
    pages['support/style.css'] = (ROOT/'infra/public-staging/support/style.css').read_text()
    r.require(not set(pages).intersection(manifest['files']), 'Support assets already exist')
    baseline = {path:r.http(path)[:2] for path in ['/v1/capabilities', '/roadmap/health', '/legal/privacy', '/legal/terms']}
    r.require(all(v[0] == 200 for v in baseline.values()), 'Existing page unavailable')
    r.require(r.http('/support/')[0] == 404, 'Unexpected original support route')
    outcome = {'source_sha':a.source_sha, 'validated':True, 'applied':False, 'existing_public_contact_reused':True}
    if not a.apply:
        print(json.dumps(outcome)); return
    with r.lock(a.source_sha):
        r.require(r.baseline(a) == (old, api, before), 'Baseline drift after lock')
        release = r.ROOT/'public-https/releases'/a.source_sha
        r.require(not release.exists(), 'Immutable release already exists')
        target = release/'infra/public-staging'
        target.mkdir(parents=True)
        journal = release/'support-release.json'
        switched = False
        try:
            shutil.copytree(old/'infra/public-staging/public-web', target/'public-web')
            r.require(r.public_files(release) == manifest, 'Copied public assets differ')
            new_manifest = json.loads(json.dumps(manifest))
            for name, content in pages.items():
                f = target/'public-web'/name
                f.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                f.parent.chmod(0o755)
                f.write_text(content); f.chmod(0o644)
                new_manifest['files'][name] = r.digest(f)
            (target/'public-web/.release.json').write_text(json.dumps(new_manifest, indent=2)+'\n')
            (target/'public-web/.release.json').chmod(0o644)
            config = target/'gateway.Caddyfile'
            config.write_text(new_text); config.chmod(0o644)
            shutil.copyfile(original, release/'gateway.before')
            old_compose = json.loads(r.run(r.compose(old/'infra/public-staging/compose.yaml')+['config','--format','json']))
            new_compose = d.compose_candidate(old_compose, config, target/'public-web')
            r.save(target/'compose.yaml', new_compose)
            r.save(release/'ci-proof.json', json.loads(a.ci_proof.read_text()))
            r.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL',
                   '--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges:true',
                   '--tmpfs','/tmp','--tmpfs','/config','--tmpfs','/data',
                   '-v',str(config)+':/etc/caddy/Caddyfile:ro',new_compose['services']['gateway']['image'],
                   'caddy','validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
            r.require(r.baseline(a) == (old, api, before), 'Baseline changed during preparation')
            switched = True
            r.run(r.compose(target/'compose.yaml')+['up','-d','--no-deps','--wait','--wait-timeout','60','gateway'],timeout=120)
            r.require(r.gateway_mounts() == {'/etc/caddy/Caddyfile':str(config),'/srv/public':str(target/'public-web')}, 'Gateway mounts differ')
            verify(new_manifest,before,api,old,release,baseline)
            r.switch(r.ROOT/'public-https/current',release)
            outcome.update(applied=True, neighbors_preserved=True, existing_assets_preserved=True,
                           gateway_sha256=r.digest(config), files={k:new_manifest['files'][k] for k in pages})
            r.save(journal,outcome)
        except r.Uncertain:
            r.save(journal,{**outcome,'status':'uncertain','lock_retained':True})
            raise
        except BaseException:
            if switched:
                r.run(r.compose(old/'infra/public-staging/compose.yaml')+['up','-d','--no-deps','--wait','--wait-timeout','60','gateway'],timeout=120)
            pointer=r.pointer(r.ROOT/'public-https/current')
            r.require(pointer in (old,release),'Foreign public pointer')
            if pointer==release:r.switch(r.ROOT/'public-https/current',old)
            r.baseline(a)
            r.save(journal,{**outcome,'status':'rolled_back','lock_retained':True})
            raise
    print(json.dumps(outcome))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for field in ('source-sha','expected-api-sha','expected-public-sha','expected-gateway-sha256'):
        parser.add_argument('--'+field,required=True)
    parser.add_argument('--ci-proof',type=Path,required=True)
    parser.add_argument('--apply',action='store_true')
    try:main(parser.parse_args())
    except BaseException as error:
        if isinstance(error,SystemExit):raise
        print(json.dumps({'status':'refused','reason':'Support publication failed; retained owned lock if acquired'}))
        sys.exit(1)
