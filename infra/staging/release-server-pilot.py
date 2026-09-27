#!/usr/bin/env python3
"""Guarded 020 -> 025 pilot: identity opt-in, immutable secrets, preserved kitchen overlays."""
import argparse
import importlib.util
import ipaddress
import json
from pathlib import Path
import re
import sys

spec = importlib.util.spec_from_file_location('pilot_daily', Path(__file__).with_name('release-daily-numbers.py'))
daily = importlib.util.module_from_spec(spec); sys.modules[spec.name] = daily; spec.loader.exec_module(daily)
market, REMOTE = daily.market, daily.REMOTE
require, quote, digest = market.require, market.quote, market.digest
BASELINE = '4ee0b801a8ceefa5aad339bdeecc1d4974f40538'
MIGRATIONS = ('021_cloud_test_service_shifts.sql', '022_cloud_otp_channels.sql',
              '023_cloud_otp_delivery_consent.sql', '024_cloud_customer_pilot_orders.sql', '025_cloud_combo_stamps.sql')
NEW_TABLES = {'test_service_shifts', 'identity_customer_test_actors', 'test_combo_stamps'}
ADDITIONS = {'test_order_numbers': ['shift_id'], 'identity_otp_challenges':
             ['delivery_channel','delivery_provider','delivery_reference','delivery_consent_version']}
AUTH_FILE = REMOTE+'/secrets/customer-auth.env'
VERSION = 'pilot-2026-09-26'


def auth_environment(raw):
    env = dict(line.split('=',1) for line in raw.splitlines() if line and not line.startswith('#'))
    required = {'CUSTOMER_AUTH_ENABLED':'true','CUSTOMER_AUTH_DAILY_SMS_BUDGET':'1000',
                'CUSTOMER_AUTH_CONSENT_VERSION':VERSION,'PHONE_DELIVERY_PROVIDER':'telegram_gateway',
                'PHONE_SMS_FALLBACK_ENABLED':'false'}
    for name in ['TERMS','PRIVACY']:
        required['CUSTOMER_AUTH_'+name+'_URL'] = 'https://'+market.HOST+'/legal/'+name.lower()
    require(all(env.get(k)==v for k,v in required.items()),'Pilot settings differ from owner decision')
    keys = [env.get('CUSTOMER_AUTH_'+k+'_KEY','') for k in ['LOOKUP','OTP','PII','RECEIPT']]
    require(len(set(keys))==4 and all(re.fullmatch('[a-f0-9]{64}',k) and len(set(bytes.fromhex(k)))>=16 for k in keys),'Independent identity keys required')
    require(re.fullmatch('[A-Za-z0-9_.:-]{16,4096}',env.get('TELEGRAM_GATEWAY_TOKEN','')),'Telegram secret missing')
    require(set(env)==set(required)|{'CUSTOMER_AUTH_'+k+'_KEY' for k in ['LOOKUP','OTP','PII','RECEIPT']}|{'TELEGRAM_GATEWAY_TOKEN'},'Unexpected secret-file field')
    return env


