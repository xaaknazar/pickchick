#!/usr/bin/env python3
"""Publish only three public help pages using the already-public restaurant contact.

Exact CI/source hashes, baseline pins, shared release lock and an immutable gateway
release are required. All existing assets/routes and neighboring services survive.
"""
import argparse
import ctypes
import hashlib
import uuid
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


SUPPORT_ASSETS = {'support/ru.html', 'support/kk.html', 'support/en.html', 'support/style.css'}


def update_manifest(manifest, pages):
    r.require(set(pages) == SUPPORT_ASSETS, 'support.update.page_set')
    r.require({k for k in manifest['files'] if k.startswith('support/')} == SUPPORT_ASSETS,
              'support.update.existing_asset_set')
    result = json.loads(json.dumps(manifest))
    for name, content in pages.items():
        result['files'][name] = hashlib.sha256(content.encode()).hexdigest()
    return result


def support_tree(path, files):
    r.require(path.is_dir() and not path.is_symlink(), 'support.update.directory')
    r.require({p.name for p in path.iterdir()} == {Path(k).name for k in SUPPORT_ASSETS},
              'support.update.directory_contents')
    for name in SUPPORT_ASSETS:
        f = path / Path(name).name
        r.require(f.is_file() and not f.is_symlink() and r.digest(f) == files[name],
                  'support.update.asset_hash')


def exchange_directories(left, right):
    # Linux RENAME_EXCHANGE replaces the complete page set in one filesystem operation.
    # No fallback to a non-atomic two-rename sequence is allowed on the live server.
    r.require(sys.platform == 'linux', 'support.update.linux_exchange_required')
    r.require(left.parent.stat().st_dev == right.parent.stat().st_dev,
              'support.update.same_filesystem')
    libc = ctypes.CDLL(None, use_errno=True)
    r.require(hasattr(libc, 'renameat2'), 'support.update.renameat2_required')
    fn = libc.renameat2
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    r.require(fn(-100, os.fsencode(left), -100, os.fsencode(right), 2) == 0,
              'support.update.atomic_exchange_failed')


