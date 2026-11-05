#!/usr/bin/env python3
"""Pure reviewed transformations for own ingress. Never deploys or reads secrets."""
import copy
import hashlib
import ipaddress
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
SUBNET = '10.240.17.0/28'
ADDRESS = '10.240.17.2'
NETWORK = 'pickchick-public-ingress'
IMAGE = 'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'
HOSTS = frozenset(['pickchick.kz', 'api.pickchick.kz', 'www.pickchick.kz',
                   'pickchick.185.129.51.103.nip.io'])
UPSTREAMS = frozenset(['pickchick-public-gateway', 'pickchick-staff-login'])
TRUST = re.compile(rb'(?m)^\t\ttrusted_proxies static ([^\n]+)\n')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def require(value, message):
    if not value:
        raise ValueError(message)


def sites(original, expected_hash):
    require(digest(original) == expected_hash, 'Front CAS differs')
    suffix = (HERE / 'Caddyfile').read_bytes()
    require(original.endswith(suffix) and original.count(suffix) == 1,
            'PickChick sites differ from reviewed byte-identical suffix')
    prefix = original[:-len(suffix)]
    require(prefix and b'pickchick' not in prefix.lower(), 'Unexpected shared prefix')
    return suffix


def subnet_guard(networks, routes=()):
    selected = ipaddress.ip_network(SUBNET)
    require(selected.prefixlen == 28 and ipaddress.ip_address(ADDRESS) in selected,
            'Fixed /28 and Caddy address required')
    for net in networks:
        require(net['Name'] != NETWORK, 'Ingress network already exists; inspect before retry')
        for config in net.get('IPAM', {}).get('Config') or []:
            existing = ipaddress.ip_network(config['Subnet'])
            require(existing.version != 4 or not existing.overlaps(selected), 'Subnet collision')
    for route in routes:
        destination = route.get('dst')
        if destination in (None, 'default'):
            continue
        existing = ipaddress.ip_network(destination, strict=False)
        require(existing.version != 4 or not existing.overlaps(selected), 'Host route collision')


def gateway(original, expected_hash):
    require(digest(original) == expected_hash, 'Gateway CAS differs')
    matches = TRUST.findall(original)
    require(len(matches) == 1 and original.count(b'trusted_proxies static') == 1,
            'Exactly one static proxy trust required')
    require(b'\t\ttrusted_proxies_strict\n' in original, 'Strict proxy parsing required')
    require(b'header_up X-PickChick-Client-IP {client_ip}' in original and
            b'{remote_host}' not in original, 'Existing client-IP fix must already be installed')
    current = [ipaddress.ip_network(v.decode(), strict=True) for v in matches[0].split()]
    require(current == [ipaddress.ip_network('172.18.0.0/16')], 'Reviewed trust baseline differs')
    result = TRUST.sub(b'\t\ttrusted_proxies static ' + ADDRESS.encode() + b'\n', original)
    require(result.replace(b'static ' + ADDRESS.encode() + b'\n',
                           b'static ' + matches[0] + b'\n') == original, 'Unrelated gateway change')
    return result


def gateway_compose(original, config):
    require(set(original['services']) == {'gateway'}, 'Only gateway compose supported')
    result = copy.deepcopy(original)
    service = result['services']['gateway']
    require(service.get('container_name') == 'pickchick-public-gateway', 'Gateway name differs')
    mounts = service['volumes']
    configs = [v for v in mounts if v.get('target') == '/etc/caddy/Caddyfile']
    require(len(configs) == 1 and configs[0].get('read_only') is True, 'Gateway config mount differs')
    configs[0]['source'] = str(config)
    require(NETWORK not in result.get('networks', {}), 'Candidate network already defined')
    require(isinstance(service.get('networks'), dict), 'Resolved compose networks required')
    service['networks'][NETWORK] = {'aliases': ['pickchick-public-gateway']}
    result.setdefault('networks', {})[NETWORK] = {'name': NETWORK, 'external': True}
    return result


def tls_allowed(relative):
    parts = Path(relative).parts
    if not parts or relative.startswith('/') or '..' in parts:
        return False
    if len(parts) >= 5 and parts[:2] == ('caddy', 'certificates'):
        return parts[3] in HOSTS and len(parts) == 5
    # Caddy ACME account keys/registration are shared; never copy legacy certificates
    # or autosave config, which contains the legacy site.
    return len(parts) >= 6 and parts[:2] == ('caddy', 'acme') and parts[3] == 'users'


def tls_guard(paths):
    require(paths and all(tls_allowed(p) for p in paths), 'Unreviewed TLS storage member')
    for host in HOSTS:
        require(any('/' + host + '/' in p and p.endswith('.crt') for p in paths),
                'Missing existing PickChick certificate')
        require(any('/' + host + '/' in p and p.endswith('.key') for p in paths),
                'Missing existing PickChick private key')
    require(any('/acme/' in p for p in paths), 'ACME account missing')


def window(now, approved_date):
    from zoneinfo import ZoneInfo
    local = now.astimezone(ZoneInfo('Asia/Almaty'))
    require(local.date().isoformat() == approved_date and local.hour == 1 and local.minute <= 25,
            'Approved separate 01:00-02:00 Almaty window required')
    require(local.date().isoformat() != '2026-11-06', 'No cutover on preparation night')
    require(not '2026-11-12' <= approved_date <= '2026-11-20', 'Launch-week freeze')
