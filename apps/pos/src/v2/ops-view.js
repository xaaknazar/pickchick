// Cutover 19.11 paid mode, part B (contracts section 5.1, POS-3..5, owner decisions section 00):
// the paid order card with void and refund, the "Чеки Webkassa" tab, X and Z reports and the
// sales shift close wizard. DOM-free like sale-view.js: it only computes template values and
// collects what the cashier taps; every money effect goes through the durable controller.
import {
  money,
  pickupText,
  REFUND_REASONS,
  REFUND_REASON_NAMES,
  REFUNDABLE_METHODS,
  tenderRefundable,
  terminalNetMinor,
  CHANNEL_NAMES,
} from '../types.js';
import {
  closeSubject,
  fiscalSubject,
  methodEnabled,
  refundSubject,
  voidSubject,
} from '../model.js';
import { saleErrorMessage } from '../api.js';
import { kitchenLabel } from '../order-view.js';
import { METHOD_NAMES } from './sale-view.js';

const time = (value) =>
  new Date(value).toLocaleTimeString('ru-RU', {
    timeZone: 'Asia/Almaty',
    hour: '2-digit',
    minute: '2-digit',
  });
const tiyn = (digits) => BigInt(digits || '0') * 100n;
/** "+1 500 ₸", "-10 ₸", "0 ₸": a difference the cashier reads at a glance. */
const signed = (value) => {
  const n = BigInt(value);
  return n === 0n ? money('0') : (n < 0n ? '-' : '+') + money((n < 0n ? -n : n).toString());
};
const RECEIPT_STATES = { pending: 'не оформлен', recorded: 'оформлен', not_required: 'не нужен' };
const RECEIPT_KINDS = { sale: 'Чек продажи', refund: 'Чек возврата' };
const REFUND_NOTES = {
  cash: 'Выдайте наличные из ящика кассы.',
  kaspi_terminal: 'Сначала проведите возврат на терминале Kaspi, затем подтвердите.',
  kaspi_manual: 'Верните деньги гостю переводом Kaspi, затем подтвердите.',
};
const NO_REVENUE = ['staff_meal', 'marketing'];
const STEPS = ['Сводка', 'Наличные', 'Терминал Kaspi', 'Чеки Webkassa', 'Причина', 'PIN'];
const blank = () => ({ card: null, report: null, close: null });
/** Revenue of a report: every method but staff meal and marketing, net of refunds. */
export const reportRevenue = (report) =>
  report.methods
    .filter((m) => !NO_REVENUE.includes(m.method))
    .reduce((sum, m) => sum + BigInt(m.sales_minor) - BigInt(m.refunds_minor), 0n)
    .toString();
/** Money rows of an X or Z report, in the order of the paper report. */
export function reportRows(report) {
  return [
    ['Начальный остаток', report.opening_cash_minor],
    ['Внесения', report.cash_in_minor],
    ['Изъятия', report.cash_out_minor],
    ['Наличные продажи', report.cash_sales_minor],
    ['Наличные возвраты', report.cash_refunds_minor],
    ['Ожидается в ящике', report.expected_cash_minor],
    ...(report.counted_cash_minor === null ? [] : [['Пересчитано', report.counted_cash_minor]]),
    ...(report.terminal_reported_minor === null
      ? []
      : [['Итог терминала Kaspi', report.terminal_reported_minor]]),
  ];
}
/** Text lines of a report that are not plain amounts (differences, receipts, orders). */
export function reportLines(report) {
  return [
    ...(report.discrepancy_minor === null
      ? []
      : ['Расхождение наличных: ' + signed(report.discrepancy_minor)]),
    ...(report.terminal_discrepancy_minor === null
      ? []
      : ['Расхождение терминала Kaspi: ' + signed(report.terminal_discrepancy_minor)]),
    `Заказов: ${report.orders.count}, отменено: ${report.orders.voided_count}`,
    `Чеки Webkassa: оформлено ${report.fiscal.recorded}, не оформлено ${report.fiscal.pending}, не нужен ${report.fiscal.not_required}`,
  ];
}
/**
 * The typed ticket of an X or Z report (contracts section 5.8): main builds the paper from this
 * JSON only, the renderer never sends HTML. Amounts stay strings of tiyn.
 */
