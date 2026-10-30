import { format, resolveConfig } from 'prettier';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const messages = JSON.parse(
  await readFile(new URL('apps/mobile/src/i18n/messages.json', root), 'utf8'),
);
const { notificationTemplates } =
  await import('../../packages/customer-notifications/dist/templates.js');
const escape = (value) => value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
let text = `# PickChick: русский / қазақша / English\n\nСловарь интерфейса мобильного приложения и push-уведомлений. Обновлено: 30.10.2026.\n\nКазахский - кириллица, единое вежливое обращение во всех разделах, включая игры. Редакторская проверка по литературным нормам; перевод не имеет отдельного официального заверения. Английский - короткие естественные подписи. Бренды PickChick, Pick Combo, Kaspi, Piko, Heinz и названия игр сохранены. «С собой» - «Алып кету» - «Takeaway»; «В зале» - «Мейрамханада» - «Dine in».\n\nПараметры в фигурных скобках заменяются значениями во время работы. Их порядок может различаться. Перенос строки отмечен <br>. Имя гостя, его комментарии и отзывы не переводятся. Цены, состав и статусы оплаты перевод не изменяет.\n\nДокумент содержит рабочий интерфейс, доступные игры и отдельно помеченные в исходном тексте демонстрационные состояния. Pick Farm не включён в публичную версию и в эту работу не входит. Доставка push на реальный iPhone ещё требует настройки APNs и отдельной приёмки.\n\n## Push о заказах\n\n| Событие | Русский | Қазақша | English |\n|---|---|---|---|\n`;
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
text = await format(text, { ...(await resolveConfig(fileURLToPath(target))), parser: 'markdown' });
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== text)
    throw new Error('Translation document is out of date');
} else await writeFile(target, text);
console.log(
  `${messages.length} UI messages and ${Object.keys(notificationTemplates).length} push events in three languages`,
);
const rows = [
  ...Object.entries(notificationTemplates).flatMap(([kind, languages]) =>
    ['title', 'body'].map((field) => ({
      section: 'push',
      ru: languages.ru[field],
      kk: languages.kk[field],
      en: languages.en[field],
      note: kind + ' · ' + (field === 'title' ? 'Заголовок' : 'Текст'),
    })),
  ),
  ...messages.map((entry) => ({ ...entry, section: 'ui', note: '' })),
];
let html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PickChick · Три языка</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f6fa;color:#07183b;font:16px/1.55 system-ui,-apple-system,sans-serif}header{padding:48px max(24px,calc((100vw - 1320px)/2));background:#07183b;color:white}header small{letter-spacing:.12em;color:#ffab72;font-weight:700}h1{font-size:clamp(28px,4vw,48px);line-height:1.12;margin:16px 0}header p{max-width:760px;color:#d4def5;margin:16px 0 0}.tools{position:sticky;top:0;z-index:3;display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:#fff;padding:16px 24px;border-bottom:1px solid #dbe0ea}input{min-height:48px;flex:1;min-width:230px;border:1px solid #a8b4ca;border-radius:12px;padding:10px 16px;font:inherit}button{font:inherit;min-height:44px;padding:8px 16px;border:1px solid #bdc7d9;border-radius:24px;background:white;color:#07183b;cursor:pointer}button[aria-pressed=true]{background:#07183b;color:white;border-color:#07183b}main{max-width:1400px;margin:auto;padding:24px}.intro{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:24px}.pill{padding:8px 14px;border-radius:10px;background:#e8edf8}.table-wrap{overflow:auto;border:1px solid #dbe0ea;border-radius:16px;background:white}table{width:100%;border-collapse:collapse;table-layout:fixed;min-width:780px}th{background:#edf1f8;text-align:left;font-size:14px;color:#405477;padding:16px 20px}td{padding:18px 20px;border-top:1px solid #e6eaf2;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th:first-child{width:30%}th:nth-child(2){width:36%}tr:hover td{background:#fff8f2}td small{display:block;margin-bottom:6px;color:#697890;font-size:12px}.footer{color:#526480;font-size:14px;margin:24px 0}#count{font-size:14px;color:#526480}.pager{display:flex;align-items:center;justify-content:center;gap:18px;padding:24px}button:disabled{opacity:.4;cursor:default}input:focus-visible,button:focus-visible{outline:3px solid #ff8a3d;outline-offset:3px}@media(max-width:600px){header{padding:32px 20px}main{padding:16px}.tools{padding:12px 16px}td,th{padding:14px}}
</style></head><body><header><small>PICKCHICK · 30 ОКТЯБРЯ 2026</small><h1>Один интерфейс.<br>Три языка.</h1><p>Сравнение русских, казахских и английских текстов приложения и уведомлений. Найдите нужную кнопку, сообщение или название - все три версии стоят рядом.</p></header>
<div class="tools"><input id="search" type="search" aria-label="Поиск по всем трём языкам" placeholder="Найти фразу на любом языке…"><button data-filter="all" aria-pressed="true">Все тексты</button><button data-filter="ui" aria-pressed="false">Интерфейс</button><button data-filter="push" aria-pressed="false">Push</button><span id="count" aria-live="polite"></span></div>
<main><div class="intro"><span class="pill">${messages.length} фразы интерфейса</span><span class="pill">4 события заказа</span><span class="pill">Казахский · кириллица</span></div><div class="table-wrap"><table><thead><tr><th scope="col">Русский</th><th scope="col">Қазақша</th><th scope="col">English</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager"><button id="prev">Назад</button><span id="page" aria-live="polite"></span><button id="next">Далее</button></div><p class="footer">Параметры {p0}, {p1} подставляются при работе приложения. Имена гостей и их комментарии не переводятся. Словарь включает демонстрационные состояния - их тексты не означают доступность функции в рабочем приложении. Реальная доставка push ещё требует настройки Apple / Google и проверки на телефоне.</p></main>
<script id="data" type="application/json">${JSON.stringify(rows).replaceAll('<', '\\u003c')}</script>
<script>
const data=JSON.parse(document.getElementById('data').textContent);let filter='all',page=0;const size=60;
function render(){const query=document.getElementById('search').value.toLocaleLowerCase();const visible=data.filter(row=>(filter==='all'||row.section===filter)&&[row.ru,row.kk,row.en].some(text=>text.toLocaleLowerCase().includes(query)));const pages=Math.max(1,Math.ceil(visible.length/size));page=Math.min(page,pages-1);const body=document.getElementById('rows');body.replaceChildren();for(const row of visible.slice(page*size,(page+1)*size)){const tr=document.createElement('tr');for(const lang of ['ru','kk','en']){const cell=document.createElement('td');cell.lang=lang;if(lang==='ru'&&row.note){const note=document.createElement('small');note.textContent=row.note;cell.append(note);}cell.append(document.createTextNode(row[lang]));tr.append(cell);}body.append(tr);}document.getElementById('count').textContent='Найдено: '+visible.length;document.getElementById('page').textContent=(page+1)+' / '+pages;document.getElementById('prev').disabled=page===0;document.getElementById('next').disabled=page===pages-1;}
document.getElementById('search').addEventListener('input',()=>{page=0;render();});for(const button of document.querySelectorAll('[data-filter]'))button.addEventListener('click',()=>{filter=button.dataset.filter;page=0;for(const other of document.querySelectorAll('[data-filter]'))other.setAttribute('aria-pressed',String(other===button));render();});document.getElementById('prev').onclick=()=>{page--;render();};document.getElementById('next').onclick=()=>{page++;render();};render();
</script></body></html>`;
const htmlTarget = new URL('docs/translations/mobile-ru-kk-en.html', root);
html = await format(html, { ...(await resolveConfig(fileURLToPath(htmlTarget))), parser: 'html' });
if (process.argv.includes('--check')) {
  if ((await readFile(htmlTarget, 'utf8')) !== html)
    throw new Error('HTML translation document is out of date');
} else await writeFile(htmlTarget, html);
