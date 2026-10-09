#!/usr/bin/env python3
"""Build a private deployment archive from the exact clean published HEAD."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--sha',required=True);p.add_argument('--output',type=Path,required=True)
a=p.parse_args();root=Path(__file__).resolve().parents[2]
def git(*args):return subprocess.check_output(['git',*args],cwd=root,text=True).strip()
assert git('rev-parse','HEAD')==a.sha
assert not git('status','--porcelain')
branch=git('branch','--show-current')
assert git('rev-parse','origin/'+branch)==a.sha
assert not a.output.exists()
assert subprocess.check_output(['node','--version'],text=True).strip()=='v'+(root/'.node-version').read_text().strip()
assert subprocess.check_output(['corepack','pnpm','--version'],cwd=root,text=True).strip()==json.loads((root/'package.json').read_text())['packageManager'].split('@')[1]
subprocess.run(['corepack','pnpm','--filter','@pickchick/backoffice','build'],cwd=root,check=True)
archive=subprocess.check_output(['git','archive',a.sha,'apps/backoffice','infra/backoffice-login','infra/domains'],cwd=root)
with tempfile.TemporaryDirectory(prefix='pickchick-ceo-') as tmp:
    stage=Path(tmp)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:tar.extractall(stage,filter='data')
    shutil.copytree(root/'apps/backoffice/dist',stage/'apps/backoffice/dist')
    files={str(f.relative_to(stage)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(stage.rglob('*')) if f.is_file()}
    (stage/'portal-manifest.json').write_text(json.dumps({'source_sha':a.sha,'files':files},indent=2)+'\n')
    with a.output.open('xb') as out:
        with tarfile.open(fileobj=out,mode='w:gz') as tar:
            for f in sorted(stage.iterdir()):tar.add(f,arcname=f.name)
a.output.chmod(0o600)
print(json.dumps({'source_sha':a.sha,'artifact_sha256':hashlib.sha256(a.output.read_bytes()).hexdigest()}))
