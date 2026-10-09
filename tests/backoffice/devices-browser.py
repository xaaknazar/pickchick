"""Offline synthetic stories: layout, roles, pairing inputs, and safe password reset form."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin = sys.argv[1]
output = Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
errors = []
results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    for story, heading in [
        ("backoffice-devices--manager", "Подключённые экраны"),
        ("backoffice-devices--analyst", "Подключённые экраны"),
        ("backoffice-devices--one-time-code", "Подключённые экраны"),
        ("kitchen-terminalpairing--kitchen", "Подключение кухни"),
        ("kitchen-terminalpairing--assembly", "Подключение сборки"),
        ("kitchen-terminalpairing--display", "Подключение табло"),
        ("kitchen-displayaccess--empty", "Табло выдачи"),
        ("kitchen-displayaccess--offline", "Табло выдачи"),
    ]:
        for width in [1280, 768, 393]:
            page.set_viewport_size({"width": width, "height": 900})
            page.goto(origin + "/iframe.html?id=" + story + "&viewMode=story")
            expect(page.get_by_role("heading", name=heading, exact=True)).to_be_visible()
            page.locator("link[data-operation-story]").evaluate("e => e.sheet !== null")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), (story, width)
            if "analyst" in story:
                assert page.get_by_role("button", name="Восстановить пароль кухни", exact=True).count() == 0
                assert page.get_by_role("button", name="Подключить экран", exact=True).count() == 0
            if "devices--manager" in story:
                edge = page.get_by_role("article").filter(has=page.get_by_role("heading", name="Касса Abay Plaza"))
                assert edge.get_by_role("button", name="Отключить", exact=True).count() == 0
            if len(sys.argv)>3 and width==768:
                page.add_script_tag(path=sys.argv[3])
                violations=page.evaluate("async()=> (await axe.run(document.querySelector('#app'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}))")
                assert not violations,(story,violations)
            page.screenshot(path=str(output / (story + "-" + str(width) + ".png")), full_page=True)
            results.append({"story": story, "width": width, "overflow": False})
    page.set_viewport_size({"width": 768, "height": 900})
    page.goto(origin + "/iframe.html?id=kitchen-passwordreset--form&viewMode=story")
    page.get_by_role("button", name="Показать восстановление пароля").click()
    expect(page.get_by_role("dialog")).to_be_visible()
    page.get_by_label("Код восстановления").fill("abcd-" * 7 + "abcd")
    page.get_by_label("Новый пароль", exact=True).fill("Synthetic-private-password")
    page.get_by_label("Повторите пароль").fill("Different-private-password")
    page.get_by_role("button", name="Сохранить пароль").click()
    expect(page.get_by_role("alert")).to_have_text("Пароли не совпадают.")
    page.get_by_label("Повторите пароль").fill("Synthetic-private-password")
    page.get_by_role("button", name="Сохранить пароль").click()
    expect(page.get_by_role("alert")).to_contain_text("Код не принят")
    assert page.get_by_label("Новый пароль", exact=True).input_value() == ""
    assert page.get_by_label("Код восстановления").input_value() == ""
    assert page.evaluate("JSON.stringify({...localStorage,...sessionStorage})") == "{}"
    page.screenshot(path=str(output / "password-reset.png"), full_page=True)
    assert not errors, errors
    browser.close()
(output / "verification.json").write_text(json.dumps({"stories": results, "passwordForm": "passed", "errors": errors}, indent=2))
print(json.dumps({"storyChecks": len(results), "passwordForm": "passed", "errors": len(errors)}))