export function reportTicket(report, terminalLabel, printedAt = new Date().toISOString()) {
  return {
    kind: report.kind === 'z' ? 'z_report' : 'x_report',
    title:
      report.kind === 'z'
        ? 'Z-отчёт PickChick (не фискальный)'
        : 'X-отчёт PickChick (не фискальный)',
    lines: reportLines(report),
    totals: reportRows(report).map(([label, amount_minor]) => ({ label, amount_minor })),
    tenders: report.methods.map((m) => ({
      method: m.method,
      label: METHOD_NAMES[m.method],
      sales_minor: m.sales_minor,
      refunds_minor: m.refunds_minor,
      count: m.count,
    })),
    printed_at: printedAt,
    terminal_label: terminalLabel,
  };
}
/** The non-fiscal order ticket of a paid order (section 5.8): number, pickup, lines, payment. */
export function orderTicket(order, sale, terminalLabel, printedAt = new Date().toISOString()) {
  return {
    kind: 'order',
    title: 'Чек заказа (не фискальный)',
    display_number: sale.display_number,
    pickup_text: pickupText(sale),
    lines: order.snapshot.lines.map((line) => ({
      name: line.name.ru,
      quantity: line.quantity,
      total_minor: line.total_minor,
      options: (line.modifiers ?? [])
        .slice(0, 30)
        .map((m) => m.name.ru + (m.quantity > 1 ? ` × ${m.quantity}` : '')),
    })),
    totals: [{ label: 'Итого', amount_minor: sale.total_minor }],
    tenders: sale.tenders.map((t) => ({
      method: t.method,
      label: METHOD_NAMES[t.method],
      amount_minor: t.amount_minor,
    })),
    ...(sale.change_minor && sale.change_minor !== '0' ? { change_minor: sale.change_minor } : {}),
    printed_at: printedAt,
    terminal_label: terminalLabel,
  };
}
/** The slip of one void or refund of a sale (section 5.8): what went back, by which payment. */
export function refundTicket(sale, refund, terminalLabel, printedAt = new Date().toISOString()) {
  const methodOf = (id) => sale.tenders.find((t) => t.tender_id === id)?.method;
  return {
    kind: 'refund',
    title: refund.kind === 'void' ? 'Отмена заказа (не фискальный)' : 'Возврат (не фискальный)',
    display_number: sale.display_number,
    totals: [
      {
        label: refund.kind === 'void' ? 'Отменено' : 'Возвращено',
        amount_minor: refund.amount_minor,
      },
    ],
    tenders: refund.tenders.map((t) => ({
      method: methodOf(t.tender_id),
      label: METHOD_NAMES[methodOf(t.tender_id)],
      amount_minor: t.amount_minor,
    })),
    printed_at: printedAt,
    terminal_label: terminalLabel,
  };
}
/** What the cashier reads after one print attempt (the main process answers its state). */
export function printMessage(result) {
  const state = result?.state;
  if (state === 'sent') return 'Отправлено на печать';
  if (state === 'not_configured') return saleErrorMessage(new Error('PRINTER_NOT_CONFIGURED'));
  if (state === 'failed')
    return saleErrorMessage(
      new Error(result.code === 'PRINTER_BUSY' ? 'PRINTER_BUSY' : 'PRINT_FAILED'),
    );
  // A lost answer: the paper may be out. Never printed again by itself (section 5.8).
  return saleErrorMessage(new Error('PRINT_UNKNOWN'));
}
/** The drawer's answer: null when there is nothing to say (an automatic opening that worked). */
export function drawerMessage(result, quiet = false) {
  const state = result?.state;
  if (state === 'sent') return quiet ? null : 'Ящик кассы открыт';
  if (state === 'not_configured')
    return quiet ? null : saleErrorMessage(new Error('PRINTER_NOT_CONFIGURED'));
  if (state === 'unsupported') return quiet ? null : saleErrorMessage(new Error('DRAWER_BY_KEY'));
  if (state === 'failed') return saleErrorMessage(new Error('DRAWER_FAILED'));
  return saleErrorMessage(new Error('DRAWER_UNKNOWN'));
}

export class OpsView {
  state = blank();
  /**
   * @param model the PosController
   * @param sale the SaleView: its PIN modal and text entry serve these screens too
   * @param options.onChange redraw request
   * @param options.guard wraps a handler: ignored while a command is busy or pending
   * @param options.say short status toast
   * @param options.setTab switches the bottom tab of the work screen
   * @param options.pinCredential isolated PIN login of the closing manager (no session change)
   * @param options.logoutCredential ends such a credential when it is not a shift manager
   * @param options.endSession locks the desk after the Z report
   * @param options.printer the pos-desktop printer bridge, or undefined (contracts 5.8)
   * @param options.terminalLabel the desk name printed on tickets
   */
  constructor(model, sale, options) {
    this.model = model;
    this.sale = sale;
    this.onChange = options.onChange;
    this.guard = options.guard;
    this.say = options.say;
    this.setTab = options.setTab;
    this.pinCredential = options.pinCredential;
    this.logoutCredential = options.logoutCredential;
    this.endSession = options.endSession;
    this.printer = options.printer;
    this.terminalLabel = options.terminalLabel ?? 'Касса';
  }
  setState(change) {
    this.state = { ...this.state, ...change };
    this.onChange?.();
  }
  reset() {
    this.state = blank();
    this.onChange?.();
  }
  get on() {
    return this.model.saleMode;
  }
  get receipts() {
    return this.model.state.fiscal?.receipts ?? [];
  }
  get ttl() {
    return this.model.state.posConfig?.approval_ttl_seconds ?? 0;
  }
  text(error, context = {}) {
    return saleErrorMessage(error, context);
  }

