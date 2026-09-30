import { act, esc, go, icon, pill, table } from './ui.js';

const logo = (className = '') =>
  `<img class="${className}" src="/design/prototype/assets/mockup/logo.png" alt="Pick Chick" />`;

const officeNav = [
  ['B02', 'Дашборд', ['B02']],
  ['B03', 'Заказы', ['B03', 'B04']],
  ['B05', 'Номенклатура', ['B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B17']],
  ['B12', 'Остатки', ['B12', 'B13', 'B14', 'B15', 'B16']],
  ['B18', 'Отчёты', ['B18', 'B19', 'B22']],
  ['B20', 'Касса и бухгалтерия', ['B20', 'B21']],
  ['B23', 'Промо и баннеры', ['B23', 'B24']],
  ['B25', 'Игры и челленджи', ['B25', 'B26', 'B27']],
  ['B28', 'Гости и push', ['B28', 'B29', 'B30', 'B31']],
  ['B32', 'Обращения', ['B32', 'B33']],
  ['B34', 'Отзывы', ['B34']],
  ['B35', 'Станции и маршруты', ['B35']],
  ['B36', 'Устройства', ['B36', 'B37', 'B38', 'B44']],
  ['B41', 'Смены и сотрудники', ['B39', 'B40', 'B41']],
  ['B42', 'Журнал аудита', ['B42', 'B43']],
];

function dashboard() {
  const stats = [
    ['Продажи за смену', '264 300 ₸', '+12%', 'После скидок и возвратов'],
    ['Выданные заказы', '78', '+8%', 'Все четыре канала'],
    ['Средний чек', '3 388 ₸', '+4%', 'По выданным заказам'],
    ['Среднее время кухни', '6:20', '−0:40', 'От принятия до сборки'],
  ];
  const hours = [24, 32, 21, 42, 56, 72, 88, 68, 58, 43, 30, 18];
  const channels = [
    ['Касса', '36 заказов · 46%', 46, '#60a5fa'],
    ['Приложение', '24 заказа · 31%', 31, '#ff671f'],
    ['Киоск iPad', '14 заказов · 18%', 18, '#a78bfa'],
    ['Яндекс Еда', '4 заказа · 5%', 5, '#f0c240'],
  ];
  return `<div class="ref-dashboard">
    <div class="ref-kpis">${stats.map(([label, value, delta, sub]) => `<article class="ref-kpi"><span>${label}</span><strong>${value}</strong><div><b>${delta}</b><small>${sub}</small></div></article>`).join('')}</div>
    <div class="ref-dashboard-panels"><section class="ref-panel"><div class="ref-panel-heading"><h2>Продажи по часам</h2><span>Сегодня · ₸</span></div><div class="ref-sales-chart" role="img" aria-label="Демонстрационный график продаж: максимум в 14 часов">${hours.map((value, i) => `<div><strong>${i === 6 ? '42 800' : ''}</strong><i style="height:${value}%" class="${i === 6 ? 'peak' : ''}"></i><span>${String(i + 8).padStart(2, '0')}</span></div>`).join('')}</div><div class="ref-chart-legend"><span><i></i>Выданные заказы</span><span>Пиковый час · 14:00-15:00</span></div></section>
    <section class="ref-panel"><div class="ref-panel-heading"><h2>Откуда приходят заказы</h2><span>78 выдано</span></div><div class="ref-channel-list">${channels.map(([label, value, pct, color]) => `<div><div><strong>${label}</strong><span>${value}</span></div><div class="ref-channel-track"><i style="width:${pct}%;background:${color}"></i></div></div>`).join('')}</div><p class="ref-panel-note">Канал заказа и способ оплаты учитываются отдельно.</p></section></div>
    <div class="ref-dashboard-bottom"><section class="ref-panel"><div class="ref-panel-heading"><h2>Сейчас на точке</h2>${go('Все заказы', 'B03', 'secondary small')}</div>${table(
      ['Заказ / канал', 'Приготовление', 'Оплата', 'Чек'],
      [
        [
          '<strong>№083</strong><small>Приложение · с собой</small>',
          pill('Готовится', 'blue'),
          pill('Подтверждена', 'green'),
          pill('Получен', 'green'),
        ],
        [
          '<strong>№082</strong><small>Киоск · в зале</small>',
          'Не принят на кухню',
          pill('Проверяется', 'orange'),
          'Не запрошен',
        ],
        [
          '<strong>№081</strong><small>Яндекс Еда · доставка</small>',
          pill('Готовится', 'blue'),
          'По договору агрегатора',
          'Режим по договору',
        ],
      ],
      'B04',
    )}</section><section class="ref-panel"><div class="ref-panel-heading"><h2>Требуют внимания</h2><span>3 события</span></div><div class="ref-attention"><button data-go="B20"><i class="ref-status-dot amber"></i><span><strong>Проверить платёж №082</strong><small>Ответ банка ещё не подтверждён</small></span>${icon('arrow')}</button><button data-go="B17"><i class="ref-status-dot red"></i><span><strong>Фирменный соус в стопе</strong><small>Проверьте остаток и доступность</small></span>${icon('arrow')}</button><button data-go="B36"><i class="ref-status-dot blue"></i><span><strong>Устройство ожидает связи</strong><small>Последний ответ · 16:42</small></span>${icon('arrow')}</button></div></section></div>
    <p class="ref-office-footnote">Демонстрационные данные на 16:45 · банковские поступления сверяются отдельно от продаж.</p>
  </div>`;
}

