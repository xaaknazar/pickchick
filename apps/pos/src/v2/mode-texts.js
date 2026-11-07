// Cutover 19.11 (CR client-5): a few texts of today's screens say "test". They stay byte for
// byte while the desk works without payments (pos/config 404 or unpaid_service: installed desks
// must not change); a desk that sells (pos/config pos_sale) says what is true there instead.
// DOM-free, like sale-view.js and ops-view.js.

/** Today's texts, exactly as the unpaid cashier shows them. */
export const TEST_TEXTS = Object.freeze({
  shiftOpened: 'Тестовая смена открыта',
  shiftClosed: 'Тестовая смена закрыта. Фискальный Z-отчёт не формировался.',
  closeReason: 'Тестовая смена без оплаты',
  unavailable: 'В тестовом режиме эта интеграция не подключена. Деньги и чеки не проводятся.',
  findGuest: 'Поиск аккаунтов и Чики подключим отдельно. Для теста укажите имя на табло.',
  kitchenOff: 'Тестовая передача на кухню ещё не включена оператором.',
  deskPrefix: 'Касса 1 · ',
  deskChip: ' · касса 1',
  appLine: 'Pick Chick POS 0.4 · TEST',
});
/** The same places on a desk that sells. No desk number: nothing tells this desk's (CR §2). */
export const PAID_TEXTS = Object.freeze({
  shiftOpened: 'Смена открыта',
  shiftClosed: 'Смена закрыта. Не забудьте закрыть смену в кабинете Webkassa.',
  closeReason: 'Закрытие смены',
  unavailable: 'Эта функция пока не подключена.',
  findGuest: 'Поиск аккаунтов и Чики подключим отдельно. Укажите имя на табло.',
  kitchenWait: 'Касса получает настройки оплаты - повторите через полминуты.',
  unpaidReceipt: 'Заказ передан без оплаты - чека нет.',
  appName: 'Pick Chick POS',
});

/** A shift opened while the edge sells (sales_mode): the edge reports payment processing. */
export const salesShift = (shift) => shift?.payment_processing_available === true;
/** Toast after opening a shift: what the edge opened, a sales shift or today's test shift. */
export const shiftOpenedText = (shift) =>
  salesShift(shift) ? PAID_TEXTS.shiftOpened : TEST_TEXTS.shiftOpened;
/** Toast after today's closing dialog, by the shift it closed. */
export const shiftClosedText = (shift) =>
  salesShift(shift) ? PAID_TEXTS.shiftClosed : TEST_TEXTS.shiftClosed;
/** Reason of today's closing dialog when no discrepancy reason was typed. */
export const closeReasonText = (shift) =>
  salesShift(shift) ? PAID_TEXTS.closeReason : TEST_TEXTS.closeReason;
/** Buttons whose integration is not connected yet; a desk that sells never claims test mode. */
export const unavailableText = (paid) => (paid ? PAID_TEXTS.unavailable : TEST_TEXTS.unavailable);
export const findGuestText = (paid) => (paid ? PAID_TEXTS.findGuest : TEST_TEXTS.findGuest);
/**
 * Today's "send to kitchen" refused by the mode of GET ordering. An edge that already sells
 * while pos/config was not read yet (it is asked again at the next refresh) is not called a
 * test.
 */
export const kitchenOffText = (ordering) =>
  ordering?.pos_service_mode === 'pos_sale' ? PAID_TEXTS.kitchenWait : TEST_TEXTS.kitchenOff;

/** Version of the installed app as pos-desktop reports it in /config.json, or null. */
export const APP_VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;
export const appVersion = (value) =>
  typeof value === 'string' && APP_VERSION.test(value) ? value : null;
/**
 * Desk line of the lock and opening screens ("Касса 1 · " + clock or date), the role chip of
 * the header and the lock footer. A desk that sells shows no desk number rather than a wrong
 * one, and its real version without "TEST".
 */
export function deskTexts(paid, version) {
  if (!paid)
    return {
      deskPrefix: TEST_TEXTS.deskPrefix,
      deskChip: TEST_TEXTS.deskChip,
      appLine: TEST_TEXTS.appLine,
    };
  const known = appVersion(version);
  return {
    deskPrefix: '',
    deskChip: '',
    appLine: PAID_TEXTS.appName + (known ? ' ' + known : ''),
  };
}

/**
 * The lock screen has no session, so GET pos/config cannot be asked there. It shows the mode
 * this desk was last told by the edge: pos/config read (any mode) or 404. Only a display hint,
 * per desk in local storage; selling always follows the live pos/config of the session.
 */
export const DESK_MODE_KEY = 'pickchick.pos.desk-mode.v1';
export function storedDeskPaid(storage) {
  try {
    return storage?.getItem(DESK_MODE_KEY) === 'pos_sale';
  } catch {
    return false;
  }
}
/**
 * Whether the screens speak as a desk that sells: the session's pos/config pos_sale, or an edge
 * that sells by GET ordering while the session waits for its first pos/config answer (review
 * 07.11 R1, model.awaitingSale), or, before a session read GET ordering (the lock screen), the
 * desk's last answer `lastPaid`. A desk without payments (404, unpaid_service, an edge that
 * does not say) gets false: today's texts byte for byte.
 */
export const deskSells = (model, lastPaid) =>
  model.saleMode || model.awaitingSale || (!model.state.ordering && lastPaid === true);
/**
 * Today's values that would call the desk of a selling edge a test, or pass an order without
 * payment, while its session waits for pos/config (model.awaitingSale; asked again at the next
 * refresh). `legacy` are today's template values, `empty` an empty cart, `say` the toast.
 * Nothing here sells or writes: «К ОПЛАТЕ», the X report and closing ask to wait.
 */
export function awaitingValues(legacy, { busy, empty, say }) {
  const wait = () => say(PAID_TEXTS.kitchenWait);
  return {
    payBtnLabel: busy ? legacy.payBtnLabel : empty ? 'К ОПЛАТЕ' : 'К ОПЛАТЕ · ' + legacy.totalLabel,
    toPay: wait,
    confirmPay: wait,
    shiftRevenue: '-',
    shiftPays: [{ name: 'Отчёт смены загружается', sum: '-', color: 'var(--n300)' }],
    kkmLine: 'Чеки: вручную в Webkassa',
    cashLog: legacy.cashLog.map((row) =>
      row.what === 'Начальный остаток · тест' ? { ...row, what: 'Начальный остаток' } : row,
    ),
    sayX: wait,
    sayTotals: wait,
    startClose: wait,
  };
}
/** Keeps the edge's last definite answer; returns whether this desk sells (for the lock). */
export function rememberDeskMode(storage, state, previous) {
  const mode = state.posConfig ? state.posConfig.mode : state.posConfigMissing ? 'none' : null;
  if (mode === null) return previous;
  const paid = mode === 'pos_sale';
  if (paid !== previous)
    try {
      storage?.setItem(DESK_MODE_KEY, paid ? 'pos_sale' : 'unpaid');
    } catch {
      /* The lock screen falls back to today's texts after a restart. */
    }
  return paid;
}
