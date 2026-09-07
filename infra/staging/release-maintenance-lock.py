#!/usr/bin/env python3
"""Cooperate with the existing cleanup flock; never install a timer or expire a lock.

The detached holder is intentionally persistent after SSH disconnect. Only the same
owner UUID can request release. JSON status contains process metadata, not credentials.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def write_once(path, value):
    temporary = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    with open(temporary, 'x', encoding='utf8') as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(value, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    os.link(temporary, path)  # Atomic publication, fails if destination already exists.
    temporary.unlink()


def validate(directory, lock, owner):
    assert str(uuid.UUID(owner)) == owner
    assert directory.is_absolute() and lock.is_absolute()
    assert directory.is_dir() and not directory.is_symlink()
    assert directory.stat().st_mode & 0o077 == 0
    assert all(not p.is_symlink() for p in [directory, lock, *directory.parents, *lock.parents])
    assert lock.name == 'identity-cleanup.lock'
    assert json.loads((directory / 'owner.json').read_text())['id'] == owner


def process_start(pid):
    # Linux /proc starttime prevents PID reuse. The macOS fallback is for local flock tests only.
    path = Path(f'/proc/{pid}/stat')
    if Path('/proc').is_dir():
        return path.read_text().rsplit(')', 1)[1].split()[19]
    return None


def status(directory, lock, owner):
    validate(directory, lock, owner)
    held = json.loads((directory / 'held.json').read_text())
    assert held['owner'] == owner and held['pid'] > 1
    assert not (directory / 'release.json').exists()
    os.kill(held['pid'], 0)
    assert held['process_start'] == process_start(held['pid'])
    fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
    try:
        stat = os.fstat(fd)
        assert [stat.st_dev, stat.st_ino] == held['inode']
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return held
        fcntl.flock(fd, fcntl.LOCK_UN)
        raise AssertionError('Cleanup lock holder is absent')
    finally:
        os.close(fd)


def hold(directory, lock, owner):
    validate(directory, lock, owner)
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stat = os.fstat(fd)
        held = {'owner': owner, 'pid': os.getpid(), 'process_start': process_start(os.getpid()),
                'inode': [stat.st_dev, stat.st_ino]}
        write_once(directory / 'held.json', held)
        while not (directory / 'release.json').exists():
            time.sleep(0.2)
        assert json.loads((directory / 'release.json').read_text()) == {'owner': owner}
        fcntl.flock(fd, fcntl.LOCK_UN)
        write_once(directory / 'released.json', {'owner': owner, 'released': True})
    finally:
        os.close(fd)


def acquire(directory, lock, owner):
    validate(directory, lock, owner)
    assert not any((directory / name).exists() for name in ['held.json', 'holder.log', 'release.json', 'released.json'])
    with open(directory / 'holder.log', 'xb') as log:
        os.fchmod(log.fileno(), 0o600)
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'hold', str(directory),
                                  str(lock), owner], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 close_fds=True, start_new_session=True)
    for _ in range(100):
        if (directory / 'held.json').exists():
            return status(directory, lock, owner)
        if child.poll() is not None:
            raise AssertionError('Existing cleanup is active or holder could not start')
        time.sleep(0.05)
    # Detached command may still acquire. Caller must retain its deployment lock and inspect.
    raise TimeoutError('Cleanup holder completion is unknown')


def release(directory, lock, owner):
    validate(directory, lock, owner)
    if not (directory / 'release.json').exists():
        status(directory, lock, owner)
        write_once(directory / 'release.json', {'owner': owner})
    assert json.loads((directory / 'release.json').read_text()) == {'owner': owner}
    for _ in range(100):
        path = directory / 'released.json'
        if path.exists():
            value = json.loads(path.read_text())
            assert value == {'owner': owner, 'released': True}
            return value
        time.sleep(0.05)
    raise TimeoutError('Cleanup release completion is unknown')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['acquire', 'hold', 'status', 'release'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('lock', type=Path)
    parser.add_argument('owner')
    args = parser.parse_args()
    os.umask(0o077)
    value = globals()[args.action](args.directory, args.lock, args.owner)
    if value is not None:
        print(json.dumps(value, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except TimeoutError:
        print('Owned cleanup coordination outcome is unknown; inspect private state.', file=sys.stderr)
        raise SystemExit(125) from None
    except Exception:
        print('Cleanup coordination guard stopped; no lock was stolen.', file=sys.stderr)
        raise SystemExit(1) from None
