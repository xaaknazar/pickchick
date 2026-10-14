import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const messages = JSON.parse(
  await readFile(new URL('apps/mobile/src/i18n/messages.json', root), 'utf8'),
);
const { notificationTemplates } =
  await import('../../packages/customer-notifications/dist/templates.js');
const escape = (value) => value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
let text = `# PickChick: русский / қазақша / English\n\nСловарь интерфейса мобильного приложения и push-уведомлений. Дата: 14.10.2026.\n\nКазахский - кириллица, в заказах вежливое обращение. В играх допустимо обращение на «ты». Английский - короткие естественные подписи. Бренды PickChick, Pick Combo, Kaspi, Piko, Heinz и названия игр сохранены. «С собой» - «Алып кету» - «Takeaway»; «В зале» - «Мейрамханада» - «Dine in».\n\nПараметры в фигурных скобках заменяются значениями во время работы. Их порядок может различаться. Перенос строки отмечен <br>. Имя гостя, его комментарии и отзывы не переводятся. Цены, состав и статусы оплаты перевод не изменяет.\n\nДокумент содержит рабочий интерфейс, доступные игры и отдельно помеченные в исходном тексте демонстрационные состояния. Pick Farm не включён в публичную версию и в эту работу не входит. Доставка push на реальный iPhone ещё требует настройки APNs и отдельной приёмки.\n\n## Push о заказах\n\n| Событие | Русский | Қазақша | English |\n|---|---|---|---|\n`;
for (const [kind, languages] of Object.entries(notificationTemplates)) {
  for (const field of ['title', 'body'])
    text += `| ${kind} / ${field} | ${['ru', 'kk', 'en'].map((locale) => escape(languages[locale][field])).join(' | ')} |\n`;
}
text += '\n## Интерфейс\n\n| № | Русский | Қазақша | English |\n|---|---|---|---|\n';
for (const [index, entry] of messages.entries())
  text += `| ${index + 1} | ${['ru', 'kk', 'en'].map((locale) => escape(entry[locale])).join(' | ')} |\n`;
text +=
  '\n## Границы перевода\n\nНовые, ещё не внесённые в словарь тексты опубликованного каталога сохраняют исходное значение. Пищевая ценность и аллергены не додумываются. В исходном каталоге встречаются разные обозначения объёма/массы соуса (мл и г); их фактическую корректность нужно подтвердить отдельно. Рекламные рассылки этим изменением не запускаются.\n';
const target = new URL('docs/translations/mobile-ru-kk-en.md', root);
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== text)
    throw new Error('Translation document is out of date');
} else await writeFile(target, text);
console.log(
  `${messages.length} UI messages and ${Object.keys(notificationTemplates).length} push events in three languages`,
);
