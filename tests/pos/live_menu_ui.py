"""Cashier POS live menu: publication categories, hash photos through the edge, mid-draft reload."""
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import expect, sync_playwright

fixture = json.loads(Path(sys.argv[1]).read_text())
url = fixture['url']
output = Path(fixture['output'])


def pin(page, digits):
    for digit in digits:
        page.get_by_role('button', name=digit, exact=True).click()


def publish(version):
    with urlopen(Request(f"{fixture['control']}/publish/{version}", method='POST', data=b'')) as response:
        assert response.status == 204, response.status


def tile_names(page):
    return [n.strip() for n in page.locator('.product-card').all_inner_texts()]


def media(page, path):
    return page.evaluate('''async (path) => {
      const response = await fetch(path, {cache: 'no-store'});
      const bytes = await response.arrayBuffer();
      const image = new Image();
      image.src = path;
      await image.decode();
      return [response.status, response.headers.get('content-type'), bytes.byteLength, image.naturalWidth];
    }''', path)


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1920, 'height': 1080}, reduced_motion='reduce', has_touch=True)
    external = []

    def lan_only(route):
        if route.request.url.startswith(url + '/'):
            route.continue_()
        else:
            external.append(route.request.url)
            route.abort()
    context.route('**/*', lan_only)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(url)
        pin(page, '2468')
        page.get_by_role('button', name='Открыть смену', exact=True).click()
        expect(page.get_by_text('КОМБО', exact=True)).to_be_visible()

        # Categories come from the publication: no operator config exists in this fixture.
        page.get_by_role('button', name='ДОПЫ', exact=True).click()
        expect(page.locator('.product-card').first).to_be_visible()
        names = tile_names(page)
        order = [next(i for i, n in enumerate(names) if label in n) for label in ('Картофель фри', 'Наггетсы', 'Сырные палочки')]
        assert order == sorted(order), names
        assert not any('Лимонад' in n for n in names), names
        page.get_by_role('button', name='НАПИТКИ', exact=True).click()
        expect(page.locator('.product-card').filter(has_text='Лимонад')).to_have_count(1)
        page.get_by_role('button', name='СТОП-ЛИСТ', exact=True).click()
        expect(page.get_by_text('Хрустящие закуски', exact=True).first).to_be_visible()
        expect(page.get_by_text('Холодные напитки', exact=True).first).to_be_visible()
        expect(page.get_by_text('Категория 1', exact=True)).to_have_count(0)
        page.get_by_role('button', name='ЗАКАЗ', exact=True).click()

        # A published photo is loaded by hash through the edge; tampered bytes fall back to the logo.
        page.get_by_role('button', name='ДОПЫ', exact=True).click()
        nuggets = page.locator('.product-card').filter(has_text='Наггетсы')
        style = nuggets.locator('.product-photo').get_attribute('style')
        assert f"/assets/menu/{fixture['good']}.webp" in style, style
        status, kind, size, width = media(page, f"/assets/menu/{fixture['good']}.webp")
        assert (status, kind, width) == (200, 'image/webp', 8), (status, kind, size, width)
        status, kind, size, width = media(page, f"/assets/menu/{fixture['bad']}.webp")
        assert (status, kind) == (200, 'image/png'), (status, kind)
        assert width > 8, width
        page.screenshot(path=str(output / 'live-menu-photos.png'))

        # Mid-draft publication: the kept line is repriced, the withdrawn one is dropped with a notice.
        nuggets.click()
        page.locator('.product-card').filter(has_text='Сырные палочки').click()
        expect(page.get_by_role('button', name='НА КУХНЮ · 1 780 ₸', exact=True)).to_be_visible()
        publish(2)
        expect(page.get_by_text('Меню обновлено: позиция Сырные палочки снята', exact=True)).to_be_visible(timeout=12000)
        expect(page.get_by_role('button', name='НА КУХНЮ · 1 190 ₸', exact=True)).to_be_visible()
        expect(page.locator('.product-card').filter(has_text='Сырные палочки')).to_have_count(0)
        page.screenshot(path=str(output / 'live-menu-reloaded.png'))
        # The moved draft is durable across a reload of the cashier screen.
        page.reload()
        expect(page.get_by_role('button', name='НА КУХНЮ · 1 190 ₸', exact=True)).to_be_visible()

        # A publication between the menu read and the quote: MENU_CHANGED is re-quoted once.
        quotes = []

        def race(route):
            quotes.append(route.request.post_data_json['release_id'])
            if len(quotes) == 1:
                publish(3)
            route.continue_()
        page.route(url + '/edge/v1/checkout/quotes', race)
        statuses = []
        page.on('response', lambda r: statuses.append(r.status) if r.url.endswith('/edge/v1/checkout/quotes') else None)
        page.get_by_role('button', name='НА КУХНЮ · 1 190 ₸', exact=True).click()
        expect(page.get_by_role('button', name='ПЕРЕДАТЬ БЕЗ ОПЛАТЫ', exact=True)).to_be_visible()
        expect(page.get_by_text('1 290 ₸').first).to_be_visible()
        assert len(quotes) == 2 and quotes[0] != quotes[1], quotes
        page.wait_for_timeout(200)
        assert statuses[:1] == [409] and statuses[1] in (200, 201), statuses
        page.screenshot(path=str(output / 'live-menu-requote.png'))
        assert external == [], external
        assert errors == [], errors
    except Exception:
        page.screenshot(path=str(output / 'live-menu-failure.png'))
        print('RENDER_ERRORS', errors)
        print(page.locator('body').inner_text()[-1800:])
        raise
    context.close()
    browser.close()
print('POS live menu: snapshot categories and order, verified hash photo and fallback, mid-draft reload with notice, MENU_CHANGED re-quote passed.')
