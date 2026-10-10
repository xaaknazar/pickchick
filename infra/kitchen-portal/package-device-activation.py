#!/usr/bin/env python3
"""Build the standalone portal operator bundle from exact committed Git bytes."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

FILES = ('infra/kitchen-portal/activate-device-access.py', 'infra/kitchen-portal/update-deploy.py',
         'infra/kitchen-portal/remote-deploy.py', 'infra/roadmap/remote-deploy.py',
         'db/edge/migrations/020_terminal_access.sql', 'infra/windows/native-device-access-worker.mjs')
MANIFEST = 'device-access-operator.json'


def build(repository, source, output):
    if not re.fullmatch('[a-f0-9]{40}', source):
        raise ValueError('Full immutable source SHA required')
    actual = subprocess.check_output(['git', 'rev-parse', source + '^{commit}'], cwd=repository, text=True).strip()
    if actual != source:
        raise ValueError('Exact Git commit required')
    # git show reads the commit object, never unstaged/generated workspace contents.
    files = {name: subprocess.check_output(['git', 'show', source + ':' + name], cwd=repository) for name in FILES}
    manifest = {'format': 'pickchick-device-access-operator-v1', 'source_sha': source,
                'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    files[MANIFEST] = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise ValueError('New output path required; preserve prior artifact')
    with output.open('xb') as handle:
        output.chmod(0o600)
        with tarfile.open(fileobj=handle, mode='w:gz') as archive:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o600
                archive.addfile(info, io.BytesIO(data))
    return {'format': manifest['format'], 'source_sha': source, 'archive': str(output),
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'files': len(files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(Path(__file__).resolve().parents[2], args.sha, args.output)))


if __name__ == '__main__':
    main()
