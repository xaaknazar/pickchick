import importlib.util
from pathlib import Path
import hashlib
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('legal_update',ROOT/'infra/public-staging/legal-update.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class LegalTests(unittest.TestCase):
    def test_guarded_terms_patch_preserves_operator_and_other_sections(self):
        original='<main><p>Действуют с old</p><p>Оператор: Synthetic</p><h2>Заказы и пилот</h2><p>Код действует 3 минуты. old</p><p>В приложении предусмотрены old</p><p>До отправки состав можно изменить old</p><h2>Акции</h2><p>unchanged</p></main>'
        with patch.dict(m.BEFORE, terms=hashlib.sha256(original.encode()).hexdigest()):
            result=m.candidate('terms', original,(ROOT/m.PROPOSAL).read_text(),'2026-10-22')
            self.assertIn('<p>Оператор: Synthetic</p>',result)
            self.assertIn('<h2>Акции</h2><p>unchanged</p>',result)
            self.assertIn('90 дней',result);self.assertIn('30 дней',result)
            self.assertIn('не отменяют банковский платёж',result)
            self.assertIn('демонстрация заказа',result)
            self.assertIn(m.VERSION,result)
            with self.assertRaises(RuntimeError):m.candidate('terms',result,(ROOT/m.PROPOSAL).read_text(),'2026-10-22')
    def test_refuses_drift_and_unapproved_text(self):
        for kind,text,date in [('terms','changed','2026-10-22'),('unknown','','2026-10-22')]:
            with self.assertRaises(RuntimeError):m.candidate(kind,text,'','bad')
    def test_html_escaped_and_replacement_unique(self):
        self.assertEqual(m.paragraphs(['<script>']),'<p>&lt;script&gt;</p>')
        with self.assertRaises(RuntimeError):m.replace_paragraph('<p>x</p><p>x</p>','x','new')

if __name__=='__main__':unittest.main()
