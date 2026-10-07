"""Local synthetic HTTPS fixture only; self-signed test certificate, never the restaurant."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
c = json.loads(Path(sys.argv[1]).read_text())
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    # Only the generated loopback fixture certificate is self-signed.
    context = browser.new_context(ignore_https_errors=True, viewport={'width':1440,'height':960})
    page = context.new_page()
    errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto(c['url']+'#finance')
    for width,height in [(1440,960),(393,852)]:
        page.set_viewport_size({'width':width,'height':height})
        expect(page.get_by_label('Логин',exact=True)).to_be_visible()
        expect(page.get_by_label('Пароль',exact=True)).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(Path(c['output'])/f'login-{width}.png'),full_page=True)
    page.get_by_label('Логин',exact=True).fill('ceo')
    page.get_by_label('Пароль',exact=True).fill('wrong')
    page.get_by_role('button',name='Войти',exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('Проверьте логин и пароль')
    page.get_by_label('Пароль',exact=True).fill(c['password'])
    page.get_by_role('button',name='Показать пароль',exact=True).click()
    expect(page.get_by_label('Пароль',exact=True)).to_have_attribute('type','text')
    page.get_by_role('button',name='Войти',exact=True).click()
    expect(page.get_by_role('button',name='Добавить операцию',exact=True)).to_be_visible()
    assert all('Bearer' not in v for v in page.evaluate('Object.values(sessionStorage)'))
    assert page.evaluate("JSON.parse(sessionStorage.getItem('pickchick.backoffice.credential.v1')).token") == 'session'
    page.reload()
    page.get_by_role('button',name='Добавить операцию',exact=True).click()
    page.get_by_test_id('finance-amount').fill('1250')
    page.get_by_test_id('finance-reference').fill('Synthetic CEO entry')
    page.get_by_role('button',name='Провести операцию',exact=True).click()
    expect(page.get_by_role('button',name='Провести операцию',exact=True)).to_have_count(0)
    page.get_by_role('button',name='Выйти',exact=True).click()
    try:
        expect(page.get_by_label('Логин',exact=True)).to_be_visible()
    except Exception:
        print(page.locator('body').inner_text())
        raise
    page.reload()
    expect(page.get_by_label('Логин',exact=True)).to_be_visible()
    assert not errors, errors
    browser.close()
print('CEO login: desktop/mobile, wrong password, session reload, real synthetic finance write and logout passed')