  // ---- Order card: void and refund ------------------------------------------------------------
  async openCard(orderId) {
    await this.model.openSale(orderId);
    if (this.model.state.sale?.order_id === orderId && !this.model.state.error)
      this.setState({ card: { mode: 'view' } });
  }
  closeCard() {
    this.setState({ card: null });
    this.model.newDraft();
  }
  /** The card's sale with the order it belongs to, or null while they disagree. */
  target() {
    const { order, sale } = this.model.state;
    return order && sale && order.order_id === sale.order_id ? { order, sale } : null;
  }
  canVoid() {
    const t = this.target();
    return Boolean(
      t &&
      t.order.state === 'paid' &&
      t.order.fulfillment_state === 'accepted' &&
      t.sale.refundable_minor !== '0',
    );
  }
  refundableTenders() {
    const t = this.target();
    if (!t || t.order.state !== 'paid') return [];
    return t.sale.tenders.filter(
      (x) => REFUNDABLE_METHODS.includes(x.method) && tenderRefundable(t.sale, x.tender_id) > 0n,
    );
  }
  startVoid() {
    if (!this.canVoid()) {
      this.say(this.text(new Error('ORDER_IN_PRODUCTION')));
      return;
    }
    this.setState({ card: { mode: 'void', reason_code: null, reason: '', issued: null } });
  }
  startRefund() {
    const tenders = this.refundableTenders();
    if (!tenders.length) {
      const method = this.target()?.sale.tenders[0]?.method;
      this.say(this.text(new Error('REFUND_NOT_SUPPORTED'), { method }));
      return;
    }
    this.setState({
      card: {
        mode: 'refund',
        reason_code: null,
        reason: '',
        amounts: Object.fromEntries(tenders.map((t) => [t.tender_id, { digits: '', all: false }])),
        edit: tenders[0].tender_id,
      },
    });
  }
  pickReason(code) {
    const card = this.state.card;
    const preset = (c) => (c && c !== 'other' ? REFUND_REASON_NAMES[c] : '');
    // A typed reason is kept; a preset one follows the chosen code.
    const reason =
      !card.reason || card.reason === preset(card.reason_code) ? preset(code) : card.reason;
    this.setState({ card: { ...card, reason_code: code, reason } });
  }
  typeReason() {
    this.sale.askText('opsReason', this.state.card.reason, (text) =>
      this.setState({ card: { ...this.state.card, reason: text } }),
    );
  }
  /** Refund parts the cashier typed: whole tenge per tender, or "Всё" for what is left. */
  refundParts() {
    const t = this.target(),
      card = this.state.card;
    if (!t || card?.mode !== 'refund') return [];
    return Object.entries(card.amounts)
      .map(([tender_id, a]) => ({
        tender_id,
        amount_minor: (a.all ? tenderRefundable(t.sale, tender_id) : tiyn(a.digits)).toString(),
      }))
      .filter((p) => p.amount_minor !== '0');
  }
  setAmount(tenderId, change) {
    const card = this.state.card;
    this.setState({
      card: {
        ...card,
        edit: tenderId,
        amounts: { ...card.amounts, [tenderId]: { ...card.amounts[tenderId], ...change } },
      },
    });
  }
  amountKeys() {
    return this.sale.keys(
      (d) => {
        const card = this.state.card,
          a = card.amounts[card.edit];
        const digits = a.all ? '' : a.digits;
        if (digits.length < 7 && !(digits === '' && d === '0'))
          this.setAmount(card.edit, { digits: digits + d, all: false });
      },
      (all) => {
        const card = this.state.card,
          a = card.amounts[card.edit];
        this.setAmount(card.edit, {
          digits: all || a.all ? '' : a.digits.slice(0, -1),
          all: false,
        });
      },
    );
  }
  /** What blocks the void or refund confirm button, said when it is tapped; null when ready. */
  missing() {
    const card = this.state.card;
    if (!card.reason_code) return this.text(new Error('REFUND_REASON_REQUIRED'));
    if (card.reason.trim().length < 3) return this.text(new Error('REASON_REQUIRED'));
    if (card.mode === 'void' && this.saleReceipt()?.state === 'pending' && card.issued === null)
      return this.text(new Error('FISCAL_SALE_ANSWER_REQUIRED'));
    if (card.mode === 'refund' && !this.refundParts().length)
      return this.text(new Error('REFUND_AMOUNT_INVALID'));
    return null;
  }
  /** Why the card offers what it offers (or nothing). */
  cardNote() {
    const { order, sale } = this.target();
    if (this.canVoid() || this.refundableTenders().length)
      return 'Отмена - пока кухня не начала. Возврат - по оплатам заказа. Для обоих нужен PIN начальника смены.';
    if (order.state === 'cancelled') return 'Заказ отменён.';
    if (sale.refundable_minor === '0') return 'Деньги по заказу возвращены полностью.';
    const method = sale.tenders[0]?.method;
    if (NO_REVENUE.includes(method))
      return 'Заказ без выручки: возвращать нечего, отмена - только пока кухня не начала.';
    return this.text(new Error('REFUND_NOT_SUPPORTED'), { method });
  }
  saleReceipt() {
    return this.target()?.sale.fiscal.find((f) => f.kind === 'sale') ?? null;
  }
  confirmVoid() {
    const lack = this.missing();
    if (lack) {
      this.say(lack);
      return;
    }
    const { sale } = this.target(),
      card = this.state.card,
      subject = voidSubject(sale);
    this.sale.askPin({
      sub: `Отмена заказа №${sale.display_number} · ${money(sale.refundable_minor)}`,
      run: async (pin) => {
        const m = this.model;
        await m.requestApproval(pin, 'void', subject);
        const approval = m.approvalFor('void', subject);
        if (!approval) return false;
        this.say('Подтвердил: ' + approval.manager.name);
        await m.voidSale({
          reason_code: card.reason_code,
          reason: card.reason,
          ...(card.issued === null ? {} : { fiscal_sale_issued: card.issued }),
        });
        if (!m.state.error && !m.state.pending) {
          this.setState({ card: { mode: 'view' } });
          this.say('Заказ отменён');
          // Cash still in the sale goes back to the guest from the drawer.
          const cash = sale.tenders.find((t) => t.method === 'cash');
          if (cash && tenderRefundable(sale, cash.tender_id) > 0n)
            await this.openDrawer({ quiet: true });
        }
        return true;
      },
    });
  }
  confirmRefund() {
    const lack = this.missing();
    if (lack) {
      this.say(lack);
      return;
    }
    const { sale } = this.target(),
      card = this.state.card,
      parts = this.refundParts(),
      subject = refundSubject(sale.order_id, parts);
    this.sale.askPin({
      sub: `Возврат по заказу №${sale.display_number} · ${money(subject.amount_minor)}`,
      run: async (pin) => {
        const m = this.model;
        await m.requestApproval(pin, 'refund', subject);
        const approval = m.approvalFor('refund', subject);
        if (!approval) return false;
        this.say('Подтвердил: ' + approval.manager.name);
        await m.refund({ tenders: parts, reason_code: card.reason_code, reason: card.reason });
        if (!m.state.error && !m.state.pending) {
          this.setState({ card: { mode: 'view' } });
          this.say('Возврат проведён. Пробейте чек возврата в Webkassa.');
          const cash = sale.tenders.find((t) => t.method === 'cash');
          if (cash && parts.some((p) => p.tender_id === cash.tender_id))
            await this.openDrawer({ quiet: true });
        }
        return true;
      },
    });
  }
  /** A pending receipt gets its number; a recorded one is corrected with the manager's PIN. */
  askReceipt(receipt) {
    const { sale } = this.target();
    const target = { ...receipt, order_id: sale.order_id };
    this.sale.askText('fiscalNumber', '', async (number) => {
      if (receipt.state !== 'recorded') {
        await this.model.recordFiscal(target, number);
        if (!this.model.state.error) this.say('Номер чека Webkassa сохранён');
        return;
      }
      if (number === receipt.receipt_number) {
        this.say(this.text(new Error('RECEIPT_NUMBER_SAME')));
        return;
      }
      const subject = fiscalSubject(target);
      this.sale.askPin({
        sub: `Исправление чека Webkassa №${receipt.receipt_number}`,
        run: async (pin) => {
          await this.model.requestApproval(pin, 'fiscal_correct', subject);
          if (!this.model.approvalFor('fiscal_correct', subject)) return false;
          await this.model.recordFiscal(target, number);
          if (!this.model.state.error) this.say('Номер чека Webkassa исправлен');
          return true;
        },
      });
    });
  }
  cardValues() {
    const t = this.target(),
      card = this.state.card,
      g = this.guard;
    if (!t) return { isOpsCard: false };
    const { order, sale } = t;
    const cancelled = order.state === 'cancelled';
    const values = {
      isOpsCard: true,
      opsCardTitle: `Заказ №${sale.display_number}`,
      opsCardStatus:
        kitchenLabel(order) +
        (cancelled ? '' : ' · оплачен') +
        ' · ' +
        (sale.sales_channel === 'hall'
          ? sale.service_mode === 'dine_in'
            ? 'в зале'
            : 'с собой'
          : CHANNEL_NAMES[sale.sales_channel]),
      opsCardPickup: pickupText(sale),
      opsCardTotal: money(sale.total_minor),
      opsCardLines: order.snapshot.lines.map((l, i) => ({
        key: String(i),
        text: `${l.quantity} × ${l.name.ru}`,
        sum: money(l.total_minor),
      })),
      opsCardTenders: sale.tenders.map((x) => ({
        key: x.tender_id,
        name: METHOD_NAMES[x.method] + (x.reference ? ' · ' + x.reference : ''),
        sum: money(x.amount_minor),
        left:
          tenderRefundable(sale, x.tender_id) === BigInt(x.amount_minor)
            ? ''
            : 'доступно к возврату ' + money(tenderRefundable(sale, x.tender_id).toString()),
      })),
      opsCardRefunds: sale.refunds.map((r) => ({
        key: r.refund_id,
        text: `${r.kind === 'void' ? 'Отмена' : 'Возврат'} · ${time(r.created_at)} · ${REFUND_REASON_NAMES[r.reason_code] ?? r.reason_code}`,
        sum: '-' + money(r.amount_minor),
        print: g(() => this.print(refundTicket(sale, r, this.terminalLabel))),
      })),
      opsCardHasRefunds: sale.refunds.length > 0,
      opsCardReceipts: sale.fiscal.map((r) => ({
        key: r.receipt_id,
        text:
          `${RECEIPT_KINDS[r.kind]} · ${money(r.amount_minor)} · ` +
          (r.state === 'recorded' ? '№' + r.receipt_number : RECEIPT_STATES[r.state]),
        action:
          r.state === 'pending' ? 'Внести номер' : r.state === 'recorded' ? 'Исправить' : false,
        tap: g(() => this.askReceipt(r)),
      })),
      opsCardView: card.mode === 'view',
      opsCardEdit: card.mode !== 'view',
      opsCardVoid: card.mode === 'void',
      opsCardRefund: card.mode === 'refund',
      opsCardCanVoid: this.canVoid(),
      opsCardCanRefund: this.refundableTenders().length > 0,
      opsCardNote: this.cardNote(),
      opsCardVoidPick: g(() => this.startVoid()),
      opsCardRefundPick: g(() => this.startRefund()),
      opsCardClose: g(() => this.closeCard()),
      opsCardPrint: g(() => this.printOrder()),
      opsCardBack: g(() => this.setState({ card: { mode: 'view' } })),
    };
    if (card.mode === 'view') return values;
    const ready = !this.missing();
    Object.assign(values, {
      opsReasons: REFUND_REASONS.map((code) => ({
        label: REFUND_REASON_NAMES[code],
        pressed: card.reason_code === code ? 'true' : 'false',
        bg: card.reason_code === code ? 'var(--blue)' : '#fff',
        fg: card.reason_code === code ? '#fff' : 'var(--n900)',
        pick: g(() => this.pickReason(code)),
      })),
      opsReasonValue: card.reason || 'Нажмите, чтобы ввести',
      opsReasonPick: g(() => this.typeReason()),
      opsConfirmBg: ready ? 'var(--orange)' : 'var(--n300)',
      opsConfirmFg: ready ? '#fff' : 'var(--n600)',
      opsConfirmDisabled: ready ? false : 'true',
    });
    if (card.mode === 'void') {
      const pending = this.saleReceipt()?.state === 'pending';
      Object.assign(values, {
        opsVoidAsk: pending,
        opsVoidAnswers: [
          [true, 'Чек продажи пробит в Webkassa'],
          [false, 'Чек продажи не пробит'],
        ].map(([value, label]) => ({
          label,
          pressed: card.issued === value ? 'true' : 'false',
          bg: card.issued === value ? 'var(--blue)' : '#fff',
          fg: card.issued === value ? '#fff' : 'var(--n900)',
          pick: g(() => this.setState({ card: { ...this.state.card, issued: value } })),
        })),
        opsVoidNote:
          'Кухня ещё не начала. Деньги вернутся по всем оплатам заказа: ' +
          money(sale.refundable_minor) +
          '.',
        opsConfirmLabel: 'Отменить заказ · PIN начальника смены',
        opsConfirm: g(() => this.confirmVoid()),
      });
    }
    if (card.mode === 'refund') {
      const parts = this.refundParts();
      const sum = parts.reduce((n, p) => n + BigInt(p.amount_minor), 0n);
      Object.assign(values, {
        opsRefundTenders: this.refundableTenders().map((x) => {
          const a = card.amounts[x.tender_id] ?? { digits: '', all: false },
            left = tenderRefundable(sale, x.tender_id);
          const amount = a.all ? left : tiyn(a.digits);
          return {
            key: x.tender_id,
            name: METHOD_NAMES[x.method],
            left: 'можно вернуть ' + money(left.toString()),
            amount: amount > 0n ? money(amount.toString()) : '-',
            border: card.edit === x.tender_id ? 'var(--blue)' : 'var(--n300)',
            warn: amount > left ? 'Больше доступной суммы' : '',
            note: REFUND_NOTES[x.method],
            pick: g(() => this.setState({ card: { ...this.state.card, edit: x.tender_id } })),
            all: g(() => this.setAmount(x.tender_id, { all: true, digits: '' })),
          };
        }),
        opsRefundKeys: this.amountKeys(),
        opsRefundSum: money(sum.toString()),
        opsConfirmLabel:
          sum > 0n
            ? `Вернуть ${money(sum.toString())} · PIN начальника смены`
            : 'Введите сумму возврата',
        opsConfirm: g(() => this.confirmRefund()),
      });
    }
    return values;
  }

