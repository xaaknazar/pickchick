"""Generate a per-user LaunchAgent for a reviewed immutable photo release."""
import os
from pathlib import Path
import plistlib
import sys

LABEL = 'kz.pickchick.photo-printer'


def definition(supervisor, config, logs):
    paths = [str(Path(p).resolve()) for p in [supervisor, config, logs]]
    return {
        'Label': LABEL,
        'ProgramArguments': ['/usr/bin/python3', '-u', paths[0], paths[1]],
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 10,
        'ExitTimeOut': 35,
        'ProcessType': 'Background',
        'WorkingDirectory': str(Path(paths[1]).parent),
        'StandardOutPath': str(Path(paths[2]) / 'supervisor.log'),
        'StandardErrorPath': str(Path(paths[2]) / 'supervisor-error.log'),
        'EnvironmentVariables': {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'PYTHONDONTWRITEBYTECODE': '1'},
    }


def main():
    if sys.platform != 'darwin' or len(sys.argv) != 4:
        raise SystemExit('Usage on macOS: launch_agent.py SUPERVISOR CONFIG LOG_DIRECTORY')
    os.umask(0o077)
    supervisor, config, logs = map(Path, sys.argv[1:])
    if not supervisor.is_file() or not config.is_file():
        raise SystemExit('Prepare the immutable release and private config first')
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    target.parent.mkdir(parents=True, exist_ok=True)
    expected = plistlib.dumps(definition(supervisor, config, logs))
    if target.exists():
        if target.read_bytes() != expected:
            raise SystemExit('Existing agent differs; review and unload it before replacement')
    else:
        with target.open('xb') as f:
            f.write(expected)
        target.chmod(0o600)
    print('LaunchAgent prepared. Bootstrap separately after source/CI and hardware checks.')


if __name__ == '__main__':
    main()
