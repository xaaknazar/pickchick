"""Install one operator-owned maintenance entry; preserve every unrelated cron entry."""
import argparse
import os
from pathlib import Path
import pwd
import re
import subprocess

START = '# BEGIN PICKCHICK IDENTITY CLEANUP'
END = '# END PICKCHICK IDENTITY CLEANUP'


def render_crontab(previous, sha):
    if not re.fullmatch('[a-f0-9]{40}', sha):
        raise ValueError('Expected a full release SHA')
    lines = previous.splitlines()
    if lines.count(START) != lines.count(END) or lines.count(START) > 1:
        raise ValueError('Existing maintenance block needs manual review')
    if START in lines:
        first, last = lines.index(START), lines.index(END)
        if last <= first:
            raise ValueError('Existing maintenance block is invalid')
        lines[first:last + 1] = []
    command = ('*/15 * * * * /bin/bash /opt/pickchick-staging/releases/' + sha
               + '/infra/staging/identity-cleanup-cron.sh ' + sha)
    return '\n'.join(lines + [START, command, END]) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sha')
    args = parser.parse_args()
    os.umask(0o077)
    if pwd.getpwuid(os.getuid()).pw_name != 'pickchick-ops':
        raise RuntimeError('Run only as the PickChick server operator')
    if not re.fullmatch('[a-f0-9]{40}', args.sha):
        raise ValueError('Expected a full release SHA')
    base = Path('/opt/pickchick-staging')
    release = base / 'releases' / args.sha
    if (base / 'current').resolve() != release or not (release / 'release.env').is_file():
        raise RuntimeError('Install only after the verified release is current')
    script = release / 'infra/staging/identity-cleanup-cron.sh'
    if not script.is_file():
        raise RuntimeError('Maintenance runner is missing')
    state = base / 'maintenance'
    state.mkdir(mode=0o700, exist_ok=True)
    state.chmod(0o700)
    result = subprocess.run(['crontab', '-l'], capture_output=True, text=True, timeout=10)
    if result.returncode not in (0, 1):
        raise RuntimeError('Cannot inspect existing operator crontab')
    if result.returncode == 1 and 'no crontab for' not in result.stderr.lower():
        raise RuntimeError('Cannot determine existing operator crontab')
    previous = result.stdout if result.returncode == 0 else ''
    backup = state / ('crontab.before-' + args.sha + '.txt')
    # Preserve the original on a repeated installation, including an empty crontab.
    if not backup.exists():
        with backup.open('x') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(previous)
    updated = render_crontab(previous, args.sha)
    # Refuse an observed edit between the initial read and installation.
    current = subprocess.run(['crontab', '-l'], capture_output=True, text=True, timeout=10)
    if current.returncode != result.returncode or current.stdout != result.stdout:
        raise RuntimeError('Operator crontab changed concurrently; inspect before retrying')
    subprocess.run(['crontab', '-'], input=updated, text=True, capture_output=True,
                   timeout=10, check=True)
    actual = subprocess.run(['crontab', '-l'], capture_output=True, text=True,
                            timeout=10, check=True).stdout
    if actual != updated:
        raise RuntimeError('Installed operator crontab differs from requested content')
    print('Pinned identity cleanup installed; unrelated cron entries preserved.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Maintenance installation stopped; review the private operator state.')
        raise SystemExit(1) from None
