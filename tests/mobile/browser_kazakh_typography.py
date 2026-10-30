"""Kazakh fonts, language switching and game label on local fixtures; no bank calls."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_slide_to_pay import URL, ROOT, make_context, new_state, add, checkout_traffic, release, slide, hint_fits, errors

OUT = ROOT / '.local/kazakh-review/screens'
OUT.mkdir(parents=True, exist_ok=True)

def check_faces(page, locale):
    samples = page.evaluate('''() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const result = []; let node;
      while (node = walker.nextNode()) {
        if (!/[А-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]/.test(node.textContent)) continue;
        const el = node.parentElement, rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        result.push({text: node.textContent.trim(), family: style.fontFamily, weight: style.fontWeight});
      }
      return result;
    }''')
    assert samples, locale
    if locale == 'kk':
        assert not [x for x in samples if 'Jost' in x['family'] or 'Manrope' in x['family']], samples
    else:
        assert any('Jost' in x['family'] or 'Manrope' in x['family'] for x in samples), samples
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(393, 852), (320, 568)]:
        state = new_state()
        ctx, page = make_context(browser, state, width, height)
        page.goto(URL + '/menu')
        add(page)
        for locale, title in [('kk', 'Ойындар'), ('ru', 'Игры'), ('kk', 'Ойындар')]:
            page.goto(URL + '/screen/M34')
            page.get_by_test_id('language-' + locale).click(timeout=20000)
            page.goto(URL + '/menu')
            expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)
            expect(page.get_by_test_id('tab-events')).to_contain_text(title)
            check_faces(page, locale)
            if locale == 'kk':
                slide(page, 0.05, steps=1, release_at_end=False)
                hint = page.get_by_test_id('cart-pay-hint')
                expect(hint).to_have_text('сырғытып төлеңіз')
                assert hint.evaluate('(e) => getComputedStyle(e).fontFamily') == 'system-ui'
                assert hint.evaluate('(e) => getComputedStyle(e).fontWeight') == '600'
                fits = hint_fits(page)
                assert fits['normal'] and fits['large'], fits
                page.screenshot(path=str(OUT / f'hint-kk-{width}.png'))
                page.mouse.up()
                page.get_by_test_id('tab-events').click()
                expect(page.get_by_test_id('screen-M26')).to_be_visible()
                check_faces(page, locale)
                page.screenshot(path=str(OUT / f'games-kk-{width}.png'))
                page.get_by_test_id('tab-menu').click()
                page.get_by_test_id('open-cart').click()
                expect(page.get_by_test_id('screen-M09')).to_be_visible()
                check_faces(page, locale)
                page.screenshot(path=str(OUT / f'cart-kk-{width}.png'))
                page.get_by_test_id('cart-close').click()
        assert not checkout_traffic(state), checkout_traffic(state)
        release(state)
        ctx.close()
    browser.close()
assert not errors, errors
print('PASS: KK system face, RU brand face restored, Games labels, hint 600 and normal/large fit, menu/games/cart at 393 and 320; no checkout requests')