function kitchenQueue(s, m) {
  const assembly = s.kind === 'kds-b';
  const overflow = s.kind === 'kds-overflow';
  const nums = overflow
    ? ['091', '090', '089', '088', '087', '086', '085', '084']
    : ['083', '077', '081', '076', '073', '072', '071', '070'];
  return `<div class="ref-kitchen-controls"><div class="ref-kitchen-tabs">${go('A · Приготовление', 'D01', !assembly ? 'selected' : 'secondary')}${go('B · Сборка', 'D02', assembly ? 'selected' : 'secondary')}</div><span>В очереди ${overflow ? '24' : '8'} · ${assembly ? 'готовность после проверки компонентов' : 'порядок по времени поступления'}</span>${overflow ? act('Следующая страница', 'page', 'secondary') : go('История', 'D07', 'secondary')}</div><div class="ref-ticket-grid">${nums
    .map((n, i) => {
      const working = i % 3 === 1 || (i === 0 && m.kdsWorking);
      const late = i === 0;
      const channel = ['Приложение', 'Киоск', 'Яндекс', 'Касса'][i % 4];
      const mode = channel === 'Яндекс' ? 'ДОСТАВКА' : i % 2 ? 'В ЗАЛЕ' : 'С СОБОЙ';
      return `<article class="ref-ticket ${late ? 'late' : ''} ${working ? 'working' : ''}"><header><div class="ref-ticket-identity"><strong>${n}</strong><span>${channel}</span><b class="${mode === 'В ЗАЛЕ' ? 'dine' : ''}">${mode}</b></div><div class="ref-ticket-timing"><strong>${['12:34', '08:12', '06:40', '04:18', '03:51', '03:10', '02:16', '01:40'][i]}</strong><span>${late ? 'дольше нормы' : working ? 'готовится' : 'новый'}</span></div></header><div class="ref-ticket-items"><div><b>×${i % 2 ? '2' : '1'}</b><span><strong>${i % 2 ? 'Стрипсы на двоих' : 'Чик Бургер комбо'}</strong><small>${i % 2 ? 'Соус отдельно' : 'Без лука · фирменный соус'}</small></span></div><div><b>×1</b><span><strong>${assembly ? 'Напиток и упаковка' : 'Картофель фри'}</strong><small>${assembly ? 'Напиток ожидается' : 'Стандарт · готовить отдельно'}</small></span></div>${assembly ? '<p class="ref-component-status">Курица готова · проверка сборщика</p>' : '<p class="ref-component-status">Приготовление · станция A</p>'}</div><footer>${go(assembly ? 'Открыть сборку' : working ? 'В работе · открыть' : 'Взять в работу', 'D03', working || assembly ? 'ref-start-blue' : 'ref-start-orange')}${go(icon('clock'), 'D04', 'ref-ticket-delay', 'aria-label="Причина задержки; время поступления сохраняется"')}</footer></article>`;
    })
    .join(
      '',
    )}</div><div class="ref-kitchen-bottom"><span>${overflow ? `Показано 8 из 24 · страница ${m.page} из 3` : 'Показаны все 8 заказов · демонстрационный снимок'}</span><span>Перенос и задержка не обнуляют время ожидания</span></div>`;
}

