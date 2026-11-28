// Stage 3 of the paid terminal release (CR pos-8): the screen «Оплаты без заказа». The guest paid
// on the Kaspi terminal and the order was never made. The cashier who sent the amount sells it
// again («Оформить»); anyone on this desk may release it («Снять») once the refund was made by
// hand on the terminal, with the same PIN of a shift manager as for voids and refunds.
// DOM-free like sale-view.js and ops-view.js: it computes template values and collects what is
// tapped; every effect goes through the durable controller (model.ts).
import { money } from '../types.js';
import { saleErrorMessage } from '../api.js';
import { terminalReleaseSubject } from '../model.js';

const time = (value) =>
  value
    ? new Date(value).toLocaleTimeString('ru-RU', {
        timeZone: 'Asia/Almaty',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '-';
/** Said instead of «Оформить» when this session cannot sell the attempt. */
export const NOT_YOURS = 'Оформляет кассир, который отправил сумму';
const DEFAULT_NOTE =
  'Сначала верните деньги гостю на самом терминале, затем снимите оплату по PIN начальника смены.';
const blank = () => ({ open: false, note: null, release: null });

export class TerminalPaymentsView {
  state = blank();
  /**
   * @param model the PosController
   * @param sale the SaleView: its PIN modal, text entry and «Оформить ещё раз» serve this screen
   * @param options.onChange redraw request
   * @param options.guard wraps a handler: ignored while a command is busy or pending
   * @param options.say short status toast
   */
  constructor(model, sale, { onChange, guard, say }) {
    this.model = model;
    this.sale = sale;
    this.onChange = onChange;
    this.guard = guard;
    this.say = say;
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
  /** The point sends released_at, so the screen can work (an older point has no such keys). */
  get available() {
    return this.model.terminalPaymentsAvailable;
  }
  /** Rows of this desk first, then (for a shift manager) the other desks of the point. */
  attempts() {
    return [
      ...this.model.unsoldPayments.map((attempt) => ({ attempt, other: false })),
      ...this.model.state.terminalOthers.map((attempt) => ({ attempt, other: true })),
    ];
  }
  get count() {
    return this.attempts().length;
  }
  attempt(id) {
    return this.attempts().find((x) => x.attempt.attempt_id === id)?.attempt ?? null;
  }
  /** Opens the list (and reads it again); `note` is shown above it, e.g. why the close stopped. */
  async open(note = null) {
    this.setState({ open: true, note, release: null });
    await this.model.refreshTerminalPayments().catch(() => {});
    this.onChange?.();
  }
  close() {
    this.setState({ open: false, note: null, release: null });
  }
  /** «Оформить»: the sale of the attempt this cashier sent, with its own quote (retryPaidSale). */
  async sell(attemptId) {
    if (!this.model.canSellPaid(attemptId)) {
      this.say(NOT_YOURS);
      return;
    }
    const before = this.model.state.sale;
    await this.sale.retryPaidSale();
    const m = this.model;
    if (m.state.sale && m.state.sale !== before && !m.state.pending && !m.state.error) this.close();
  }
  startRelease(attemptId) {
    this.setState({ release: { attemptId, reason: '', refunded: false } });
  }
  setReason(reason) {
    if (this.state.release) this.setState({ release: { ...this.state.release, reason } });
  }
  toggleRefunded() {
    const r = this.state.release;
    if (r) this.setState({ release: { ...r, refunded: !r.refunded } });
  }
  typeReason() {
    this.sale.askText('opsReason', this.state.release?.reason ?? '', (text) =>
      this.setReason(text),
    );
  }
  /** What blocks «Снять», said when it is tapped; null when ready. */
  missing() {
    const r = this.state.release;
    if (!r || r.reason.trim().length < 3) return saleErrorMessage(new Error('REASON_REQUIRED'));
    if (!r.refunded) return 'Отметьте: возврат на терминале сделан';
    return null;
  }
  /** One release request; the form closes only when the point released the payment. */
  async finishRelease(attemptId, reason) {
    const released = await this.model.releaseTerminalPayment(attemptId, reason);
    if (released) {
      this.setState({ release: null });
      this.say('Оплата снята. Возврат гостю сделан на терминале');
    }
  }
  /**
   * «Снять - возврат на терминале сделан»: reason, the mark, then the PIN of a shift manager
   * (action terminal_release for the quote and amount of the attempt). A request whose answer was
   * lost is repeated without a new PIN, with the same key.
   */
  async confirmRelease() {
    const r = this.state.release,
      attempt = r && this.attempt(r.attemptId);
    if (!r || !attempt) {
      this.setState({ release: null });
      return;
    }
    if (this.model.releaseUnknown(r.attemptId)) {
      await this.finishRelease(r.attemptId, r.reason);
      return;
    }
    const lack = this.missing();
    if (lack) {
      this.say(lack);
      return;
    }
    const subject = terminalReleaseSubject(attempt);
    this.sale.askPin({
      sub: `Снятие оплаты ${money(attempt.amount_minor)} без заказа`,
      run: async (pin) => {
        const m = this.model;
        await m.requestApproval(pin, 'terminal_release', subject);
        const approval = m.approvalFor('terminal_release', subject);
        if (!approval) return false;
        this.say('Подтвердил: ' + approval.manager.name);
        await this.finishRelease(r.attemptId, this.state.release?.reason ?? r.reason);
        return true;
      },
    });
  }
  row({ attempt: t, other }) {
    const g = this.guard,
      actor = this.model.state.actor;
    const canSell = !other && this.model.canSellPaid(t.attempt_id);
    const who =
      t.staff_id && t.staff_id === actor?.staff_id ? 'отправили вы' : 'отправил другой кассир';
    const deskLabel = other ? `Другая касса · ${(t.terminal_id ?? '').slice(0, 8)}` : '';
    return {
      key: t.attempt_id,
      amount: money(t.amount_minor),
      time: time(t.created_at),
      who,
      deskLabel,
      info: deskLabel ? `${who} · ${deskLabel}` : who,
      canSell,
      noSell: !canSell,
      sellNote: canSell ? '' : NOT_YOURS,
      ...(canSell ? { sell: g(() => this.sell(t.attempt_id)) } : {}),
      release: g(() => this.startRelease(t.attempt_id)),
    };
  }
  /** The shift tab and the header: how many payments wait, and the tap that opens the list. */
  entryValues() {
    const count = this.count;
    return {
      termPayEntry: count ? `Оплаты без заказа: ${count}` : false,
      termPayEntryOpen: this.guard(() => this.open()),
    };
  }
  templateValues() {
    const entry = this.on ? this.entryValues() : { termPayEntry: false };
    if (!this.on || !this.state.open) return { isTermPay: false, ...entry };
    const g = this.guard,
      r = this.state.release,
      attempt = r && this.attempt(r.attemptId);
    const rows = this.attempts().map((x) => this.row(x));
    const ready = Boolean(r && !this.missing());
    const unknown = Boolean(r && this.model.releaseUnknown(r.attemptId));
    return {
      isTermPay: true,
      ...entry,
      termPayTitle: 'Оплаты без заказа',
      termPaySub: 'Гость оплатил на терминале Kaspi, а заказ не оформлен',
      termPayNote: this.state.note ?? DEFAULT_NOTE,
      termPayNoteBg: this.state.note ? '#FFF3C4' : 'var(--n100)',
      termPayRows: rows,
      termPayEmpty: rows.length === 0,
      termPayList: !attempt,
      termPayRefresh: g(() => this.model.refreshTerminalPayments()),
      termPayClose: g(() => this.close()),
      termPayForm: Boolean(attempt),
      termPayFormTitle: attempt ? `Снятие оплаты ${money(attempt.amount_minor)}` : '',
      termPayReasonValue: r?.reason || 'Нажмите, чтобы ввести',
      termPayReasonPick: g(() => this.typeReason()),
      termPayRefundedLabel: 'Возврат на терминале сделан',
      termPayRefundedPressed: r?.refunded ? 'true' : 'false',
      termPayRefundedBg: r?.refunded ? 'var(--blue)' : '#fff',
      termPayRefundedFg: r?.refunded ? '#fff' : 'var(--n900)',
      termPayRefunded: g(() => this.toggleRefunded()),
      termPayBack: g(() => this.setState({ release: null })),
      termPayConfirmLabel: unknown ? 'Повторить снятие' : 'Снять оплату · PIN начальника смены',
      termPayConfirmBg: ready || unknown ? 'var(--orange)' : 'var(--n300)',
      termPayConfirmFg: ready || unknown ? '#fff' : 'var(--n600)',
      termPayConfirm: g(() => this.confirmRelease()),
    };
  }
}
