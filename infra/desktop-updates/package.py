#!/usr/bin/env python3
"""Package the reviewed feed scripts of a clean committed checkout: package.py <out.tar.gz>."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

FILES = ['infra/desktop-updates/remote-deploy.py', 'infra/desktop-updates/compose.yaml',
         'infra/desktop-updates/sidecar.Caddyfile', 'infra/roadmap/remote-deploy.py']


def main(out):
    repo = Path(__file__).resolve().parents[2]
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo), 'Commit source first'
    manifest = {'source_sha': sha, 'files': {}}
    with tempfile.TemporaryDirectory() as directory:
        stage = Path(directory)
        for name in FILES:
            data = (repo / name).read_bytes()
            assert not (repo / name).is_symlink()
            assert subprocess.check_output(['git', 'show', sha + ':' + name], cwd=repo) == data
            manifest['files'][name] = hashlib.sha256(data).hexdigest()
            (stage / name).parent.mkdir(parents=True, exist_ok=True)
            (stage / name).write_bytes(data)
        (stage / 'desktop-updates-package.json').write_text(json.dumps(manifest, indent=2) + '\n')
        with tarfile.open(out, 'x:gz') as archive:
            for path in sorted(stage.rglob('*')):
                if path.is_file():
                    archive.add(path, arcname=path.relative_to(stage), recursive=False)
    print(json.dumps({'source_sha': sha, 'sha256': hashlib.sha256(out.read_bytes()).hexdigest(),
                      'files': len(FILES)}))


if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve())