def replace_manifest(path, data):
    temp = path.with_name('.release-' + uuid.uuid4().hex + '.json')
    with temp.open('xb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    temp.chmod(0o644)
    temp.replace(path)


def update_existing(a, old, api, before):
    web = old / 'infra/public-staging/public-web'
    manifest_path = web / '.release.json'
    r.require(re.fullmatch('[a-f0-9]{64}', a.expected_manifest_sha256 or ''),
              'support.update.manifest_pin_required')
    original_manifest = manifest_path.read_bytes()
    r.require(hashlib.sha256(original_manifest).hexdigest() == a.expected_manifest_sha256,
              'support.update.manifest_pin')
    original_config = (old / 'infra/public-staging/gateway.Caddyfile').read_bytes()
    r.require(original_config.decode().count(BLOCK) == 1, 'support.update.existing_route')
    manifest = r.public_files(old)
    phone = public_contact((web / 'legal/privacy.html').read_text())
    pages = {'support/' + lang + '.html': render(lang, phone) for lang in ('ru', 'kk', 'en')}
    pages['support/style.css'] = (ROOT / 'infra/public-staging/support/style.css').read_text()
    updated = update_manifest(manifest, pages)
    support_tree(web / 'support', manifest['files'])
    r.require(any(updated['files'][k] != manifest['files'][k] for k in SUPPORT_ASSETS),
              'support.update.already_current')
    baseline = {path: r.http(path)[:2] for path in
                ['/v1/capabilities', '/roadmap/health', '/legal/privacy', '/legal/terms']}
    r.require(all(status == 200 for status, _ in baseline.values()), 'support.update.baseline_http')
    for name in SUPPORT_ASSETS:
        r.verify_public_asset((name, manifest['files'][name]))
    r.require(r.http('/support/')[0] == 200, 'support.update.existing_http')
    outcome = {'source_sha': a.source_sha, 'mode': 'update-existing', 'validated': True,
               'applied': False, 'public_sha': old.name, 'api_sha': api.name,
               'manifest_before_sha256': a.expected_manifest_sha256,
               'gateway_sha256': a.expected_gateway_sha256}
    if not a.apply:
        print(json.dumps(outcome)); return
    with r.lock(a.source_sha):
        r.require(r.baseline(a) == (old, api, before), 'support.update.baseline_after_lock')
        r.require(manifest_path.read_bytes() == original_manifest, 'support.update.manifest_after_lock')
        release = r.ROOT / 'support-updates' / a.source_sha
        r.require(not release.exists(), 'support.update.immutable_journal_exists')
        release.mkdir(parents=True, mode=0o700)
        backup = release / 'before'
        shutil.copytree(web / 'support', backup)
        support_tree(backup, manifest['files'])
        (release / 'manifest.before.json').write_bytes(original_manifest)
        r.require((release / 'manifest.before.json').read_bytes() == original_manifest,
                  'support.update.backup_manifest')
        (release / 'gateway.before').write_bytes(original_config)
        prepared = release / 'exchange'
        prepared.mkdir(mode=0o755)
        for name, content in pages.items():
            f = prepared / Path(name).name
            f.write_text(content); f.chmod(0o644)
        support_tree(prepared, updated['files'])
        # Prove the exchange primitive on isolated copies before changing the public directory.
        rehearsal = release / 'exchange-probe'
        shutil.copytree(backup, rehearsal)
        exchange_directories(prepared, rehearsal)
        support_tree(prepared, manifest['files']); support_tree(rehearsal, updated['files'])
        exchange_directories(prepared, rehearsal)
        support_tree(prepared, updated['files']); support_tree(rehearsal, manifest['files'])
        journal = release / 'result.json'
        r.save(journal, {**outcome, 'status': 'prepared', 'backup_verified': True})
        switched = False
        try:
            r.require(r.baseline(a) == (old, api, before), 'support.update.baseline_before_exchange')
            r.require(manifest_path.read_bytes() == original_manifest, 'support.update.manifest_before_exchange')
            exchange_directories(web / 'support', prepared)
            switched = True
            replace_manifest(manifest_path, (json.dumps(updated, indent=2) + '\n').encode())
            r.require(r.public_files(old) == updated, 'support.update.manifest_after_exchange')
            verify(updated, before, api, old, old, baseline)
            r.require(r.containers() == before, 'support.update.any_container_changed')
            r.require((old / 'infra/public-staging/gateway.Caddyfile').read_bytes() == original_config,
                      'support.update.gateway_changed')
            r.require(r.http('/support/')[1] == pages['support/ru.html'].encode(),
                      'support.update.root_alias')
            for lang in ('ru', 'kk', 'en'):
                r.require('id="delete-account"' in pages['support/' + lang + '.html'],
                          'support.update.deletion_section')
            outcome.update(applied=True, status='PASS', backup_verified=True,
                           all_containers_unchanged=True, gateway_unchanged=True,
                           manifest_after_sha256=r.digest(manifest_path),
                           files={k: updated['files'][k] for k in sorted(SUPPORT_ASSETS)})
            r.save(journal, outcome)
        except BaseException:
            if switched:
                # Refuse overwriting an intervening writer; preserve lock and evidence.
                support_tree(web / 'support', updated['files'])
                support_tree(prepared, manifest['files'])
                exchange_directories(web / 'support', prepared)
                replace_manifest(manifest_path, original_manifest)
                r.require(r.public_files(old) == manifest, 'support.update.rollback_manifest')
                r.require(r.baseline(a) == (old, api, before), 'support.update.rollback_baseline')
                for name in SUPPORT_ASSETS:
                    r.verify_public_asset((name, manifest['files'][name]))
            r.save(journal, {**outcome, 'status': 'rolled_back' if switched else 'stopped',
                             'lock_retained': True})
            raise
    print(json.dumps(outcome))


def rollback_update(a, old, api, before):
    release = r.ROOT / 'support-updates' / a.source_sha
    result = json.loads((release / 'result.json').read_text())
    r.require(result.get('status') == 'PASS' and result.get('source_sha') == a.source_sha,
              'support.rollback.successful_update_required')
    r.require(result.get('api_sha') == api.name and result.get('public_sha') == old.name,
              'support.rollback.pointers')
    web = old / 'infra/public-staging/public-web'
    manifest_path = web / '.release.json'
    r.require(r.digest(manifest_path) == result['manifest_after_sha256'] == a.expected_manifest_sha256,
              'support.rollback.current_manifest')
    current = r.public_files(old)
    original_bytes = (release / 'manifest.before.json').read_bytes()
    r.require(hashlib.sha256(original_bytes).hexdigest() == result['manifest_before_sha256'],
              'support.rollback.backup_manifest')
    original = json.loads(original_bytes)
    support_tree(web / 'support', current['files'])
    support_tree(release / 'exchange', original['files'])
    support_tree(release / 'before', original['files'])
    r.require((old / 'infra/public-staging/gateway.Caddyfile').read_bytes() ==
              (release / 'gateway.before').read_bytes(), 'support.rollback.gateway')
    r.require({k:v for k,v in current['files'].items() if k not in SUPPORT_ASSETS} ==
              {k:v for k,v in original['files'].items() if k not in SUPPORT_ASSETS},
              'support.rollback.unrelated_assets')
    if not a.apply:
        print(json.dumps({'validated': True, 'applied': False, 'mode': 'rollback-update'})); return
    with r.lock(a.source_sha):
        r.require(r.baseline(a) == (old, api, before), 'support.rollback.baseline_after_lock')
        r.require(r.digest(manifest_path) == result['manifest_after_sha256'],
                  'support.rollback.manifest_after_lock')
        exchange_directories(web / 'support', release / 'exchange')
        replace_manifest(manifest_path, original_bytes)
        r.require(r.public_files(old) == original, 'support.rollback.restored_manifest')
        for name in SUPPORT_ASSETS:
            r.verify_public_asset((name, original['files'][name]))
        r.require(r.baseline(a) == (old, api, before), 'support.rollback.restored_baseline')
        result.update(status='rolled_back', applied=False, rollback_verified=True)
        r.save(release / 'result.json', result)
    print(json.dumps({'status': 'rolled_back', 'rollback_verified': True, 'source_sha': a.source_sha}))


def main(a):
    os.umask(0o077)
    for value in (a.source_sha, a.expected_api_sha, a.expected_public_sha):
        r.require(re.fullmatch('[a-f0-9]{40}', value), 'Exact commits required')
    verify_source(a)
    p.verify_ci(json.loads(a.ci_proof.read_text()), a.source_sha)
    a.expected_api_release = str(r.ROOT/'releases'/a.expected_api_sha)
    a.expected_public_release = str(r.ROOT/'public-https/releases'/a.expected_public_sha)
    old, api, before = r.baseline(a)
    if getattr(a, 'rollback_update', False):
        return rollback_update(a, old, api, before)
    if getattr(a, 'update_existing', False):
        return update_existing(a, old, api, before)
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
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--update-existing',action='store_true')
    mode.add_argument('--rollback-update',action='store_true')
    parser.add_argument('--expected-manifest-sha256')
    parser.add_argument('--apply',action='store_true')
    try:main(parser.parse_args())
    except BaseException as error:
        if isinstance(error,SystemExit):raise
        print(json.dumps({'status':'refused','check':str(error) if isinstance(error, RuntimeError) and str(error).startswith(('support.update.', 'support.rollback.')) else type(error).__name__, 'reason':'Support publication failed; retained owned lock if acquired'}))
        sys.exit(1)
