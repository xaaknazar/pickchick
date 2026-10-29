#!/usr/bin/env python3
"""Prepare a local review verifier with hidden owner input; never prints the code or hash."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import sys


def prepare(path, code, confirmation):
    if not re.fullmatch(r"[A-Za-z0-9-]{12,64}", code):
        raise ValueError("Use 12-64 letters, digits or hyphens; choose a unique review-only code.")
    if code != confirmation:
        raise ValueError("Codes do not match.")
    # Refuse any tracked/untracked repository location, including worktrees.
    path = Path(path).expanduser().resolve()
    if any((parent / '.git').exists() for parent in [path.parent, *path.parents]):
        raise ValueError("Choose a private location outside repositories.")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(path, 'x', opener=lambda name, flags: os.open(name, flags, 0o600)) as handle:
        json.dump({"purpose": "pickchick-kiosk-review-v1", "sha256": hashlib.sha256(code.encode()).hexdigest()}, handle)
        handle.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty():
        raise ValueError('Owner must enter the code in a local interactive terminal.')
    prepare(args.output, getpass.getpass('New Apple kiosk review code (hidden): '),
            getpass.getpass('Repeat code (hidden): '))
    print('Private verifier saved. Keep the code privately for Apple Review Notes. No upload performed.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
