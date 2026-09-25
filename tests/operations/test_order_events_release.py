import importlib.util
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('order_events_release',ROOT/'infra/staging/release-order-events.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)

class OrderEventsReleaseTest(unittest.TestCase):
 def test_overlay_preserves_all_other_routes_assets_and_headers(self):
  source=(ROOT/'infra/public-staging/gateway.Caddyfile').read_text()
  begin=source.index('\t# Bounded event wait:');end=source.index('\t@test_post {',begin)
  baseline=(source[:begin]+source[end:]).replace('write 40s','write 10s').replace('quotes|orders/watch|orders|','quotes|orders|')
  self.assertEqual(r.extend_gateway(baseline,source),source)
  extra='\n# immutable edge and roadmap overlay\n'
  self.assertEqual(r.extend_gateway(baseline+extra,source),source+extra)
  with self.assertRaises(r.market.GuardFailure):r.extend_gateway(source,source)
  with self.assertRaises(r.market.GuardFailure):r.extend_gateway(baseline.replace('write 10s','write 60s'),source)

if __name__=='__main__':unittest.main()
