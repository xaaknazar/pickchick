import { mobileReferenceView, mobileReferenceShell } from './reference-mobile.js';
import { kioskView, kioskShell, kioskCartDescription } from './reference-kiosk.js';
import { operationsView, operationsShell } from './reference-operations.js';
import {
  icon,
  esc,
  go,
  act,
  pill,
  notice,
  field,
  summary,
  navList,
  products,
  money,
  photo,
  productGrid,
  categories,
  timeline,
  table,
  qr,
  brands,
} from './ui.js';

const links = (s) =>
  s.surface === 'kiosk'
    ? {
        menu: 'K03',
        product: 'K04',
        combo: 'K05',
        cart: 'K06',
        claim: 'K07',
        pay: 'K09',
        order: 'K12',
        support: 'K16',
      }
    : s.surface === 'pos'
      ? {
          menu: 'P03',
          product: 'P20',
          combo: 'P21',
          cart: 'P03',
          claim: 'P06',
          pay: 'P08',
          order: 'P05',
          support: 'P10',
        }
      : {
          menu: 'M06',
          product: 'M07',
          combo: 'M08',
          cart: 'M09',
          claim: 'M29',
          pay: 'M13',
          order: 'M20',
          support: 'M31',
        };
const card = (html) => `<div class="card">${html}</div>`;
const amount = (model) => products[model.product].price * model.qty;
const cartLine = (model, surface = '') => {
  const p = products[model.product];
  return `<div class="cart-line">${photo(p.image, p.name)}<div><h3>${p.name}</h3><small class="muted">${surface === 'kiosk' ? esc(kioskCartDescription(model)) : 'Фирменный соус · стандарт'}</small><div class="stepper"><button data-action="decrement" aria-label="Уменьшить количество">−</button><strong>${model.qty}</strong><button data-action="increment" aria-label="Увеличить количество">+</button></div></div><strong class="line-amount" style="margin-left:auto">${money(amount(model))}</strong></div>`;
};
const checkoutSummary = (model) =>
  summary([
    ['Блюда', money(amount(model))],
    ['Скидки', '0 ₸'],
    ['К оплате', money(amount(model)), true],
  ]);
const stateRows = () =>
  navList([
    ['Оплата', 'Банк подтвердил · 16:42', 'M16'],
    ['Чек', 'Ожидаем документ ККМ', 'M21'],
    ['Кухня', 'Сборка · 2 из 3 компонентов', 'M17'],
  ]);