def extend_gateway(text, outer_ip):
    ipaddress.ip_address(outer_ip)
    require('@pilot_auth' not in text and text.count('\tservers {')==1 and text.count('\t@health {')==1,'Gateway baseline differs')
    text = text.replace('\tservers {','\tservers {\n\t\ttrusted_proxies static '+outer_ip+'\n\t\ttrusted_proxies_strict',1)
    # No real customer response may inherit the old synthetic-data assertion.
    text = text.replace('not path /v1/content/*','not path /v1/auth/* /v1/customers/* /legal/* /v1/content/*',1)
    block = '''
\t@pilot_combo_progress {
\t\tmethod GET
\t\tpath /v1/test/combo-progress
\t}
\thandle @pilot_combo_progress {
\t\theader Access-Control-Allow-Origin *
\t\treverse_proxy pickchick-staging-api-1:3100 {
\t\t\theader_up -Cookie
\t\t\theader_up -X-Device-Id
\t\t\ttransport http {
\t\t\t\tdial_timeout 2s
\t\t\t\tresponse_header_timeout 7s
\t\t\t}
\t\t}
\t}
\t@pilot_auth_preflight {
\t\tmethod OPTIONS
\t\tpath /v1/test/combo-progress /v1/auth/config /v1/auth/otp/request /v1/auth/otp/verify /v1/auth/refresh /v1/auth/logout /v1/customers/me
\t}
\thandle @pilot_auth_preflight {
\t\theader Access-Control-Allow-Origin *
\t\theader Access-Control-Allow-Methods GET,POST,PATCH,DELETE
\t\theader Access-Control-Allow-Headers Authorization,Content-Type
\t\trespond "" 204
\t}
\t@pilot_auth {
\t\texpression `(method('GET') && path('/v1/auth/config', '/v1/customers/me')) || (method('POST') && path('/v1/auth/otp/request', '/v1/auth/otp/verify', '/v1/auth/refresh', '/v1/auth/logout')) || ((method('PATCH') || method('DELETE')) && path('/v1/customers/me'))`
\t}
\thandle @pilot_auth {
\t\theader X-PickChick-Data customer
\t\theader Access-Control-Allow-Origin *
\t\treverse_proxy pickchick-staging-api-1:3100 {
\t\t\theader_up -Cookie
\t\t\theader_up -X-Device-Id
\t\t\theader_up X-Forwarded-For {client_ip}
\t\t\ttransport http {
\t\t\t\tdial_timeout 2s
\t\t\t\tresponse_header_timeout 7s
\t\t\t}
\t\t}
\t}
\t@pilot_legal {
\t\tmethod GET HEAD
\t\tpath /legal/terms /legal/privacy
\t}
\thandle @pilot_legal {
\t\theader X-PickChick-Data public
\t\theader Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
\t\theader Referrer-Policy no-referrer
\t\theader Content-Type "text/html; charset=utf-8"
\t\trewrite * {path}.html
\t\troot * /srv/public
\t\tfile_server
\t}
'''
    return text.replace('\t@health {',block+'\n\t@health {',1)


def verify_acl(before, after):
    require(all(row in after for row in before),'Existing runtime privilege removed')
    expected = {'test_service_shifts':{'SELECT'},
                'test_service_shifts_sequence_seq':{'USAGE'},
                'identity_customers':{'SELECT','INSERT','UPDATE'},
                'identity_sessions':{'SELECT','INSERT','UPDATE','DELETE'},
                'identity_refresh_receipts':{'SELECT','INSERT','UPDATE','DELETE'},
                'identity_otp_challenges':{'SELECT','INSERT','UPDATE','DELETE'},
                'identity_sms_daily_budget':{'SELECT','INSERT','UPDATE','DELETE'},
                'identity_consents':{'SELECT','INSERT','DELETE'},
                'identity_otp_request_tombstones':{'SELECT','INSERT'},
                'identity_deletions':{'SELECT','INSERT'},
                'identity_customer_test_actors':{'SELECT','INSERT'},
                'test_combo_stamps':{'SELECT','INSERT'}}
    allowed = {(name,p) for name,ps in expected.items() for p in ps}|{('bo_records','INSERT')}
    for row in after:
        if row not in before:
            column_grant = row['name']=='test_service_shifts' and (row['column'],row['privilege']) in {('branch_id','INSERT'),('state','INSERT'),('state','UPDATE'),('version','UPDATE'),('closed_at','UPDATE')}
            require(not row['grantable'] and (column_grant or ((row['name'],row['privilege']) in allowed and row['column'] is None)),'Unexpected runtime privilege delta')
    for name, privileges in expected.items():
        require({r['privilege'] for r in after if r['name']==name and r['column'] is None}==privileges,'Missing or excessive pilot privilege')
    require({(r['column'],r['privilege']) for r in after if r['name']=='test_service_shifts' and r['column'] is not None} == {('branch_id','INSERT'),('state','INSERT'),('state','UPDATE'),('version','UPDATE'),('closed_at','UPDATE')},'Missing shift column privilege')
    require(any(r['name']=='bo_records' and r['privilege']=='INSERT' for r in after),'Feedback insert unavailable')


