import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('legal_restyle', ROOT / 'infra/public-staging/legal/restyle.py')
restyle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restyle)

TERMS = ('<!doctype html><html lang="ru"><head><title>PickChick - Условия</title><style>body{}</style></head>'
         '<body><main><section><h2>Условия использования PickChick</h2><p>Действуют с 2026-10-22.</p></section>'
         '<section><h2>Оператор</h2><p>ИП «Пример», телефон <a href="tel:+70000000000">+7 000</a>.</p></section>'
         '</main></body></html>')
OFFER = ('<html><head><title>Оферта</title></head><body><main><h1>Публичная оферта</h1><p class="meta">Редакция</p>'
         '<h2>1. Термины</h2><p>1.1. Текст — как есть.</p><div class="wrap"><table><tr><td>a</td><td>b</td></tr></table></div>'
         '</main></body></html>')


class LegalRestyle(unittest.TestCase):
    def test_terms_title_becomes_h1_and_text_stays(self):
        page, (text, links) = restyle.restyle('terms', TERMS)
        self.assertIn('<h1 class="doc-title">Условия использования PickChick</h1>', page)
        self.assertIn('<h2 id="section-1">Оператор</h2>', page)
        self.assertIn('<a href="#section-1">Оператор</a>', page)
        self.assertIn('aria-current="page">Условия</a>', page)
        main = page.split('<main id="text">')[1].split('</main>')[0]
        self.assertEqual(restyle.read(main)[0], text)
        self.assertEqual(links, ['tel:+70000000000'])

    def test_offer_keeps_h1_tables_and_inlines_css(self):
        page, _ = restyle.restyle('offer', OFFER)
        self.assertEqual(page.count('<h1'), 1)
        self.assertIn('<div class="wrap"><table>', page)
        self.assertIn('--color-accent: #ff8a3d', page)
        self.assertIn('<a href="/legal/privacy">Конфиденциальность</a>', page)

    def test_refuses_pages_without_one_main(self):
        with self.assertRaises(AssertionError):
            restyle.restyle('offer', '<html><head><title>x</title></head><body><p>no main</p></body></html>')


if __name__ == '__main__':
    unittest.main()
