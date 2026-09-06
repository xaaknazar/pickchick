import { icon, esc, go, act, products, money, photo, notice } from './ui.js';

const asset = (name) => `/design/prototype/assets/mockup/${name}`;
const logo = () =>
  `<span class="rk-logo"><img src="${asset('logo.png')}" alt="Pick Chick" /></span>`;
const language = () =>
  `<div class="rk-language" aria-label="Язык интерфейса">${act('KZ', 'language', '', 'lang="kk" aria-label="Қазақша"')}${act('RU', 'language', 'selected', 'aria-label="Русский"')}</div>`;
const video = () =>
  `<video class="rk-video" src="${asset('hero.mp4')}" poster="${asset('hero-poster.jpg')}" autoplay muted loop playsinline aria-hidden="true" tabindex="-1"></video>`;
const amount = (m) => products[m.product].price * m.qty;
export function kioskCartDescription(m) {
  const choices = m.kioskChoices ?? {};
  if (m.kioskCartKind === 'combo') {
    return [
      ['Pick Combo', 'Master Combo'][choices['combo-1'] ?? 0],
      ['Фирменный соус', 'Томатный соус'][choices['combo-2'] ?? 0],
      ['Cola · 0,5 л', 'Вода · 0,5 л'][choices['combo-3'] ?? 0],
    ].join(' · ');
  }
  return [
    ['Фирменный соус', 'Томатный соус'][choices[`product-${m.product}-sauce`] ?? 0],
    choices[`product-${m.product}-no-onion`] ? 'Без лука' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
const topbar = (back, mode = '', locked = false) =>
  `<header class="rk-topbar">${locked ? '' : go(icon('back'), back, 'rk-back', 'aria-label="Назад"')}${logo()}${mode ? `<span class="rk-mode-label"><i></i>${esc(mode)}</span>` : '<span class="rk-wordmark">PICK CHICK</span>'}<span class="rk-spacer"></span>${locked ? '' : go('Отмена', 'K14', 'rk-cancel')}${language()}</header>`;
const full = (classes, body) =>
  `<div class="rk-screen rk-full ${classes}" data-kiosk-layout="full">${body}</div>`;

function menu(m) {
  const category = m.category || 'Все';
  const visible =
    category === 'Все' || category === 'Популярное'
      ? products
      : products.filter((p) => p.category === category);
  const categoryNames = ['Все', ...new Set(products.map((p) => p.category))];
  return full(
    'rk-menu',
    `${topbar('K02', m.mode)}<nav class="rk-categories" aria-label="Категории меню">${categoryNames.map((c) => `<button class="rk-category ${category === c ? 'selected' : ''}" data-category="${esc(c)}" aria-pressed="${category === c}">${esc(c)}</button>`).join('')}</nav><main class="rk-menu-scroll"><button class="rk-promo" data-go="K05" data-product="0"><span class="rk-promo-copy"><span class="rk-kicker">КОМБО НЕДЕЛИ</span><strong>PICK COMBO</strong><span>Фингерсы, фри и любимый соус.<br>Собери свой идеальный набор.</span></span><span class="rk-promo-action"><strong>${money(products[0].price)}</strong><span>Выбрать ${icon('arrow')}</span></span></button><div class="rk-product-grid">${visible.map((p, i) => `<button class="product-card rk-product-card" data-product="${products.indexOf(p)}" data-go="K04"><span class="rk-product-image">${photo(p.image, p.name)}${i === 0 ? '<span class="rk-product-tag">ХИТ</span>' : ''}</span><span class="rk-product-copy"><strong>${esc(p.name)}</strong><span>${esc(p.desc)}</span><span class="rk-price-row"><strong>${money(p.price)}</strong><span class="rk-add" aria-hidden="true">+</span></span></span></button>`).join('')}</div>${visible.length ? '' : notice('В этой категории пока нет доступных блюд. Выберите другую категорию.')}</main><footer class="rk-cartbar"><div><span>В КОРЗИНЕ: ${m.qty} ПОЗ.</span><strong>${money(amount(m))}</strong></div>${go('Оформить заказ →', 'K06', 'rk-checkout')}</footer>`,
  );
}

function product(m, isCombo) {
  const p = products[m.product];
  const step = m.comboStep;
  const options = isCombo
    ? step === 1
      ? ['Pick Combo', 'Master Combo']
      : step === 2
        ? ['Фирменный соус', 'Томатный соус']
        : ['Cola · 0,5 л', 'Вода · 0,5 л']
    : ['Фирменный соус', 'Томатный соус'];
  const choiceKey = isCombo ? `combo-${step}` : `product-${m.product}-sauce`;
  const selectedOption = m.kioskChoices?.[choiceKey] ?? 0;
  const onionKey = `product-${m.product}-no-onion`;
  const title = isCombo ? ['', 'Выберите основу', 'Добавьте соус', 'И напиток'][step] : p.name;
  return full(
    'rk-detail',
    `<div class="rk-detail-photo">${photo(p.image, p.name)}</div><div class="rk-detail-veil"></div>${go('×', 'K03', 'rk-close', 'aria-label="Закрыть карточку"')}<div class="rk-detail-heading">${isCombo ? `<span class="rk-detail-eyebrow">${esc(p.name.toUpperCase())} · ШАГ ${step} ИЗ 3</span>` : ''}<h1>${esc(title)}</h1><p>${esc(p.desc)}</p><span>Состав и аллергены — по утверждённой карточке блюда</span></div><div class="rk-detail-options">${isCombo ? `${step > 1 ? act('← Предыдущий шаг', 'kiosk-combo-back', 'rk-combo-back') : ''}<div class="rk-progress" aria-label="Шаг ${step} из 3">${[1, 2, 3].map((n) => `<i class="${n <= step ? 'on' : ''}"></i>`).join('')}</div>` : ''}<div class="rk-group-heading"><h2>${isCombo ? 'Ваш выбор' : 'Выберите соус'}</h2><span>ОБЯЗАТЕЛЬНО</span></div><div class="rk-option-grid">${options.map((o, i) => `<label class="rk-option"><input type="radio" name="${isCombo ? 'combo' : 'sauce'}" ${selectedOption === i ? 'checked' : ''} value="${i}" data-kiosk-choice="${choiceKey}" /><span>${esc(o)}<small>Без доплаты</small></span></label>`).join('')}</div>${!isCombo ? `${go('Собрать комбо по шагам', 'K05', 'rk-outline full')}<div class="rk-group-heading"><h2>Пожелания</h2><span>ПО ЖЕЛАНИЮ</span></div><label class="rk-option"><input type="checkbox" data-kiosk-choice="${onionKey}" ${m.kioskChoices?.[onionKey] ? 'checked' : ''} /><span>Без лука<small>Если предусмотрено рецептурой</small></span></label>` : ''}<p class="rk-detail-note">Обязательные варианты выбраны для просмотра макета. Доступность и итоговую цену проверит сервер.</p></div><footer class="rk-detail-footer">${!isCombo ? `<div class="rk-quantity">${act('−', 'decrement', '', 'aria-label="Уменьшить количество"')}<strong>${m.qty}</strong>${act('+', 'increment', '', 'aria-label="Увеличить количество"')}</div>` : `<strong class="rk-detail-total">${money(amount(m))}</strong>`}${isCombo && step < 3 ? act('Далее →', 'combo-next', 'rk-checkout') : go(`В корзину · ${money(amount(m))}`, 'K06', 'rk-checkout')}</footer>`,
  );
}

export function kioskView(s, m) {
  if (s.surface !== 'kiosk') return null;
  switch (s.id) {
    case 'K01':
      return full(
        'rk-attract',
        `${video()}<div class="rk-attract-veil"></div><button class="rk-attract-target" data-go="K02" aria-label="Коснитесь экрана, чтобы начать заказ"></button><header class="rk-attract-header">${logo()}<div class="rk-attract-controls">${language()}</div></header><div class="rk-attract-copy"><div><h1>PICK YOUR<br>PEAK</h1><p>Твой вкус. Твой момент.</p></div>${go(`НАЧАТЬ ${icon('arrow')}`, 'K02', 'rk-start')}<span>Коснись экрана и сделай свой выбор</span></div>`,
      );
    case 'K02':
      return full(
        'rk-mode',
        `${topbar('K01')}<main class="rk-mode-body"><h1>Где будете есть?</h1><div class="rk-mode-grid"><button class="rk-mode-tile dine" data-mode="В зале" data-go="K03">${icon('cup')}<strong>В ЗАЛЕ</strong><span>Насладись моментом здесь</span></button><button class="rk-mode-tile takeaway" data-mode="С собой" data-go="K03">${icon('bag')}<strong>С СОБОЙ</strong><span>Забери любимое с собой</span></button></div></main>`,
      );
    case 'K03':
      return menu(m);
    case 'K04':
      return product(m, false);
    case 'K05':
      return product(m, true);
    case 'K12':
      return full(
        'rk-ready',
        `${topbar('K03', '', true)}<main class="rk-ready-body"><span class="rk-ready-check">${icon('check')}</span><h1>Ваш заказ принят!</h1><p>Оплата подтверждена</p><div class="rk-order-number">083</div><h2>Следите за номером на табло</h2><p>Приготовим горячим и позовём, когда всё будет готово.</p><div class="rk-receipt-note">${icon('receipt')} Чек: ожидаем документ ККМ</div>${go('Завершить и скрыть данные', 'K01', 'rk-checkout full')}<small>После завершения экрана контакты скрываются.</small></main>`,
      );
    case 'K16':
      if (!m.kioskHelpFrom) return null;
      return full(
        'rk-generic rk-maintenance',
        `${topbar('K03', '', true)}<main class="rk-body"><span class="rk-step-label">PICK CHICK · ПОМОЩЬ С ОПЛАТОЙ</span><h1>Обратитесь к сотруднику</h1><div class="content"><div class="status-hero"><div class="status-disc">${icon('info')}</div><h2>Назовите номер 083</h2><p class="muted">Банк ещё проверяет платёж. Не оплачивайте заказ повторно; сотрудник поможет выяснить результат.</p></div>${go('Вернуться к проверке оплаты', m.kioskHelpFrom, 'full')}${notice('Переход к помощи не запускает и не отменяет платёж. Повторный заказ станет доступен после окончательного результата.')}</div></main>`,
      );
    default:
      return null;
  }
}

export function kioskShell(s, content) {
  if (s.surface !== 'kiosk') return null;
  if (content.includes('data-kiosk-layout="full"')) return content;
  const previous = {
    K06: 'K03',
    K07: 'K06',
    K08: 'K07',
    K09: 'K07',
    K10: 'K09',
    K11: 'K09',
    K13: 'K06',
  };
  return `<div class="rk-screen rk-generic rk-${esc(s.kind)}">${topbar(previous[s.id] || 'K03', '', ['payment', 'unknown', 'busy'].includes(s.kind))}<main class="rk-body"><span class="rk-step-label">PICK CHICK · ЗАКАЗ БЕЗ РЕГИСТРАЦИИ</span><h1>${esc(s.title)}</h1>${content}</main></div>`;
}
