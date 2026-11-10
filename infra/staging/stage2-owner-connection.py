"""Resolve the existing owner connection without requiring a provision service.

Pure validation plus protected-file reading only. No database connection,
container creation, migrations or printing occurs on import or invocation.
The returned credential must be passed in process environment, never argv/logs.
"""
from pathlib import Path
import re
from urllib.parse import urlsplit


class OwnerConnectionError(RuntimeError):
    """Only a stable check name, never the rejected value."""


def require(ok, name):
    if not ok:
        raise OwnerConnectionError(name)


def owner_environment(api_database_url, protected_settings):
    try:
        url = urlsplit(api_database_url)
        valid = (url.scheme in ('postgresql', 'postgres') and
                 url.username == 'pickchick_app' and url.hostname == 'cloud-db' and
                 url.port == 5432 and url.path == '/pickchick_cloud' and
                 not url.query and not url.fragment)
    except (ValueError, TypeError):
        valid = False
    require(valid, 'owner.api_database_contract')
    require(isinstance(protected_settings, str), 'owner.settings_type')
    values = [line.split('=', 1)[1] for line in protected_settings.splitlines()
              if line.startswith('DB_OWNER_PASSWORD=')]
    require(len(values) == 1, 'owner.credential_unique')
    require(re.fullmatch('[a-f0-9]{64}', values[0]) is not None,
            'owner.credential_format')
    return {'CLOUD_DATABASE_URL':
            'postgresql://pickchick_owner:' + values[0] +
            '@127.0.0.1:5432/pickchick_cloud'}


def read_owner_environment(api_database_url, settings_path):
    path = Path(settings_path)
    require(path.is_file() and not path.is_symlink(), 'owner.protected_file')
    require(path.stat().st_mode & 0o077 == 0, 'owner.file_permissions')
    try:
        settings = path.read_text()
    except (OSError, UnicodeError):
        raise OwnerConnectionError('owner.file_read') from None
    return owner_environment(api_database_url, settings)
