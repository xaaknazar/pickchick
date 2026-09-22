import { photos } from './photos.js';
import { ReferenceView } from './reference-view.js';
import { TemplateView } from './template-engine.js';
import { model, pinLogin } from './runtime.js';
import { money, lineKey, linePrice, validateSelections } from '../types.js';
import { transport, errorMessage } from '../api.js';
import { kitchenLabel, orderNumber } from '../order-view.js';
const root = document.getElementById('app');
let config, template;
try {
  const response = await fetch('/config.json');
  if (!response.ok) throw Error('CONFIG_UNAVAILABLE');
  config = await response.json();
  const page = await fetch('/v2/template.html');
  if (!page.ok) throw Error('TEMPLATE_UNAVAILABLE');
  template = await page.text();
} catch {
  root.textContent = 'Не удалось открыть кассу. Проверьте установку программы и перезапустите её.';
  root.className = 'startup-error';
  throw Error('POS_STARTUP_UNAVAILABLE');
}
const renderer = new TemplateView(template, root);
const reference = new ReferenceView(() => schedule());
const time = (value) =>
  new Date(value ?? Date.now()).toLocaleTimeString('ru-RU', {
    timeZone: 'Asia/Almaty',
    hour: '2-digit',
    minute: '2-digit',
  });
const date = (value) =>
  new Date(value ?? Date.now()).toLocaleDateString('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
let lastRender = '',
  successTimer = null,
  wizardDrinks = {},
  scheduled = false,
  signing = false,
  modifier = null,
  chosen = [],
  portions = 1,
  previousKey = null,
  lastDeleted = null,
  lastOrder = null,
  closeReason = 'Тестовая смена без оплаты',
  commentPurpose = 'order',
  errorShown = '',
  filterDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
const blocked = () => model.state.busy || model.state.pending || model.state.storageBlocked;
function schedule() {
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      draw();
    });
  }
}
const say = (text) => reference.say(text);
const unavailable = () =>
  say('В тестовом режиме эта интеграция не подключена. Деньги и чеки не проводятся.');
const safe =
  (fn) =>
  async (...args) => {
    if (blocked()) return;
    try {
      await fn(...args);
    } catch (e) {
      say(e.message);
    }
    schedule();
  };
