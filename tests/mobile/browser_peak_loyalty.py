"""Offline acceptance of the proposed mountain loyalty screens, never real awards."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
from account_fixture import signed_in

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost'), 'Use an isolated loopback export'
OUTPUT = ROOT / '.local/peaks/browser'
OUTPUT.mkdir(parents=True, exist_ok=True)
PEAKS = [
    ('furmanov', 'Фурманова', 300),
    ('kumbel', 'Кумбель', 1000),
    ('panorama', 'Панорама', 2000),
    ('big-almaty', 'Большой Алматинский', 3500),
    ('molodezhny', 'Молодёжный', 5500),
    ('talgar', 'Талгар', 8000),
]


def assert_unactivated(page):
    # React Navigation can retain the earlier M23 underneath a newly pushed M23.
    wallet = page.get_by_test_id('screen-M23').last
    expect(wallet.get_by_test_id('peak-wallet-balance')).to_have_text('-')
    expect(wallet.get_by_test_id('peak-earned-progress')).to_have_text('-')
    expect(wallet.get_by_text('Готовим программу. Пороги и подарки предварительные;', exact=False)).to_have_count(0)
    assert wallet.get_by_text('ОТКРЫТА · ПРИМЕР', exact=True).count() == 0


def assert_text_fits(locator):
    # Inspect rendered text dimensions rather than accepting presence in the DOM
    # as proof that a long peak name or reward condition is readable.
    result = locator.evaluate("""(element) => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      const range = document.createRange(); range.selectNodeContents(element);
      const lines = [...range.getClientRects()].filter(rect => rect.width && rect.height);
      return { text: element.textContent, box: box.toJSON(), clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth, clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight, clamp: style.webkitLineClamp,
        overflowX: style.overflowX, overflowY: style.overflowY,
        horizontallyClipped: lines.some(rect => rect.left < box.left - 1 || rect.right > box.right + 1),
        verticallyClipped: lines.some(rect => rect.top < box.top - 1 || rect.bottom > box.bottom + 1) };
    }""")
    assert result['scrollWidth'] <= result['clientWidth'] + 1, result
    assert not result['horizontallyClipped'], result
    # Font ascenders can extend the line box without clipping when overflow is
    # visible. Reject that extension only when CSS actually hides the glyphs.
    if result['overflowY'] in ('hidden', 'clip'):
        assert result['scrollHeight'] <= result['clientHeight'] + 1, result
        assert not result['verticallyClipped'], result
    assert result['clamp'] in ('none', '0', ''), result


def assert_words_stay_whole(locator):
    broken = locator.evaluate("""(element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const broken = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const match of node.textContent.matchAll(/[А-Яа-яЁё]+/gu)) {
          const range = document.createRange();
          range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
          const tops = [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => rect.top);
          if (tops.length && Math.max(...tops) - Math.min(...tops) > 2) broken.push(match[0]);
        }
      }
      return broken;
    }""")
    assert broken == [], f'Peak name breaks words across lines: {broken}'


def assert_horizontal_fit(page, screen_id):
    root = page.get_by_test_id(screen_id)
    dimensions = root.evaluate("""(element) => ({
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      right: element.getBoundingClientRect().right, viewport: innerWidth,
      bodyWidth: document.documentElement.scrollWidth
    })""")
    assert dimensions['scrollWidth'] <= dimensions['clientWidth'] + 1, dimensions
    assert dimensions['right'] <= dimensions['viewport'] + 1, dimensions
    assert dimensions['bodyWidth'] <= dimensions['viewport'] + 1, dimensions


def screenshot_at_top(page, screen, name):
    page.get_by_test_id('scroll-' + screen).evaluate('(element) => element.scrollTo(0, 0)')
    page.wait_for_timeout(100)
    page.screenshot(path=str(OUTPUT / name))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    requests = []
    errors = []
    for width in (320, 393):
        context = browser.new_context(viewport={'width': width, 'height': 852}, reduced_motion='reduce')

        def block_api(route):
            requests.append((route.request.method, urlparse(route.request.url).path))
            route.abort()

        context.route('**/v1/**', block_api)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/menu')
        page.get_by_test_id('loyalty-card').click(timeout=20000)
        expect(page.get_by_test_id('screen-M23').last).to_be_visible()
        assert_unactivated(page)
        assert_horizontal_fit(page, 'screen-M23')
        screenshot_at_top(page, 'M23', f'M23-{width}.png')

        for peak_id, name, threshold in PEAKS:
            card = page.get_by_test_id('peak-' + peak_id)
            card.scroll_into_view_if_needed()
            expect(card).to_be_visible()
            assert_text_fits(card.get_by_text(name, exact=True))
            assert_words_stay_whole(card.get_by_text(name, exact=True))
            art = page.get_by_test_id('peak-art-' + peak_id)
            expect(art).to_be_visible()
            page.wait_for_function("""(id) => {
              const image = document.querySelector('[data-testid="'+id+'"] img');
              return image && image.complete && image.naturalWidth > 0;
            }""", arg='peak-art-' + peak_id)
            card.click()
            details = page.get_by_test_id('peak-details')
            expect(details).to_be_visible()
            expect(details.get_by_text(name, exact=True)).to_be_visible()
            points = details.get_by_text('Чиков за всё время', exact=False)
            assert ''.join(filter(str.isdigit, points.inner_text())) == str(threshold)
            assert_text_fits(details.get_by_text(name, exact=True))
            assert_horizontal_fit(page, 'peak-details')
            expect(details.get_by_text('Готовим программу.', exact=False)).to_be_visible()
            if peak_id == 'kumbel':
                assert_text_fits(details.get_by_text(
                    'Одно базовое комбо из списка программы. Чики с баланса не списываются.', exact=True))
            page.get_by_test_id('peak-close').click()
            expect(details).not_to_be_visible()
            expect(card).to_be_visible()
        assert page.get_by_test_id('mountain-road').get_by_role('button').count() == 6
        page.get_by_test_id('peak-big-almaty').scroll_into_view_if_needed()
        page.screenshot(path=str(OUTPUT / f'M23-road-{width}.png'))

        rules = page.get_by_test_id('ascent-rules-toggle')
        rules.click()
        expect(rules).to_have_attribute('aria-expanded', 'true')
        expect(page.get_by_test_id('ascent-rules')).to_be_visible()
        expect(page.get_by_text('Уже потраченные Чики продолжают учитываться для уровня.', exact=False)).to_be_visible()
        expect(page.get_by_text('Возврат заказа корректирует начисление и прогресс.', exact=False)).to_be_visible()
        assert_horizontal_fit(page, 'screen-M23')
        rules.click()
        expect(rules).to_have_attribute('aria-expanded', 'false')
        expect(page.get_by_test_id('ascent-rules')).not_to_be_visible()

        page.get_by_text('Миссии и подарки', exact=True).click()
        expect(page.get_by_test_id('screen-M25')).to_be_visible()
        expect(page.get_by_text('Предварительные условия · подарок ещё не активен', exact=True)).to_be_visible()
        assert_horizontal_fit(page, 'screen-M25')
        screenshot_at_top(page, 'M25', f'M25-{width}.png')
        page.get_by_text('Открой новый вкус', exact=True).scroll_into_view_if_needed()
        long_mission = page.get_by_text('Миссия месяца: получи заказы с двумя разными основными блюдами', exact=False)
        assert_text_fits(long_mission)
        page.screenshot(path=str(OUTPUT / f'M25-missions-{width}.png'))
        # M23/M25 above were reached as a guest. The game's existing access rule
        # uses the shared synthetic account fixture, never a real credential.
        signed_in(context)
        page.reload()
        expect(page.get_by_test_id('screen-M25')).to_be_visible()
        page.get_by_test_id('ascent-mission-1').click()
        expect(page.get_by_test_id('screen-M26')).to_be_visible()
        expect(page.get_by_test_id('pick-blocks-open')).to_be_visible()

        # Return via the real stack, then the explicit route back to the peaks.
        page.go_back()
        expect(page.get_by_test_id('screen-M25')).to_be_visible()
        page.get_by_role('button', name='Посмотреть вершины', exact=True).click()
        expect(page.get_by_test_id('screen-M23').last).to_be_visible()
        assert_unactivated(page)
        for peak_id, _, _ in PEAKS:
            expect(page.get_by_test_id('screen-M23').last.get_by_test_id('peak-' + peak_id)).to_have_count(1)

        # Fixture numbers are acceptable only on the explicitly marked design route.
        page.goto(URL + '/screen/M23?preview=1')
        expect(page.get_by_text('Просмотр дизайна · пример, не операция', exact=True)).to_be_visible()
        expect(page.get_by_test_id('open-design-review')).to_be_visible()
        expect(page.get_by_test_id('peak-wallet-balance')).to_have_text('180')
        expect(page.get_by_test_id('peak-earned-progress')).to_have_text('540')
        expect(page.get_by_text('540 Чиков заработано, 360 потрачено.', exact=False)).to_be_visible()
        screenshot_at_top(page, 'M23', f'M23-preview-{width}.png')
        page.goto(URL + '/screen/M23')
        assert_unactivated(page)
        context.close()

    assert errors == [], errors
    assert all(method == 'GET' for method, _ in requests), requests
    browser.close()
    print(json.dumps({'result': 'PASS', 'api_requests_blocked': len(requests),
                      'widths': [320, 393], 'screenshots': str(OUTPUT)}, ensure_ascii=False))
