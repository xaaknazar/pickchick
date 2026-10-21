#!/usr/bin/env python3
"""Trust the outer ingress network, not one container IP, and forward the resolved client.

Audit 19.10 findings 5.0 and 5.6. Two lines of the installed public gateway change:

* `trusted_proxies static <one outer Caddy IP>` becomes the subnet of the Docker network
  the outer Caddy reaches us through (default `deploy_default`). The outer Caddy belongs to
  another project and its address is not pinned; when Docker gives it a new address the old
  rule silently stops trusting it and every customer collapses into the proxy's IP.
* the kitchen portal route forwards `{client_ip}` (resolved through the trusted proxies)
  instead of `{remote_host}` (always the outer proxy).

The subnet is read from Docker at release time and the release refuses (fail closed, clear
message) unless the network has exactly one private IPv4 subnet of size /16../28 that holds
the outer Caddy's current address. Nothing else in the gateway may differ.

`--check` is read-only and needs no lock or CI proof: it exits 1 with a clear reason when the
installed gateway no longer trusts the outer Caddy's current address or still forwards
`{remote_host}`. The ops watchdog may run it periodically.

Run on the VPS from verified source with exact successful CI, CAS pins and the shared lock.
Only the PickChick gateway may be recreated. No DB, identity, payment or roadmap change.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[2]
OUTER = 'deploy-caddy-1'
NETWORK = 'deploy_default'
TRUST = re.compile(r'^\t\ttrusted_proxies static ([^\n]+)\n', re.M)
CLIENT_OLD = 'header_up X-PickChick-Client-IP {remote_host}'
CLIENT_NEW = 'header_up X-PickChick-Client-IP {client_ip}'


class GuardFailure(RuntimeError):
    """A clear, operator-facing refusal; nothing was changed."""


def require(condition, message):
    if not condition:
        raise GuardFailure(message)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ingress_subnet(inspect, outer_ip):
    """The single private IPv4 subnet of the outer ingress network that holds the outer proxy."""
    require(isinstance(inspect, list) and len(inspect) == 1 and isinstance(inspect[0], dict),
            'Expected exactly one ingress network')
    configs = (inspect[0].get('IPAM') or {}).get('Config') or []
    subnets = []
    for entry in configs:
        try:
            subnets.append(ipaddress.ip_network(entry.get('Subnet', ''), strict=True))
        except ValueError:
            raise GuardFailure('Ingress network subnet is not a valid CIDR') from None
    v4 = [s for s in subnets if s.version == 4]
    require(len(v4) == 1, 'Ingress network must have exactly one IPv4 subnet; trust it by hand')
    subnet = v4[0]
    rfc1918 = [ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
    require(any(subnet.subnet_of(n) for n in rfc1918) and 16 <= subnet.prefixlen <= 28,
            'Ingress subnet must be RFC 1918 and between /16 and /28: ' + str(subnet))
    try:
        outer = ipaddress.ip_address(outer_ip)
    except ValueError:
        raise GuardFailure('Outer proxy has no address on the ingress network') from None
    require(outer in subnet, 'Outer proxy address is outside the ingress subnet')
    return str(subnet)


def trusted(text):
    """Networks named by the gateway's single trusted_proxies line."""
    found = TRUST.findall(text)
    require(len(found) == 1 and text.count('trusted_proxies static') == 1,
            'Expected exactly one trusted_proxies static line')
    require('\t\ttrusted_proxies_strict\n' in text, 'trusted_proxies_strict is required')
    try:
        return [ipaddress.ip_network(value, strict=True) for value in found[0].split()]
    except ValueError:
        raise GuardFailure('trusted_proxies holds a value that is not an IP or CIDR') from None