  // ---- "Чеки Webkassa" tab ---------------------------------------------------------------------
  /** One more bottom tab in the paid mode; its badge counts the receipts still to punch. */
  navItem(on) {
    const count = this.receipts.length;
    return {
      label: 'ЧЕКИ WEBKASSA',
      bg: on ? 'var(--blue)' : '#fff',
      fg: on ? '#fff' : 'var(--n900)',
      badge: count ? String(count) : false,
      pulse: 'none',
      go: this.guard(async () => {
        this.setTab('fiscal');
        await this.model.refreshFiscal();
      }),
    };
  }
  askPending(item) {
    this.sale.askText('fiscalNumber', '', async (number) => {
      await this.model.recordFiscal({ ...item, state: 'pending' }, number);
      if (!this.model.state.error) this.say(`Чек заказа №${item.display_number} оформлен`);
    });
  }
  fiscalValues() {
    const fiscal = this.model.state.fiscal,
      g = this.guard,
      rows = this.receipts;
    const scope = fiscal?.scope ?? 'shift';
    const total = rows.reduce((n, r) => n + BigInt(r.amount_minor), 0n);
    return {
      opsFiscalTitle: rows.length
        ? `Не оформлено: ${rows.length} на ${money(total.toString())}`
        : 'Все чеки оформлены',
      opsFiscalSub: fiscal
        ? `${scope === 'shift' ? 'Эта смена' : 'Все смены точки'} · обновлено в ${time(fiscal.at)}`
        : 'Список ещё не загружен',
      opsFiscalEmpty: rows.length === 0,
      opsFiscalScopes: [
        ['shift', 'Эта смена'],
        ['all', 'Все смены'],
      ].map(([code, label]) => ({
        label,
        pressed: scope === code ? 'true' : 'false',
        bg: scope === code ? 'var(--blue)' : '#fff',
        fg: scope === code ? '#fff' : 'var(--n900)',
        pick: g(() => this.model.refreshFiscal(code)),
      })),
      opsFiscalRefresh: g(() => this.model.refreshFiscal(scope)),
      opsFiscalRows: rows.map((r) => ({
        key: r.receipt_id,
        no: '№' + r.display_number,
        time: time(r.created_at),
        kind: r.kind === 'refund' ? 'Возврат' : 'Продажа',
        methods: r.methods.map((m) => METHOD_NAMES[m]).join(' + '),
        sum: money(r.amount_minor),
        record: g(() => this.askPending(r)),
      })),
    };
  }

