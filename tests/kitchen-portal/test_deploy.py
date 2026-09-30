import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('deploy',Path(__file__).resolve().parents[2]/'infra/kitchen-portal/remote-deploy.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
class GatewayTests(unittest.TestCase):
 def test_narrow_route(self):
  source='site {\n\t@operations {\n\t\tmethod GET HEAD\n\t\tpath /kiosk /kitchen/prep /kitchen/assembly /display /manager\n\t}\n\thandle @operations { root * /srv/public/operations }\n\t@other { path /roadmap/* }\n}'
  after=d.add_route(source)
  self.assertIn('path /kiosk /manager',after)
  self.assertIn('header_up X-PickChick-Client-IP {remote_host}',after)
  self.assertIn('@other { path /roadmap/* }',after)
  with self.assertRaises(RuntimeError):d.add_route(after)
  with self.assertRaises(RuntimeError):d.add_route(source.replace('/display','/changed'))
if __name__=='__main__':unittest.main()