def candidate(original, subnet):
    current = trusted(original)
    network = ipaddress.ip_network(subnet, strict=True)
    require(network.is_private and network.prefixlen >= 16, 'Refusing a broad trusted network')
    lines = original.split('\n')
    result = TRUST.sub('\t\ttrusted_proxies static ' + subnet + '\n', original, count=1)
    result = result.replace(CLIENT_OLD, CLIENT_NEW)
    require(result != original and (current != [network] or CLIENT_OLD in original),
            'Gateway already trusts this subnet and forwards {client_ip}')
    changed = [i for i, (a, b) in enumerate(zip(lines, result.split('\n'))) if a != b]
    require(len(lines) == len(result.split('\n')) and all(
        lines[i].startswith('\t\ttrusted_proxies static ') or lines[i].strip() == CLIENT_OLD
        for i in changed), 'Unrelated gateway line changed')
    require('{remote_host}' not in result, 'A route still forwards the proxy hop as the client')
    return result


def check(text, outer_ip):
    """Read-only invariant for the watchdog: the outer proxy is trusted, the client resolved."""
    problems = []
    try:
        outer = ipaddress.ip_address(outer_ip)
    except ValueError:
        return {'ok': False, 'problems': ['outer_proxy_address_unknown']}
    try:
        networks = trusted(text)
    except GuardFailure:
        return {'ok': False, 'problems': ['trusted_proxies_unreadable']}
    if not any(outer in network for network in networks):
        problems.append('outer_proxy_not_trusted')
    if CLIENT_OLD in text:
        problems.append('kitchen_route_forwards_proxy_hop')
    return {'ok': not problems, 'problems': problems,
            'trusted': [str(n) for n in networks], 'outer_proxy': str(outer)}


def compose_candidate(old, config, web):
    result = json.loads(json.dumps(old))
    require(set(result['services']) == {'gateway'}, 'Only gateway service is allowed')
    volumes = result['services']['gateway']['volumes']
    require(len(volumes) == 2 and {v['target'] for v in volumes} ==
            {'/etc/caddy/Caddyfile', '/srv/public'} and all(v['read_only'] for v in volumes),
            'Gateway mount profile changed')
    for v in volumes:
        v['source'] = str(config if v['target'] == '/etc/caddy/Caddyfile' else web)
    return result


def outer_address(r, network=NETWORK):
    return r.run(['docker', 'inspect', '--format',
                  '{{(index .NetworkSettings.Networks "' + network + '").IPAddress}}', OUTER])


