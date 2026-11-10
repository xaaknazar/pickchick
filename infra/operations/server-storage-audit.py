#!/usr/bin/env python3
"""Read-only Linux/Docker metadata audit for launch checklist Б10.

Never reads Redis configuration contents, container environment or log contents.
This is a point-in-time configuration check, not a Redis connectivity test.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess


DOCKER = ['docker', '--host=unix:///var/run/docker.sock']
FORMAT = ('{"logs":{{json .HostConfig.LogConfig}},'
          '"mounts":{{json .Mounts}},"running":{{json .State.Running}}}')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')


def redis_metadata(path):
    """Only lstat and xattr NAMES. Do not resolve links or open the file."""
    result = {'status': 'unknown', 'contentsRead': False,
              'runtimeReadabilityVerified': False}
    if not path.is_absolute() or '..' in path.parts:
        return {**result, 'reason': 'absolute_normalized_path_required'}
    entries = []
    try:
        # Check ancestors first, so lstat never follows a known parent symlink.
        for item in [*reversed(path.parents), path]:
            metadata = item.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                return {**result, 'reason': 'symlink_requires_manual_review'}
            if item != path and not stat.S_ISDIR(metadata.st_mode):
                return {**result, 'reason': 'parent_not_directory'}
            attrs = os.listxattr(item, follow_symlinks=False)
            if any('acl' in attr.lower() for attr in attrs):
                return {**result, 'reason': 'acl_requires_manual_review'}
            entries.append(metadata)
    except (OSError, AttributeError, NotImplementedError):
        return {**result, 'reason': 'metadata_or_acl_unavailable'}
    file = entries[-1]
    if not stat.S_ISREG(file.st_mode):
        return {**result, 'reason': 'not_regular_file'}
    mode = stat.S_IMODE(file.st_mode)
    traverse = all(item.st_mode & stat.S_IXOTH for item in entries[:-1])
    other_read = bool(mode & stat.S_IROTH)
    result.update(mode=f'{mode:04o}', uid=file.st_uid, gid=file.st_gid,
                  otherReadBit=other_read, otherTraverseAllParents=traverse,
                  otherDacReadPath=bool(other_read and traverse),
                  acl='no_acl_xattr_observed')
    if mode & 0o077:
        return {**result, 'status': 'review', 'reason':
                'other_dac_read_path' if result['otherDacReadPath'] else
                'shared_mode_review_container_uid_and_group_access'}
    return {**result, 'status': 'restricted_mode',
            'reason': 'owner_only_mode_runtime_access_not_tested'}


def size_bytes(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r'([1-9][0-9]{0,14})([kmg]?)', value.lower())
    if not match:
        return None
    return int(match[1]) * (1024 ** {'': 0, 'k': 1, 'm': 2, 'g': 3}[match[2]])


def log_policy(logs):
    """Do not echo arbitrary driver names/options (remote options can be secrets)."""
    unknown = {'status': 'unknown', 'reason': 'logging_policy_requires_review'}
    if not isinstance(logs, dict):
        return unknown
    driver, options = logs.get('Type'), logs.get('Config')
    if not isinstance(options, dict):
        return unknown
    if driver not in ('json-file', 'local'):
        return {**unknown, 'driver': driver if driver in
                ('journald', 'syslog', 'none', 'fluentd', 'awslogs', 'splunk', 'gcplogs')
                else 'other'}
    result = {'driver': driver}
    size = options.get('max-size', '20m' if driver == 'local' else '-1')
    if size == '-1':
        return {**result, 'status': 'unbounded', 'reason': 'no_size_rotation'}
    limit = size_bytes(size)
    count = options.get('max-file', '5' if driver == 'local' else '1')
    if not limit or not isinstance(count, str) or not re.fullmatch(r'[1-9][0-9]{0,8}', count):
        return {**result, **unknown}
    return {**result, 'status': 'bounded', 'maxSizeBytes': limit,
            'maxFiles': int(count), 'nominalCapacityBytes': limit * int(count),
            'usesDriverDefaults': 'max-size' not in options or 'max-file' not in options}


def inspect_container(name):
    if not NAME.fullmatch(name):
        return None
    env = {key: value for key, value in os.environ.items() if key not in
           {'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'}}
    try:
        completed = subprocess.run(
            [*DOCKER, 'container', 'inspect', '--format', FORMAT, name],
            env=env, check=True, capture_output=True, text=True, timeout=15)
        value = json.loads(completed.stdout)
        return value if isinstance(value, dict) else None
    except (OSError, subprocess.SubprocessError, ValueError):
        # Docker errors may contain server paths or sensitive plugin options.
        return None


def redis_mount(data, path):
    if not isinstance(data, dict) or not isinstance(data.get('mounts'), list):
        return {'status': 'unknown', 'reason': 'mount_metadata_unavailable'}
    matches = [mount for mount in data['mounts'] if isinstance(mount, dict)
               and mount.get('Type') == 'bind' and mount.get('Source') == str(path)
               and mount.get('Destination') == '/usr/local/etc/redis/redis.conf']
    if len(matches) != 1:
        return {'status': 'unknown', 'reason': 'expected_exact_file_bind_not_found'}
    return {'status': 'read_only' if matches[0].get('RW') is False else 'review',
            'running': data.get('running') is True,
            'runtimeReadabilityVerified': False}


def audit(path, redis_name, containers):
    names = list(dict.fromkeys([redis_name, *containers]))
    if not all(NAME.fullmatch(name) for name in names):
        raise ValueError('invalid_container_name')
    metadata = redis_metadata(path)
    snapshots = {name: inspect_container(name) for name in names}
    logs = [{'container': name, **log_policy(data.get('logs') if data else None)}
            for name, data in snapshots.items()]
    mount = redis_mount(snapshots[redis_name], path)
    attention = (metadata['status'] != 'restricted_mode' or mount['status'] != 'read_only'
                 or not mount.get('running') or any(log['status'] != 'bounded' for log in logs))
    return {'schemaVersion': 1, 'readOnly': True, 'scope': 'selected_local_containers_only',
            'needsAttention': attention, 'redisFile': metadata, 'redisMount': mount,
            'containerLogs': logs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--redis-conf', required=True, type=Path)
    parser.add_argument('--redis-container', required=True)
    parser.add_argument('--container', action='append', required=True,
                        help='Repeat for staff-login and each actual iDrink container')
    args = parser.parse_args()
    try:
        report = audit(args.redis_conf, args.redis_container, args.container)
    except ValueError:
        print(json.dumps({'error': 'invalid_container_name', 'readOnly': True}))
        return 1
    print(json.dumps(report, indent=2))
    return 2 if report['needsAttention'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
