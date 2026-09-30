#!/usr/bin/env python3
"""Tiny real Docker COPY probe; no shared containers, secrets, database or network."""
import json
from pathlib import Path
import subprocess
import tempfile
import uuid
ROOT=Path(__file__).resolve().parents[2]
IMAGE='node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203'

def main():
    context=json.loads(subprocess.run(['docker','context','inspect'],check=True,capture_output=True).stdout)
    assert context[0]['Endpoints']['docker']['Host'].startswith('unix://')
    tag='pickchick-context-probe:'+uuid.uuid4().hex
    created=False
    try:
        with tempfile.TemporaryDirectory(prefix='pickchick-context-') as name:
            path=Path(name)
            (path/'.dockerignore').write_bytes((ROOT/'.dockerignore').read_bytes())
            files={'infra/staging/provision.mjs':'included',
                'infra/windows/pos-sync-worker-grants.mjs':'included',
                'infra/windows/unrelated-operator.mjs':'excluded',
                'infra/windows/operator.env':'excluded',
                'infra/public-staging/unrelated':'excluded',
                'infra/staging/private.key':'excluded',
                '.local/private-operator.json':'excluded'}
            for file,value in files.items():
                target=path/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(value)
            (path/'Probe.Dockerfile').write_text('FROM '+IMAGE+'\nWORKDIR /probe\nCOPY . .\n')
            build=subprocess.run(['docker','build','--network=none','-q','-f',str(path/'Probe.Dockerfile'),'-t',tag,str(path)],capture_output=True)
            if build.returncode: raise RuntimeError('Docker context probe build failed')
            created=True
            program='const fs=require("node:fs");const files='+json.dumps(files)+';for(const [p,v]of Object.entries(files)){if(fs.existsSync(p)!==(v==="included"))throw new Error("Context mismatch:"+p)}'
            result=subprocess.run(['docker','run','--rm','--network=none',tag,'node','-e',program],capture_output=True)
            if result.returncode: raise RuntimeError(result.stderr.decode())
    finally:
        if created: subprocess.run(['docker','image','rm',tag],check=True,capture_output=True)
    print('Docker context includes only the required Windows grant helper; private/other paths excluded.')

if __name__=='__main__':main()