  // ---- Shift tab, X and Z ----------------------------------------------------------------------
  /** The shift tab of the paid mode: real money of this desk instead of today's test texts. */
  shiftValues(legacy) {
    const report = this.model.state.shiftReport,
      g = this.guard,
      count = this.receipts.length;
    const revenue = report ? reportRevenue(report) : null;
    return {
      shiftOrders: report ? report.orders.count : legacy.shiftOrders,
      shiftRevenue: revenue === null ? '-' : money(revenue),
      shiftPays: report
        ? report.methods.map((m) => ({
            name:
              METHOD_NAMES[m.method] +
              (m.refunds_minor === '0' ? '' : ' · возвраты ' + money(m.refunds_minor)),
            sum: money(m.sales_minor),
            color: NO_REVENUE.includes(m.method) ? 'var(--n600)' : 'var(--blue)',
          }))
        : [{ name: 'Отчёт смены загружается', sum: '-', color: 'var(--n300)' }],
      drawerLabel: report ? money(report.expected_cash_minor) : legacy.drawerLabel,
      kkmLine: 'Чеки: вручную в Webkassa · не оформлено: ' + count,
      kkmDot: count ? '#F0C240' : 'var(--green)',
      kkmBg: count ? '#FFF3C4' : 'rgba(18,161,80,.1)',
      queued: count,
      retryFg: count ? 'var(--orange)' : 'var(--n600)',
      cashLog: legacy.cashLog.map((row) =>
        row.what === 'Начальный остаток · тест' ? { ...row, what: 'Начальный остаток' } : row,
      ),
      sayX: g(() => this.openX()),
      sayTotals: () =>
        this.say(
          report
            ? `${report.orders.count} заказов · выручка ${money(revenue)} · в ящике ${money(report.expected_cash_minor)}`
            : 'Отчёт смены ещё не получен',
        ),
      sayRetry: g(async () => {
        this.setTab('fiscal');
        await this.model.refreshFiscal('shift');
      }),
      sayDrawer: g(() => this.openDrawer()),
      startClose: g(() => this.startClose()),
    };
  }
  async openX() {
    await this.model.xReport();
    if (!this.model.state.error) this.setState({ report: 'x' });
  }
  /** One print attempt per tap; a lost answer is unknown and never printed again by itself. */
  async print(ticket) {
    if (typeof this.printer?.print !== 'function') {
      this.say(this.text(new Error('PRINTER_NOT_CONFIGURED')));
      return;
    }
    let result;
    try {
      result = await this.printer.print(ticket);
    } catch {
      // The bridge refused the call before main printed anything.
      result = { state: 'failed' };
    }
    this.say(printMessage(result));
  }
  /** One drawer pulse. `quiet`: an automatic opening says only when it did not work. */
  async openDrawer({ quiet = false } = {}) {
    if (typeof this.printer?.openDrawer !== 'function') {
      if (!quiet) this.say(this.text(new Error('PRINTER_NOT_CONFIGURED')));
      return;
    }
    let result;
    try {
      result = await this.printer.openDrawer();
    } catch {
      result = { state: 'failed' };
    }
    const message = drawerMessage(result, quiet);
    if (message) this.say(message);
  }
  /** After a sale is paid on this desk (design КС4): cash in hand opens the drawer once. */
  async sold(sale) {
    if (sale?.tenders.some((t) => t.method === 'cash')) await this.openDrawer({ quiet: true });
  }
  /** The order ticket of the paid order on screen (done screen or order card). */
  async printOrder() {
    const { order, sale } = this.model.state;
    if (!order || !sale || order.order_id !== sale.order_id) return;
    await this.print(orderTicket(order, sale, this.terminalLabel));
  }
  reportValues() {
    const kind = this.state.report,
      report = kind === 'z' ? this.model.state.zReport : this.model.state.shiftReport,
      g = this.guard;
    if (!report || report.kind !== kind) return { isOpsReport: false };
    const z = kind === 'z';
    return {
      isOpsReport: true,
      opsReportTitle: z ? 'Z-отчёт PickChick (не фискальный)' : 'X-отчёт PickChick (не фискальный)',
      opsReportSub:
        `Смена с ${time(report.opened_at)}` +
        (report.closed_at ? ` до ${time(report.closed_at)}` : ` · на ${time(report.report_at)}`),
      opsReportRows: reportRows(report).map(([label, amount]) => ({
        label,
        value: money(amount),
      })),
      opsReportMethods: report.methods.map((m) => ({
        name: `${METHOD_NAMES[m.method]} · ${m.count}`,
        value:
          money(m.sales_minor) + (m.refunds_minor === '0' ? '' : ' / -' + money(m.refunds_minor)),
      })),
      opsReportChannels: report.channels.map((c) => ({
        name: `${CHANNEL_NAMES[c.sales_channel]} · ${c.count}`,
        value: money(c.total_minor),
      })),
      opsReportLines: reportLines(report).map((text, i) => ({ key: String(i), text })),
      opsReportRevenue: money(reportRevenue(report)),
      opsReportZ: z,
      opsReportPrint: g(() => this.print(reportTicket(report, this.terminalLabel))),
      opsReportClose: g(() => {
        if (!z) {
          this.setState({ report: null });
          return;
        }
        this.setState({ report: null });
        this.endSession();
      }),
      opsReportCloseLabel: z ? 'Готово · закрыть кассу' : 'Закрыть',
    };
  }