function details(change) {
  const d = model.state.draft;
  if (d)
    model.replaceDraft({
      ...d,
      details: { display_name: '', kitchen_comment: '', ...d.details, ...change },
    });
}
function item(id) {
  return model.state.menu?.items.find((i) => i.variant_id === id);
}
function selectionsText(product, selections) {
  return selections
    .map((s) => {
      const g = product.modifier_groups?.find((g) => g.id === s.group_id),
        o = g?.options.find((o) => o.id === s.option_id);
      return (s.quantity > 1 ? `${s.quantity} × ` : '') + (o?.name.ru ?? '');
    })
    .join(' · ');
}
function total() {
  let sum = 0n;
  for (const l of model.state.draft?.items ?? []) {
    try {
      sum += linePrice(item(l.variant_id), l.modifiers) * BigInt(l.quantity);
    } catch {
      return null;
    }
  }
  return sum;
}
function openModifier(product, line) {
  modifier = product;
  chosen =
    line?.modifiers?.map((s) => ({ ...s })) ??
    (product.modifier_groups ?? []).flatMap((g) =>
      g.options
        .filter((o) => o.default_quantity && o.available !== false)
        .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity })),
    );
  portions = line?.quantity ?? 1;
  previousKey = line ? lineKey(line) : null;
  reference.setState({
    mod: {
      name: product.name.ru,
      price: Number(product.price_minor) / 100,
      combo: true,
      comp: 'Настройте состав',
    },
    wiz: null,
  });
}
function openWizard(product) {
  modifier = product;
  chosen = [];
  wizardDrinks = {};
  portions = 1;
  previousKey = null;
  reference.setState({ mod: null, wiz: { name: product.name.ru }, wizStep: 1 });
}
function defaultAdd(product) {
  const selected = (product.modifier_groups ?? []).flatMap((g) =>
    g.options
      .filter((o) => o.default_quantity && o.available !== false)
      .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity })),
  );
  try {
    validateSelections(product, selected);
    model.configure(product.variant_id, selected, 1);
    say(product.name.ru + ' - в заказе');
  } catch {
    openModifier(product);
  }
}
function changeOption(group, option, count) {
  if (option.available === false || model.state.stops.get(option.id)?.stopped) return;
  const existing = chosen.find((s) => s.group_id === group.id && s.option_id === option.id);
  const current = existing?.quantity ?? (existing ? 1 : 0);
  if (group.max_selected === 1) {
    chosen = chosen.filter((s) => s.group_id !== group.id);
    if (count) chosen.push({ group_id: group.id, option_id: option.id, quantity: 1 });
  } else {
    const n = chosen
      .filter((s) => s.group_id === group.id)
      .reduce((n, s) => n + (s.quantity ?? 1), 0);
    if (count < 0 || count > (option.max_quantity ?? 1) || n - current + count > group.max_selected)
      return;
    chosen = chosen.filter((s) => s !== existing);
    if (count) chosen.push({ group_id: group.id, option_id: option.id, quantity: count });
  }
  schedule();
}
function optionValues(group) {
  return (group?.options ?? []).map((o) => {
    const n = chosen.find((s) => s.group_id === group.id && s.option_id === o.id)?.quantity ?? 0,
      out = o.available === false || model.state.stops.get(o.id)?.stopped;
    return {
      multi: group.max_selected > 1,
      label: o.name.ru,
      name: o.name.ru,
      note: o.price_minor === '0' ? '' : '+ ' + money(o.price_minor),
      qty: n,
      priceLabel: money(o.price_minor),
      bg: n ? 'var(--blue)' : '#fff',
      fg: n ? '#fff' : 'var(--n900)',
      border: n ? 'var(--blue)' : 'var(--n300)',
      opacity: out ? 0.4 : 1,
      deco: out ? 'line-through' : 'none',
      pick: () => changeOption(group, o, group.max_selected === 1 ? 1 : n + 1),
      inc: () => changeOption(group, o, n + 1),
      dec: () => changeOption(group, o, n - 1),
    };
  });
}
async function enterPin(pin, close = false) {
  if (signing || blocked()) return;
  signing = true;
  try {
    if (close) {
      // Verify the manager in an isolated login request first; do not replace the cashier on failure.
      const response = await fetch('/edge/v1/staff/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, terminal_id: config.terminalId }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw Error('Неверный PIN или слишком много попыток');
      const credential = await response.json();
      if (credential.role !== 'shift_manager') {
        await transport('staff/logout', credential, { method: 'POST' });
        throw Error('Нужен PIN начальника смены');
      }
      const shiftId = model.state.shift?.shift_id;
      await model.login(JSON.stringify(credential));
      await model.closeShift(shiftId, String(reference.state.counted * 100), closeReason);
      if (model.state.error) throw Error(errorMessage(model.state.error));
      reference.setState({ closeOpen: false, screen: 'lock', pin: '', closePin: '' });
      model.logout();
      say('Тестовая смена закрыта. Фискальный Z-отчёт не формировался.');
    } else {
      await pinLogin(pin, config.terminalId);
      if (!model.state.draft && !model.state.pending) model.newDraft();
      if (!model.state.shift && model.state.actor?.role !== 'shift_manager') {
        model.logout();
        throw Error('Смена не открыта - нужен PIN начальника смены');
      }
      reference.setState({
        pin: '',
        pinErr: '',
        screen: model.state.shift ? 'work' : 'openshift',
        tab: 'order',
      });
    }
  } catch (e) {
    reference.setState({ pin: '', closePin: '', pinErr: e.message });
    say(e.message);
  } finally {
    signing = false;
    schedule();
  }
}
function pinKeys(field, close = false) {
  return reference.keys(
    (d) => {
      if (signing || blocked()) return;
      const value = reference.state[field] + d;
      reference.setState({ [field]: value, pinErr: '' });
      if (value.length === 4) void enterPin(value, close);
    },
    (all) => reference.setState({ [field]: all ? '' : reference.state[field].slice(0, -1) }),
    !close,
  );
}
async function submit() {
  if (blocked() || !model.hasConfirmedOpenShift) return;
  await model.calculate();
  if (model.state.error) {
    say(errorMessage(model.state.error));
    return;
  }
  if (model.state.ordering?.pos_service_mode !== 'unpaid_service') {
    say('Тестовая передача на кухню ещё не включена оператором.');
    return;
  }
  await model.create(true);
  if (model.state.order) {
    lastOrder = model.state.order;
    reference.setState({ screen: 'success', doneLeft: 8, done: {}, mod: null });
    clearInterval(successTimer);
    successTimer = setInterval(() => {
      if (reference.state.screen !== 'success') {
        clearInterval(successTimer);
        return;
      }
      const left = reference.state.doneLeft - 1;
      reference.setState({ doneLeft: left });
      if (left <= 0) nextOrder();
    }, 1000);
  } else if (model.state.error) say(errorMessage(model.state.error));
}
function nextOrder() {
  if (blocked()) return;
  clearInterval(successTimer);
  model.newDraft();
  lastOrder = null;
  reference.setState({
    screen: 'work',
    tab: 'order',
    sel: null,
    guest: null,
    board: '',
    comment: '',
    done: null,
  });
}
function lock() {
  if (blocked()) return;
  model.logout();
  globalThis.pickchickPosJournal?.endSession();
  reference.setState({ screen: 'lock', pin: '', user: null });
}
function collectProducts() {
  const groups = { combo: [], duo: [], party: [], dops: [], drinks: [] };
  for (const p of model.state.menu?.items ?? []) {
    const label = config.categories?.[p.category_id] ?? '',
      key = /двои/i.test(label)
        ? 'duo'
        : /компани/i.test(label)
          ? 'party'
          : /напит/i.test(label)
            ? 'drinks'
            : /комбо/i.test(label)
              ? 'combo'
              : 'dops';
    groups[key].push({
      id: (key === 'drinks' ? 'n' : 'd') + p.variant_id,
      variant: p.variant_id,
      name: p.name.ru,
      price: Number(p.price_minor) / 100,
      img: photos[p.image_url] ?? p.image_url,
      combo: ['combo', 'duo'].includes(key),
      party: key === 'party',
      product: p,
    });
  }
  reference.COMBOS = groups.combo;
  reference.DUO = groups.duo;
  reference.PARTY = groups.party;
  reference.DOPS = groups.dops.concat(groups.drinks);
  return groups;
}
function draw() {
  const m = model.state,
    s = reference.state,
    groups = collectProducts();
  s.clock = time();
  s.ready = Boolean(m.menu);
  s.shiftOpen = Boolean(m.shift);
  s.drawer = Number(m.shift?.expected_cash_minor ?? 0) / 100;
  s.cart = (m.draft?.items ?? []).map((l) => {
    const p = item(l.variant_id);
    let unit = 0;
    try {
      unit = Number(linePrice(p, l.modifiers)) / 100;
    } catch {
      /* Missing or invalid selections disable confirmation below. */
    }
    return {
      key: lineKey(l),
      id: 'd' + l.variant_id,
      name: p?.name.ru ?? 'Позиция недоступна',
      qty: l.quantity,
      price: unit,
      extra: 0,
      mods: selectionsText(p ?? {}, l.modifiers ?? []),
      line: l,
    };
  });
  s.mode = m.draft?.service_mode === 'dine_in' ? 'dine' : 'take';
  s.comment = m.draft?.details?.kitchen_comment ?? '';
  if (!s.guestOpen) s.board = m.draft?.details?.display_name ?? '';
  s.shiftAt = m.shift ? time(m.shift.opened_at) : '';
  s.stops = Object.fromEntries(
    [...m.stops].filter(([, v]) => v.stopped).map(([id]) => ['d' + id, true]),
  );
  s.held = model.heldDrafts;
  s.offline = false;
  s.queued = 0;
  s.user = m.actor
    ? {
        name: m.actor.name ?? (m.actor.role === 'shift_manager' ? 'Начальник смены' : 'Кассир'),
        short: m.actor.name?.split(' ')[0] ?? m.actor.staff_id.slice(0, 8),
        role: m.actor.role === 'shift_manager' ? 'Начальник смены' : 'Кассир',
        boss: m.actor.role === 'shift_manager',
      }
    : null;
  if (!m.actor && s.screen !== 'lock') s.screen = 'lock';
  const v = reference.renderVals();
  // The designer module supplies appearance and local view transitions only.
  // All business handlers below use the durable model or explicitly report unavailable integration.
  for (const key of [
    'toggleGoods',
    'toggleOffline',
    'addGift',
    'togglePromo',
    'toggleRush',
    'createGuest',
    'findGuest',
    'acceptDelivery',
    'acceptAllDelivery',
    'rejectDelivery',
    'sayReprint',
    'sayDrawer',
    'sayX',
    'sayRetry',
    'askOtp',
    'confirmPay',
    'sayCashIn',
    'sayCashOut',
  ])
    v[key] = unavailable;
  Object.assign(v, {
    branchLabel: config.branchLabel ?? 'Локальная точка',
    dateLabel: date(),
    dayDateLabel: date(filterDate + 'T12:00:00+05:00'),
    dayPrevious: () => changeDay(-1),
    dayNext: () => changeDay(1),
    pinKeys: pinKeys('pin'),
    closePinKeys: pinKeys('closePin', true),
    pinError: signing ? 'Проверяем PIN...' : s.pinErr,
    staffHint: 'Личный PIN выдаёт управляющий. Проверка на локальном сервере.',
    connLabel:
      m.operationsAvailable && !m.operationsError ? 'Локальная сеть' : 'Нет связи с кассой',
    connDot: m.operationsAvailable && !m.operationsError ? 'var(--green)' : 'var(--red)',
    kkmLine: 'ТЕСТ · Оплата и фискальный чек отключены',
    kkmDot: '#F0C240',
    kkmBg: '#FFF3C4',
    orderNoLabel: 'новый',
    openShift: safe(async () => {
      if (m.actor?.role !== 'shift_manager') {
        say('Открывает начальник смены');
        return;
      }
      await model.openShift(String(Math.round(s.openCash * 100)));
      if (model.state.shift) {
        reference.setState({ screen: 'work', tab: 'order' });
        say('Тестовая смена открыта');
      }
    }),
    lock,
    sayChangeCashier: lock,
    restoreHeld: safe(() => {
      model.restoreDraft();
      say('Отложенный заказ восстановлен');
    }),
    holdOrder: safe(() => {
      model.holdDraft();
      say('Заказ отложен и сохранён на кассе');
    }),
    modeOpts: v.modeOpts.map((o, i) => ({
      ...o,
      pick: safe(() => model.mode(i ? 'dine_in' : 'takeaway')),
    })),
    decSel: safe(() => {
      const l = s.cart.find((l) => l.key === s.sel);
      if (l) model.quantity(l.key, l.qty - 1);
    }),
    incSel: safe(() => {
      const l = s.cart.find((l) => l.key === s.sel);
      if (l) model.quantity(l.key, l.qty + 1);
    }),
    delSel: safe(() => {
      const l = s.cart.find((l) => l.key === s.sel);
      if (l) {
        lastDeleted = l.line;
        model.quantity(l.key, 0);
        say('Позиция удалена');
        reference.setState({ toastUndo: true });
      }
    }),
    undo: safe(() => {
      if (lastDeleted) {
        model.configure(lastDeleted.variant_id, lastDeleted.modifiers ?? [], lastDeleted.quantity);
        lastDeleted = null;
        reference.setState({ toastUndo: null });
      }
    }),
    clearGuest: () => details({ display_name: '' }),
    guestDone: () => {
      details({ display_name: s.board.trim().slice(0, 14) });
      reference.setState({ guestOpen: false, guest: null });
    },
    findGuest: () =>
      say('Поиск аккаунтов и Чики подключим отдельно. Для теста укажите имя на табло.'),
    hasPromo: false,
    discountLabel: '0',
    giftAvail: false,
    earnLabel: '0',
    guestLevel: 'Имя для табло',
    guestChiki: '-',
    guestIdleText:
      'Поиск аккаунтов и начисление Чики пока не подключены. Можно указать имя для табло.',
    openComment: () => {
      commentPurpose = 'order';
      reference.setState({ commentOpen: true, draft: s.comment });
    },
    closeComment: () => {
      reference.setState({
        commentOpen: false,
        ...(commentPurpose === 'discrepancy' ? { closeOpen: true } : {}),
      });
    },
    commentSave: () => {
      if (commentPurpose === 'discrepancy') {
        if (!s.draft.trim()) {
          say('Укажите причину расхождения');
          return;
        }
        closeReason = s.draft.trim();
        reference.setState({ commentOpen: false, closeOpen: true, closeStep: 3 });
      } else {
        details({ kitchen_comment: s.draft.trim().slice(0, 60) });
        reference.setState({ commentOpen: false });
        say('Комментарий сохранён в заказе');
      }
    },
    commentTitle:
      commentPurpose === 'discrepancy' ? 'Причина расхождения' : 'Комментарий для кухни',
    commentCta: commentPurpose === 'discrepancy' ? 'Сохранить причину' : 'Сохранить в заказ',
    commentSub:
      commentPurpose === 'discrepancy'
        ? 'Причина расхождения останется в отчёте смены.'
        : 'Просьба гостя будет видна на локальной кухне вместе с заказом.',
    totalLabel: total() === null ? '-' : money(total().toString()),
    subtotalLabel: total() === null ? '-' : money(total().toString()),
    payBtnLabel: blocked()
      ? 'Проверяем запрос...'
      : !s.cart.length
        ? 'ПЕРЕДАТЬ НА КУХНЮ'
        : 'НА КУХНЮ · ' + (total() === null ? '-' : money(total().toString())),
    toPay: safe(async () => {
      if (!s.cart.length) return;
      if (!model.hasConfirmedOpenShift) {
        say('Сначала откройте смену');
        return;
      }
      await model.calculate();
      if (model.state.error) {
        say(errorMessage(model.state.error));
        return;
      }
      reference.setState({ screen: 'pay', pay: null });
    }),
    payTiles: v.payTiles.map((o) => ({ ...o, pick: unavailable, opacity: 0.45 })),
    payCtaLabel: 'ПЕРЕДАТЬ БЕЗ ОПЛАТЫ',
    payCtaBg: 'var(--orange)',
    payCtaFg: '#fff',
    confirmPay: safe(submit),
    doneNo: lastOrder ? orderNumber(lastOrder) : '',
    doneGuest: lastOrder?.snapshot.details?.display_name || '-',
    doneMode: lastOrder?.snapshot.service_mode === 'dine_in' ? 'В ЗАЛЕ' : 'С СОБОЙ',
    doneMethod: 'Тест · без оплаты',
    doneSum: lastOrder ? money(lastOrder.snapshot.total_minor) : '0 ₸',
    doneNote: 'Заказ сохранён на локальном сервере и передан на кухню. Чек не создавался.',
    nextOrder,
    shiftOrders: m.shift?.order_count ?? 0,
    shiftRevenue: '0 ₸',
    shiftPays: [
      {
        name: 'Тестовые заказы без оплаты',
        sum: money(m.shift?.unpaid_total_minor ?? '0'),
        color: 'var(--blue)',
      },
    ],
    drawerLabel: money(m.shift?.expected_cash_minor ?? '0'),
    cashLog: m.shift
      ? [
          ...(m.shift.cash_movements ?? [])
            .slice()
            .reverse()
            .map((v) => ({
              time: time(v.created_at),
              what: (v.direction === 'in' ? 'Внесение' : 'Изъятие') + ' · ' + v.reason,
              sum: (v.direction === 'in' ? '+' : '-') + money(v.amount_minor),
              fg: v.direction === 'in' ? 'var(--green)' : 'var(--red)',
            })),
          {
            time: time(m.shift.opened_at),
            what: 'Начальный остаток · тест',
            sum: money(m.shift.opening_cash_minor),
            fg: 'var(--green)',
          },
        ]
      : [],
    sayCashIn: () => cashDialog('in'),
    sayCashOut: () => cashDialog('out'),
    shiftAtLabel: m.shift ? time(m.shift.opened_at) : '-',
    sayTotals: () =>
      say(
        `${m.shift?.order_count ?? 0} заказов · без оплаты ${money(m.shift?.unpaid_total_minor ?? '0')}`,
      ),
    startClose: () => {
      if (m.actor?.role !== 'shift_manager') {
        say('Закрывает начальник смены');
        return;
      }
      reference.setState({ closeOpen: true, closeStep: 1, counted: 0, closePin: '' });
    },
    queueLine: 'Тестовый режим. Фискальные чеки не создавались.',
    closeCtaLabel: s.closeStep < 5 ? 'Дальше' : 'Введите PIN начальника смены',
    closeNext: () => {
      if (
        s.closeStep === 2 &&
        BigInt(s.counted) * 100n !== BigInt(m.shift?.expected_cash_minor ?? '0')
      ) {
        showReason();
        return;
      }
      if (s.closeStep < 5) reference.setState({ closeStep: s.closeStep + 1 });
    },
    diffLabel: (() => {
      const delta = BigInt(s.counted) * 100n - BigInt(m.shift?.expected_cash_minor ?? '0');
      return delta === 0n
        ? 'Расхождения нет'
        : 'Расхождение ' +
            (delta < 0n ? '-' : '+') +
            money((delta < 0n ? -delta : delta).toString()) +
            ' - добавьте комментарий';
    })(),
    collectLabel: '0 ₸',
    carryLabel: money(String(s.counted * 100)),
    shiftByLabel: m.shift?.staff_id.slice(0, 8) ?? '-',
    syncLabel: 'Локальный сервер · внешние каналы ещё не подключены',
  });
  v.tiles = (groups[s.cat] ?? []).map((p) => {
    const stop = m.stops.get(p.variant),
      out = stop?.stopped !== false;
    return {
      name: p.name,
      price: money(p.product.price_minor),
      img: p.img,
      noImg: !p.img,
      slot: p.id,
      tag: p.name === 'Pick Combo' ? 'ХИТ' : p.name === 'Solo Combo' ? 'НОВИНКА' : false,
      out,
      opacity: 1,
      quick: p.combo && !out ? 'По умолчанию' : false,
      canStop: false,
      quickTap: safe(() => defaultAdd(p.product)),
      tap: safe(() => {
        if (out) {
          say('Позиция в стоп-листе или доступность ещё не подтверждена');
          return;
        }
        if (p.party) openWizard(p.product);
        else if (p.product.modifier_groups?.length) openModifier(p.product);
        else model.configure(p.variant, [], 1);
      }),
    };
  });
  v.navItems = v.navItems.map((o, i) => ({
    ...o,
    go: safe(() => {
      if (i === 0 && model.state.order) model.newDraft();
      o.go();
    }),
  }));
  v.langOpts = v.langOpts.map((o) => ({ ...o, pick: unavailable }));
  v.lines = v.lines.map((line, i) => ({
    ...line,
    select: () => {
      const row = s.cart[i];
      if (s.sel === row.key && item(row.line.variant_id)?.modifier_groups?.length)
        openModifier(item(row.line.variant_id), row.line);
      else reference.setState({ sel: row.key });
    },
    warn: m.stops.get(s.cart[i].line.variant_id)?.stopped,
  }));
  if (modifier) {
    const gs = modifier.modifier_groups ?? [],
      drink = gs.find((g) => /напит/i.test(g.name.ru)),
      sauce = gs.find((g) => /соус.*выбор|соусы/i.test(g.name.ru)),
      size = gs.find((g) => /объ[её]м|размер/i.test(g.name.ru)),
      extra = gs.find((g) => /добав/i.test(g.name.ru));
    let price = null;
    try {
      price = linePrice(modifier, chosen) * BigInt(portions);
    } catch {
      /* Missing or invalid selections disable confirmation below. */
    }
    Object.assign(v, {
      modOpen: Boolean(s.mod),
      modName: modifier.name.ru,
      modComp: gs
        .filter((g) => g.min_selected)
        .map(
          (g) =>
            `${g.name.ru}: ${chosen.filter((s) => s.group_id === g.id).reduce((n, s) => n + s.quantity, 0)} / ${g.min_selected}`,
        )
        .join(' · '),
      modBase: money(modifier.price_minor),
      modIsCombo: Boolean(drink || sauce),
      modHasSizes: Boolean(size),
      drinkOpts: optionValues(drink),
      sauceOpts: optionValues(sauce),
      sizeOpts: optionValues(size),
      addonRows: optionValues(extra),
      modQty: portions,
      modIncQty: () => {
        if (portions < 99) portions++;
        schedule();
      },
      modDecQty: () => {
        if (portions > 1) portions--;
        schedule();
      },
      modCtaLabel:
        price === null ? 'Выберите обязательный состав' : 'В заказ · ' + money(price.toString()),
      modCtaBg: price === null ? 'var(--n300)' : 'var(--orange)',
      modCtaFg: price === null ? 'var(--n600)' : '#fff',
      modConfirm: safe(() => {
        if (price === null) return;
        model.configure(modifier.variant_id, chosen, portions, previousKey ?? undefined);
        if (!model.state.error) {
          modifier = null;
          reference.setState({ mod: null });
        }
      }),
    });
  }
  if (modifier && s.wiz) {
    const sauce = modifier.modifier_groups?.find((g) => /соус/i.test(g.name.ru));
    const count = chosen
        .filter((o) => o.group_id === sauce?.id)
        .reduce((sum, o) => sum + o.quantity, 0),
      need = sauce?.min_selected ?? 0;
    let price = null;
    try {
      price =
        linePrice(modifier, chosen) +
        groups.drinks.reduce(
          (sum, p) => sum + BigInt(p.product.price_minor) * BigInt(wizardDrinks[p.variant] ?? 0),
          0n,
        );
    } catch {
      /* Missing or invalid selections disable confirmation below. */
    }
    const drinkCount = Object.values(wizardDrinks).reduce((sum, n) => sum + n, 0);
    const add = () => {
      if (price === null) return;
      const d = model.state.draft;
      if (!d) return;
      const additions = [
        { variant_id: modifier.variant_id, quantity: 1, modifiers: chosen.map((v) => ({ ...v })) },
        ...groups.drinks
          .filter((p) => wizardDrinks[p.variant])
          .map((p) => ({
            variant_id: p.variant,
            quantity: wizardDrinks[p.variant],
            modifiers: [],
          })),
      ];
      model.replaceDraft({
        ...d,
        items: [...d.items, ...additions].reduce((all, line) => {
          const found = all.find((l) => lineKey(l) === lineKey(line));
          if (found) found.quantity += line.quantity;
          else all.push({ ...line });
          return all;
        }, []),
      });
      if (!model.state.error) {
        modifier = null;
        reference.setState({ wiz: null });
      }
    };
    Object.assign(v, {
      wizOpen: true,
      wizName: modifier.name.ru,
      wizComp: 'Состав и цены из локального меню',
      wizCountLabel: s.wizStep === 1 ? `Выбрано ${count} / ${need}` : `Напитков: ${drinkCount}`,
      wizCountFg: count === need ? 'var(--green)' : 'var(--orange)',
      wizHint: s.wizStep === 1 ? 'соусов в сете' : 'Необязательно - до 20 напитков',
      wizSteps: [1, 2].map((step) => ({
        label: step === 1 ? 'Шаг 1 · Соусы' : 'Шаг 2 · Напитки',
        bg: s.wizStep === step ? '#fff' : 'transparent',
        fg: s.wizStep === step ? 'var(--blue)' : 'var(--n600)',
        pick: () => {
          if (step === 1 || count === need) reference.setState({ wizStep: step });
        },
      })),
      wizFillPick: () => {
        if (!sauce) return;
        const o = sauce.options.find(
          (o) => o.default_quantity && !m.stops.get(o.id)?.stopped && o.available !== false,
        );
        if (!o) {
          say('Соус по умолчанию недоступен');
          return;
        }
        chosen = chosen.filter((v) => v.group_id !== sauce.id);
        changeOption(sauce, o, need);
      },
      wizRows:
        s.wizStep === 1
          ? optionValues(sauce)
          : groups.drinks.map((p) => ({
              name: p.name + ' · ' + money(p.product.price_minor),
              qty: wizardDrinks[p.variant] ?? 0,
              opacity: m.stops.get(p.variant)?.stopped ? 0.4 : 1,
              deco: m.stops.get(p.variant)?.stopped ? 'line-through' : 'none',
              inc: () => {
                if (drinkCount < 20 && !m.stops.get(p.variant)?.stopped) {
                  wizardDrinks[p.variant] = (wizardDrinks[p.variant] ?? 0) + 1;
                  schedule();
                }
              },
              dec: () => {
                wizardDrinks[p.variant] = Math.max(0, (wizardDrinks[p.variant] ?? 0) - 1);
                schedule();
              },
            })),
      wizCtaLabel:
        s.wizStep === 1
          ? count === need
            ? 'Дальше'
            : `Выберите ещё ${need - count}`
          : 'В заказ · ' + (price === null ? '-' : money(price.toString())),
      wizCtaBg: count === need ? 'var(--orange)' : 'var(--n300)',
      wizCtaFg: count === need ? '#fff' : 'var(--n600)',
      wizNext: safe(() => {
        if (s.wizStep === 1) {
          if (count === need) reference.setState({ wizStep: 2 });
        } else add();
      }),
    });
  }
  const rows = m.orders.filter(
    (o) =>
      (s.dayFilter === 'all' || s.dayFilter === 'pos') &&
      new Date(o.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' }) ===
        filterDate,
  );
  v.dayRows = rows.map((o) => ({
    no: orderNumber(o),
    time: time(o.created_at),
    channel: 'КАССА · ТЕСТ',
    chBg: 'var(--blue)',
    guest: o.snapshot.details?.display_name || '-',
    items: o.snapshot.lines.map((l) => l.name.ru + ' ×' + l.quantity).join(', '),
    sum: money(o.snapshot.total_minor),
    pay: 'Без оплаты',
    status: kitchenLabel(o),
    stBg: o.fulfillment_state === 'ready' ? '#DCF2E4' : 'var(--n100)',
    stFg: o.fulfillment_state === 'ready' ? '#0B7A3B' : 'var(--n900)',
    fiscal: 'var(--n300)',
    rowBg: '#fff',
    canRefund: false,
    open: safe(() => orderDialog(o.order_id)),
    fiscalLabel: 'без чека',
    note: o.snapshot.details?.kitchen_comment ?? '',
    hasNote: Boolean(o.snapshot.details?.kitchen_comment),
    canEditNote: false,
    canSwapMode: false,
    modeLabel: o.snapshot.service_mode === 'dine_in' ? 'В ЗАЛЕ' : 'С СОБОЙ',
    modeFg: 'var(--blue)',
  }));
  v.dayStats = [
    ['ВСЕ ЗАКАЗЫ', rows],
    ['ЗАЛ И НАВЫНОС', rows],
    ['ДОСТАВКА', []],
  ].map(([label, list]) => ({
    label,
    note: 'Тест без оплаты',
    color: 'var(--blue)',
    orders: String(list.length),
    revenue: '0 ₸',
    avg: list.length
      ? money(
          (
            list.reduce((n, o) => n + BigInt(o.snapshot.total_minor), 0n) / BigInt(list.length)
          ).toString(),
        )
      : '-',
    share: 'Сумма тестовых заказов',
  }));
  v.dayTotal = rows.length + ' заказов · последние 100';
  v.fiscalLegend = [{ color: 'var(--n300)', label: 'Тест · без оплаты и чека' }];
  const stopRows = (m.menu?.items ?? [])
    .flatMap((p) => [
      p,
      ...(p.modifier_groups ?? []).flatMap((g) =>
        g.options.map((o) => ({
          variant_id: o.id,
          name: o.name,
          category_id: p.category_id,
          stopCategory: g.name.ru + ' · ' + p.name.ru,
        })),
      ),
    ])
    .map((p) => {
      const stop = m.stops.get(p.variant_id),
        on = Boolean(stop?.stopped);
      return {
        name: p.name.ru,
        cat: p.stopCategory ?? config.categories?.[p.category_id] ?? 'Блюдо',
        on,
        fg: on ? 'var(--red)' : 'var(--n900)',
        trackBg: on ? 'var(--red)' : 'var(--green)',
        knob: on ? 'flex-start' : 'flex-end',
        bg: on ? 'rgba(196,48,43,.06)' : '#fff',
        border: on ? 'var(--red)' : 'var(--n300)',
        track: on ? 'var(--red)' : '#CFD5DF',
        left: on ? '30px' : '4px',
        toggle: safe(() => {
          if (on) void model.setStop(p.variant_id, false, 'Снят кассиром');
          else reference.setState({ stopAsk: { id: p.variant_id, name: p.name.ru } });
        }),
        variant: p.variant_id,
      };
    });
  v.stopItems = stopRows.filter((p) => !/напит/i.test(p.cat));
  v.stopDrinks = stopRows.filter((p) => /напит/i.test(p.cat));
  v.stopActive = stopRows
    .filter((p) => p.on)
    .map((p) => ({
      name: p.name,
      meta: 'Локальный стоп',
      channels: [{ label: 'КАССА', bg: 'var(--blue)' }],
      lift: safe(() => model.setStop(p.variant, false, 'Снят кассиром')),
    }));
  v.stopCount = v.stopActive.length;
  v.noStops = !v.stopCount;
  v.stopDurations = [
    ['shift', 'До конца смены'],
    ['hour', 'На 1 час'],
    ['manual', 'Пока не сниму'],
  ].map(([duration, label]) => ({
    label,
    pick: safe(async () => {
      if (!s.stopAsk) return;
      await model.setStop(s.stopAsk.id, true, 'Поставлен кассиром', duration);
      reference.setState({ stopAsk: null });
      if (!model.state.error) say('Позиция остановлена на локальном сервере');
    }),
  }));
  const visual = JSON.stringify({
    v,
    busy: m.busy,
    pending: m.pending,
    actor: m.actor?.session_id,
    shift: m.shift?.shift_id,
    release: m.menu?.release_id,
    draft: m.draft,
    error: String(m.error ?? ''),
  });
  if (visual === lastRender) return;
  lastRender = visual;
  renderer.render(v);
  // Honest permanent test label, operation recovery, fullscreen and local status.
  const badge = document.createElement('button');
  badge.className = 'test-mode';
  badge.textContent = 'ТЕСТ · без оплаты и чека';
  badge.title = 'Переключить полноэкранный режим';
  badge.onclick = () => {
    const b = globalThis.pickchickPosWindow;
    if (b) void b.toggleFullscreen();
    else if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };
  root.append(badge);
  if (m.pending) {
    const box = document.createElement('div');
    box.className = 'recovery';
    const text = document.createElement('span');
    text.textContent = 'Результат запроса неизвестен. Новая отправка заблокирована.';
    const button = document.createElement('button');
    button.textContent = 'Проверить результат';
    button.onclick = async () => {
      const wasCreate = model.state.pending?.kind === 'create';
      await model.recover();
      if (wasCreate && model.state.order && !model.state.pending) {
        lastOrder = model.state.order;
        reference.setState({ screen: 'success', done: {}, doneLeft: 8 });
      }
    };
    box.append(text, button);
    root.append(box);
  }
  if (m.error && errorShown !== String(m.error)) {
    errorShown = String(m.error);
    say(errorMessage(m.error));
  } else if (!m.error) errorShown = '';
  if (m.busy || signing) {
    root.setAttribute('aria-busy', 'true');
  } else root.removeAttribute('aria-busy');
}
function changeDay(days) {
  const d = new Date(filterDate + 'T12:00:00+05:00');
  d.setUTCDate(d.getUTCDate() + days);
  filterDate = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
  schedule();
}
function showReason() {
  commentPurpose = 'discrepancy';
  reference.setState({ commentOpen: true, draft: '', closeOpen: false });
}
async function orderDialog(id) {
  await model.openOrder(id);
  if (model.state.error) {
    say(errorMessage(model.state.error));
    return;
  }
  const o = model.state.order;
  if (!o) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'order-dialog';
  const title = document.createElement('h2');
  title.textContent = 'Заказ № ' + orderNumber(o);
  const state = document.createElement('p');
  state.textContent = kitchenLabel(o) + ' · без оплаты и чека';
  state.dataset.testid = 'order-status';
  const list = document.createElement('div');
  for (const line of o.snapshot.lines) {
    const row = document.createElement('p');
    row.textContent = line.name.ru + ' × ' + line.quantity + ' · ' + money(line.total_minor);
    if (line.modifiers?.length) {
      const mods = document.createElement('small');
      mods.textContent = line.modifiers
        .map((v) => (v.quantity > 1 ? v.quantity + ' × ' : '') + v.name.ru)
        .join(' · ');
      row.append(mods);
    }
    list.append(row);
  }
  const note = document.createElement('p');
  note.textContent = [o.snapshot.details?.display_name, o.snapshot.details?.kitchen_comment]
    .filter(Boolean)
    .join(' · ');
  const actions = document.createElement('div');
  actions.className = 'cash-actions';
  const close = document.createElement('button');
  close.textContent = 'Закрыть';
  close.onclick = () => dialog.close();
  actions.append(close);
  if (o.state === 'awaiting_payment' && ['blocked', 'accepted'].includes(o.fulfillment_state)) {
    const cancel = document.createElement('button');
    cancel.textContent = 'Отменить заказ';
    cancel.onclick = () => {
      actions.replaceChildren(close);
      const hint = document.createElement('p');
      hint.textContent =
        'Подтвердите причину отмены. Кухня получит отмену, если приготовление ещё не началось.';
      list.append(hint);
      for (const reason of ['Гость отказался', 'Ошибка кассира', 'Нет ингредиентов']) {
        const b = document.createElement('button');
        b.textContent = reason;
        b.onclick = async () => {
          if (blocked()) return;
          b.disabled = true;
          await model.cancel(reason);
          dialog.close();
          if (!model.state.error) say('Заказ отменён');
        };
        actions.append(b);
      }
    };
    actions.append(cancel);
  }
  dialog.append(title, state, list, note, actions);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
function cashDialog(direction) {
  if (model.state.actor?.role !== 'shift_manager') {
    say('Внесение и изъятие выполняет начальник смены');
    return;
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'cash-dialog';
  let amount = '';
  const title = document.createElement('h2');
  title.textContent = direction === 'in' ? 'Внесение в ящик' : 'Изъятие из ящика';
  const note = document.createElement('p');
  note.textContent = 'Тестовая смена - без платежа и фискального документа';
  const output = document.createElement('output');
  output.textContent = '0 ₸';
  const reasons = document.createElement('div');
  reasons.className = 'cash-reasons';
  let reason = direction === 'in' ? 'Размен' : 'Инкассация';
  for (const value of direction === 'in'
    ? ['Размен', 'Пополнение']
    : ['Инкассация', 'Выдача размена']) {
    const b = document.createElement('button');
    b.textContent = value;
    b.onclick = () => {
      reason = value;
      for (const item of reasons.children) item.classList.toggle('selected', item === b);
    };
    if (value === reason) b.className = 'selected';
    reasons.append(b);
  }
  const keys = document.createElement('div');
  keys.className = 'cash-keys';
  for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']) {
    const b = document.createElement('button');
    b.textContent = key;
    b.onclick = () => {
      amount =
        key === 'C'
          ? ''
          : key === '⌫'
            ? amount.slice(0, -1)
            : amount.length < 7
              ? amount + key
              : amount;
      output.textContent = money((BigInt(amount || 0) * 100n).toString());
    };
    keys.append(b);
  }
  const actions = document.createElement('div');
  actions.className = 'cash-actions';
  const cancel = document.createElement('button');
  cancel.textContent = 'Отмена';
  cancel.onclick = () => dialog.close();
  const submit = document.createElement('button');
  submit.textContent = 'Сохранить';
  submit.onclick = async () => {
    if (blocked() || BigInt(amount || 0) <= 0n) return;
    submit.disabled = true;
    await model.moveCash(direction, (BigInt(amount) * 100n).toString(), reason);
    dialog.close();
    if (!model.state.error) say('Движение сохранено в журнале смены');
  };
  actions.append(cancel, submit);
  dialog.append(title, note, output, reasons, keys, actions);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
model.subscribe(schedule);
schedule();
await model.boot();
if (model.state.actor) {
  await model.refreshStops();
  if (!model.state.draft && !model.state.pending) model.newDraft();
}
if (model.state.actor) reference.setState({ screen: model.state.shift ? 'work' : 'openshift' });
setInterval(() => {
  for (const e of root.querySelectorAll('[data-clock]')) e.textContent = time();
  if (reference.state.clock !== time()) schedule();
}, 1000);
setInterval(() => {
  if (model.state.actor && !blocked() && !document.hidden)
    void Promise.all([model.refreshOperations(), model.refreshStops()]);
}, 3000);
// Physical keyboards are supplementary; the on-screen keypad remains primary.
document.addEventListener('keydown', (event) => {
  if (reference.state.screen !== 'lock' || event.target.matches('input,textarea')) return;
  if (/^\d$/.test(event.key)) {
    const keys = pinKeys('pin');
    keys.find((k) => k.label === event.key)?.tap();
  } else if (event.key === 'Backspace')
    reference.setState({ pin: reference.state.pin.slice(0, -1) });
});
