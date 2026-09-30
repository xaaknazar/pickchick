"""Targeted kiosk interaction checks; imported by the full browser smoke."""


def check_kiosk_ux(browser, base):
    page = browser.new_page(viewport={'width': 2100, 'height': 1800})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def visit(screen):
        page.goto(base + '/#' + screen)
        page.wait_for_function(
            '(id)=>document.title.startsWith(id) && '
            'Boolean(document.querySelector("#preview")?.style.width) && '
            'document.fonts.status==="loaded"', arg=screen)

    def click_route(screen):
        page.locator(f'#preview [data-go="{screen}"]').first.click()
        page.wait_for_function('(id)=>document.title.startsWith(id)', arg=screen)

    # Measure native kiosk units; the atlas itself scales its review preview.
    # Radio/checkbox labels are the full operable touch target.
    for number in range(1, 17):
        screen = f'K{number:02}'
        visit(screen)
        undersized = page.locator('#preview button,#preview input').evaluate_all('''els=>els
            .filter(e=>!e.disabled && getComputedStyle(e).visibility!=="hidden")
            .map(e=>{const target=e.closest("label")||e;return {
                name:e.getAttribute("aria-label")||target.innerText||e.type,
                width:target.offsetWidth,height:target.offsetHeight}})
            .filter(e=>e.width<64||e.height<64)''')
        assert not undersized, (screen, undersized)

    visit('K01')
    assert page.locator('#preview [data-action="video-toggle"]').count() == 0
    assert page.locator('#preview video').evaluate('(v)=>!v.controls && v.muted && v.loop')
    click_route('K02')
    page.locator('#preview [data-mode="В зале"]').click()
    page.wait_for_selector('.rk-menu-scroll')
    footer_top = page.locator('.rk-cartbar').evaluate('(e)=>e.getBoundingClientRect().top')
    page.locator('.rk-menu-scroll').evaluate('(e)=>e.scrollTop=e.scrollHeight')
    assert page.locator('.rk-menu-scroll').evaluate('(e)=>e.scrollTop>0')
    assert abs(page.locator('.rk-cartbar').evaluate('(e)=>e.getBoundingClientRect().top') - footer_top) < 1

    visit('K04')
    page.locator('input[type="radio"]').nth(1).check()
    page.locator('input[type="checkbox"]').check()
    page.locator('#preview [data-action="increment"]').click()
    assert page.locator('input[type="radio"]').nth(1).is_checked()
    assert page.locator('input[type="checkbox"]').is_checked()
    click_route('K06')
    assert 'Томатный соус' in page.locator('.cart-line').inner_text()
    assert 'Без лука' in page.locator('.cart-line').inner_text()
    click_route('K14')
    page.locator('#preview [data-action="resume"]').click()
    page.wait_for_function('()=>document.title.startsWith("K06")')
    assert 'Томатный соус' in page.locator('.cart-line').inner_text()

    # A previously opened product must not override the promoted Pick Combo.
    visit('K03')
    page.locator('#preview .product-card[data-product="1"]').click()
    click_route('K03')
    page.locator('#preview .rk-promo').click()
    page.wait_for_function('()=>document.title.startsWith("K05")')
    assert page.locator('.rk-detail-photo img').get_attribute('alt') == 'Pick Combo'
    for step in (1, 2, 3):
        page.locator('input[type="radio"]').nth(1).check()
        if step < 3:
            page.locator('[data-action="combo-next"]').click()
    page.locator('[data-action="kiosk-combo-back"]').click()
    assert page.locator('input[type="radio"]').nth(1).is_checked()
    page.locator('[data-action="combo-next"]').click()
    assert page.locator('input[type="radio"]').nth(1).is_checked()
    click_route('K06')
    for text in ('Master Combo', 'Томатный соус', 'Вода'):
        assert text in page.locator('.cart-line').inner_text()

    # Tab reaches consent after the phone input; scrolling keeps later actions reachable.
    click_route('K07')
    phone = page.locator('#preview input[type="tel"]')
    phone.focus()
    phone.press('Tab')
    assert page.locator('#preview input[type="checkbox"]').evaluate('(e)=>e===document.activeElement')
    page.locator('#preview [data-go="K08"]').scroll_into_view_if_needed()
    assert page.locator('#preview [data-go="K08"]').is_visible()

    # Help is not an escape hatch to a duplicate payment attempt.
    visit('K11')
    page.locator('[data-action="payment-check"]').click()
    assert page.url.endswith('#K11')
    click_route('K16')
    assert page.locator('#preview [data-go="K01"]').count() == 0
    assert page.locator('#preview [data-go="K14"]').count() == 0
    click_route('K11')
    assert page.locator('[data-action="payment-check"]').count() == 1

    # Explicit completion resets demo choices for the next guest.
    visit('K12')
    click_route('K01')
    visit('K04')
    assert page.locator('input[type="radio"]').first.is_checked()
    assert not page.locator('input[type="checkbox"]').is_checked()
    assert page.locator('.rk-quantity strong').inner_text() == '1'
    assert not errors, errors
    page.close()
    return ['K01–K16 native 64px touch targets', 'kiosk video without playback controls',
            'fixed cart footer while scrolling', 'modifiers survive quantity and resume',
            'combo selection and previous step', 'phone keyboard focus order',
            'unknown-payment help has no new-session shortcut', 'new guest resets choices']
