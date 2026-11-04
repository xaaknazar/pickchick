import importlib.util
from pathlib import Path
import unittest

root=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('support_release',root/'infra/public-staging/support-page-release.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SupportPageTests(unittest.TestCase):
    def test_route_preserves_existing_gateway(self):
        before=(root/'infra/public-staging/gateway.Caddyfile').read_text()
        after=m.candidate(before)
        self.assertEqual(after.replace(m.BLOCK+'\n','',1),before)
        self.assertIn('method GET HEAD',m.BLOCK)
        self.assertIn("script-src 'none'",m.BLOCK)
        with self.assertRaises(RuntimeError):m.candidate(after)

    def test_contact_requires_unique_existing_public_phone(self):
        for invalid in ('no contact','+77000000000 and +77000000001'):
            with self.assertRaises(RuntimeError):m.public_contact(invalid)
        self.assertEqual(m.public_contact('<p>+7 (700) 000-00-00.</p>'),'+77000000000')

    def test_all_languages_have_contact_and_deletion_without_tracking(self):
        for lang in ('ru','kk','en'):
            text=m.render(lang,'+77000000000')
            self.assertIn('lang="'+lang+'"',text)
            self.assertEqual(text.count('<summary>'),4)
            self.assertIn('href="tel:+77000000000"',text)
            self.assertIn('aria-current="page"',text)
            for absent in ('<script','<form','review_code','review_phone','iframe','—','–'):
                self.assertNotIn(absent,text)

    def test_account_deletion_section_for_google_play(self):
        # Google Play (lane android 05.11.2026): /support/#delete-account names PickChick, the
        # in-app path with the app's own labels and a way to ask without the app.
        labels={'ru':('Удалить аккаунт','Язык','Аккаунт удалён'),
                'kk':('Аккаунтты жою','Тіл','Аккаунт жойылды'),
                'en':('Delete account','Language','Account deleted')}
        for lang,words in labels.items():
            text=m.render(lang,'+77000000000')
            section=text.split('<section id="delete-account"',1)[1].split('</section>',1)[0]
            self.assertIn('href="#delete-account"',text.split('<section id="answers"',1)[0])
            self.assertIn('PickChick',section)
            for word in words:self.assertIn(word,section)
            self.assertEqual(section.count('<li>'),3)
            self.assertIn('href="tel:+77000000000"',section)
            for absent in ('<form','<script','{SUPPORT_EMAIL}','—','–'):self.assertNotIn(absent,section)
            # Google asks which data is kept and for how long: the section says what stays and
            # links the policy's retention heading (the one legal-update.py pins on the page).
            self.assertIn('href="/legal/privacy#:~:text=%D0%A1%D1%80%D0%BE%D0%BA%D0%B8%20%D1%85%D1%80%D0%B0%D0%BD%D0%B5%D0%BD%D0%B8%D1%8F%20%D0%B0%D0%BA%D0%BA%D0%B0%D1%83%D0%BD%D1%82%D0%B0"',section)
            self.assertIn('«Сроки хранения аккаунта»',section)
            self.assertEqual(section.count('<p class="prepare'),2)
        self.assertIn("'<h2>Сроки хранения аккаунта</h2>'",(root/'infra/public-staging/legal-update.py').read_text())

    def test_invalid_contact_cannot_inject_markup(self):
        with self.assertRaises(ValueError):m.render('ru','"><script>')
        with self.assertRaises(ValueError):m.render('../private','+77000000000')


if __name__=='__main__':unittest.main()
