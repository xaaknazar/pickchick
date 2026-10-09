import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
from browser_network import API, FixtureRoute, health, isolated_context, route_fixture


def request(url, method='GET'):
    return Mock(request=SimpleNamespace(url=url, method=method))


class NetworkIsolation(unittest.TestCase):
    def test_health_local_200_and_exact_get(self):
        route=request(API+'/health/live')
        self.assertTrue(health(route));route.continue_.assert_not_called()
        self.assertEqual(route.fulfill.call_args.kwargs['status'],200)
        self.assertEqual(route.fulfill.call_args.kwargs['headers']['Access-Control-Allow-Origin'],'*')
        with self.assertRaises(AssertionError):health(request(API+'/health/live','POST'))
        self.assertFalse(health(request(API+'/health/other')))

    def test_external_continuation_cannot_escape_even_redirect_override(self):
        for url in [API+'/v1/customer-checkout/orders',API+'/unhandled','https://kaspi.kz/pay',
                    'http://localhost.example.test/','https://example.test/image.png']:
            route=request(url);FixtureRoute(route).continue_();route.abort.assert_called_once();route.continue_.assert_not_called()
        route=request('http://127.0.0.1:4196/menu')
        FixtureRoute(route).continue_(url=API+'/v1/customer-checkout/orders')
        route.abort.assert_called_once();route.continue_.assert_not_called()

    def test_local_preview_is_allowed(self):
        route=request('http://127.0.0.1:4196/assets/a.png')
        FixtureRoute(route).continue_();route.continue_.assert_called_once();route.abort.assert_not_called()

    def test_fetch_only_allows_loopback_without_redirects(self):
        route=request(API+'/v1/customer-checkout/quotes')
        proxy=FixtureRoute(route)
        with self.assertRaises(AssertionError):proxy.fetch()
        with self.assertRaises(AssertionError):proxy.fetch(url=API+'/elsewhere')
        with self.assertRaises(AssertionError):proxy.fetch(url='http://127.0.0.1:4196/a',max_redirects=1)
        route.fetch.assert_not_called()
        proxy.fetch(url='http://127.0.0.1:4196/a')
        self.assertEqual(route.fetch.call_args.kwargs,{'url':'http://127.0.0.1:4196/a','max_redirects':0})

    def test_broad_fixture_still_gets_local_health(self):
        context,handler=Mock(),Mock()
        route_fixture(context,'**/*',handler)
        callback=context.route.call_args.args[1]
        probe=request(API+'/health/live');callback(probe)
        handler.assert_not_called();probe.fulfill.assert_called_once()
        api=request(API+'/v1/catalog');callback(api)
        self.assertIsInstance(handler.call_args.args[0],FixtureRoute)
        self.assertIs(handler.call_args.args[0].request,api.request)

    def test_default_context_blocks_network_and_service_workers(self):
        browser=Mock();context=isolated_context(browser,viewport={'width':393,'height':852})
        self.assertEqual(browser.new_context.call_args.kwargs['service_workers'],'block')
        callback=context.route.call_args.args[1]
        route=request(API+'/unhandled');callback(route)
        route.abort.assert_called_once();route.continue_.assert_not_called()
        with self.assertRaises(AssertionError):isolated_context(browser,service_workers='allow')

    def test_all_mobile_browser_contexts_keep_guard_until_close(self):
        for path in Path(__file__).parent.glob('browser_*.py'):
            if path.name=='browser_network.py':continue
            tree=ast.parse(path.read_text())
            for node in ast.walk(tree):
                if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute):
                    self.assertNotIn(node.func.attr,('new_context','unroute_all','route'),str(path))


if __name__=='__main__':unittest.main()
