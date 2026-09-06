#!/usr/bin/env python3
"""Generate a NEW isolated staging installation. Never overwrite existing secrets."""
import os
import pathlib
import secrets
import sys

root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(mode=0o700, parents=True, exist_ok=True)
if any(root.iterdir()):
    raise SystemExit('Refusing to overwrite a non-empty secrets directory')
os.chmod(root, 0o700)
values = {key: secrets.token_hex(32) for key in (
    'DB_ADMIN_PASSWORD', 'DB_OWNER_PASSWORD', 'DB_APP_PASSWORD', 'REDIS_PASSWORD')}
for name, content in {
    'staging.env': ''.join(f'{k}={v}\n' for k, v in values.items()) + f'SECRETS_DIR={root}\n',
    'redis.conf': 'bind 0.0.0.0\nprotected-mode yes\nmaxmemory 64mb\nmaxmemory-policy allkeys-lru\nsave ""\nappendonly no\nrequirepass ' + values['REDIS_PASSWORD'] + '\n',
}.items():
    with os.fdopen(os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        f.write(content)
# The directory is 700; the container's redis uid needs read access to this bind mount.
os.chmod(root / 'redis.conf', 0o644)
print('New staging secrets generated; values omitted')
