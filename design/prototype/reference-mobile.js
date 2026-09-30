import { icon, go, photo, products, money, navList, esc, field } from './ui.js';
const asset = (file) => '/design/prototype/assets/mockup/' + file;
const logo = () =>
  `<span class="ref-mobile-logo"><img src="${asset('logo.png')}" alt="Pick Chick" /></span>`;
const video = () =>
  `<video class="ref-mobile-video" autoplay muted loop playsinline preload="metadata" poster="${asset('hero-poster.jpg')}" aria-hidden="true"><source src="${asset('hero.mp4')}" type="video/mp4" /></video>`;
const loyalty = (large = false) =>
  `<button class="ref-loyalty ${large ? 'large' : ''}" data-go="M23"><span class="ref-ring"><span>66%</span></span><span><strong>Пик-мастер</strong><small>1 240 Чиков · дорога к следующему пику</small></span>${icon('arrow')}</button>`;
const menuCards = (m) => {
  const selected = m.category === 'Все' ? 'Комбо' : m.category;
  const list = products.filter((p) => p.category === selected);
  return `<div class="ref-mobile-categories">${['Комбо', 'На двоих', 'На компанию', 'Допы', 'Напитки', 'Соусы'].map((c) => `<button class="chip ${c === selected ? 'selected' : ''}" data-category="${c}">${c}</button>`).join('')}</div><h2 class="ref-section-title">${esc(selected)}</h2><div class="ref-mobile-products ${['Допы', 'Напитки', 'Соусы'].includes(selected) ? 'compact' : ''}">${list.map((p, i) => `<button class="product-card ref-product-row" data-product="${products.indexOf(p)}" data-go="M07"><div class="ref-product-image">${photo(p.image, p.name)}${i === 0 ? '<span>ХИТ</span>' : ''}</div><div class="ref-product-text"><h3>${p.name}</h3><p>${p.desc}</p><strong>${money(p.price)} <span>+</span></strong></div></button>`).join('')}</div>`;
};
export function mobileReferenceView(s, m) {
  if (s.surface !== 'mobile') return null;
  const p = products[m.product];
  if (s.id === 'M04')
    return `<div class="content ref-profile-setup"><div class="ref-avatar">${icon('user')}</div><h1>Как вас называть?</h1><p class="muted">Добавьте ник для своего профиля. Этот шаг можно пропустить.</p>${field('Никнейм', '', 'text', 'Ваш ник')}<label class="checkline"><input type="checkbox" /><span>Показывать мой ник на табло рядом с номером</span></label><p class="fineprint">По умолчанию в зале виден только номер заказа. Согласие можно изменить в профиле.</p>${go('Сохранить и продолжить', 'M06', 'full')}${go('Пока пропустить', 'M06', 'secondary full')}</div>`;
  if (s.kind === 'menu')
    return `<div class="ref-mobile-menu"><div class="ref-mobile-hero">${video()}<div class="ref-mobile-gradient"></div><div class="ref-mobile-menu-header"><div class="ref-statusbar"><span>9:41</span><i></i><span>▮▮▮ ▰</span></div><div class="ref-menu-brand">${logo()}<button data-go="M05"><strong>Pick Chick</strong><small>Тестовая точка · самовывоз⌄</small></button><button class="ref-bell" data-go="M34" aria-label="Уведомления">${icon('info')}<i></i></button></div><div class="ref-segment"><button data-mode="С собой" class="${m.mode === 'С собой' ? 'selected' : ''}">Заберу сам</button><button data-mode="В зале" class="${m.mode === 'В зале' ? 'selected' : ''}">В зале</button></div></div><button class="ref-hero-caption" data-go="M08"><h1>Комбо недели</h1><span>Подробнее</span></button></div><div class="ref-menu-body">${loyalty()}${menuCards(m)}</div>${go(`${icon('bag')} Корзина <strong>${money(p.price * m.qty)}</strong>`, 'M09', 'ref-floating-cart')}</div>`;
  if (s.kind === 'welcome')
    return `<div class="ref-mobile-welcome"><div class="ref-welcome-brand">${logo()}<span>Pick Chick</span></div><h1>Твой выбор.<br>Твой пик.</h1><p>Хрустящий вкус, любимые комбо<br>и Чики за твои заказы.</p><div class="ref-welcome-dots"><b></b><i></i><i></i></div>${go('Начать', 'M06', 'orange full')}${go('Войти по номеру', 'M02', 'secondary full')}</div>`;
  if (s.kind === 'product')
    return `<div class="ref-product-detail"><div class="ref-product-cover">${photo(p.image, p.name)}${go('×', 'M06', 'ref-close', 'aria-label="Закрыть блюдо"')}</div><div class="content"><h1>${p.name}</h1><p class="muted">${p.desc}</p><div class="ref-nutrition"><span>Состав и аллергены<small>Информация из карточки блюда</small></span>${icon('info')}</div><h3>Соус на выбор</h3><label class="choice selected"><span>Фирменный<small>Входит в комбо</small></span><input type="radio" name="sauce" checked /></label><label class="choice"><span>Томатный<small>Без доплаты</small></span><input type="radio" name="sauce" /></label><label class="checkline"><input type="checkbox" /> Без лука</label><h3>Добавить к заказу</h3><div class="ref-extras">${photo('mockup/i4.jpg', 'Фингерс')}${photo('mockup/i20.jpg', 'Картофельные дольки')}</div>${go(`Добавить · ${money(p.price)}`, 'M09', 'orange full')}</div></div>`;
  if (s.kind === 'ready')
    return `<div class="ref-mobile-ready"><div class="row"><div><h1>Готово!</h1><p>Забирайте на кассе</p></div>${logo()}</div><div class="ref-ready-number">083</div><p>Ваш заказ ждёт на выдаче</p>${go('Состав и чек', 'M20', 'secondary full')}<span class="ref-ready-location">Тестовая точка · Алматы</span></div>`;
  if (s.kind === 'tracker')
    return `<div class="content ref-tracker"><div class="row"><span>Заказ принят</span><span class="pill">С собой</span></div><h1>Готовим<br>для вас</h1><div class="ref-tracker-number">083</div><p class="muted">Ориентировочно ещё 6-9 минут</p><div class="ref-progress"><span></span><span></span><i></i></div><div class="ref-tracker-steps"><p>✓ Оплата подтверждена</p><p>✓ Ресторан принял заказ</p><p>◉ Готовим и собираем</p><p class="muted">○ Можно забирать</p></div>${go('Состав и чек', 'M20', 'secondary full')}</div>`;
  if (s.kind === 'profile')
    return `<div class="content ref-profile"><div class="row"><div><span class="eyebrow muted">Личный кабинет</span><h1>Привет, гость!</h1></div><div class="ref-avatar">${icon('user')}</div></div><p class="muted">Твой вкус. Твои Чики. Твой пик.</p>${loyalty(true)}<div class="ref-profile-panels"><button data-go="M29" class="ref-profile-qr">${icon('grid')}<strong>Мой QR</strong><span>Показать на кассе</span></button><button data-go="M25" class="ref-profile-road">${icon('star')}<strong>Мои награды</strong><span>На пути к новому пику</span></button></div>${navList(
      [
        ['Мои заказы', 'История и чеки', 'M19'],
        ['Личные данные', 'Ник и настройки профиля', 'M04'],
        ['Уведомления и язык', 'Русский · настройки push', 'M34'],
        ['Помощь', 'Мы рядом', 'M31'],
        ['Документы', 'Условия и конфиденциальность', 'M33'],
        ['Удалить аккаунт', 'Управление данными', 'M32'],
      ],
    )}${go('Выйти', 'M01', 'secondary full')}</div>`;
  if (s.kind === 'wallet')
    return `<div class="content ref-wallet"><div><span class="eyebrow muted">Твоя лояльность</span><h1>Чики</h1></div><div class="ref-wallet-card"><div class="row"><span>Доступно</span>${icon('star')}</div><strong>1 240 <span>Ч</span></strong><p>Копи, выбирай, обменивай</p>${go('Мой QR', 'M29', 'secondary full')}</div>${loyalty()}<div class="ref-profile-panels"><button data-go="M24"><strong>История</strong><span>Все операции</span>${icon('receipt')}</button><button data-go="M25"><strong>Дорога наград</strong><span>Твой следующий пик</span>${icon('star')}</button></div>${navList(
      [
        ['События', 'Игры и новые впечатления', 'M26'],
        ['Правила программы', 'Условия начисления и обмена', 'M33'],
      ],
    )}</div>`;
  if (s.kind === 'events')
    return `<div class="content ref-events"><h1>События</h1><p class="muted">Играй. Собирай. Открывай новое.</p><button class="ref-event-poster" data-go="M27">${photo('mockup/pickrun-poster.png', 'Pick Run')}<span class="pill orange">Доступно · демоигра</span></button><div class="row"><div><h2>Pick Run</h2><p class="muted">Твой хрустящий забег</p></div>${go('Играть', 'M27', 'orange')}</div><div class="ref-event-next"><span class="eyebrow">СКОРО</span><h2>Больше поводов<br>заглянуть к нам</h2><p>Следи за событиями Pick Chick</p></div></div>`;
  return null;
}
export function mobileReferenceShell(s, content) {
  if (s.surface !== 'mobile') return null;
  const full = ['menu', 'welcome', 'product', 'ready'].includes(s.kind);
  const nav = [
    ['M06', 'bag', 'Меню'],
    ['M26', 'game', 'События'],
    ['M19', 'receipt', 'Заказы'],
    ['M30', 'user', 'Профиль'],
  ];
  return `<div class="ref-mobile-shell ref-mobile-page-${s.kind}">${full ? '' : `<div class="ref-statusbar"><span>9:41</span><i></i><span>▮▮▮ ▰</span></div><header class="ref-mobile-page-header">${go(icon('back'), 'M06', 'ref-back', 'aria-label="Вернуться в меню"')}<span>${s.title}</span>${logo()}</header>`}<main class="ref-mobile-main">${content}</main>${s.kind === 'welcome' || s.kind === 'ready' ? '' : `<nav class="bottom-nav" aria-label="Навигация приложения">${nav.map(([id, i, label]) => `<button data-go="${id}" class="${s.id === id ? 'active' : ''}">${icon(i)}<span>${label}</span></button>`).join('')}<i class="ref-home-indicator"></i></nav>`}</div>`;
}
