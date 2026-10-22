#!/usr/bin/env python3
"""Publish the owner-approved terms and privacy update, preserving public operator details.

Exact CI/source hashes, baseline pins, shared release lock and an immutable gateway
release are required. All existing assets/routes and neighboring services survive.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import html
import hashlib
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
VERSION = 'storefront-2026-10-22'
PROPOSAL = 'docs/operations/mobile-appstore-2026-10-22/legal-final-proposal.md'
BEFORE = {
    'terms': 'a2db09ed2e6e50b0797472e17dc93aff05fefc620736cfd6fbd31939c2063c58',
    'privacy': '98cdf40ae17339184ba28d357215fdd809bcbbac8d3880c92e18ed2bfbef29a8',
}


def section(proposal, heading):
    marker = '## '+heading+'\n\n'
    r.require(proposal.count(marker) == 1, 'Approved section missing')
    text = proposal.split(marker)[1].split('\n## ')[0].strip()
    return [' '.join(part.split()) for part in text.split('\n\n')]


def replace_paragraph(text, prefix, replacement):
    pattern = r'<p[^>]*>'+re.escape(prefix)+r'.*?</p>'
    r.require(len(re.findall(pattern, text, re.S)) == 1, 'Legal paragraph drift')
    return re.sub(pattern, lambda _: replacement, text, count=1, flags=re.S)


def paragraphs(values):
    return ''.join('<p>'+html.escape(value)+'</p>' for value in values)


def candidate(kind, original, proposal, effective_date):
    r.require(kind in BEFORE and hashlib.sha256(original.encode()).hexdigest() == BEFORE[kind], 'Legal baseline differs')
    r.require(re.fullmatch(r'20[0-9]{2}-[0-9]{2}-[0-9]{2}', effective_date), 'Exact publication date required')
    r.require('Подтверждаю текст и принятие' in proposal and VERSION in proposal, 'Owner-approved proposal required')
    stamp = ('Действуют' if kind == 'terms' else 'Действует')+' с '+effective_date+'. Версия: '+VERSION
    text = replace_paragraph(original, 'Действуют с ' if kind == 'terms' else 'Действует с ', paragraphs([stamp]))
    if kind == 'terms':
        sessions = section(proposal, 'Условия: коды и сохранение входа')
        orders = section(proposal, 'Условия: заказ и оплата')
        r.require(len(sessions) == 1 and len(orders) == 5, 'Approved terms structure changed')
        text = replace_paragraph(text, 'Код действует 3 минуты.', paragraphs(sessions))
        text = replace_paragraph(text, 'В приложении предусмотрены', paragraphs(orders[:3]+orders[4:]))
        text = replace_paragraph(text, 'До отправки состав можно изменить', paragraphs([orders[3]]))
        r.require(text.count('Заказы и пилот') == 1, 'Terms heading changed')
        text = text.replace('Заказы и пилот', 'Заказ и оплата')
    else:
        old = 'Сессия остаётся действующей до выхода, отзыва или удаления аккаунта, без плановой повторной отправки кода.'
        r.require(text.count(old) == 1, 'Privacy session text changed')
        text = text.replace(old, html.escape(section(proposal, 'Политика: срок входа')[0]))
        anchor = '<h2>Сроки хранения аккаунта</h2>'
        r.require(text.count(anchor) == 1, 'Privacy storage heading changed')
        text = text.replace(anchor, '<h2>Сведения об оплате</h2>'+paragraphs(section(proposal, 'Политика: сведения об оплате'))+anchor)
    r.require('pilot-2026-09-26' not in text, 'Old version remains')
    return text


def verify_source(a):
    m = json.loads((ROOT/'legal-source.json').read_text())
    r.require(m.get('source_sha') == a.source_sha, 'Source manifest differs')
    needed = {'infra/public-staging/legal-update.py', PROPOSAL,
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
    new_text = original.read_text()
    manifest = r.public_files(old)
    proposal = (ROOT/PROPOSAL).read_text()
    pages = {'legal/'+kind+'.html': candidate(kind, (old/'infra/public-staging/public-web/legal'/ (kind+'.html')).read_text(), proposal, a.effective_date) for kind in ('terms','privacy')}
    r.require(all(name in manifest['files'] for name in pages), 'Existing legal assets missing')
    baseline = {path:r.http(path)[:2] for path in ['/v1/capabilities', '/roadmap/health', '/support/']}
    r.require(all(v[0] == 200 for v in baseline.values()), 'Existing page unavailable')
    outcome = {'source_sha':a.source_sha, 'validated':True, 'applied':False, 'legal_version':VERSION, 'effective_date':a.effective_date, 'operator_preserved':True}
    if not a.apply:
        print(json.dumps(outcome)); return
    with r.lock(a.source_sha):
        r.require(r.baseline(a) == (old, api, before), 'Baseline drift after lock')
        release = r.ROOT/'public-https/releases'/a.source_sha
        r.require(not release.exists(), 'Immutable release already exists')
        target = release/'infra/public-staging'
        target.mkdir(parents=True)
        journal = release/'legal-release.json'
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
            outcome.update(applied=True, neighbors_preserved=True, unrelated_assets_preserved=True,
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
    parser.add_argument('--effective-date',required=True)
    parser.add_argument('--apply',action='store_true')
    try:main(parser.parse_args())
    except BaseException as error:
        if isinstance(error,SystemExit):raise
        print(json.dumps({'status':'refused','reason':'Legal publication failed; retained owned lock if acquired'}))
        sys.exit(1)
