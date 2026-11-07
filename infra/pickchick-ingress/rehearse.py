#!/usr/bin/env python3
"""Local Docker rehearsal, synthetic upstream only; never connects to the VPS or a bank."""
import concurrent.futures
import http.client
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import uuid

HERE=Path(__file__).resolve().parent

def docker(*args, check=True):
    r=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=45)
    if check and r.returncode:raise RuntimeError('Local Docker rehearsal command failed: '+args[0])
    return (r.stdout + (r.stderr if args[0]=='logs' else '')).strip()

REQUEST_CONTAINER=None
REQUEST_HOST=None

def request(port,host,path,method='GET'):
    # Probe from the synthetic upstream on an internal network: no WAN access.
    args={'hostname':REQUEST_HOST,'port':80,'path':path,'method':method,'headers':{'Host':host}}
    program="const t=Date.now();const q=require('node:http').request("+json.dumps(args)+",r=>{r.resume();r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,seconds:(Date.now()-t)/1000,hsts:r.headers['strict-transport-security']||null,location:r.headers.location||null}))) });q.on('error',()=>process.exit(1));q.setTimeout(35000,()=>process.exit(1));q.end()"
    return json.loads(docker('exec',REQUEST_CONTAINER,'node','-e',program))

def ready(port):
    for _ in range(50):
        try:
            if request(port,'legacy.test','/')['status']==200:return
        except (OSError,RuntimeError):pass
        time.sleep(.1)
    raise RuntimeError('Local ingress did not become ready')

def main():
    global REQUEST_CONTAINER,REQUEST_HOST
    context=json.loads(docker('context','inspect'))
    if not context[0]['Endpoints']['docker']['Host'].startswith('unix://'):raise ValueError('Local Unix Docker only')
    caddy=docker('image','inspect','caddy:2.11.4-alpine','--format','{{.Id}}')
    node=docker('image','inspect','node:22-bookworm-slim','--format','{{.Id}}')
    prefix='pickchick-ingress-rehearsal-'+uuid.uuid4().hex[:10]
    upstream=prefix+'-upstream';REQUEST_CONTAINER=upstream;old=prefix+'-old';new=prefix+'-new';network=prefix+'-net'
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    report={'synthetic':True,'caddy_image':caddy,'checks':{}}
    try:
        docker('network','create','--internal',network)
        with tempfile.TemporaryDirectory(prefix=prefix) as tmp:
            p=Path(tmp);(p/'private').mkdir()
            sites=(HERE/'sites.Caddyfile').read_text()
            for domain in ['pickchick.185.129.51.103.nip.io','pickchick.kz','api.pickchick.kz','www.pickchick.kz']:
                sites=sites.replace('\n'+domain+' {','\nhttp://'+domain+' {')
                if sites.startswith(domain+' {'):sites='http://'+sites
            legacy='http://legacy.test {\n respond "unchanged synthetic legacy" 200\n}\n'
            (p/'sites.Caddyfile').write_text(sites)
            (p/'private/legacy.Caddyfile').write_text(legacy)
            (p/'Caddyfile').write_bytes((HERE/'Caddyfile').read_bytes())
            (p/'original.Caddyfile').write_text(legacy+sites)
            program="require('node:http').createServer((q,r)=>setTimeout(()=>{r.writeHead(200);r.end('synthetic')},q.url.includes('slow')?12000:0)).listen(8080,'0.0.0.0');require('node:http').createServer((q,r)=>{r.writeHead(200);r.end('staff fixture')}).listen(4177,'0.0.0.0')"
            docker('run','-d','--name',upstream,'--network',network,'--network-alias','pickchick-public-gateway','--network-alias','pickchick-staff-login',node,'node','-e',program)
            for config in ['original.Caddyfile','Caddyfile']:
                docker('run','--rm','--network','none','-v',str(p)+':/etc/caddy:ro',caddy,'caddy','validate','--config','/etc/caddy/'+config,'--adapter','caddyfile')
            def start(name,config):
                global REQUEST_HOST
                REQUEST_HOST=name
                docker('run','-d','--name',name,'--network',network,'-p',f'127.0.0.1:{port}:80','-v',str(p)+':/etc/caddy:ro',caddy,'caddy','run','--config','/etc/caddy/'+config,'--adapter','caddyfile');ready(port)
            start(old,'original.Caddyfile')
            hosts=['legacy.test','pickchick.185.129.51.103.nip.io','pickchick.kz','api.pickchick.kz','www.pickchick.kz']
            before={h:request(port,h,'/') for h in hosts}
            docker('stop','--time','2',old);start(new,'Caddyfile')
            after={h:request(port,h,'/') for h in hosts}
            for h in hosts:
                assert {k:v for k,v in before[h].items() if k!='seconds'}=={k:v for k,v in after[h].items() if k!='seconds'}
            report['checks']['host_parity']=True
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                jobs={name:pool.submit(request,port,'pickchick.185.129.51.103.nip.io',path,method) for name,path,method in [
                  ('availability','/v1/customer-checkout/availability?slow=1','GET'),('order_watch','/v1/test/orders/watch?slow=1','POST'),('default','/slow','GET')]}
                for name,job in jobs.items():report['checks'][name]=job.result()
            assert report['checks']['availability']['status']==200 and report['checks']['availability']['seconds']>=11
            assert report['checks']['order_watch']['status']==200 and report['checks']['order_watch']['seconds']>=11
            assert report['checks']['default']['status']==504 and 7<report['checks']['default']['seconds']<11
            started=time.monotonic();docker('stop','--time','2',new);docker('start',old);REQUEST_HOST=old;ready(port)
            report['checks']['rollback_seconds']=round(time.monotonic()-started,2)
            assert report['checks']['rollback_seconds']<60
            assert request(port,'legacy.test','/')['status']==200
            print(json.dumps(report))
    except Exception:
        Path('/private/tmp/pickchick-ingress-rehearsal-debug.log').write_text('\n'.join(docker('logs',name,check=False) for name in [old,new,upstream]))
        raise
    finally:
        for name in [new,old,upstream]:docker('rm','-f',name,check=False)
        docker('network','rm',network,check=False)

if __name__=='__main__':main()