class Release(daily.Release):
    def __init__(self,args):
        require(args.expected_api_sha==BASELINE,'Unexpected schema020 baseline')
        profile=market.ReleaseProfile('customer-pilot-020-025',BASELINE,args.expected_public_sha,20,MIGRATIONS,
            market.TRANSPORT_PROFILE.ci_jobs,frozenset({'test_service_shifts_sequence_seq'}),'server-pilot-release',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    def runtime_old(self):
        market.Release.runtime_old(self)
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0]==self.args.expected_gateway_sha256,'Mounted gateway differs')
        require([r['version'] for r in self.ledger()]==self.baseline_migrations(),'Schema020 baseline differs')
        self.kitchen_before=self.http_json('/kitchen-live/health')
        self.outer_ip=self.remote('docker inspect --format '+quote('{{(index .NetworkSettings.Networks "deploy_default").IPAddress}}')+' deploy-caddy-1')
        self.gateway_ip=self.remote('docker inspect --format '+quote('{{(index .NetworkSettings.Networks "pickchick-staging_ingress").IPAddress}}')+' '+market.GATEWAY)
        ipaddress.ip_address(self.outer_ip); ipaddress.ip_address(self.gateway_ip)

    def prepare_api(self, target):
        path=self.args.auth_env
        require(path.is_file() and not path.is_symlink() and path.stat().st_mode&0o077==0,'Protected local auth file required')
        raw=path.read_text(); auth_environment(raw)
        program='''from pathlib import Path
import sys,os
p=Path(sys.argv[1]);raw=sys.stdin.buffer.read()
if p.exists():
 assert p.is_file() and not p.is_symlink() and p.stat().st_mode&0o077==0 and p.read_bytes()==raw
else:
 with open(p,'xb') as f: os.fchmod(f.fileno(),0o600);f.write(raw)
'''
        self.remote('python3 -c '+quote(program)+' '+quote(AUTH_FILE),input=raw)
        # Canonical compose keeps opt-in and protected env_file on every later restart.
        source=(market.REPO/'infra/staging/compose.yaml').read_text()
        require(source.count('  api:\n')==1 and source.count('  provision:\n')==1,'Compose source differs')
        source=source.replace('  api:\n','  api:\n    env_file: ['+AUTH_FILE+']\n',1)
        source=source.replace('      APP_ENV: staging','      CUSTOMER_AUTH_ENABLED: "true"\n      APP_ENV: staging')
        source=source.replace("      API_PORT: '3100'", "      API_PORT: '3100'\n      TRUSTED_PROXY_IPS: '"+self.gateway_ip+"'")
        self.remote('python3 -c '+quote('from pathlib import Path;import sys;Path(sys.argv[1]).write_text(sys.stdin.read())')+' '+quote(target+'/infra/staging/compose.yaml'),input=source)

    def gateway_candidate(self, text): return extend_gateway(text,self.outer_ip)

    def prepare_public(self, target, manifest):
        assets={}
        for name in ['terms','privacy']:
            p=self.args.legal_dir/(name+'.html')
            require(p.is_file() and not p.is_symlink(),'Published legal artifact missing')
            body=p.read_text()
            require(500<len(body)<200000 and VERSION in body and '{{' not in body and '[До публикации' not in body,'Legal artifact unfinished')
            assets['legal/'+name+'.html']=body
        program='''from pathlib import Path
import json,sys,hashlib
root=Path(sys.argv[1]);data=json.load(sys.stdin)
for name,body in data.items():
 p=root/'public-web'/name;p.parent.mkdir(exist_ok=True,mode=0o755);p.write_text(body);p.chmod(0o644)
p=root/'public-web/.release.json';m=json.loads(p.read_text())
for name,body in data.items(): m['files'][name]=hashlib.sha256(body.encode()).hexdigest()
p.write_text(json.dumps(m,indent=2)+'\\n');print(json.dumps(m))
'''
        manifest=json.loads(self.remote('python3 -c '+quote(program)+' '+quote(target),input=json.dumps(assets)))
        compose=json.loads(self.remote('cat '+quote(target+'/compose.yaml')))
        networks=compose['services']['gateway']['networks']
        require(isinstance(networks,dict),'Resolved gateway networks missing')
        key=next(k for k,v in compose['networks'].items() if v.get('name')=='pickchick-staging_ingress')
        networks[key]={**(networks[key] or {}),'ipv4_address':self.gateway_ip}
        self.remote('python3 -c '+quote('from pathlib import Path;import sys;Path(sys.argv[1]).write_text(sys.stdin.read())')+' '+quote(target+'/compose.yaml'),input=json.dumps(compose))
        return manifest

    def prepared_artifacts(self, manifest):
        result=market.Release.prepared_artifacts(self,manifest)
        result['auth_file']=self.file_hashes([AUTH_FILE])
        result['proxy_ips']={'outer':self.outer_ip,'gateway':self.gateway_ip}
        return result

    def snapshot(self,database=market.DB):
        # Compare every pre-existing column, while new nullable/backfilled fields are checked separately.
        tables=json.loads(self.psql(database,"SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'"))
        parts=[]
        for table in tables:
            require(re.fullmatch('[a-z][a-z0-9_]*',table),'Unexpected table')
            expression='to_jsonb(t)'+''.join("-'"+key+"'" for key in ADDITIONS.get(table,[]))
            parts.append("SELECT '"+table+"' AS name,count(*) AS rows,encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex') AS sha256 FROM (SELECT encode(sha256(convert_to(("+expression+")::text,'UTF8')),'hex') h FROM public.\""+table+'\" t) hashes')
        return json.loads(self.psql(database,"SELECT json_build_object('tables',(SELECT json_object_agg(name,json_build_object('rows',rows,'sha256',sha256)) FROM ("+' UNION ALL '.join(parts)+") h),'sequences',(SELECT coalesce(json_agg(row_to_json(s) ORDER BY sequencename),'[]') FROM (SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences WHERE schemaname='public') s))"))

    def verify_data(self,before):
        expected=before['ledger']+[{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in MIGRATIONS]
        require(self.ledger()==expected,'Unexpected migration delta')
        after=self.snapshot()
        require(set(after['tables'])-set(before['data']['tables'])==NEW_TABLES,'Unexpected table delta')
        preserved={'tables':{k:v for k,v in after['tables'].items() if k not in NEW_TABLES},
                   'sequences':[s for s in after['sequences'] if s['sequencename'] not in self.profile.new_sequences]}
        preserved['tables']['schema_migrations']=before['data']['tables']['schema_migrations']
        market.compare_existing(before['data'],preserved)
        verify_acl(before['acl'],self.acl())
        require(self.psql(market.DB,"SELECT count(*) FROM test_combo_stamps")=='0','Historical practice stamps adopted')
        require(self.psql(market.DB,"SELECT count(*) FROM identity_customer_test_actors")=='0','Anonymous customer ownership adopted')
        require(self.psql(market.DB,"SELECT count(*) FROM identity_otp_challenges WHERE delivery_channel<>'sms' OR delivery_provider IS NOT NULL OR delivery_reference IS NOT NULL OR delivery_consent_version IS NOT NULL")=='0','Historical OTP consent or channel fabricated')
        require(self.psql(market.DB,"SELECT count(*) FROM test_order_numbers n JOIN test_service_shifts s ON s.id=n.shift_id WHERE s.state<>'closed' OR s.branch_id<>n.branch_id OR (s.opened_at AT TIME ZONE (SELECT timezone FROM branches WHERE id=n.branch_id))::date<>n.business_date OR n.number>s.last_number")=='0','Historical shift numbering changed')

    def verify_capabilities(self,caps):
        require(caps['data_mode']=='pilot' and caps['features']['phone_auth'] is True and caps['features'].get('unpaid_test_orders') is True and caps['ordering_enabled'] is False,'Wrong pilot capabilities')
        require(all(caps['features'][k] is False for k in ['checkout','payments','fiscal','loyalty']),'Commercial feature enabled')

    def verify_public(self):
        require(self.http('/v1/test/combo-progress')[0]==401,'Anonymous combo progress allowed')
        auth=self.http_json('/v1/auth/config')
        require(auth['enabled'] is True and auth['consent_version']==VERSION,'Public identity unavailable')
        require(auth['channels']==['telegram'] and auth['delivery_consent_required'] is True,'Wrong delivery configuration')
        require(self.http('/v1/customers/me')[0]==401,'Anonymous customer access allowed')
        for path in ['/legal/terms','/legal/privacy']:
            require(self.http(path)[0]==200,'Legal page unavailable')
        require(self.http_json('/kitchen-live/health')['sourceSha']==self.kitchen_before['sourceSha'],'Kitchen bridge was replaced')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['prepare','apply'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']:
        parser.add_argument('--'+name,required=True)
    for name in ['ssh-key','backup-identity','ci-proof','auth-env','legal-dir']:
        parser.add_argument('--'+name,type=Path,required=name in ['ssh-key','auth-env','legal-dir'])
    parser.add_argument('--ci-run')
    args=parser.parse_args();release=Release(args)
    try:
        if args.action=='prepare':
            require(args.auth_env.is_file() and not args.auth_env.is_symlink() and args.auth_env.stat().st_mode&0o077==0,'Protected local auth file required')
            auth_environment(args.auth_env.read_text())
            for name in ['terms','privacy']:
                p=args.legal_dir/(name+'.html')
                require(p.is_file() and not p.is_symlink(),'Published legal artifact missing')
                text=p.read_text()
                require(500<len(text)<200000 and VERSION in text and '{{' not in text and '[До публикации' not in text,'Legal artifact unfinished')
        with release.deployment_lock():getattr(release,args.action)()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error,market.GuardFailure) else 'Stopped; private diagnostics and owned lock retained.',file=sys.stderr)
        raise SystemExit(1)
if __name__=='__main__':main()