  // ---- Closing a sales shift -------------------------------------------------------------------
  terminalAsked() {
    const config = this.model.state.posConfig,
      report = this.model.state.shiftReport;
    return Boolean(
      (config && methodEnabled(config, 'kaspi_terminal')) ||
      (report && terminalNetMinor(report) !== 0n),
    );
  }
  async startClose() {
    const m = this.model;
    if (m.state.actor?.role !== 'shift_manager') {
      this.say('Закрывает начальник смены');
      return;
    }
    const shiftId = m.state.shift?.shift_id;
    if (!shiftId) {
      this.say('Сначала откройте смену');
      return;
    }
    await m.xReport();
    if (m.state.error) return;
    await m.refreshFiscal('shift');
    this.setState({ close: { step: 1, shiftId, counted: '', terminal: '', reason: '' } });
  }
  closeNumbers() {
    const report = this.model.state.shiftReport,
      c = this.state.close;
    const expected = BigInt(report.expected_cash_minor),
      counted = tiyn(c.counted),
      terminalNet = terminalNetMinor(report);
    return {
      expected,
      counted,
      cashDiff: counted - expected,
      terminalNet,
      terminal: tiyn(c.terminal),
      terminalDiff: tiyn(c.terminal) - terminalNet,
    };
  }
  /** A discrepancy (cash or terminal) needs a typed reason; otherwise the plain close text. */
  needsReason() {
    const n = this.closeNumbers();
    return n.cashDiff !== 0n || (this.terminalAsked() && n.terminalDiff !== 0n);
  }
  closeStepAllowed(step) {
    return step !== 3 || this.terminalAsked();
  }
  closeMove(delta) {
    const c = this.state.close;
    let step = c.step + delta;
    while (step > 1 && step < 6 && !this.closeStepAllowed(step)) step += delta;
    this.setState({ close: { ...c, step: Math.min(6, Math.max(1, step)) } });
  }
  closeNext() {
    const c = this.state.close;
    if (c.step === 5 && this.needsReason() && c.reason.trim().length < 3) {
      this.say(this.text(new Error('REASON_REQUIRED')));
      return;
    }
    if (c.step < 6) {
      this.closeMove(1);
      return;
    }
    const pending = this.receipts.length;
    this.sale.askPin({
      sub:
        'Закрытие смены' +
        (pending ? ` · не оформлено чеков Webkassa: ${pending}` : ' · все чеки оформлены'),
      run: (pin) => this.closeWithPin(pin),
    });
  }
  /**
   * The closing shift manager types their PIN (contracts section 5.1, KS2): an isolated PIN
   * login (as today's close), the manager's session, the pending receipts read again, the
   * shift_close_pending_fiscal approval with the same PIN when any are left, then the close and
   * the frozen Z report. A wrong PIN changes nothing; the cashier's journal stays as it is.
   */
  async closeWithPin(pin) {
    const m = this.model,
      c = this.state.close;
    // Taken before the manager's login, which starts a fresh session state.
    const numbers = this.closeNumbers(),
      terminal = this.terminalAsked(),
      reason = this.needsReason() ? c.reason.trim() : c.reason.trim() || 'Закрытие смены';
    const credential = await this.pinCredential(pin);
    if (credential.role !== 'shift_manager') {
      await this.logoutCredential(credential);
      throw new Error('Нужен PIN начальника смены');
    }
    await m.login(JSON.stringify(credential));
    if (m.state.actor?.staff_id !== credential.staff_id || m.state.error)
      throw new Error(this.text(m.state.error ?? new Error('UNAUTHORIZED')));
    const pending = await m.pendingForClose(c.shiftId);
    if (pending === null) throw new Error(this.text(m.state.error));
    if (pending.length) {
      const subject = closeSubject(c.shiftId, pending);
      await m.requestApproval(pin, 'shift_close_pending_fiscal', subject);
      if (!m.approvalFor('shift_close_pending_fiscal', subject)) return false;
    }
    await m.closeSaleShift(c.shiftId, {
      counted_cash_minor: numbers.counted.toString(),
      ...(terminal ? { terminal_reported_minor: numbers.terminal.toString() } : {}),
      reason,
    });
    if (m.state.error || m.state.pending) return true;
    await m.zReport(c.shiftId);
    this.setState({ close: null, report: 'z' });
    this.say('Смена закрыта. Не забудьте закрыть смену в кабинете Webkassa.');
    return true;
  }
  closeValues() {
    const c = this.state.close,
      g = this.guard,
      report = this.model.state.shiftReport;
    if (!c || !report) return { isOpsClose: false };
    const n = this.closeNumbers(),
      receipts = this.receipts,
      pendingSum = receipts.reduce((sum, r) => sum + BigInt(r.amount_minor), 0n);
    const diffTone = (diff) => ({
      bg: diff === 0n ? 'rgba(18,161,80,.1)' : 'rgba(196,48,43,.08)',
      fg: diff === 0n ? '#0B7A3B' : 'var(--red)',
    });
    const digitsKeys = (field) =>
      this.sale.keys(
        (d) => {
          const v = this.state.close[field];
          if (v.length < 9 && !(v === '' && d === '0'))
            this.setState({ close: { ...this.state.close, [field]: v + d } });
        },
        (all) =>
          this.setState({
            close: {
              ...this.state.close,
              [field]: all ? '' : this.state.close[field].slice(0, -1),
            },
          }),
      );
    const step = {
      1: {
        title: '1 · Сводка смены',
        rows: [
          ...report.methods.map((m) => ({
            label: METHOD_NAMES[m.method],
            value:
              money(m.sales_minor) +
              (m.refunds_minor === '0' ? '' : ' / -' + money(m.refunds_minor)),
          })),
          { label: 'Выручка', value: money(reportRevenue(report)) },
          { label: 'Заказов', value: String(report.orders.count) },
        ],
      },
      2: {
        title: '2 · Пересчитайте наличные',
        rows: [{ label: 'Ожидается в ящике', value: money(n.expected.toString()) }],
        keypad: digitsKeys('counted'),
        amountTitle: 'Фактически в ящике',
        amount: money(n.counted.toString()),
        diff: n.cashDiff === 0n ? 'Расхождения нет' : 'Расхождение ' + signed(n.cashDiff),
        ...diffTone(n.cashDiff),
      },
      3: {
        title: '3 · Итог терминала Kaspi за смену',
        rows: [{ label: 'По кассе PickChick', value: money(n.terminalNet.toString()) }],
        keypad: digitsKeys('terminal'),
        amountTitle: 'Итог на терминале Kaspi',
        amount: money(n.terminal.toString()),
        diff:
          n.terminalDiff === 0n
            ? 'Совпадает с кассой'
            : 'Расхождение терминала ' + signed(n.terminalDiff),
        ...diffTone(n.terminalDiff),
      },
      4: {
        title: '4 · Чеки Webkassa',
        rows: receipts.slice(0, 6).map((r) => ({
          label: `№${r.display_number} · ${r.kind === 'refund' ? 'возврат' : 'продажа'}`,
          value: money(r.amount_minor),
        })),
        note: receipts.length
          ? `Не оформлено: ${receipts.length} на ${money(pendingSum.toString())}. Закрыть смену можно только с PIN начальника смены.`
          : 'Все чеки Webkassa этой смены оформлены.',
        noteBg: receipts.length ? '#FFF3C4' : 'rgba(18,161,80,.1)',
        action: receipts.length ? 'Оформить чеки сейчас' : false,
        act: g(() => {
          this.setState({ close: null });
          this.setTab('fiscal');
        }),
      },
      5: {
        title: '5 · Причина',
        rows: [],
        note: this.needsReason()
          ? 'Есть расхождение - укажите причину. Она останется в отчёте смены.'
          : 'Расхождений нет.',
        noteBg: this.needsReason() ? 'rgba(196,48,43,.08)' : 'rgba(18,161,80,.1)',
        field: this.needsReason(),
        fieldValue: c.reason || 'Нажмите, чтобы ввести',
        fieldPick: g(() =>
          this.sale.askText('closeReason', c.reason, (text) =>
            this.setState({ close: { ...this.state.close, reason: text } }),
          ),
        ),
      },
      6: {
        title: '6 · PIN начальника смены',
        rows: [
          { label: 'В ящике', value: money(n.counted.toString()) },
          ...(this.terminalAsked()
            ? [{ label: 'Терминал Kaspi', value: money(n.terminal.toString()) }]
            : []),
          { label: 'Не оформлено чеков', value: String(receipts.length) },
        ],
        note: 'После закрытия - Z-отчёт PickChick (не фискальный). Смену в Webkassa закройте отдельно.',
        noteBg: 'var(--n100)',
      },
    }[c.step];
    return {
      isOpsClose: true,
      opsCloseSteps: STEPS.map((label, i) => ({
        label,
        bg: i + 1 <= c.step ? 'var(--blue)' : 'var(--n300)',
        shown: this.closeStepAllowed(i + 1),
      })).filter((x) => x.shown),
      opsCloseTitle: step.title,
      opsCloseRows: step.rows.map((r, i) => ({ key: String(i), ...r })),
      opsCloseKeypad: Boolean(step.keypad),
      opsCloseKeys: step.keypad ?? [],
      opsCloseAmountTitle: step.amountTitle ?? '',
      opsCloseAmount: step.amount ?? '',
      opsCloseDiff: step.diff ?? '',
      opsCloseDiffBg: step.bg ?? 'transparent',
      opsCloseDiffFg: step.fg ?? 'var(--n900)',
      opsCloseNote: step.note ?? false,
      opsCloseNoteBg: step.noteBg ?? 'var(--n100)',
      opsCloseAction: step.action ?? false,
      opsCloseAct: step.act ?? (() => {}),
      opsCloseField: Boolean(step.field),
      opsCloseFieldValue: step.fieldValue ?? '',
      opsCloseFieldPick: step.fieldPick ?? (() => {}),
      opsCloseBack: g(() => (c.step === 1 ? this.setState({ close: null }) : this.closeMove(-1))),
      opsCloseBackLabel: c.step === 1 ? 'Отмена' : 'Назад',
      opsCloseNext: g(() => this.closeNext()),
      opsCloseCta: c.step < 6 ? 'Дальше' : 'Закрыть смену · PIN начальника смены',
    };
  }

  /** Everything the template needs from part B, on top of today's values `legacy`. */
  templateValues(legacy, tab) {
    const off = {
      isFiscalTab: false,
      isOpsCard: false,
      isOpsReport: false,
      isOpsClose: false,
    };
    if (!this.on) return off;
    return {
      ...off,
      ...this.shiftValues(legacy),
      ...this.fiscalValues(),
      isFiscalTab: tab === 'fiscal',
      navItems: [...legacy.navItems, this.navItem(tab === 'fiscal')],
      ...(this.state.card ? this.cardValues() : {}),
      ...(this.state.report ? this.reportValues() : {}),
      ...(this.state.close ? this.closeValues() : {}),
    };
  }
}
