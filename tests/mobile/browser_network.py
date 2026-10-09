"""Keep browser fixtures local, including NetInfo's reachability probe."""
from urllib.parse import urlparse

API = 'https://pickchick.185.129.51.103.nip.io'
LOCAL_HOSTS = {'localhost', '127.0.0.1', '::1'}


def local(url):
    parsed = urlparse(url)
    return parsed.scheme in ('http', 'https') and parsed.hostname in LOCAL_HOSTS


def health(route):
    if route.request.url != API + '/health/live':
        return False
    assert route.request.method == 'GET', 'NetInfo must use the reviewed GET probe'
    route.fulfill(status=200, json={'alive': True, 'service': 'api'},
                  headers={'Access-Control-Allow-Origin': '*'})
    return True


class FixtureRoute:
    """A fixture may fulfill external API requests, but cannot send them onward."""
    def __init__(self, route):
        self._route = route

    def __getattr__(self, name):
        return getattr(self._route, name)

    def continue_(self, **kwargs):
        if local(kwargs.get('url', self._route.request.url)):
            return self._route.continue_(**kwargs)
        return self._route.abort('blockedbyclient')

    def fetch(self, **kwargs):
        assert local(kwargs.get('url', self._route.request.url)), 'Fixture fetch must stay on loopback'
        assert kwargs.get('max_redirects', 0) == 0, 'Fixture fetch cannot follow redirects'
        return self._route.fetch(**{**kwargs, 'max_redirects': 0})


def isolated_context(browser, **kwargs):
    assert kwargs.get('service_workers', 'block') == 'block'
    context = browser.new_context(**{**kwargs, 'service_workers': 'block'})

    def guard(route):
        if not health(route):
            FixtureRoute(route).continue_()

    context.route('**/*', guard)
    return context


def route_fixture(context, pattern, handler):
    """Retain each fixture's exact API assertions; health wins over broad patterns."""
    def guarded(route):
        if not health(route):
            handler(FixtureRoute(route))
    context.route(pattern, guarded)
