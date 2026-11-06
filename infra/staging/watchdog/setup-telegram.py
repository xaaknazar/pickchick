#!/usr/bin/env python3
"""Owner-only setup after a successful server window. Never run from the agent with a token.

Token arrives through stdin from the owner's hidden Terminal read. No messages are sent.
Only an unambiguous private group named PickChick Tech is accepted. Existing VPS secrets
are never overwritten; database grants and timers remain separate guarded steps.
"""
import argparse
import json
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys
import time
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Telegram redirect refused')


def select_group(data, now):
    if data.get('ok') is not True or not isinstance(data.get('result'), list):
        raise ValueError('Telegram response rejected')
    ids = set()
    for update in data['result']:
        msg = update.get('message') or update.get('my_chat_member') or {}
        chat = msg.get('chat', {})
        if chat.get('title') == 'PickChick Tech' and chat.get('type') in ('group', 'supergroup'):
            ident = chat.get('id')
            if type(ident) is int and ident < 0 and 0 <= now-msg.get('date', 0) < 86400:
                ids.add(ident)
    if len(ids) != 1:
        raise ValueError('Expected one recent PickChick Tech group; send a command in the group')
    return str(ids.pop())


def render(template, token, chat_id):
    if not re.fullmatch(r'[0-9]{5,20}:[A-Za-z0-9_-]{20,100}', token) or not re.fullmatch(r'-[0-9]+', chat_id):
        raise ValueError('Invalid credentials shape')
    values = {'WATCHDOG_TELEGRAM_BOT_TOKEN':token, 'WATCHDOG_TELEGRAM_CHAT_ID':chat_id,
              'WATCHDOG_DB_PASSWORD':secrets.token_hex(32)}
    for key, value in values.items():
        marker = key+'=\n'
        if template.count(marker) != 1: raise ValueError('Template differs')
        template = template.replace(marker,key+'='+value+'\n')
    if '\nWATCHDOG_TELEGRAM_ENABLED=false\n' not in template:
        raise ValueError('Shadow mode required')
    return template


REMOTE = r'''
import os,pathlib,sys,json,uuid
root=pathlib.Path('/opt/pickchick-staging');lock=root/'.market-release.lock'
target=root/'secrets/watchdog.env'
assert not target.exists() and not target.is_symlink()
assert target.parent.is_dir() and not target.parent.is_symlink()
assert target.parent.stat().st_uid==os.getuid()
owner={'id':str(uuid.uuid4()),'action':'watchdog-secret-setup'}
lock.mkdir(mode=0o700)
try:
 with (lock/'owner.json').open('x') as f:
  os.chmod(lock/'owner.json',0o600);json.dump(owner,f)
 data=sys.stdin.buffer.read(32769)
 assert 0<len(data)<=32768
 assert b'\nWATCHDOG_TELEGRAM_ENABLED=false\n' in data
 fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
 assert target.stat().st_uid==os.getuid() and target.stat().st_mode&0o777==0o600
 assert json.loads((lock/'owner.json').read_text())==owner
 (lock/'owner.json').unlink();lock.rmdir()
 print('Watchdog secrets saved privately; shadow mode; no grants/timers/messages changed.')
except BaseException:
 sys.stderr.write('Setup failed; inspect owned lock privately before retrying.\n');sys.exit(1)
'''


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--ssh-key', type=Path, required=True)
    p.add_argument('--server-window-verified', action='store_true', required=True)
    p.add_argument('--apply', action='store_true', required=True)
    a=p.parse_args()
    token=sys.stdin.readline(256).strip()
    if not re.fullmatch(r'[0-9]{5,20}:[A-Za-z0-9_-]{20,100}',token):raise ValueError('Invalid token input')
    request=urllib.request.Request('https://api.telegram.org/bot'+token+'/getUpdates',
      data=json.dumps({'timeout':0,'limit':100,'allowed_updates':['message','my_chat_member']}).encode(),
      headers={'Content-Type':'application/json'})
    with urllib.request.build_opener(NoRedirect).open(request,timeout=15) as response:
        raw=response.read(2_000_001)
        if len(raw)>2_000_000:raise ValueError('Response too large')
        group=select_group(json.loads(raw),time.time())
    template=(Path(__file__).resolve().parents[1]/'watchdog.env.example').read_text()
    payload=render(template,token,group).encode()
    r=subprocess.run(['ssh','-i',str(a.ssh_key.expanduser()),'-o','IdentitiesOnly=yes',
      '-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15',
      'pickchick-ops@185.129.51.103','python3 -c '+shlex.quote(REMOTE)],
      input=payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45)
    if r.returncode:raise ValueError('Private setup failed')
    print('Настройки сохранены с правами 0600. Telegram выключен; сообщения не отправлялись.')


if __name__=='__main__':
    try:main()
    except BaseException:
        sys.stderr.write('Остановлено. Проверьте вход и закрытый журнал; секреты не выводятся.\n')
        sys.exit(1)
