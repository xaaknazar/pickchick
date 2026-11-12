// Cutover 19.11 (CR client-5): a desk without payments (pos/config 404 or unpaid_service) says
// so in a few places; a desk that sells (pos/config pos_sale) says what is true there instead.
// No screen says "test" (owner, 12.11.2026): an unpaid desk is "без оплаты" and shows its real
// version.
// DOM-free, like sale-view.js and ops-view.js.
import { deskNumber } from '../types.js';

/** Texts of a desk without payments. */
export const TEST_TEXTS = Object.freeze({
  shiftOpened: 'Смена открыта · без оплаты',
  shiftClosed: 'Смена закрыта. Оплат не было, Z-отчёт не формировался.',
  closeReason: 'Смена без оплаты',
  unavailable: 'Эта функция пока не подключена. Деньги и чеки не проводятся.',
  findGuest: 'Поиск аккаунтов и Чики подключим отдельно. Укажите имя на табло.',
  kitchenOff: 'Передачу на кухню ещё не включил оператор.',
  deskPrefix: 'Касса 1 · ',
  deskChip: ' · касса 1',
});
/**
 * The same places on a desk that sells. Its desk number only when the edge tells it (pos/config
 * desk_number, CR client-5 §3.2), see deskTexts.
 */
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
 * the header and the lock footer. Every desk shows its real version (or only the name when
 * pos-desktop does not report one). A desk that sells shows the number its edge gave it (1..99,
 * in today's wording) or no number rather than a wrong one; without payments it is "Касса 1".
 */
export function deskTexts(paid, version, number = null) {
  const known = appVersion(version);
  const appLine = PAID_TEXTS.appName + (known ? ' ' + known : '');
  if (!paid) return { deskPrefix: TEST_TEXTS.deskPrefix, deskChip: TEST_TEXTS.deskChip, appLine };
  const desk = deskNumber(number);
  return {
    deskPrefix: desk === null ? '' : `Касса ${desk} · `,
    deskChip: desk === null ? '' : ` · касса ${desk}`,
    appLine,
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
    cashLog: legacy.cashLog,
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
/**
 * The desk number that goes with the pos_sale hint above: the number of the edge's last pos_sale
 * answer to this desk, kept in a sibling key (the mode key keeps its two values for older
 * builds). Only a display hint, like the mode; a desk without payments never writes it.
 */
export const DESK_NUMBER_KEY = 'pickchick.pos.desk-number.v1';
export function storedDeskNumber(storage) {
  try {
    const value = storage?.getItem(DESK_NUMBER_KEY);
    return typeof value === 'string' && /^[1-9][0-9]?$/.test(value) ? Number(value) : null;
  } catch {
    return null;
  }
}
/** Keeps the number of a pos_sale answer; any other answer or none keeps `previous`. */
export function rememberDeskNumber(storage, state, previous) {
  if (state.posConfig?.mode !== 'pos_sale') return previous;
  const number = deskNumber(state.posConfig.desk_number);
  if (number !== previous)
    try {
      if (number === null) storage?.removeItem(DESK_NUMBER_KEY);
      else storage?.setItem(DESK_NUMBER_KEY, String(number));
    } catch {
      /* The lock screen shows no number after a restart; the session shows it again. */
    }
  return number;
}