def main(a):
    r = load('client_ip_parent', ROOT/'infra/roadmap/remote-deploy.py')
    if a.check:
        current = r.pointer(r.ROOT/'public-https/current')
        result = check((current/'infra/public-staging/gateway.Caddyfile').read_text(),
                       outer_address(r, a.network))
        print(json.dumps({'event': 'gateway_client_ip_check', **result}))
        sys.exit(0 if result['ok'] else 1)
    p = load('client_ip_ci', ROOT/'infra/backoffice-login/release.py')
    os.umask(0o077)
    for value in (a.source_sha, a.expected_api_sha, a.expected_public_sha):
        require(re.fullmatch('[a-f0-9]{40}', value or ''), 'Exact commit required')
    p.verify_ci(json.loads(a.ci_proof.read_text()), a.source_sha)
    a.expected_api_release = str(r.ROOT/'releases'/a.expected_api_sha)
    a.expected_public_release = str(r.ROOT/'public-https/releases'/a.expected_public_sha)
    old, api, before = r.baseline(a)
    original = old/'infra/public-staging/gateway.Caddyfile'
    outer_ip = outer_address(r, a.network)
    subnet = ingress_subnet(json.loads(r.run(['docker', 'network', 'inspect', a.network])), outer_ip)
    new_text = candidate(original.read_text(), subnet)
    manifest = r.public_files(old)
    baseline = {path: r.http(path)[:2] for path in ['/v1/capabilities', '/roadmap/health']}
    require(all(status == 200 for status, _ in baseline.values()), 'Baseline health failed')
    plan = {'source_sha': a.source_sha, 'trusted_subnet': subnet, 'outer_proxy': outer_ip}
    if not a.apply:
        print(json.dumps({**plan, 'validated': True, 'applied': False}))
        return
    outcome = {**plan, 'status': 'preparing'}
    with r.lock(a.source_sha):
        require(r.baseline(a) == (old, api, before), 'Baseline drift after lock')
        release = r.ROOT/'public-https/releases'/a.source_sha
        require(not release.exists(), 'Immutable candidate already exists')
        target = release/'infra/public-staging'
        target.mkdir(parents=True)
        journal = release/'client-ip-release.json'
        switched = False
        try:
            shutil.copytree(old/'infra/public-staging/public-web', target/'public-web')
            require(r.public_files(release) == manifest, 'Public backup/copy differs')
            config = target/'gateway.Caddyfile'
            config.write_text(new_text)
            config.chmod(0o644)
            shutil.copyfile(original, release/'gateway.before')
            require((release/'gateway.before').read_bytes() == original.read_bytes(), 'Backup differs')
            old_compose = json.loads(r.run(r.compose(old/'infra/public-staging/compose.yaml') +
                                           ['config', '--format', 'json']))
            new_compose = compose_candidate(old_compose, config, target/'public-web')
            r.save(target/'compose.yaml', new_compose)
            r.save(release/'ci-proof.json', json.loads(a.ci_proof.read_text()))
            r.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                   '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
                   '--tmpfs', '/tmp', '--tmpfs', '/config', '--tmpfs', '/data',
                   '-v', str(config)+':/etc/caddy/Caddyfile:ro', new_compose['services']['gateway']['image'],
                   'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
            require(r.baseline(a) == (old, api, before), 'Baseline changed during prepare')
            require(outer_address(r, a.network) == outer_ip, 'Outer proxy address changed during prepare')
            switched = True
            r.run(r.compose(target/'compose.yaml') +
                  ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'gateway'], timeout=120)
            require(r.gateway_mounts() == {'/etc/caddy/Caddyfile': str(config),
                    '/srv/public': str(target/'public-web')}, 'Candidate mounts differ')
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(r.verify_public_asset, manifest['files'].items()))
            for path, expected in baseline.items():
                require(r.http(path)[:2] == expected, 'Existing endpoint changed: '+path)
            require(r.http('/health/live')[0] == 200 and r.http('/kitchen-live/health')[0] == 200,
                    'Application health changed')
            require(check(config.read_text(), outer_address(r, a.network))['ok'], 'Post-check failed')
            neighbors = r.containers()
            require({k: v for k, v in neighbors.items() if k != r.GATEWAY} ==
                    {k: v for k, v in before.items() if k != r.GATEWAY}, 'Neighbor changed')
            require(r.pointer(r.ROOT/'current') == api and
                    r.pointer(r.ROOT/'public-https/current') == old, 'Pointer drift')
            r.switch(r.ROOT/'public-https/current', release)
            outcome.update(status='deployed', gateway_sha256=r.digest(config),
                           previous_public_release=str(old), neighbors_preserved=True)
            r.save(journal, outcome)
        except r.Uncertain:
            outcome.update(status='uncertain', lock_retained=True)
            r.save(journal, outcome)
            raise
        except BaseException:
            try:
                if switched:
                    r.run(r.compose(old/'infra/public-staging/compose.yaml') +
                          ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'gateway'], timeout=120)
                pointer = r.pointer(r.ROOT/'public-https/current')
                require(pointer in (old, release), 'Foreign public pointer')
                if pointer == release:
                    r.switch(r.ROOT/'public-https/current', old)
                r.baseline(a)
                outcome.update(status='rolled_back')
                r.save(journal, outcome)
            except BaseException:
                r.save(journal, {**outcome, 'status': 'rollback_unverified', 'lock_retained': True})
                raise
    print(json.dumps(outcome))
    require(outcome['status'] == 'deployed', 'Gateway release rolled back')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check', action='store_true', help='read-only invariant check')
    parser.add_argument('--network', default=NETWORK)
    for name in ('source-sha', 'expected-api-sha', 'expected-public-sha', 'expected-gateway-sha256'):
        parser.add_argument('--'+name)
    parser.add_argument('--ci-proof', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.check and (args.ci_proof is None or not args.expected_gateway_sha256):
        parser.error('a release needs --source-sha, --expected-*, --ci-proof (or use --check)')
    try:
        main(args)
    except GuardFailure as error:
        print(json.dumps({'status': 'refused', 'reason': str(error)}), file=sys.stderr)
        sys.exit(1)
