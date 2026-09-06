import { groups, stateNames, icon, esc, photo, products, money } from './ui.js';
import { view, appShell, stateView } from './views.js';

const screens = await (await fetch('/design/prototype/screens.json')).json();
const byId = new Map(screens.map((s) => [s.id, s]));
const model = {
  product: 0,
  qty: 1,
  category: 'Все',
  mode: 'С собой',
  comboStep: 1,
  kioskChoices: {},
  kioskCartKind: 'product',
  kioskResume: 'K03',
  kioskHelpFrom: null,
  score: 0,
  paused: false,
  rating: 0,
  cash: 5000,
  assembled: false,
  kdsWorking: false,
  page: 1,
};
let surface = 'mobile',
  state = 'default',
  spec = true,
  focus = false,
  selected = 'M06',
  search = '',
  overview = !location.hash;
let toastTimer;
function readHash() {
  const [id, query] = location.hash.slice(1).split('?');
  if (byId.has(id)) {
    selected = id;
    surface = byId.get(id).surface;
    overview = false;
    const requested = new URLSearchParams(query).get('state') ?? 'default';
    state = byId.get(id).states.includes(requested) ? requested : 'default';
  }
}
readHash();
function changeScreen(id) {
  if (!byId.has(id)) return;
  search = '';
  state = 'default';
  overview = false;
  location.hash = id;
  if (selected === id) {
    render();
  }
}
function previewRules(s) {
  if (s.id === 'M04')
    return [
      'Ник необязателен; шаг можно пропустить без потери доступа к заказу.',
      'Публичное отображение требует отдельного согласия и фильтрации имени.',
      'По умолчанию на табло только номер заказа; согласие можно отозвать в профиле.',
    ];
  const common = [
    'Клиент не подтверждает деньги, выдачу или Чики самостоятельно.',
    'Сумма и состав проверяются сервером; демонстрационные цены не являются прайсом.',
  ];
  if (s.surface === 'display')
    return [
      'Только номера заказов, без телефона, имени и состава.',
      'Источник — edge. Нет связи: явное сообщение, без случайных обновлений.',
      'После выдачи убрать номер по событию сотрудника.',
    ];
  if (s.surface === 'kitchen')
    return [
      'Номер, канал, модификаторы и исходный возраст всегда видны.',
      'Компонент ≠ готовый заказ. Финальная сборка требует всех заданий.',
      'Отмена/перенос аудируются; нет дублирующего тикета при повторе.',
    ];
  if (s.kind === 'claim')
    return [
      'Телефон даёт только pending начисление.',
      'Баланс, история и расходование по непроверенному номеру недоступны.',
      'Для расходования нужен OTP или одноразовый QR.',
    ];
  if (s.kind === 'unknown')
    return [
      'Никакой повторной оплаты до разрешения неизвестного результата.',
      'Восстановить попытку по сохранённому заказу после restart.',
      'Проверка статуса не создаёт новую попытку оплаты.',
    ];
  if (s.fields.length)
    return [
      'Поля: ' + s.fields.join('; '),
      'Сохранить черновик отдельно от публикации/проведения.',
      'Конфликт версии показывает сравнение; права проверяет сервер.',
    ];
  return common;
}
function inspector(s) {
  return `<aside class="spec-panel" aria-label="Спецификация экрана"><span class="eyebrow muted">Передача в разработку</span><h2>${s.id} · ${s.title}</h2><span class="tag">${s.requirement}</span><span class="tag">${s.release} · проектный приоритет</span><h3>Задача экрана</h3><p>${s.purpose}</p><h3>Состояния</h3><div class="state-switch-inline">${s.states.map((v) => `<button data-state="${v}" aria-pressed="${state === v}">${stateNames[v]}</button>`).join('')}</div><h3>Поведение и ограничения</h3><ul>${previewRules(
    s,
  )
    .map((t) => `<li>${esc(t)}</li>`)
    .join(
      '',
    )}</ul><h3>Переходы</h3><button class="scenario" data-go="${s.next}">Далее: ${s.next} · ${byId.get(s.next).title}</button>${s.kind === 'payment' || s.kind === 'unknown' ? `<h3>События для просмотра дизайна</h3><p>Выбор ниже только меняет макет. Запрос к банку не выполняется.</p><button class="scenario" data-go="${s.surface === 'mobile' ? 'M16' : s.surface === 'kiosk' ? 'K12' : 'P05'}">Демо: банк подтвердил оплату</button>${s.surface === 'mobile' ? '<button class="scenario" data-go="M15">Демо: окончательный отказ</button>' : ''}` : ''}<h3>Размер и доступность</h3><p>${groups[s.surface].size.join(' × ')} · элементы управления ${s.surface === 'kiosk' || s.surface === 'kitchen' ? '64' : s.surface === 'pos' ? '56' : '48'} px или больше. Контрастные подписи, видимый focus, без зависимости только от цвета.</p><h3>Текущий статус</h3><p>Дизайн-прототип. Данные синтетические, формы не сохраняются на сервере. KZ-тексты требуют редактора. Платёжные SDK, реальная ККМ и устройства здесь не подключены.</p></aside>`;
}
function nav() {
  const filtered = screens.filter((s) =>
    search
      ? s.title.toLowerCase().includes(search.toLowerCase()) ||
        s.id.toLowerCase().includes(search.toLowerCase())
      : s.surface === surface,
  );
  return `<aside class="atlas-nav"><div class="brandmark">${photo('brand-logo.png', 'PickChick')}<div><strong>PickChick</strong><small>DESIGN WORKSPACE / 01</small></div></div><div class="surface-switch" aria-label="Выбор приложения">${Object.entries(
    groups,
  )
    .map(
      ([key, g]) =>
        `<button class="${surface === key && !overview ? 'active' : ''}" data-surface="${key}" title="${g.name}">${icon(g.icon)}${g.short}</button>`,
    )
    .join(
      '',
    )}</div><input class="atlas-search" id="screen-search" placeholder="Найти экран или ID…" value="${esc(search)}" aria-label="Найти экран во всех приложениях"/><div class="nav-count eyebrow">${search ? 'Результаты поиска' : groups[surface].name} · ${filtered.length}</div><nav class="screen-list" aria-label="Каталог экранов">${filtered.map((s) => `<button class="screen-link ${selected === s.id && !overview ? 'active' : ''}" data-go="${s.id}" ${selected === s.id ? 'aria-current="page"' : ''}><span>${s.id}</span>${s.title}</button>`).join('') || '<p class="empty-search">Ничего не найдено. Попробуйте «оплата» или «B12».</p>'}</nav><div class="nav-footer">${screens.length} экранов · 6 приложений<br>ТЗ → сценарий → состояние</div></aside>`;
}
function overviewHtml() {
  return `<div><section class="overview-hero"><div><span class="eyebrow">Одна сеть. Единый опыт.</span><h1 style="margin-top:18px">От первого хруста<br>до последнего заказа.</h1><p>Полная карта интерфейсов PickChick: ${screens.length} экранов, роли и исключения. Выберите приложение, пройдите сценарий и изучите состояния.</p></div>${photo('brand-logo.png', 'PickChick')}</section><section class="overview-grid">${Object.entries(
    groups,
  )
    .map(
      ([key, g]) =>
        `<button class="overview-card" data-surface="${key}">${icon(g.icon)}<h2>${g.name}</h2><p>${{ mobile: 'Меню, оплата, получение, Чики и события.', kiosk: 'Заказ без регистрации на большом сенсорном экране.', pos: 'Продажи, все каналы, смены, деньги и работа без WAN.', kitchen: 'Приготовление и сборка: два экрана, общие зависимости.', display: 'Крупные номера, RU / KZ и честное состояние связи.', backoffice: 'Все 15 разделов управления сетью и вложенные страницы.' }[key]}</p><div class="mini-stat">${screens.filter((s) => s.surface === key).length} экранов · открыть →</div></button>`,
    )
    .join('')}</section></div>`;
}
function render() {
  const s = byId.get(selected);
  document.body.classList.toggle('focus', focus);
  document.title = `${overview ? 'Экосистема' : s.id + ' · ' + s.title} — PickChick`;
  document.querySelector('#app').innerHTML =
    `<div class="atlas">${nav()}<main class="atlas-main"><header class="atlas-toolbar"><div><span class="eyebrow muted">${overview ? 'Дизайн экосистемы' : groups[s.surface].name + ' / ' + s.id}</span><h1>${overview ? 'Все интерфейсы PickChick' : s.title}</h1></div><div class="atlas-actions"><button class="tool" data-action="overview">Обзор</button><button class="tool ${spec ? 'active' : ''}" data-action="spec">Спецификация</button><button class="tool ${focus ? 'active' : ''}" data-action="focus">${focus ? 'Выйти из фокуса' : 'Фокус'}</button><button class="tool" data-action="copy">Ссылка</button></div></header><nav class="flow-strip" aria-label="Ключевые сценарии">${[
      ['M06', 'Заказ в приложении'],
      ['K01', 'Заказ на киоске'],
      ['P03', 'Продажа на кассе'],
      ['D01', 'Кухня A → B'],
      ['T01', 'Табло выдачи'],
      ['B02', 'Управление сменой'],
      ['M14', 'Неизвестная оплата'],
    ]
      .map(([id, title]) => `<button data-go="${id}">${title}</button>`)
      .join(
        '',
      )}</nav>${overview ? overviewHtml() : `<div class="workspace ${!spec ? 'no-spec' : ''}"><section class="review-stage"><div class="preview-meta"><span class="prototype-label">Дизайн-прототип · демонстрационные данные</span><label>Состояние <select id="state-select" aria-label="Состояние экрана">${s.states.map((v) => `<option value="${v}" ${state === v ? 'selected' : ''}>${stateNames[v]}</option>`).join('')}</select></label></div><div class="viewport-holder" id="holder"><div class="frame ${s.surface}" id="preview" tabindex="-1"><div class="frame-content">${appShell(s, stateView(s, state) ?? view(s, model))}</div></div></div></section>${spec ? inspector(s) : ''}</div>`}</main></div>`;
  requestAnimationFrame(fit);
}
function fit() {
  const holder = document.querySelector('#holder'),
    frame = document.querySelector('#preview');
  if (!holder || !frame) return;
  const [w, h] = groups[byId.get(selected).surface].size;
  const available =
    holder.parentElement.clientWidth -
    parseFloat(getComputedStyle(holder.parentElement).paddingLeft) -
    parseFloat(getComputedStyle(holder.parentElement).paddingRight);
  const scale = Math.min(1, available / w);
  holder.style.width = `${w * scale}px`;
  holder.style.height = `${h * scale}px`;
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  frame.style.transform = `scale(${scale})`;
}
function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  document.querySelector('#announcement').textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 5000);
}
function setState(next) {
  state = next;
  location.hash = `${selected}${next === 'default' ? '' : '?state=' + next}`;
  render();
}
document.addEventListener('click', async (event) => {
  const el = event.target.closest('button');
  if (!el || el.disabled) return;
  if (el.dataset.product !== undefined) {
    model.product = Number(el.dataset.product);
    model.qty = 1;
  }
  if (el.dataset.mode) {
    model.mode = el.dataset.mode;
  }
  if (el.dataset.go) {
    if (el.dataset.go === 'K16' && selected !== 'K16') {
      model.kioskHelpFrom = ['K09', 'K11'].includes(selected) ? selected : null;
    }
    if (el.dataset.go === 'K14' && selected !== 'K14' && surface === 'kiosk') {
      model.kioskResume = selected;
    }
    if (el.dataset.go === 'K06' && ['K04', 'K05'].includes(selected)) {
      model.kioskCartKind = selected === 'K05' ? 'combo' : 'product';
    }
    if (byId.get(el.dataset.go)?.kind === 'welcome') {
      Object.assign(model, { qty: 1, category: 'Все', comboStep: 1, score: 0, assembled: false });
      if (el.dataset.go === 'K01') {
        Object.assign(model, {
          product: 0,
          mode: 'С собой',
          kioskChoices: {},
          kioskCartKind: 'product',
          kioskResume: 'K03',
          kioskHelpFrom: null,
        });
      }
    }
    changeScreen(el.dataset.go);
    return;
  }
  if (el.dataset.surface) {
    surface = el.dataset.surface;
    changeScreen(groups[surface].first);
    return;
  }
  if (el.dataset.state) {
    setState(el.dataset.state);
    return;
  }
  if (el.dataset.category) {
    model.category = el.dataset.category;
    render();
    return;
  }
  if (el.dataset.rating) {
    model.rating = Number(el.dataset.rating);
    render();
    return;
  }
  if (el.dataset.cash) {
    model.cash =
      el.dataset.cash === '←'
        ? Math.floor(model.cash / 10)
        : Math.min(999999, Number(String(model.cash) + el.dataset.cash));
    render();
    return;
  }
  if (el.dataset.mode) {
    render();
    return;
  }
  const action = el.dataset.action;
  if (action === 'overview') {
    overview = true;
    render();
    return;
  }
  if (action === 'spec') {
    spec = !spec;
    render();
    return;
  }
  if (action === 'focus') {
    focus = !focus;
    render();
    return;
  }
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Ссылка на экран скопирована.');
    } catch {
      toast('Адрес экрана находится в строке браузера.');
    }
    return;
  }
  if (action === 'increment') {
    model.qty = Math.min(9, model.qty + 1);
    render();
    return;
  }
  if (action === 'decrement') {
    model.qty = Math.max(1, model.qty - 1);
    render();
    return;
  }
  if (action === 'combo-next') {
    model.comboStep = Math.min(3, model.comboStep + 1);
    render();
    return;
  }
  if (action === 'kiosk-combo-back') {
    model.comboStep = Math.max(1, model.comboStep - 1);
    render();
    return;
  }
  if (action === 'coin') {
    if (!model.paused) model.score += 1;
    render();
    return;
  }
  if (action === 'pause') {
    model.paused = !model.paused;
    render();
    return;
  }
  if (action === 'cash-5000') {
    model.cash = 5000;
    render();
    return;
  }
  if (action === 'page') {
    model.page = (model.page % 3) + 1;
    render();
    toast('Демо навигации по страницам. Рабочий список получает данные с сервера.');
    return;
  }
  if (action === 'resume') {
    changeScreen(model.kioskResume);
    return;
  }
  if (action === 'restore-state') {
    setState('default');
    return;
  }
  if (action === 'kds-done') {
    toast('Демо: отправлен запрос финальной сборки. Рабочая система ждёт подтверждение edge.');
    return;
  }
  const messages = {
    save: 'Демо: показано сохранение черновика. Серверные данные не изменены.',
    send: 'Демо: обращение или отзыв не отправлены. В рабочем приложении появится номер запроса.',
    publish:
      'Демо: перед публикацией потребуется проверить изменения и права. Меню не опубликовано.',
    revoke: 'Демо: отзыв потребует подтверждения управляющего и плана замены. Доступ не отозван.',
    approval: 'Демо: подтверждение полномочий выполняется сервером. Возврат не произведён.',
    promo: 'Демо: промокод проверяется сервером; скидка без подтверждения не применяется.',
    'payment-check': 'Результат остаётся неизвестным. Повторный платёж не запущен.',
    'receipt-check': 'Документ ККМ ещё ожидается. Фискальный номер не генерируется интерфейсом.',
    'cash-confirm': 'Демо: запрос принятия наличных. Реальный платёж и чек здесь не создаются.',
    delete: 'Демо: перед удалением нужен повторный вход и подтверждение последствий.',
    'qr-refresh': 'Демонстрационный QR не содержит токена. Рабочий код выдаст сервер.',
    language:
      'RU / KZ заложены в дизайн. В этой версии русский текст и двуязычное табло; полный перевод ждёт редактора.',
    filter: 'Выбран пример фильтра. Поиск по строкам таблицы работает в поле ниже.',
    period: 'Период макета: 06 сентября, Asia/Almaty. Метрики демонстрационные.',
    reconnect: 'Демо проверки связи: отдельно WAN, LAN, банк и ККМ.',
    sync: 'Демо: повтор обмена не должен создавать новые бизнес-операции.',
    audit: 'Журнал: сотрудник, операция, версия и причина. В макете данные демонстрационные.',
  };
  if (action === 'video-toggle') {
    const video = document.querySelector('#preview video');
    if (video) {
      // Before the first decoded frame, paused can still be true despite autoplay.
      // Follow the displayed command so Pause also cancels pending autoplay.
      if (el.dataset.videoCommand !== 'play') {
        video.autoplay = false;
        video.pause();
        el.dataset.videoCommand = 'play';
        el.textContent = '▶';
        el.setAttribute('aria-label', 'Включить фоновое видео');
      } else {
        if (video.error || video.networkState === video.NETWORK_NO_SOURCE) {
          video.pause();
          toast('Видео недоступно. Меню работает; показываем обложку.');
          return;
        }
        try {
          await video.play();
          if (!el.isConnected) {
            video.pause();
            return;
          }
          el.dataset.videoCommand = 'pause';
          el.textContent = 'Ⅱ';
          el.setAttribute('aria-label', 'Остановить фоновое видео');
        } catch {
          video.pause();
          toast('Видео недоступно. Меню работает; показываем обложку.');
        }
      }
    }
    return;
  }
  if (action) toast(messages[action] ?? 'Демонстрация действия. Внешние системы не вызываются.');
});
document.addEventListener('change', (event) => {
  if (event.target.dataset.kioskChoice) {
    model.kioskChoices[event.target.dataset.kioskChoice] =
      event.target.type === 'checkbox' ? event.target.checked : Number(event.target.value);
  }
  if (event.target.id === 'state-select') setState(event.target.value);
  if (event.target.dataset.action === 'assemble') {
    model.assembled = event.target.checked;
    render();
  }
  if (event.target.type === 'radio') {
    event.target
      .closest('.content')
      ?.querySelectorAll('.choice')
      .forEach((el) =>
        el.classList.toggle('selected', el.querySelector('input')?.checked ?? false),
      );
  }
});
document.addEventListener('input', (event) => {
  if (event.target.hasAttribute('data-cash-input')) {
    model.cash = Math.max(0, Math.min(999999, Number(event.target.value) || 0));
    const due = products[model.product].price * model.qty;
    document.querySelector('.cash-number').textContent = money(Math.max(0, model.cash - due));
    document.querySelector('[data-action="cash-confirm"]').disabled = model.cash < due;
  }

  if (event.target.id === 'screen-search') {
    const pos = event.target.selectionStart;
    search = event.target.value;
    const sidebar = document.querySelector('.atlas-nav');
    sidebar.outerHTML = nav();
    const input = document.querySelector('#screen-search');
    input.focus();
    input.setSelectionRange(pos, pos);
  }
  if (event.target.hasAttribute('data-table-search')) {
    const q = event.target.value.toLowerCase();
    document.querySelectorAll('#preview tbody tr').forEach((row) => {
      row.hidden = !row.textContent.toLowerCase().includes(q);
    });
  }
});
window.addEventListener('hashchange', () => {
  readHash();
  render();
  document.querySelector('#preview')?.focus({ preventScroll: true });
});
window.addEventListener('resize', fit);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && byId.get(selected)?.kind === 'game') {
    model.paused = true;
  }
});
window.addEventListener('focus', () => {
  if (byId.get(selected)?.kind === 'game' && model.paused) render();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && focus) {
    focus = false;
    render();
  }
});
render();