function board(s, m) {
  const lost = s.kind === 'board-offline';
  const idle = s.kind === 'board-idle';
  const overflow = s.kind === 'board-overflow';
  const preparing = overflow
    ? ['091', '090', '089', '088', '087', '086']
    : ['083', '077', '081', '076', '073', '072'];
  return `<div class="ref-board"><header class="ref-board-header"><div class="ref-board-logo">${logo()}</div><div><h1>Табло выдачи</h1><p>Pick Chick · Алматы</p></div><div class="ref-board-clock"><strong>16:45</strong><span>6 сентября · воскресенье</span></div></header>${lost || idle ? `<div class="ref-board-message">${logo()}<h2>${lost ? 'Обновления временно недоступны' : 'Выбирай свой хруст'}</h2><p>${lost ? 'Уточните готовность у сотрудника.' : 'Ваш номер появится здесь после принятия заказа.'}</p><p>${lost ? 'Дайындығын қызметкерден сұраңыз.' : 'Тапсырыс нөмірі осында көрсетіледі.'}</p></div>` : `<div class="ref-board-columns"><section class="ref-board-preparing"><h2><i></i>ГОТОВИТСЯ</h2><p class="ref-board-kz">Дайындалып жатыр</p><div class="ref-board-cards">${preparing.map((n, i) => `<article><strong>${n}</strong><div class="ref-board-stage"><span>${i % 3 === 0 ? 'Собираем' : i % 3 === 1 ? 'Готовим' : 'В очереди'}</span>${icon(i % 3 === 0 ? 'bag' : 'clock')}</div><div class="ref-board-progress" aria-hidden="true"><i class="stage-${i % 3}"></i></div></article>`).join('')}</div></section><section class="ref-board-ready"><h2>${icon('check')}ГОТОВО</h2><p class="ref-board-kz">Алып кетуге болады</p><div class="ref-board-cards">${['080', '078', '075'].map((n) => `<article><strong>${n}</strong><span>Можно забирать</span></article>`).join('')}</div><p class="ref-board-pickup">Подойдите к стойке выдачи<br>и назовите номер заказа</p></section></div>`}<footer class="ref-board-footer"><strong><i></i>PICK YOUR PEAK</strong><span>${lost ? 'Последние данные: 16:42' : overflow ? `Страница ${m.page} из 3 · все заказы сохраняются` : 'Твой выбор. Твой хруст.'}</span><span>Номер заказа - без личных данных</span></footer></div>`;
}

export function operationsView(s, m) {
  if (s.surface === 'display') return board(s, m);
  if (s.surface === 'backoffice' && s.kind === 'dashboard') return dashboard();
  if (s.surface === 'kitchen' && ['kds-a', 'kds-b', 'kds-overflow'].includes(s.kind))
    return kitchenQueue(s, m);
  return null;
}

export function operationsShell(s, content) {
  if (s.surface === 'kitchen') {
    const assembly = s.kind === 'kds-b' || s.kind === 'kds-detail';
    return `<div class="ref-kitchen"><header class="ref-kitchen-header"><div class="ref-kitchen-brand">${logo()}</div><div class="ref-kitchen-title"><h1>Кухня · ${assembly ? 'станция сборки' : 'приготовление'}</h1><p>Алматы · смена 06.09 · ${assembly ? 'экран B' : 'экран A'}</p></div><div class="ref-kitchen-stats"><div><span>В ОЧЕРЕДИ</span><strong>${s.kind === 'kds-overflow' ? '24' : '8'}</strong></div><div><span>В РАБОТЕ</span><strong>4</strong></div><div><span>ДОЛЬШЕ НОРМЫ</span><strong class="orange">2</strong></div><div><span>СР. ВРЕМЯ</span><strong>6:20</strong></div></div><div class="ref-kitchen-clock"><strong>16:45</strong><span>Демо · локальный узел</span></div></header><main class="ref-kitchen-content">${['kds-a', 'kds-b', 'kds-overflow'].includes(s.kind) ? '' : `<div class="ref-kitchen-controls"><h2>${esc(s.title)}</h2><div class="row">${go('Экран A', 'D01', 'secondary')}${go('Экран B', 'D02', 'secondary')}</div></div>`}${content}</main></div>`;
  }
  if (s.surface !== 'backoffice') return null;
  return `<div class="ref-office"><aside class="ref-office-sidebar"><button class="ref-office-brand" data-go="B02">${logo()}<span><strong>Pick Chick</strong><small>бэк-офис</small></span></button><nav aria-label="Навигация бэк-офиса">${officeNav.map(([id, label, children]) => `<button data-go="${id}" class="${children.includes(s.id) ? 'active' : ''}" ${children.includes(s.id) ? 'aria-current="page"' : ''}><i></i><span>${label}</span>${id === 'B32' ? '<b>3</b>' : id === 'B36' ? '<b>1</b>' : ''}</button>`).join('')}</nav><div class="ref-office-shift"><span class="ref-status-dot green"></span><strong>Смена открыта</strong><p>Тестовая точка · Алматы<br>Демо · 06.09 · данные на 16:45</p><div>${go('Профиль', 'B01', 'secondary small')}${go('Настройки', 'B43', 'secondary small')}</div></div></aside><div class="ref-office-main"><header class="ref-office-topbar"><div><h1>${s.kind === 'dashboard' ? 'Дашборд смены' : esc(s.title)}</h1><p>${s.kind === 'dashboard' ? 'Тестовая точка · операционные показатели' : 'Pick Chick · управление сетью'}</p></div><div class="ref-office-top-actions"><div class="ref-office-period" aria-label="Период">${['День', 'Неделя', 'Месяц'].map((name, i) => `<button data-action="period" class="${i === 0 ? 'active' : ''}">${name}</button>`).join('')}</div><div class="ref-office-period" aria-label="Область данных"><button data-action="filter" class="active">Точка</button><button data-action="filter">Сеть</button></div>${go('Смена', 'B41', 'secondary small')}${go(`${icon('receipt')} Экспорт`, 'B22', 'small')}</div></header><main class="ref-office-content">${content}</main></div></div>`;
}
