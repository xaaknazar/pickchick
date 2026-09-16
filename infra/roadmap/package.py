#!/usr/bin/env python3
"""Package a committed, locally checked roadmap without credentials or repository data."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    if not re.fullmatch('[a-f0-9]{40}', args.source_sha):
        parser.error('A full committed SHA is required')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    if head != args.source_sha:
        parser.error('Source SHA must match this checkout HEAD')
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=repo):
        parser.error('Commit tracked changes before packaging')
    if args.output.exists():
        parser.error('Output must not already exist')
    files = [repo / 'apps/roadmap/server.mjs', repo / 'apps/roadmap/model.mjs']
    dist = repo / 'apps/roadmap/dist'
    for name in ['index.html', 'styles.css', 'app.js', 'project.json']:
        if not (dist / name).is_file():
            parser.error('Build apps/roadmap/dist before packaging')
    files += list(dist.rglob('*'))
    files += [p for p in (repo / 'infra/roadmap').iterdir() if p.suffix in ('.py', '.yaml', '.md')]
    manifest = {'source_sha': head, 'files': {}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pickchick-roadmap-') as temporary:
        staged = Path(temporary)
        for path in sorted(files):
            if path.is_symlink():
                parser.error('Package inputs must not be symlinks')
            if path.is_dir():
                continue
            if not path.is_file():
                parser.error('Missing application input: ' + str(path.relative_to(repo)))
            relative = path.relative_to(repo)
            data = path.read_bytes()
            if not str(relative).startswith('apps/roadmap/dist/'):
                committed = subprocess.run(['git', 'show', head + ':' + str(relative)],
                                           cwd=repo, capture_output=True)
                if committed.returncode != 0 or committed.stdout != data:
                    parser.error('Source file is not committed at HEAD: ' + str(relative))
            if str(relative).startswith('apps/roadmap/dist/') and path.suffix not in (
                '.html', '.css', '.js', '.json', '.svg', '.png', '.webp', '.woff2', '.jpg', '.jpeg'
            ):
                parser.error('Unsupported public asset: ' + str(relative))
            target = staged / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
            manifest['files'][str(relative)] = hashlib.sha256(data).hexdigest()
        (staged / 'roadmap-package.json').write_text(json.dumps(manifest, indent=2) + '\n')
        with tarfile.open(args.output, 'x:gz') as archive:
            for path in sorted(staged.rglob('*')):
                if path.is_file():
                    archive.add(path, arcname=str(path.relative_to(staged)), recursive=False)
    print(json.dumps({'source_sha': head, 'package': str(args.output.resolve()),
                      'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(),
                      'files': len(manifest['files'])}))


if __name__ == '__main__':
    main()