function mobileView(s, m) {
  const l = links(s),
    p = products[m.product];
  switch (s.kind) {
    case 'welcome':
      return `<div class="phone-welcome"><div class="row"><span class="eyebrow">Хруст начинается здесь</span><button class="btn secondary small" data-action="language">RU / KZ</button></div>${photo('brand-logo.png', 'Логотип PickChick', 'welcome-logo')}<h1>Твой выбор.<br>Твой хруст.</h1><p>Заказывай без очереди, забирай горячим и открывай больше с Чиками.</p><div class="welcome-bottom">${go(s.surface === 'kiosk' ? 'Начать заказ' : 'Выбрать вкусное', s.surface === 'kiosk' ? 'K02' : 'M06', 'orange full')}${go(s.surface === 'kiosk' ? 'Қазақша' : 'Войти по номеру', s.surface === 'kiosk' ? 'K02' : 'M02', 'secondary full')}<p class="fineprint" style="color:#dbe8ff">${s.surface === 'kiosk' ? 'Заказ без регистрации · Тапсырыс тіркелусіз' : 'Меню можно смотреть без входа'}</p></div></div>`;
    case 'phone':
      return `<div class="content"><p class="muted">Номер нужен, чтобы видеть заказы и пользоваться Чиками.</p>${field('Казахстанский номер', '', 'tel', '+7 (7••) ••• •• ••')}<p class="fineprint">Код придёт в SMS. Регистрация и вход — один шаг.</p>${go('Получить код', 'M03', 'full')}${go('Пока посмотреть меню', 'M06', 'secondary full')}<p class="fineprint">Продолжая, вы принимаете условия оферты и обработки данных.</p>${go('Прочитать документы', 'M33', 'secondary full')}</div>`;
    case 'otp':
      return `<div class="content"><p class="muted">Введите код из SMS или выберите его над клавиатурой.</p><label class="form-field">Код из SMS<input class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" aria-label="Шестизначный код из SMS" /></label>${go('Подтвердить · демопереход', 'M12', 'full')}${act('Отправить снова через 00:43', 'limited', 'secondary full', 'disabled')}<p class="fineprint">Если код не пришёл, дождитесь повторной отправки или проверьте номер.</p>${go('Изменить номер', 'M02', 'secondary full')}</div>`;
    case 'branches':
      return `<div class="content"><p class="muted">Выберите, где заберёте заказ. Корзина пересчитается для этой точки.</p><div class="illustrated-map"><span class="map-pin">${icon('pin')} PickChick</span></div>${card(`<div class="row"><h3>Тестовая точка</h3>${pill('Открыто', 'green')}</div><p class="muted" style="margin:12px 0">Алматы · адрес предоставит PickChick</p><p class="fineprint">Часы работы — из справочника точки</p>${go('Выбрать этот ресторан', 'M06', 'full')}`)}${notice('При смене ресторана проверим цены и доступность блюд.')}</div>`;
    case 'menu':
      return `<div class="content"><div class="row"><div><span class="eyebrow muted">Сегодня хочется</span><h2>Чего-то хрустящего</h2></div>${go(icon('pin'), s.surface === 'kiosk' ? 'K02' : 'M05', 'secondary', 'aria-label="Выбрать ресторан"')}</div><div class="brand-hero"><div class="hero-copy"><small>ВКУСНО В КОМПАНИИ</small><h2>Два бургера.<br>Один план.</h2>${go('Собрать комбо', l.combo, 'orange small')}</div>${photo('duo.jpg', 'Комбо на двоих')}</div>${categories(m.category)}<div class="section-head"><h2>Наши хиты</h2><span class="fineprint">Готовим после заказа</span></div>${productGrid(l.product, m.category)}${go(`${icon('bag')} Корзина · ${money(amount(m))}`, l.cart, 'full')}</div>`;
    case 'product':
      return `<div class="content">${photo(p.image, p.name, 'product-hero')}<div><div class="row"><h2>${p.name}</h2>${pill('Хит')}</div><p class="muted" style="margin-top:12px">${p.desc}. Горячее приготовление после заказа.</p></div>${notice('Состав, вес, КБЖУ и аллергены заполняются из утверждённой карточки блюда.')}<h3>Выберите соус <span class="fineprint">· обязательно</span></h3><label class="choice selected"><span>Фирменный<small>Входит в стоимость</small></span><input type="radio" name="sauce" checked /></label><label class="choice"><span>Томатный<small>Без доплаты</small></span><input type="radio" name="sauce" /></label><label class="checkline"><input type="checkbox" /> Без лука</label>${go(`Добавить · ${money(p.price)}`, l.cart, 'full')}</div>`;
    case 'combo':
      return `<div class="content"><div class="step-head"><span class="on"></span><span class="${m.comboStep > 1 ? 'on' : ''}"></span><span class="${m.comboStep > 2 ? 'on' : ''}"></span></div><p class="eyebrow muted">Шаг ${m.comboStep} из 3 · ${['', 'Основа', 'Соус', 'Напиток'][m.comboStep]}</p>${photo('duo.jpg', 'Комбо на двоих', 'product-hero')}<h2>${['', 'Выберите основу', 'Добавьте соус', 'И напиток'][m.comboStep]}</h2>${(m.comboStep === 1 ? ['Два Чик Бургера', 'Стрипсы на двоих'] : m.comboStep === 2 ? ['Фирменный', 'Томатный'] : ['Cola · 0,5 л', 'Вода · 0,5 л']).map((name, i) => `<label class="choice ${i === 0 ? 'selected' : ''}"><span>${name}<small>Входит в комбо</small></span><input type="radio" name="combo" ${i === 0 ? 'checked' : ''}/></label>`).join('')}${m.comboStep < 3 ? act('Далее', 'combo-next', 'full') : go('Добавить выбранное комбо', l.cart, 'full')}${notice('Подтверждение доступно после обязательного выбора в каждой группе.')}</div>`;
    case 'cart':
      return `<div class="content">${card(cartLine(m, s.surface))}${card(`<h3>Есть промокод?</h3><div style="margin-top:12px">${field('Промокод', '', 'text', 'Введите код')}</div>${act('Применить', 'promo', 'secondary full')}`)}${card(checkoutSummary(m))}<p class="fineprint">Чики за покупку появятся после подтверждённой оплаты и выдачи. Правила начисления ещё согласуются.</p>${go('Продолжить', s.surface === 'kiosk' ? 'K07' : 'M12', 'full')}${go('Добавить ещё', l.menu, 'secondary full')}</div>`;
    case 'changed':
      return `<div class="content">${notice('Пока вы выбирали, меню обновилось. Проверьте изменения перед оплатой.', 'warning')}${card(
        summary([
          ['Чик Бургер комбо', '3 490 → 3 590 ₸'],
          ['Фирменный соус', 'Временно недоступен'],
        ]),
      )}<p class="muted">Ничего не заменим без вашего подтверждения.</p>${go('Вернуться и пересчитать', 'M09', 'full')}${go('Выбрать другое блюдо', 'M06', 'secondary full')}</div>`;
    case 'unavailable':
      return status(
        'clock',
        'Сейчас не принимаем заказы',
        'Ресторан временно приостановил приём. Корзина сохранена.',
        go('Выбрать ресторан', 'M05', 'full'),
      );
    case 'checkout':
      return `<div class="content">${card(`<span class="eyebrow muted">Ресторан</span><h3 style="margin-top:8px">Тестовая точка · Алматы</h3><p class="fineprint" style="margin-top:8px">Получение в ближайшее время · оценку уточнит ресторан</p>`)}<h3>Как будете есть?</h3><div class="row"><button class="choice ${m.mode === 'В зале' ? 'selected' : ''}" data-mode="В зале">${icon('cup')} В зале</button><button class="choice ${m.mode === 'С собой' ? 'selected' : ''}" data-mode="С собой">${icon('bag')} С собой</button></div>${card(checkoutSummary(m))}<label class="choice selected"><span><strong>Kaspi</strong><small>Переход к банковской оплате</small></span>${icon('lock')}</label>${notice('Демонстрация оплаты: деньги не списываются.')}<p class="fineprint">Не вошли в аккаунт? Перед оплатой подтвердите номер.</p>${go('Подтвердить номер', 'M02', 'secondary full')}${go(`К оплате · ${money(amount(m))}`, 'M13', 'full')}</div>`;
    case 'mode':
      return `<div class="content"><p class="muted">Приготовим горячим. Выберите удобный способ получения.</p><div class="mode-grid">${[
        ['cup', 'В зале'],
        ['bag', 'С собой'],
      ]
        .map(
          ([i, t]) =>
            `<button class="mode-card" data-mode="${t}" data-go="K03">${icon(i)}<strong>${t}</strong><small>${t === 'В зале' ? 'Осында' : 'Өзіңізбен бірге'}</small></button>`,
        )
        .join('')}</div></div>`;
    case 'claim':
      return `<div class="content"><p class="muted">Укажите номер для начисления Чиков за эту покупку.</p>${field('Номер телефона', '', 'tel', '+7 (7••) ••• •• ••')}${notice('Телефон не открывает баланс и не разрешает тратить Чики. Владение номером нужно подтвердить в приложении.')}<label class="checkline"><input type="checkbox"/> Согласен на обработку номера для начисления</label>${go('Продолжить', s.next, 'full')}${go('Без Чиков', s.next, 'secondary full')}${go('У меня есть QR', s.surface === 'kiosk' ? 'K08' : 'P22', 'secondary full')}</div>`;
    case 'scan':
      return status(
        'grid',
        'Покажите QR из приложения',
        'Наведите код на сканер. Одноразовый код подтверждает доступ к вашей лояльности.',
        qr() + go('Продолжить без QR', s.surface === 'kiosk' ? 'K09' : 'P03', 'secondary full'),
      );
    case 'payment':
      return status(
        'phone',
        s.surface === 'kiosk' ? 'Оплатите на терминале' : 'Ожидаем оплату',
        `Заказ №083 · ${money(amount(m))}. ${s.surface === 'mobile' ? 'Вернитесь сюда после оплаты в приложении банка.' : 'Следуйте указаниям закреплённого терминала.'}`,
        card(
          summary([
            ['Заказ', '№083'],
            ['Сумма', money(amount(m))],
            ['Состояние', 'Ожидаем ответ банка'],
          ]),
        ) +
          go('Проверить состояние', s.next, 'full') +
          go('Нужна помощь', l.support, 'secondary full'),
      );
    case 'unknown':
      return status(
        'clock',
        'Проверяем платёж',
        'Ответ банка пока не получен. Не оплачивайте этот заказ повторно. Номер и попытка оплаты сохранены.',
        notice(
          'Если деньги списались, дождитесь проверки или обратитесь к сотруднику.',
          'warning',
        ) +
          act('Проверить ещё раз', 'payment-check', 'full') +
          go('Нужна помощь', l.support, 'secondary full'),
      );
    case 'failed':
      return status(
        'info',
        'Оплата не завершена',
        'Предыдущая попытка завершилась отказом. Можно выбрать способ оплаты снова.',
        go('Вернуться к оплате', 'M12', 'full'),
      );
    case 'paid':
      return status(
        'check',
        'Оплачено',
        'Передаём заказ ресторану. Пока не получили подтверждение кухни.',
        card(
          summary([
            ['Номер', '083'],
            ['Оплата', 'Подтверждена банком'],
            ['Ресторан', 'Ожидаем принятия'],
            ['Чек', 'Проверяем состояние'],
          ]),
        ) + go('Посмотреть заказ', 'M20', 'full'),
      );
    case 'tracker':
      return `<div class="content"><div class="status-hero"><span class="pill">С собой · тестовая точка</span><div class="number-hero">083</div><h2>Готовим для вас</h2><p class="muted">Ориентировочно ещё 6–9 минут</p></div>${card(
        timeline([
          ['Оплата подтверждена', '16:42 · ответ банка', 'done'],
          ['Ресторан принял', '16:42 · кухня получила заказ', 'done'],
          ['Готовим и собираем', 'Завершаем обязательные компоненты', 'current'],
          ['Можно забирать', 'Уведомим, когда всё будет готово', ''],
        ]),
      )}${go('Состав и чек', 'M20', 'secondary full')}</div>`;
    case 'ready':
      return `<div class="content"><div class="status-hero"><span class="pill green">${s.surface === 'kiosk' ? 'Заказ оплачен' : 'Готов к выдаче'}</span><div class="number-hero">083</div><h2>${s.surface === 'kiosk' ? 'Ваш заказ принят' : 'Всё готово!'}</h2><p class="muted">${s.surface === 'kiosk' ? 'Следите за номером на табло.' : 'Назовите номер на выдаче.'}</p></div>${card(`<h3>Тестовая точка · Алматы</h3><p class="muted" style="margin-top:10px">${s.surface === 'kiosk' ? 'Чек: ожидаем документ ККМ' : 'У стойки выдачи заказов'}</p>`)}${s.surface === 'mobile' ? go('Посмотреть состав', 'M20', 'secondary full') : go('Завершить и скрыть данные', 'K01', 'full')}<p class="fineprint">${s.surface === 'mobile' ? 'Получение отмечает сотрудник. Здесь нет кнопки, которая начисляет бонусы за выдачу.' : 'После завершения экрана контакты скрываются.'}</p></div>`;
    case 'history':
      return `<div class="content">${navList([
        ['№083 · Готовится', 'Сегодня · С собой · 3 490 ₸', 'M20'],
        ['№074 · Выдан', 'Демонстрационный заказ · 6 290 ₸', 'M20'],
        ['№061 · Возвращён', 'Возврат завершён · чек получен', 'M22'],
      ])}${go('Повторить последний заказ', 'M10', 'full')}<p class="fineprint">Перед повтором проверим текущие цены и стоп-лист.</p></div>`;
    case 'order':
      return orderView(s, m);
    case 'receipt':
      return `<div class="content">${notice('Оплата и чек имеют отдельные состояния. В этом примере банк подтвердил оплату, документ ККМ ещё ожидается.', 'warning')}${card(
        `<span class="eyebrow muted">Электронный документ</span><h2 style="margin:18px 0">Чек формируется</h2>${summary(
          [
            ['Заказ', '№083'],
            ['Сумма', money(amount(m))],
            ['Фискальный номер', 'Ещё не получен'],
            ['ККМ', 'Ожидаем подтверждение'],
          ],
        )}`,
      )}${act('Проверить документ', 'receipt-check', 'full')}${go('К заказу', s.surface === 'pos' ? 'P05' : s.surface === 'backoffice' ? 'B04' : 'M20', 'secondary full')}</div>`;
    case 'refund':
      return `<div class="content">${notice('Отмена заказа, возврат денег и возвратный чек выполняются отдельно.', 'warning')}${card(`<h3>Что возвращаем</h3><label class="checkline"><input type="checkbox" checked /> ${p.name} · ${money(p.price)}</label>${summary([['К возврату', money(p.price), true]])}`)}${field('Причина', '', 'text', 'Укажите причину возврата')}${card(
        timeline([
          ['Запрос возврата', 'Проверка состава и полномочий', 'current'],
          ['Деньги', 'Ожидаем подтверждение банка', ''],
          ['Возвратный чек', 'После подтверждённой операции', ''],
          ['Чики и склад', 'Отдельные корректировки', ''],
        ]),
      )}${s.surface === 'mobile' ? go('Связаться с поддержкой', 'M31', 'full') : go('Проверить и подтвердить', s.surface === 'pos' ? 'P12' : 'B20', 'full')}<p class="fineprint">Приготовленное блюдо не возвращается на склад автоматически.</p></div>`;
    case 'wallet':
      return `<div class="content"><div class="wallet-card"><div class="row"><span>Доступно Чиков</span>${icon('star')}</div><div class="balance">1 240 <span style="font-size:23px">Ч</span></div><p>Демонстрационный баланс кошелька</p></div>${go(`${icon('grid')} Показать мой QR`, 'M29', 'full')}${card(`<div class="row"><h3>Следующая награда</h3><span class="fineprint">Дорога наград</span></div><div class="progress-track"><span></span></div><p class="fineprint">Прогресс не уменьшает доступный кошелёк. Условия поступают из правил программы.</p>`)}${navList(
        [
          ['История Чиков', 'Начисления, списания и сроки', 'M24'],
          ['Дорога наград', 'Отдельный прогресс покупок', 'M25'],
          ['Условия программы', 'Правила и ограничения', 'M33'],
        ],
      )}</div>`;
    case 'ledger':
      return `<div class="content">${notice('Здесь отдельно видны доступные, зарезервированные и ожидаемые операции.')}${navList(
        [
          ['Покупка №074 · +240 Ч', 'Начислено после выдачи · пример', 'M20'],
          ['Заказ №083 · ожидается', 'До оплаты и выдачи баланс не увеличивается', 'M20'],
          ['Резерв · 100 Ч', 'Временно недоступны для другой покупки', 'M23'],
          ['Срок партии', 'Условия истечения должны быть утверждены', 'M33'],
        ],
      )}</div>`;
    case 'rewards':
      return `<div class="content">${card(`<h2>Больше любимого</h2><p class="muted" style="margin-top:12px">Копите прогресс покупок и открывайте награды.</p><div class="progress-track"><span></span></div><strong>3 из 5 шагов · демонстрация</strong>`)}${navList(
        [
          ['Шаг 1 · Знакомство', 'Получено', 'M23'],
          ['Шаг 3 · Любимый вкус', 'Текущий прогресс', 'M23'],
          ['Шаг 5 · Награда', 'Условия награды на согласовании', 'M33'],
        ],
      )}${notice('Дорога наград, уровень и расходуемые Чики — разные показатели.')}</div>`;
    case 'events':
      return `<div class="content"><div class="game-poster">${photo('pick-run.jpg', 'Брендовый постер Pick Run')}<div><span class="pill orange">Короткая игра · 2D</span><h2>Pick Run</h2><p>Лови момент. Собирай хруст.</p></div></div>${go('Открыть игру', 'M27', 'full')}${notice('Игра в деморежиме. Условия наград появятся перед запуском.')}${card(`<h3>Новые события впереди</h3><p class="muted" style="margin-top:10px">Следите за анонсами PickChick.</p>`)}</div>`;
    case 'game':
      return `<div class="content"><div class="row">${pill('Демо механики')}<strong>Собрано: ${m.score}</strong></div><div class="game-lanes" aria-label="Пример простой 2D-механики">${[0, 1, 2].map((i) => `<button data-action="coin" aria-label="Собрать Чик ${i + 1}">Ч</button>`).join('')}<span class="runner" aria-hidden="true">✦</span>${m.paused ? '<div class="demo-pause"><h2>Пауза</h2><p>Вернитесь, когда будете готовы.</p></div>' : ''}</div>${act(m.paused ? 'Продолжить' : 'Пауза', 'pause', 'secondary full')}${go('Завершить демосессию', 'M28', 'full')}<p class="fineprint">Нажатия показывают управление. Баланс Чиков от них не меняется.</p></div>`;
    case 'game-result':
      return status(
        'clock',
        'Проверяем результат',
        'Игра завершена. Проверяем результат — награда пока не начислена.',
        card(
          summary([
            ['Собрано в демо', String(m.score)],
            ['Проверка', 'Ожидается'],
            ['Начисление', 'Ещё не выполнено'],
          ]),
        ) + go('К событиям', 'M26', 'full'),
      );
    case 'qr':
      return `<div class="content">${qr()}<h2 style="text-align:center">Покажите на кассе</h2><p class="muted" style="text-align:center">Код подтверждает доступ к вашей лояльности. Он действует ограниченное время.</p>${pill('Обновится через 00:24')}${act('Обновить код', 'qr-refresh', 'full')}${notice('Пример не содержит реального токена. Публичный телефон в коде не используется.')}</div>`;
    case 'profile':
      return `<div class="content">${card(`<div class="row"><div class="status-disc">${icon('user')}</div><div><h2>Привет, гость</h2><p class="muted">Ник можно добавить позже</p></div></div>`)}${navList(
        [
          ['Мои заказы', 'История и чеки', 'M19'],
          ['Чики', 'Кошелёк и дорога наград', 'M23'],
          ['Личные данные', 'Необязательный ник', 'M04'],
          ['Язык и уведомления', 'Русский · сервисные push', 'M34'],
          ['Помощь', 'Связаться с PickChick', 'M31'],
          ['Документы', 'Правила и конфиденциальность', 'M33'],
          ['Удалить аккаунт', 'Управление данными', 'M32'],
        ],
      )}${go('Выйти из аккаунта', 'M01', 'secondary full')}</div>`;
    case 'settings':
      return `<div class="content"><h3>Язык приложения</h3><label class="choice selected"><span>Русский</span><input type="radio" name="language" checked /></label><label class="choice"><span>Қазақша</span><input type="radio" name="language" /></label><h3>Уведомления</h3><label class="checkline"><input type="checkbox" checked /> Статусы заказа</label><label class="checkline"><input type="checkbox" /> Акции и события</label>${notice('Рекламные уведомления требуют отдельного согласия. Настройки ОС могут ограничивать push.')}${act('Сохранить настройки', 'save', 'full')}</div>`;
    case 'support':
      return `<div class="content"><p class="muted">Расскажите, что случилось. Номер заказа поможет быстрее разобраться.</p>${field('Номер заказа', '083')}${field('Тема', '', 'text', 'Например, проверка оплаты')}<label class="form-field">Сообщение<textarea placeholder="Опишите ситуацию"></textarea></label>${act('Отправить обращение', 'send', 'full')}<p class="fineprint">Не отправляйте код SMS и данные банковской карты.</p></div>`;
    case 'delete':
      return `<div class="content">${notice('Удаление аккаунта прекратит доступ к профилю и лояльности.', 'warning')}<p>Перед подтверждением покажем последствия для Чиков и незавершённых заказов.</p><p class="fineprint">Сроки хранения обязательных документов описываются в утверждённой политике.</p><label class="checkline"><input type="checkbox" /> Я понимаю последствия удаления</label>${act('Запросить подтверждение номера', 'delete', 'danger full')}${go('Сохранить аккаунт', 'M30', 'secondary full')}</div>`;
    case 'legal':
      return `<div class="content legal-copy">${notice('Макет раздела документов. Юридические тексты предоставляет и утверждает PickChick.')}<h3>Публичная оферта</h3><p class="muted">Условия заказа, оплаты и получения.</p><h3>Конфиденциальность</h3><p class="muted">Обработка данных, согласия, сроки и удаление аккаунта.</p><h3>Правила лояльности</h3><p class="muted">Кошелёк, прогресс, уровни, возвраты и ограничения.</p>${go('Вернуться в профиль', 'M30', 'full')}</div>`;
    case 'rating':
      return `<div class="content"><div class="status-hero"><h2>Как вам заказ?</h2><p class="muted">№083 · выдан сотрудником</p></div><div class="rating-stars" aria-label="Оценка заказа">${[1, 2, 3, 4, 5].map((n) => `<button data-rating="${n}" class="${n <= m.rating ? 'chosen' : ''}" aria-label="${n} из 5">★</button>`).join('')}</div><label class="form-field">Ваш комментарий<textarea placeholder="Что понравилось или что улучшить?"></textarea></label>${act('Отправить отзыв', 'send', 'full')}${go('Нужна помощь', 'M31', 'secondary full')}</div>`;
    case 'busy':
      return status(
        'clock',
        'Терминал занят',
        'Завершается предыдущая операция. Ваш заказ сохранён; второй платёж не запущен.',
        go('Вернуться к корзине', 'K06', 'secondary full'),
      );
    case 'cash-fallback':
      return status(
        'receipt',
        'Оплатите на кассе',
        'Назовите сотруднику номер. Приготовление начнётся после оплаты и разрешения на кухню.',
        `<div class="number-hero">083</div>${notice('Заказ ещё не оплачен. Срок ожидания задаёт точка.', 'warning')}${go('Начать новый заказ', 'K01', 'full')}`,
      );
    case 'timeout':
      return status(
        'clock',
        'Продолжим заказ?',
        'Из-за бездействия скоро скроем ваши данные и очистим корзину.',
        act('Да, я здесь', 'resume', 'full') +
          go('Завершить сеанс', 'K01', 'secondary full') +
          notice('Если банк ещё проверяет платёж, мы продолжим следить за его результатом.'),
      );
    case 'maintenance':
      return status(
        'info',
        'Обратитесь к сотруднику',
        'Не удалось завершить операцию на этом устройстве. Если оплата началась, назовите номер 083.',
        go('К началу', 'K01', 'secondary full'),
      );
    default:
      return '';
  }
}
function status(i, title, description, body = '') {
  return `<div class="content"><div class="status-hero"><div class="status-disc">${icon(i)}</div><h2>${title}</h2><p class="muted">${description}</p></div>${body}</div>`;
}
function orderView(s, m) {
  const mobile = s.surface === 'mobile';
  return `<div class="content"><div class="row"><div><span class="eyebrow muted">Заказ · сегодня, 16:42</span><h2 style="margin-top:7px">№083 · ${m.mode}</h2></div>${pill('Готовится')}</div><div class="order-detail-grid"><div class="stack">${card(cartLine(m) + checkoutSummary(m))}${mobile ? go('Повторить с текущим меню', 'M10', 'secondary full') : go('Оформить возврат', s.surface === 'pos' ? 'P11' : 'B20', 'secondary full')}</div><div class="stack">${
    mobile
      ? stateRows()
      : card(
          summary([
            ['Канал', 'Приложение'],
            ['Оплата', 'Подтверждена'],
            ['Чек', 'Ожидается'],
            ['Кухня', 'В приготовлении'],
            ['Возврат', 'Не запрошен'],
            ['Синхронизация', 'Подтверждена'],
          ]),
        )
  }${card(
    timeline([
      ['Создан', '16:41 · заказ сохранён', 'done'],
      ['Оплата подтверждена', '16:42 · доверенный ответ банка', 'done'],
      ['Кухня приняла', '16:42 · обязательные компоненты', 'current'],
      ['Выдача', 'Ожидается действие сотрудника', ''],
    ]),
  )}</div></div>${mobile ? go('Помощь с заказом', 'M31', 'secondary full') : act('Показать журнал события', 'audit', 'secondary')}</div>`;
}
const datasets = {
  orders: {
    cols: ['Заказ / канал', 'Получение', 'Оплата', 'Кухня', 'Сумма'],
    rows: [
      [
        '<strong>№083</strong><small>Приложение · 16:42</small>',
        'С собой',
        pill('Подтверждена', 'green'),
        pill('Готовится'),
        '3 490 ₸',
      ],
      [
        '<strong>№082</strong><small>Киоск · 16:40</small>',
        'В зале',
        pill('Проверяем', 'orange'),
        'Не отправлен',
        '5 690 ₸',
      ],
      [
        '<strong>№081</strong><small>Яндекс · 16:38</small>',
        'Агрегатор',
        pill('По договору'),
        'Сборка',
        '6 290 ₸',
      ],
      [
        '<strong>№080</strong><small>Касса · 16:36</small>',
        'С собой',
        pill('Наличные', 'green'),
        pill('Готов', 'green'),
        '3 490 ₸',
      ],
      [
        '<strong>№079</strong><small>Приложение · 16:33</small>',
        'В зале',
        pill('Возврат', 'orange'),
        'Отменён',
        '3 490 ₸',
      ],
    ],
  },
  catalog: {
    cols: ['Позиция', 'Категория', 'RU / KZ', 'Версия', 'Доступность'],
    rows: [
      [
        '<strong>Чик Бургер комбо</strong><small>SKU DEMO-01</small>',
        'Комбо',
        'RU ✓ · KZ черновик',
        'v12',
        pill('Доступно', 'green'),
      ],
      [
        '<strong>Стрипсы</strong><small>SKU DEMO-02</small>',
        'Курица',
        'RU ✓ · KZ черновик',
        'v12',
        pill('Доступно', 'green'),
      ],
      [
        '<strong>Фирменный соус</strong><small>SKU DEMO-03</small>',
        'Соусы',
        'RU ✓ · KZ черновик',
        'v12',
        pill('Ручной стоп', 'orange'),
      ],
    ],
  },
  stock: {
    cols: ['Ингредиент', 'Учётный остаток', 'Резерв', 'Доступно', 'Единица'],
    rows: [
      [
        '<strong>Куриное филе</strong><small>Склад точки · партия 06.09</small>',
        '24,5',
        '3,2',
        '21,3',
        'кг',
      ],
      ['Картофель', '18,0', '2,4', '15,6', 'кг'],
      ['Булочка', '86', '12', '74', 'шт.'],
      ['Соус фирменный', '1,2', '0,8', pill('0,4 · мало', 'orange'), 'кг'],
    ],
  },
  stops: {
    cols: ['Блюдо / компонент', 'Источник', 'Причина', 'До', 'Доставка'],
    rows: [
      [
        'Фирменный соус',
        'Управляющий',
        'Закончилась заготовка',
        'Ручное снятие',
        pill('Edge подтвердил', 'green'),
      ],
      [
        'Большой сет',
        'По компоненту',
        'Недоступен соус',
        'До восстановления',
        pill('Ожидаем ACK', 'orange'),
      ],
    ],
  },
  reconciliation: {
    cols: ['Операция', 'Заказ', 'Банк', 'ККМ', 'Исключение'],
    rows: [
      [
        'PAY-DEMO-083',
        '№083',
        pill('Подтверждено', 'green'),
        pill('Ожидается', 'orange'),
        'Проверить чек',
      ],
      ['PAY-DEMO-082', '№082', pill('Неизвестно', 'orange'), 'Не запрошен', 'Проверить банк'],
      ['REF-DEMO-061', '№061', 'Частичный возврат', pill('Получен', 'green'), 'Сверено'],
    ],
  },
  fiscal: {
    cols: ['Тип', 'Заказ', 'Сумма', 'Документ ККМ', 'Состояние'],
    rows: [
      ['Продажа', '№083', '3 490 ₸', 'Пока не получен', pill('Проверяется', 'orange')],
      ['Продажа', '№080', '3 490 ₸', 'Демо · без фискального номера', pill('Макет документа')],
      ['Возврат', '№061', '1 290 ₸', 'Демо · без фискального номера', pill('Макет документа')],
    ],
  },
  exports: {
    cols: ['Задание', 'Период', 'Формат', 'Запрошено', 'Состояние'],
    rows: [
      ['Продажи по каналам', 'Сегодня', 'CSV', '16:44', pill('В очереди', 'orange')],
      ['Сверка банк / ККМ', 'Вчера', 'CSV', '09:10', pill('Обработано', 'green')],
      ['Обмен с 1С', 'Текущая смена', 'По договору', '—', 'Не подключён'],
    ],
  },
  promotions: {
    cols: ['Акция', 'Каналы', 'Период', 'Бюджет', 'Статус'],
    rows: [
      [
        '<strong>Комбо на двоих</strong><small>RU / KZ</small>',
        'App · Киоск',
        'Согласовать',
        'Не утверждён',
        pill('Черновик'),
      ],
      ['Новый вкус', 'App', 'Согласовать', 'Не утверждён', pill('Предпросмотр')],
    ],
  },
  games: {
    cols: ['Механика', 'Версия', 'Попытки', 'Бюджет наград', 'Состояние'],
    rows: [
      [
        '<strong>Pick Run</strong><small>Одна 2D-механика</small>',
        'v1',
        'Серверный лимит',
        'На согласовании',
        pill('Прототип'),
      ],
      ['Следующее событие', '—', '—', '—', 'Планируется'],
    ],
  },
  guests: {
    cols: ['Гость', 'Заказов', 'Доступные Чики', 'Согласие на промо', 'Сегмент'],
    rows: [
      [
        '<strong>Гость ••042</strong><small>Телефон скрыт по роли</small>',
        '8',
        '1 240',
        pill('Есть', 'green'),
        'Возвращается',
      ],
      ['Гость ••071', '2', '340', pill('Нет'), 'Новый гость'],
      ['Гость ••086', '5', '720', pill('Есть', 'green'), 'Активный'],
    ],
  },
  campaigns: {
    cols: ['Кампания', 'Отправлено', 'Доставка известна', 'Открыто', 'Заказ в окне'],
    rows: [
      ['Время хруста · демо', '120', '96', '28', '7'],
      ['Новое событие · черновик', '—', '—', '—', '—'],
    ],
  },
  tickets: {
    cols: ['Обращение', 'Заказ', 'Ответственный', 'Срок реакции', 'Состояние'],
    rows: [
      [
        '<strong>SUP-012 · Оплата</strong><small>Проверяем банковский статус</small>',
        '№082',
        'Управляющий',
        '12 минут',
        pill('В работе', 'orange'),
      ],
      ['SUP-011 · Состав заказа', '№074', 'Начальник смены', 'Завершено', pill('Закрыто', 'green')],
    ],
  },
  reviews: {
    cols: ['Оценка', 'Заказ', 'Источник', 'Комментарий', 'Состояние'],
    rows: [
      ['5 / 5', '№074', 'Приложение', 'Всё горячее, спасибо', pill('Новый')],
      ['3 / 5', '№068', 'Приложение', 'Долго ждали', pill('Есть обращение', 'orange')],
    ],
  },
  devices: {
    cols: ['Устройство', 'Роль / точка', 'Версия', 'Последний контакт', 'Синхронизация'],
    rows: [
      [
        '<strong>EDGE-01</strong><small>Тестовая точка</small>',
        'Локальный сервер',
        'v0.3',
        '16:45',
        pill('Актуально', 'green'),
      ],
      ['KIOSK-01', 'iPad · меню', 'Дизайн', 'Нет устройства', pill('Не подключён')],
      ['KDS-A / KDS-B', 'Два экрана', 'Дизайн', 'Нет устройства', 'Назначение ожидается'],
    ],
  },
  staff: {
    cols: ['Сотрудник', 'Роль', 'Точки', 'Доступ', 'Состояние'],
    rows: [
      [
        '<strong>Кассир · демо</strong>',
        'Кассир',
        'Тестовая точка',
        'Продажа без возврата',
        pill('Активен', 'green'),
      ],
      [
        'Управляющий · демо',
        'Управляющий',
        'Все назначенные',
        'Возврат / смена',
        pill('Активен', 'green'),
      ],
      ['Сборщик · демо', 'Кухня', 'Тестовая точка', 'Задания кухни', pill('Активен', 'green')],
    ],
  },
  shifts: {
    cols: ['Смена', 'Сотрудник', 'ККМ', 'Операционный день', 'Состояние'],
    rows: [
      [
        'SHIFT-DEMO-06',
        'Кассир · демо',
        'Отдельная смена ККМ',
        '06.09.2026',
        pill('Открыта', 'green'),
      ],
      ['SHIFT-DEMO-05', 'Кассир · демо', 'Закрыта отдельно', '05.09.2026', pill('Закрыта')],
    ],
  },
  audit: {
    cols: ['Когда / кто', 'Действие', 'Было → стало', 'Причина', 'Связь'],
    rows: [
      [
        '<strong>16:44 · управляющий</strong>',
        'Стоп-лист',
        'Доступно → стоп',
        'Нет заготовки',
        'Соус',
      ],
      [
        '16:42 · банковский адаптер',
        'Подтверждение',
        'Ожидается → оплачено',
        'Результат провайдера',
        '№083',
      ],
      [
        '16:40 · управляющий',
        'Право сотрудника',
        'Кассир → старший',
        'Назначение на смену',
        'STAFF-DEMO',
      ],
    ],
  },
  'shift-report': {
    cols: ['Документ / операция', 'Смена', 'Сумма', 'Состояние'],
    rows: [
      ['X-отчёт', 'Текущая', 'По данным ККМ', pill('Запросить')],
      ['Z-отчёт', 'Предыдущая', 'По данным ККМ', 'Архив'],
      ['Внесение наличности', 'Текущая', '20 000 ₸', 'Демо'],
    ],
  },
  'kds-history': {
    cols: ['Заказ', 'Компонент', 'Станция', 'Завершён'],
    rows: [
      ['№080', 'Чик Бургер', 'A · фритюр', '16:41'],
      ['№074', 'Упаковка', 'B · сборка', '16:39'],
      ['№078', 'Стрипсы', 'A · фритюр', '16:38'],
    ],
  },
};
function operational(s, m) {
  const ds = datasets[s.kind];
  if (ds)
    return `<div class="content"><div class="toolbar-row"><div class="chips"><button class="chip selected" data-action="filter">Все</button><button class="chip" data-action="filter">Требуют внимания</button></div>${go(s.kind === 'orders' ? 'Создать / открыть' : s.kind === 'catalog' ? 'Добавить блюдо' : 'Открыть карточку', s.next, 'small')}</div><label class="form-field">Поиск в списке<input data-table-search placeholder="Номер, название или идентификатор" /></label>${table(ds.cols, ds.rows, s.next)}<div class="row"><p class="fineprint">Показано ${ds.rows.length} · демонстрационные данные</p>${act('Следующая страница', 'page', 'secondary small')}</div>${['orders', 'reconciliation', 'fiscal'].includes(s.kind) ? notice('Оплата, чек и приготовление показаны отдельно. Неизвестный банковский результат требует проверки.', 'warning') : ''}</div>`;
  if (s.fields.length) return formView(s);
  switch (s.kind) {
    case 'staff-login':
      return `<div class="feedback-form stack">${notice('Рабочее место: тестовая точка. Доступ выдаётся персонально.')}${field('Сотрудник', '', 'text', 'Имя или идентификатор')}${field('Пароль / PIN', '', 'password', 'Введите личный код')}${go('Войти · демопереход', s.next, 'full')}${act('Нужна помощь со входом', 'help', 'secondary full')}<p class="fineprint">Используйте личную учётную запись. Если точка недоступна, обратитесь к управляющему.</p></div>`;
    case 'pos-sale':
      return `<div class="pos-layout"><div class="stack">${categories(m.category)}${productGrid('P20', m.category)}${notice('Проверьте состав и сумму после изменения заказа.')}</div><aside class="pos-cart"><div class="row"><h2>Новый заказ</h2>${pill('Касса')}</div><div class="row"><button class="chip ${m.mode === 'В зале' ? 'selected' : ''}" data-mode="В зале">В зале</button><button class="chip ${m.mode === 'С собой' ? 'selected' : ''}" data-mode="С собой">С собой</button></div><div class="pos-cart-lines">${cartLine(m)}<div class="pos-actions">${go('Добавки', 'P20', 'secondary')}${go('Комбо', 'P21', 'secondary')}</div>${go('Телефон / QR гостя', 'P06', 'secondary')}</div>${checkoutSummary(m)}<div class="pos-actions">${go('Наличные', 'P07', 'full')}${go('Терминал', 'P08', 'secondary full')}</div><p class="fineprint">Демонстрационные цены.</p></aside></div>`;
    case 'cash':
      return `<div class="two-columns"><div class="card stack"><h2>К оплате ${money(amount(m))}</h2>${field('Получено от гостя, ₸', String(m.cash), 'number').replace('<input', '<input data-cash-input')}<div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '←'].map((n) => `<button data-cash="${n}">${n}</button>`).join('')}</div>${act('Получено 5 000 ₸', 'cash-5000', 'secondary')}</div><div class="card stack"><h2>Сдача</h2><div class="cash-number">${money(Math.max(0, m.cash - amount(m)))}</div>${notice(m.cash < amount(m) ? 'Полученная сумма меньше стоимости заказа.' : 'Сдачу выдаёт кассир. Подтверждение приёма наличных — отдельное действие.', m.cash < amount(m) ? 'warning' : '')}${act('Подтвердить приём наличных', 'cash-confirm', 'full', m.cash < amount(m) ? 'disabled' : '')}${go('Вернуться к заказу', 'P03', 'secondary full')}</div></div>`;
    case 'approval':
      return `<div class="feedback-form stack">${notice('Нужно личное подтверждение управляющего.', 'warning')}${card(
        summary([
          ['Действие', 'Частичный возврат'],
          ['Заказ', '№083'],
          ['Сумма', money(products[m.product].price)],
          ['Причина', 'Ошибка при оформлении'],
        ]),
      )}${field('Управляющий', '', 'text', 'Личный идентификатор')}${field('Подтверждение', '', 'password', 'PIN / повторный вход')}${act('Подтвердить запрос возврата', 'approval', 'danger full')}${go('Отменить запрос', 'P05', 'secondary full')}</div>`;
    case 'sync':
      return `<div class="content">${notice('Продажи на точке сохранены. Повтор обмена не создаёт второй заказ.', 'warning')}${metricCards(
        [
          ['В очереди', '12', 'Локальные события'],
          ['Последний ACK', '16:42', 'Подтверждение центра'],
          ['Самое старое', '3 мин', 'Возраст, не таймер интерфейса'],
          ['Режим', 'Повтор', 'С ограничением частоты'],
        ],
      )}${table(
        ['Поток', 'Отправлено', 'Подтверждено', 'Состояние'],
        [
          ['Меню', 'v12', 'v12', pill('Согласовано', 'green')],
          ['Заказы', '128', '116', pill('Ожидаем связь', 'orange')],
        ],
        'P03',
      )}${act('Повторить безопасную синхронизацию', 'sync', 'secondary')}</div>`;
    case 'dashboard':
      return dashboard(s);
    case 'reports':
      return `<div class="content">${metricCards([
        ['Продажи до скидок', '284 300 ₸', 'По завершённым заказам'],
        ['Скидки / Чики', '12 800 ₸', 'Отдельный показатель'],
        ['Возвраты', '7 200 ₸', 'За выбранный период'],
        ['Поступило в банк', 'Проверяется', 'Не равно продажам'],
      ])}${card(`<h2>Продажи по часам</h2>${chart()}<p class="chart-note">Демо · Алматы · завершённые заказы. Комиссии и банковские поступления сверяются отдельно.</p>`)}${table(
        ['Канал', 'Выданные заказы', 'Продажи', 'Средний чек'],
        [
          ['Касса', '36', '125 640 ₸', '3 490 ₸'],
          ['Приложение', '24', '83 760 ₸', '3 490 ₸'],
          ['Киоск', '18', '62 820 ₸', '3 490 ₸'],
        ],
        s.next,
      )}${notice('Себестоимость без аренды, персонала и налогов не называется чистой прибылью.')}</div>`;
    case 'analytics':
      return `<div class="content">${metricCards([
        ['DAU', '124', 'Авторизованные гости · демо'],
        ['MAU', '860', 'По customer ID · демо'],
        ['D7', '24%', 'Когорта зарегистрированных'],
        ['Повтор за 30 дней', '31%', 'Оплачено и выдано'],
      ])}${card(
        `<h2>Путь гостя</h2>${summary([
          ['OTP подтверждён', '120'],
          ['Меню просмотрено', '108'],
          ['Quote создан', '64'],
          ['Попытка оплаты', '51'],
          ['Банк подтвердил', '46'],
          ['Заказ выдан', '44'],
        ])}`,
      )}${notice('DAU/MAU учитывают авторизованных гостей. Анонимные просмотры показаны отдельно.')}</div>`;
    case 'publish':
      return `<div class="content">${notice('Черновик не меняет меню на кассе. После публикации дождитесь подтверждения от каждой точки.')}<div class="two-columns">${card(
        `<h2>Меню v13 · изменения</h2>${summary([
          ['Чик Бургер комбо', '3 490 → 3 590 ₸'],
          ['Фирменный соус', 'Ручной стоп'],
          ['Переводы', 'KZ требует проверки'],
        ])}<label class="checkline"><input type="checkbox"/> Проверены состав, цены и тексты</label>`,
      )}${card(
        `<h2>Доставка по точкам</h2>${summary([
          ['Тестовая точка', 'Активно v12'],
          ['Новое меню', 'Ожидает публикации'],
          ['Edge ACK', 'Не получен'],
        ])}`,
      )}</div>${act('Предпросмотр публикации', 'publish', 'full')}${go('Вернуться к каталогу', 'B05', 'secondary')}</div>`;
    case 'guest':
      return `<div class="content">${notice('Персональные данные скрыты. Просмотр расширенной карточки требует права и аудируется.')}<div class="two-columns">${card(
        `<h2>Гость ••042</h2>${summary([
          ['Заказов', '8'],
          ['Доступные Чики', '1 240'],
          ['Резерв', '100'],
          ['Промо-согласие', 'Есть · версия согласия'],
          ['Телефон', 'Скрыт по роли'],
        ])}`,
      )}${navList([
        ['Заказы гостя', 'История покупок', 'B03'],
        ['Операции Чиков', 'Начисления, списания и резервы', 'M24'],
        ['Обращения', '1 закрытое', 'B32'],
      ])}</div>${act('Запросить расширенный доступ', 'access', 'secondary')}</div>`;
    case 'ticket':
      return `<div class="content"><div class="row"><h2>SUP-012 · Проверка оплаты</h2>${pill('В работе', 'orange')}</div><div class="two-columns">${card(`<p class="eyebrow muted">Сообщение гостя · демо</p><p style="margin:15px 0">После оплаты статус заказа не обновился.</p>${notice('Не просить повторную оплату, пока результат банка неизвестен.', 'warning')}<label class="form-field" style="margin-top:20px">Ответ гостю<textarea placeholder="Напишите ответ"></textarea></label>${act('Подготовить ответ', 'send', 'full')}`)}${card(
        summary([
          ['Заказ', '№082'],
          ['Состояние банка', 'Неизвестно'],
          ['Ответственный', 'Управляющий'],
          ['Срок реакции', '12 минут'],
        ]) + go('Проверить заказ', 'B04', 'secondary full'),
      )}</div></div>`;
    case 'stations':
      return `<div class="content">${notice('Предложение распределения: экран A — приготовление; экран B — сборка, напитки и выдача. Подтвердить на точке.')}<div class="two-columns">${card(
        `<span class="pill">Экран A</span><h2 style="margin:15px 0">Фритюр и приготовление</h2>${summary(
          [
            ['Стрипсы', 'queued → in_progress → done'],
            ['Картофель', 'Отдельный компонент'],
            ['Отмена', 'Подтверждение остановки'],
          ],
        )}${go('Посмотреть экран A', 'D01', 'full')}`,
      )}${card(
        `<span class="pill orange">Экран B</span><h2 style="margin:15px 0">Сборка и выдача</h2>${summary(
          [
            ['Напиток / соус', 'Отдельное подтверждение'],
            ['Упаковка', 'После обязательных компонентов'],
            ['Выдача', 'Действие сотрудника'],
          ],
        )}${go('Посмотреть экран B', 'D02', 'full')}`,
      )}</div>${act('Изменить маршруты', 'save', 'secondary')}</div>`;
    case 'device':
      return `<div class="content"><div class="row"><h2>EDGE-01 · тестовая точка</h2>${pill('На связи', 'green')}</div>${metricCards(
        [
          ['Последний heartbeat', '16:45', 'Свежесть данных'],
          ['Версия', 'v0.3', 'Пример UI'],
          ['Очередь', '12', 'Не подтверждено центром'],
          ['Ключ', '24 дня', 'До истечения · демо'],
        ],
      )}${card(
        summary([
          ['Назначение', 'Основной локальный сервер точки'],
          ['Меню', 'v12 · подтверждено'],
          ['База', 'Локальная PostgreSQL'],
          ['Резервный экран', 'Назначается управляющим'],
        ]),
      )}<div class="row">${act('Запросить диагностику', 'diagnostics', 'secondary')}${act('Отозвать доступ', 'revoke', 'danger')}</div>${notice('После отзыва устройство потеряет доступ. Сначала убедитесь, что подготовлена замена.', 'warning')}</div>`;
    case 'system':
      return `<div class="content">${metricCards([
        ['Cloud API', 'Доступен', 'Последняя проверка · демо'],
        ['Очередь событий', '12', 'Тестовая точка'],
        ['Копия БД', 'Сегодня', 'Состояние из мониторинга'],
        ['Restore drill', 'Проверен', 'Дата и протокол отдельно'],
      ])}${table(
        ['Компонент', 'Свежесть', 'Состояние'],
        [
          ['Edge точки', '16:45', pill('На связи', 'green')],
          ['Kaspi mobile', 'Не подключён', pill('Внешняя зависимость', 'orange')],
          ['ККМ', 'Не подключена', 'Требует проверки'],
          ['Яндекс Еда KZ', 'Доступ ожидается', 'Не включён'],
        ],
        s.next,
      )}${notice('Это пример будущей страницы мониторинга, не текущие метрики рабочего ресторана.')}</div>`;
    default:
      return '';
  }
}
function formView(s) {
  return `<div class="content">${notice(s.purpose)}<div class="card"><div class="row" style="margin-bottom:24px"><h2>${s.title}</h2>${pill('Черновик')}</div><div class="field-grid">${s.fields.map((f, i) => field(f, '', 'text', f.includes('согласовать') ? 'Требует утверждения' : i === 0 ? 'Введите значение' : 'Укажите значение')).join('')}</div>${
    ['recipe', 'inventory', 'production', 'combo-edit'].includes(s.kind)
      ? `<div style="margin-top:24px">${table(
          ['Компонент', 'План', 'Факт / правило'],
          [
            ['Куриное филе', '0,180 кг', 'Из техкарты'],
            ['Соус', '1 порция', 'Обязательный компонент'],
          ],
          s.next,
        )}</div>`
      : ''
  }</div>${['loyalty-policy', 'game-edit', 'promo-edit'].includes(s.kind) ? notice('Экономические параметры не утверждены. Не публиковать значения из демонстрации как действующие правила.', 'warning') : ''}<div class="row">${go('Назад без сохранения', s.next, 'secondary')}${act('Проверить и сохранить черновик', 'save', '')}</div><p class="fineprint">При конфликте версии показать изменения другого сотрудника. Сохранение не равно публикации или проведению документа.</p></div>`;
}
function metricCards(data) {
  return `<div class="metric-grid">${data.map(([l, v, n]) => `<div class="metric"><small>${l}</small><div class="metric-number">${v}</div><p>${n}</p></div>`).join('')}</div>`;
}
function chart() {
  return `<div class="chart" role="img" aria-label="Демонстрационная диаграмма продаж по часам">${[21, 35, 54, 44, 90, 72, 64, 43, 55, 68].map((h, i) => `<div class="bar" style="height:${h}%"><span>${i + 9}:00</span></div>`).join('')}</div>`;
}
function dashboard() {
  return `<div class="content">${notice('<strong>Одна точка требует внимания.</strong> Есть платёж без окончательного ответа банка. Последние данные: 16:45.', 'warning')}${metricCards(
    [
      ['Продажи', '284 300 ₸', 'До скидок · демо'],
      ['Выдано заказов', '78', 'Отдельно от принятых'],
      ['Средний чек', '3 490 ₸', 'По выданным заказам'],
      ['Время кухни', '08:24', 'По событиям этапов'],
    ],
  )}<div class="two-columns">${card(`<div class="section-head"><h2>Ритм смены</h2>${pill('Сегодня')}</div>${chart()}<p class="chart-note">Продажи по часам · Asia/Almaty · демонстрационные значения</p>`)}${card(
    `<div class="section-head"><h2>Нужно внимание</h2>${pill('3', 'orange')}</div>${navList([
      ['Платёж №082', 'Проверить ответ банка', 'B20'],
      ['Соус в стоп-листе', 'Ручное ограничение', 'B17'],
      ['Меню v13', 'Ожидает публикации', 'B11'],
    ])}`,
  )}</div>${table(datasets.orders.cols, datasets.orders.rows.slice(0, 3), 'B04')}</div>`;
}
function kitchen(s, m) {
  if (s.kind === 'offline') return offline(s);
  if (s.kind === 'kds-detail')
    return `<div class="content"><div class="row"><h1>№083 · Сборка заказа</h1>${pill('Приложение · С собой')}</div>${notice('Готовность заказа доступна после всех обязательных компонентов.', 'warning')}${[
      ['Стрипсы · экран A', true],
      ['Картофель · экран A', true],
      ['Соус и напиток · экран B', m.assembled],
    ]
      .map(
        ([t, done], i) =>
          `<label class="component-row"><span>${t}</span><span class="row">${pill(done ? 'Готово' : 'Ожидается', done ? 'green' : 'orange')}<input type="checkbox" ${done ? 'checked' : ''} ${i < 2 ? 'disabled' : 'data-action="assemble"'} aria-label="${t}" /></span></label>`,
      )
      .join(
        '',
      )}${act('Подтвердить финальную сборку', 'kds-done', 'full', m.assembled ? '' : 'disabled')}${go('Вернуться к очереди', 'D02', 'secondary')}</div>`;
  if (s.kind === 'kds-blocked')
    return `<div class="content">${notice('№083 · нет заготовки. Ожидание считается от исходного поступления 16:42.', 'warning')}${field('Причина блокировки', 'Нет заготовки')}${field('Ответственный', 'Начальник смены')}${act('Зафиксировать блокировку', 'save', 'full')}${go('К очереди', 'D01', 'secondary')}</div>`;
  if (s.kind === 'kds-cancel')
    return `<div class="content">${notice('Получена отмена №081. Нужно подтвердить остановку приготовления.', 'error')}<h1>Что уже приготовлено?</h1>${field('Количество приготовленных порций', '1', 'number')}${field('Комментарий', 'Передать решение о списании управляющему')}${act('Подтвердить остановку', 'kds-cancel', 'danger')}${go('К очереди', 'D01', 'secondary')}</div>`;
  if (s.kind === 'kds-transfer')
    return `<div class="content">${notice('Перенос ролей выполняет управляющий. Номер заказа и исходное время сохраняются.', 'warning')}<h1>Резервный экран</h1>${field('Исходная станция', 'A · приготовление')}${field('Принимающий экран', 'B · сборка')}${field('Причина', 'Экран A временно недоступен')}${act('Запросить подтверждение управляющего', 'approval', 'full')}${go('Отмена', 'D02', 'secondary')}</div>`;
  if (s.kind === 'kds-history') return operational(s, m);
  const assembly = s.kind === 'kds-b';
  const nums =
    s.kind === 'kds-overflow'
      ? ['091', '090', '089', '088', '087', '086', '085', '084']
      : ['083', '077', '081', '076'];
  return `<div class="stack"><div class="kds-toolbar"><div class="chips"><button class="chip selected" data-action="filter">Все · ${s.kind === 'kds-overflow' ? '24' : '8'}</button><button class="chip" data-action="filter">В работе · 4</button><button class="chip" data-action="filter">Поздние · 2</button></div><div class="muted">Поступление не меняется при переносе</div></div><div class="kds-grid">${nums.map((n, i) => `<article class="ticket ${i === 0 ? 'late' : ''}"><div class="ticket-head"><div><div class="ticket-number">${n}</div><small>${['Приложение', 'Киоск', 'Яндекс', 'Касса'][i % 4]} · ${i % 2 ? 'В зале' : 'С собой'}</small></div><span class="ticket-age">${['12:34', '08:12', '06:40', '04:18'][i % 4]}</span></div><div class="ticket-body"><div>${pill(i === 0 ? 'Дольше нормы' : assembly ? 'Ждём компоненты' : 'В очереди', i === 0 ? 'orange' : '')}<h3 style="margin-top:18px">${i % 2 ? 'Стрипсы на двоих' : 'Чик Бургер комбо'}</h3><p>${assembly ? 'Собрать полный заказ' : '2 × курица · 1 × картофель'}</p><span class="modifier">${i % 2 ? 'Соус отдельно' : 'Без лука'}</span></div>${assembly ? `<div class="stack">${pill('Курица готова', 'green')}${pill('Напиток ожидается', 'orange')}</div>` : '<div><h3>Картофель</h3><p>Стандарт · готовить отдельно</p></div>'}</div>${go(assembly ? 'Открыть сборку' : m.kdsWorking && i === 0 ? 'В работе · открыть' : 'Взять в работу', 'D03', i === 0 ? '' : 'secondary')}</article>`).join('')}</div>${s.kind === 'kds-overflow' ? `<div class="row"><span class="muted">Показано 8 из 24 · страница ${m.page} из 3</span>${act('Следующая страница', 'page', 'secondary')}</div>` : ''}</div>`;
}
function board(s, m) {
  const idle = s.kind === 'board-idle',
    lost = s.kind === 'board-offline';
  return `<div class="board"><header class="board-header">${brands('Тапсырыстар / Заказы')}<span class="muted">${lost ? 'Нет связи с точкой' : 'Горячее уже близко'}</span></header>${idle || lost ? `<div class="board-offline">${photo('brand-logo.png', 'PickChick', 'welcome-logo')}<h1>${lost ? 'Обновления временно недоступны' : 'Выбирай свой хруст'}</h1><p>${lost ? 'Уточните готовность у сотрудника.' : 'Ваш номер появится здесь после принятия заказа.'}</p><p style="margin-top:25px">${lost ? 'Дайындығын қызметкерден сұраңыз.' : 'Тапсырыс нөмірі осында көрсетіледі.'}</p></div>` : `<div class="board-columns"><section class="board-column"><h1>Готовится</h1><p>Дайындалып жатыр</p><div class="board-numbers">${(s.kind === 'board-overflow' ? ['091', '090', '089', '088', '087', '086'] : ['083', '077', '081', '076', '073', '072']).map((n) => `<div class="board-number">${n}</div>`).join('')}</div></section><section class="board-column ready-column"><h1>Можно забирать</h1><p>Алып кетуге болады</p><div class="board-numbers">${['080', '078', '075'].map((n) => `<div class="board-number">${n}</div>`).join('')}</div></section></div>`}<footer class="board-footer"><strong>Твой выбор. Твой хруст.</strong><span>${s.kind === 'board-overflow' ? `Страница ${m.page} из 3 · смена без потери заказов` : lost ? 'Последние данные: 16:42' : 'Номер заказа — без личных данных'}</span></footer></div>`;
}
export function offline(s) {
  const local = ['pos', 'kiosk', 'kitchen'].includes(s.surface);
  return `<div class="content"><div class="status-hero"><div class="status-disc">${icon('wifi')}</div><h2>${local ? 'Проверьте соединение' : 'Нет соединения'}</h2><p class="muted">${local ? 'Интернет и локальная сеть проверяются отдельно.' : 'Сохранённый заказ не потерян. Платёж проверим после восстановления связи.'}</p></div>${card(
    summary(
      local
        ? [
            ['Интернет / WAN', 'Нет связи'],
            ['Локальный сервер / LAN', s.surface === 'kitchen' ? 'Нет связи' : 'Доступен'],
            ['Банк', 'Недоступен'],
            ['ККМ', 'Режим требует подтверждения'],
            ['Принтер', 'Проверяется'],
          ]
        : [
            ['Последние данные', '16:42'],
            ['Новый платёж', 'Не запускается'],
            ['Сохранённый заказ', '№083'],
          ],
    ),
  )}${notice(local ? 'При отсутствии LAN новые команды не считаются принятыми. При наличии LAN разрешаются только проверенные режимы банка и ККМ.' : 'Не оплачивайте заказ повторно, пока результат предыдущей попытки неизвестен.', 'warning')}${act('Проверить связь', 'reconnect', 'full')}${go('Вернуться к экрану', s.next, 'secondary full')}</div>`;
}
export function stateView(s, state) {
  if (state === 'default') return null;
  if (state === 'offline') return offline(s);
  if (state === 'loading')
    return `<div class="state-panel" aria-busy="true"><h2>Загружаем ${s.surface === 'display' ? 'статусы' : 'данные'}</h2><p class="muted">${esc(s.title)} · действия доступны после проверки актуального состояния.</p><div class="skeleton short"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
  const content = {
    empty: [
      'Пока ничего нет',
      `В разделе «${s.title}» нет данных для выбранных условий. Измените фильтр или начните с основного экрана.`,
    ],
    error: [
      s.kind === 'otp' ? 'Код не подошёл' : 'Не удалось получить данные',
      s.kind === 'otp'
        ? 'Проверьте цифры кода и попробуйте ещё раз.'
        : s.financial
          ? 'Сначала уточним результат операции. Повторное списание не запускается автоматически.'
          : 'Сохранённые данные не удалены. Можно безопасно повторить чтение.',
    ],
    denied: [
      'Недостаточно прав',
      'Для этого действия нужна назначенная роль. Обратитесь к управляющему; смена интерфейса не выдаёт полномочия.',
    ],
    conflict: [
      'Данные уже изменились',
      'Другой сотрудник или обновлённое меню изменили версию. Сравните значения и подтвердите новое предложение.',
    ],
    expired: [
      s.kind === 'otp' ? 'Код истёк' : 'QR больше не действует',
      s.kind === 'otp'
        ? 'Запросите новый SMS-код. Старый challenge больше не принимается.'
        : 'Откройте новый одноразовый код в авторизованном приложении.',
    ],
    limited: [
      'Попробуйте немного позже',
      'Слишком много попыток. Подождите перед следующим запросом кода.',
    ],
    paused: [
      'Игра на паузе',
      'Сессия остановлена при потере фокуса. Вернитесь в игру, чтобы продолжить.',
    ],
    pending: [
      'Результат на проверке',
      'Сервер проверяет сессию и лимиты. Пока награда не начислена.',
    ],
    rejected: [
      'Награда не выдана',
      'Результат не прошёл проверку либо лимит исчерпан. Баланс не изменился. Можно прочитать правила или обратиться в поддержку.',
    ],
  }[state];
  return `<div class="state-panel"><div class="status-disc">${icon(state === 'denied' ? 'lock' : state === 'empty' ? 'bag' : 'info')}</div><h2>${content[0]}</h2><p class="muted">${esc(content[1])}</p>${
    state === 'conflict'
      ? card(
          summary([
            ['Версия на экране', '12'],
            ['Текущая версия', '13'],
            ['Изменение', 'Цена или доступность'],
          ]),
        )
      : ''
  }${act(state === 'denied' ? 'Обратиться к управляющему' : state === 'limited' ? 'Понятно' : state === 'pending' ? 'Проверить состояние' : 'Вернуться к основному виду', 'restore-state', 'full')}<p class="fineprint">Это отдельное состояние дизайна ${s.id}, демонстрационный режим.</p></div>`;
}
export function view(s, m) {
  const reference = mobileReferenceView(s, m) ?? kioskView(s, m) ?? operationsView(s, m);
  if (reference !== null) return reference;
  if (s.surface === 'display') return board(s, m);
  if (s.surface === 'kitchen') return kitchen(s, m);
  if (s.kind === 'offline') return offline(s);
  return (
    mobileView(s, m) ||
    operational(s, m) ||
    `<div class="state-panel"><h2>Экран не определён</h2><p>${esc(s.id)}</p></div>`
  );
}
export function appShell(s, content) {
  const reference =
    mobileReferenceShell(s, content) ?? kioskShell(s, content) ?? operationsShell(s, content);
  if (reference !== null) return reference;
  if (s.surface === 'mobile') {
    if (s.kind === 'welcome') return content;
    const top =
      s.kind === 'menu'
        ? `<header class="phone-header"><div style="flex:1"><span class="eyebrow muted">Ресторан · Алматы</span><h3 style="margin-top:5px">Тестовая точка ${icon('arrow')}</h3></div><button class="round" data-go="M29" aria-label="Мой QR">${icon('grid')}</button></header>`
        : `<header class="phone-header"><button class="round" data-go="M06" aria-label="В меню">${icon('back')}</button><h1>${s.title}</h1></header>`;
    return `<div class="statusbar">9:41</div>${top}${content}<nav class="bottom-nav" aria-label="Навигация приложения">${[
      ['M06', 'bag', 'Меню'],
      ['M23', 'star', 'Чики'],
      ['M26', 'game', 'События'],
      ['M30', 'user', 'Профиль'],
    ]
      .map(
        ([id, i, t]) =>
          `<button data-go="${id}" class="${s.id === id ? 'active' : ''}">${icon(i)}${t}</button>`,
      )
      .join('')}</nav>`;
  }
  if (s.surface === 'display') return content;
  if (s.surface === 'kitchen')
    return `<div class="kds"><header class="app-topbar">${brands(s.id === 'D02' ? 'B · Сборка' : 'A · Приготовление')}<div class="row"><span class="station-line"><span class="dot"></span>Локальный сервер</span>${go('Экран A', 'D01', 'secondary small')}${go('Экран B', 'D02', 'secondary small')}</div></header><main class="kds-content"><div class="kds-toolbar"><div><span class="eyebrow muted">Тестовая точка · Смена 06.09</span><h1 style="margin-top:7px">${s.title}</h1></div><span class="muted">16:45 · пример</span></div>${content}</main></div>`;
  if (s.surface === 'kiosk')
    return s.kind === 'welcome'
      ? content
      : `<header class="app-topbar">${brands('Киоск')}<div class="row"><button class="btn secondary" data-action="language">RU / KZ</button>${go('Начать заново', 'K01', 'secondary')}</div></header><main class="big-content"><div><span class="eyebrow muted">Тестовая точка · Заказ без регистрации</span><h1 style="margin-top:13px">${s.title}</h1></div>${content}</main>`;
  const nav =
    s.surface === 'pos'
      ? [
          ['P03', 'bag', 'Новый заказ'],
          ['P04', 'receipt', 'Все заказы'],
          ['P17', 'chart', 'Смена'],
          ['P13', 'grid', 'Наличные'],
          ['P18', 'refresh', 'Синхронизация'],
          ['P19', 'monitor', 'Оборудование'],
        ]
      : [
          ['B02', 'chart', 'Обзор'],
          ['B03', 'bag', 'Заказы'],
          ['B05', 'grid', 'Номенклатура'],
          ['B12', 'grid', 'Остатки'],
          ['B18', 'chart', 'Отчёты'],
          ['B20', 'receipt', 'Касса и сверка'],
          ['B23', 'star', 'Промо'],
          ['B25', 'game', 'Игры'],
          ['B28', 'user', 'Гости и push'],
          ['B32', 'info', 'Обращения'],
          ['B34', 'star', 'Отзывы'],
          ['B35', 'flame', 'Станции'],
          ['B36', 'monitor', 'Устройства'],
          ['B39', 'user', 'Сотрудники'],
          ['B42', 'lock', 'Аудит'],
        ];
  return `<header class="app-topbar">${brands(s.surface === 'pos' ? 'Касса' : 'Бэк-офис')}<div class="row"><span class="station-line"><span class="dot"></span>Демо · данные на 16:45</span><span class="pill">Тестовая точка · Алматы</span><button class="round" data-go="${s.surface === 'pos' ? 'P01' : 'B01'}" aria-label="Учётная запись">${icon('user')}</button></div></header><div class="desktop-layout"><nav class="app-sidebar" aria-label="Навигация рабочего приложения">${nav.map(([id, i, t]) => `<button data-go="${id}" class="${s.id === id ? 'active' : ''}">${icon(i)}${t}</button>`).join('')}</nav><main class="desktop-body"><div class="row"><div><span class="eyebrow muted">${s.surface === 'pos' ? 'Рабочее место кассира' : 'Управление сетью'}</span><h1 style="margin-top:8px">${s.title}</h1></div>${s.surface === 'backoffice' ? act('Сегодня · 06 сентября', 'period', 'secondary small') : go('Закрыть смену', 'P14', 'secondary small')}</div>${content}</main></div>`;
}
