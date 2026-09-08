"""Check the two data-only scripts in an owned temporary PostgreSQL cluster.

Requires local PostgreSQL initdb/pg_ctl/psql; opens only a private Unix socket.
Does not read .env, connect to an existing database, or contact the VPS.
"""
import getpass
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
CONTENT = ROOT / 'infra/staging/content'
BRANCH = '10000000-0000-4000-8000-000000000003'
BEFORE = 'Тестовая точка — не ресторан'
AFTER = 'ТЦ Abay Plaza'
FORWARD = CONTENT / '2026-09-08-abay-plaza.sql'
ROLLBACK = CONTENT / '2026-09-08-abay-plaza-rollback.sql'
SETUP = f"""
INSERT INTO organizations(id,name) VALUES
  ('10000000-0000-4000-8000-000000000001','Synthetic content rehearsal');
INSERT INTO legal_entities(id,organization_id,name,bin) VALUES
  ('10000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001','Synthetic entity','000000000000');
INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES
  ('{BRANCH}','10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002','TEST-ALMATY-01','{BEFORE}');
"""


def main():
    executable = shutil.which('pg_ctl')
    if not executable:
        raise SystemExit('PostgreSQL pg_ctl is required; no database was contacted')
    pg_bin = Path(executable).resolve().parent
    for binary in ['initdb', 'pg_ctl', 'psql', 'postgres']:
        if not (pg_bin / binary).is_file():
            raise SystemExit(f'PostgreSQL tool is missing: {binary}')
    # Ignore any inherited PostgreSQL endpoint, credentials, service or options.
    env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    work = Path(tempfile.mkdtemp(prefix='pickchick-abay-', dir='/tmp'))
    safe_to_delete = True
    try:
        data, sock = work / 'data', work / 'socket'
        sock.mkdir(mode=0o700)
        subprocess.run([str(pg_bin / 'initdb'), '-D', str(data), '--auth-local=trust',
                        '--auth-host=reject', '--encoding=UTF8', '--no-locale'],
                       check=True, env=env, capture_output=True, text=True)
        checks = []
        safe_to_delete = False
        subprocess.run([str(pg_bin / 'pg_ctl'), '-D', str(data), '-l', str(work / 'pg.log'),
                        '-o', f"-k {sock} -h '' -p 65432", '-w', '-t', '15', 'start'],
                       check=True, env=env, capture_output=True, text=True)
        command = [str(pg_bin / 'psql'), '-X', '-q', '-A', '-t',
                   '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
                   '-h', str(sock), '-p', '65432', '-U', getpass.getuser(), '-d', 'postgres']

        def sql(body, success=True):
            result = subprocess.run(command, input=body, env=env, text=True,
                                    capture_output=True, timeout=25)
            if success:
                if result.returncode:
                    raise AssertionError(result.stderr)
            else:
                assert result.returncode != 0, 'Unexpectedly accepted an unsafe branch scope'
                assert '23514' in result.stderr and 'Abay Plaza' in result.stderr, result.stderr
            return result.stdout.strip()

        def reset():
            sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
            sql((ROOT / 'db/cloud/migrations/001_cloud_foundation.sql').read_text())
            sql(SETUP)

        def snapshot():
            tables = sql("SELECT tablename FROM pg_tables WHERE schemaname='public' "
                         'ORDER BY tablename').splitlines()
            return {table: json.loads(sql(
                "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') "
                f'FROM public."{table}" t')) for table in tables}

        reset()
        for script, name, label in [(FORWARD, AFTER, 'forward'),
                                    (ROLLBACK, BEFORE, 'rollback')]:
            baseline = snapshot()
            sql(script.read_text())
            expected = json.loads(json.dumps(baseline))
            expected['branches'][0]['name'] = name
            assert snapshot() == expected, f'{label} changed fields or entities beyond name'
            checks.append(f'{label}: only name changes')
            xmin = sql('SELECT xmin::text FROM public.branches')
            sql(script.read_text())
            assert snapshot() == expected, f'{label} repeat changed data'
            assert sql('SELECT xmin::text FROM public.branches') == xmin
            checks.append(f'{label}: repeat performs no write')

        invalid_scopes = {
            'zero branches': 'DELETE FROM branches',
            'two branches': "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) "
                            "SELECT '20000000-0000-4000-8000-000000000003',organization_id,"
                            "legal_entity_id,'OTHER','Other synthetic' FROM branches",
            'wrong id': "UPDATE branches SET id='20000000-0000-4000-8000-000000000003'",
            'wrong code': "UPDATE branches SET code='OTHER'",
            'ordering enabled': 'UPDATE branches SET ordering_enabled=true',
            'later operator rename': "UPDATE branches SET name='Later operator name'",
        }
        for script in [FORWARD, ROLLBACK]:
            for label, mutation in invalid_scopes.items():
                reset()
                if script == ROLLBACK:
                    sql(FORWARD.read_text())
                sql(mutation)
                baseline = snapshot()
                sql(script.read_text(), success=False)
                assert snapshot() == baseline, f'{script.name}: {label} did not roll back'
                checks.append(f'{script.name}: rejects {label} without changes')
        print(json.dumps({'result': 'PASS', 'checks': len(checks), 'scenarios': checks,
                          'postgres': sql('SHOW server_version'),
                          'transport': 'owned private Unix socket; no TCP'}, ensure_ascii=False))
    finally:
        if not safe_to_delete:
            subprocess.run([str(pg_bin / 'pg_ctl'), '-D', str(data), '-m', 'fast',
                            '-w', '-t', '15', 'stop'], env=env,
                           capture_output=True, text=True)
            status = subprocess.run([str(pg_bin / 'pg_ctl'), '-D', str(data), 'status'],
                                    env=env, capture_output=True, text=True)
            safe_to_delete = status.returncode == 3
        if safe_to_delete:
            shutil.rmtree(work)
        else:
            raise RuntimeError(f'PostgreSQL shutdown is unconfirmed; retained owned directory {work}')


if __name__ == '__main__':
    main()
