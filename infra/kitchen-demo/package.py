#!/usr/bin/env python3
"""Build and package static kitchen demo from a clean committed checkout."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
repo = Path(__file__).resolve().parents[2]
out = Path(sys.argv[1]).resolve()
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo), 'Commit source first'
subprocess.run(['node', 'apps/kitchen/build.mjs'], cwd=repo, check=True)
subprocess.run(['node', 'apps/kitchen/build-demo.mjs'], cwd=repo, check=True)
files = [p for p in (repo / 'apps/kitchen/demo-dist').rglob('*') if p.is_file()]
files += [repo / 'infra/kitchen-demo/remote-deploy.py', repo / 'infra/roadmap/remote-deploy.py']
manifest = {'source_sha': sha, 'files': {}}
with tempfile.TemporaryDirectory() as directory:
    stage = Path(directory)
    for f in files:
        assert not f.is_symlink()
        name = f.relative_to(repo).as_posix()
        assert f.suffix in ('.js', '.html', '.css', '.woff2', '.png', '.py')
        if name.startswith('infra/'):
            assert subprocess.check_output(['git', 'show', sha + ':' + name], cwd=repo) == f.read_bytes()
        manifest['files'][name] = hashlib.sha256(f.read_bytes()).hexdigest()
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(f.read_bytes())
    (stage / 'demo-package.json').write_text(json.dumps(manifest, indent=2))
    with tarfile.open(out, 'x:gz') as archive:
        for f in stage.rglob('*'):
            if f.is_file(): archive.add(f, arcname=f.relative_to(stage), recursive=False)
print(json.dumps({'source_sha': sha, 'sha256': hashlib.sha256(out.read_bytes()).hexdigest(), 'files': len(files)}))
