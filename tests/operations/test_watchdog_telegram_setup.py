import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('setup',Path(__file__).resolve().parents[2]/'infra/staging/watchdog/setup-telegram.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class Setup(unittest.TestCase):
    def row(self,ident=-123,date=1000,title='PickChick Tech',kind='group'):
        return {'message':{'date':date,'chat':{'id':ident,'title':title,'type':kind}}}
    def test_only_unique_recent_named_group(self):
        self.assertEqual(r.select_group({'ok':True,'result':[self.row(),self.row()]},1001),'-123')
        for rows in [[],[self.row(),self.row(-124)],[self.row(123)],[self.row(date=1)],[self.row(title='other')],[self.row(kind='private')]]:
            with self.subTest(),self.assertRaises(ValueError):r.select_group({'ok':True,'result':rows},86402)
    def test_template_stays_shadow_and_other_bytes_unchanged(self):
        template=(Path(__file__).resolve().parents[2]/'infra/staging/watchdog.env.example').read_text()
        result=r.render(template,'123456:'+('x'*30),'-123')
        self.assertIn('WATCHDOG_TELEGRAM_ENABLED=false\n',result)
        for key in ('WATCHDOG_TELEGRAM_BOT_TOKEN','WATCHDOG_TELEGRAM_CHAT_ID','WATCHDOG_DB_PASSWORD'):
            lines=result.splitlines(keepends=True)
            result=''.join(key+'=\n' if line.startswith(key+'=') else line for line in lines)
        self.assertEqual(result,template)
        with self.assertRaises(ValueError):r.render(template,'bad\nTOKEN','-123')
    def test_no_redirect_to_another_host(self):
        with self.assertRaises(ValueError):r.NoRedirect().redirect_request(None,None,None,None,None,None)

if __name__=='__main__':unittest.main()
