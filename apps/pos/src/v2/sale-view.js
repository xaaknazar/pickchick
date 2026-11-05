// Cutover 19.11 paid mode screens (contracts section 5.1, owner decisions section 00).
// DOM-free: computes the values of the sale blocks in template.html. Every money effect goes
// through the durable controller (model.ts); this module only collects what the cashier taps.
import {
  money,
  pickupText,
  isAggregator,
  EXTERNAL_ORDER_REF,
  aggregatorMethod,
  lineKey,
} from '../types.js';
import { saleErrorMessage } from '../api.js';
import { methodEnabled, mixableMethods, saleChannelEnabled, saleContext } from '../model.js';

const TILES = [
  ['cash', 'НАЛИЧНЫЕ', '₸', 'var(--green)'],
  ['kaspi_terminal', 'KASPI ТЕРМИНАЛ', 'K', 'var(--kaspi)'],
  ['kaspi_manual', 'KASPI ВРУЧНУЮ', 'K', 'var(--kaspi)'],
  ['mixed', 'СМЕШАННАЯ', '½', 'var(--n600)'],
  ['chocofood', 'CHOCOFOOD', 'C', 'var(--blue)'],
  ['staff_meal', 'ПИТАНИЕ СОТРУДНИКА', '0', 'var(--n600)'],
  ['marketing', 'МАРКЕТИНГ', '0', 'var(--n600)'],
];
export const METHOD_NAMES = {
  cash: 'Наличные',
  kaspi_terminal: 'Kaspi терминал',
  kaspi_manual: 'Kaspi вручную',
  aggregator_yandex_eda: 'Яндекс Еда',
  aggregator_glovo: 'Glovo',
  chocofood: 'ChocoFood',
  staff_meal: 'Питание сотрудника',
  marketing: 'Маркетинг',
};
const CHANNEL_LABELS = { hall: 'ЗАЛ', yandex_eda: 'ЯНДЕКС ЕДА', glovo: 'GLOVO' };
/** "в Яндекс Еде", "в Glovo"; "Яндекс Еды", "Glovo". */
const IN_CHANNEL = { yandex_eda: 'в Яндекс Еде', glovo: 'в Glovo' };
const OF_CHANNEL = { yandex_eda: 'Яндекс Еды', glovo: 'Glovo' };
const CODE_KEYS = '1234567890QWERTYUIOPASDFGHJKLZXCVBNM-'.split('');
const TEXT_KEYS = 'ЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮЁ1234567890'.split('');
const CODE_HINT = 'Латинские буквы, цифры и дефис, от 3 до 40 знаков.';
const ENTRIES = {
  ref: { keys: CODE_KEYS, max: 40, sub: 'Как на планшете агрегатора. ' + CODE_HINT },
  choco: {
    title: 'Номер заказа ChocoFood',
    keys: CODE_KEYS,
    max: 40,
    sub: 'Как в заказе ChocoFood. ' + CODE_HINT,
  },
  manualRef: {
    title: 'Номер операции Kaspi',
    keys: CODE_KEYS,
    max: 40,
    sub: 'Необязательно. До 40 знаков.',
  },
  beneficiary: {
    title: 'Кому питание сотрудника',
    keys: TEXT_KEYS,
    max: 100,
    space: true,
    sub: 'Имя сотрудника, до 100 знаков.',
  },
  reason: {
    title: 'Причина маркетинга',
    keys: TEXT_KEYS,
    max: 300,
    space: true,
    sub: 'От 3 до 300 знаков. Останется в отчёте продаж.',
  },
  receipt: {
    title: 'Номер чека Webkassa',
    keys: CODE_KEYS,
    max: 40,
    sub: 'Номер пробитого чека из кабинета Webkassa, до 40 знаков.',
  },
};
const tiyn = (digits) => BigInt(digits || '0') * 100n;
/** Whole tenge at or above an amount: what a guest can hand over without coins of tiyn. */
const ceilTenge = (minor) => ((BigInt(minor) + 99n) / 100n).toString();
const blank = () => ({
  screen: null,
  method: null,
  cash: '',
  mix: null,
  mixFirst: '',
  mixCash: '',
  mixEdit: 'first',
  manualRef: '',
  chocoRef: '',
  beneficiary: '',
  reason: '',
  receipt: '',
  receiptLater: false,
  entry: null,
  approvalOpen: false,
  approvalPin: '',
});

export class SaleView {
  state = blank();
  /**
   * @param model the PosController
   * @param options.onChange redraw request
   * @param options.guard wraps a handler: ignored while a command is busy or pending
   * @param options.say short status toast
   * @param options.pinLength PIN digits of this branch (4 or 6)
   * @param options.next starts the next order (the app's own reset of the order screen)
   */
  constructor(model, { onChange, guard, say, pinLength = 4, next }) {
    this.model = model;
    this.onChange = onChange;
    this.guard = guard;
    this.say = say;
    this.pinLength = pinLength;
    this.next = next;
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
  get draft() {
    return this.model.state.saleDraft;
  }
  get config() {
    return this.model.state.posConfig;
  }
  get quote() {
    return this.model.state.quote;
  }
  /** Error text context: the journaled sale first, then what the cashier is paying with. */
  errorContext() {
    const pending = this.model.state.pending;
    if (pending?.kind === 'sale') return saleContext(pending.body);
    return {
      channel: this.draft.channel,
      ...(this.state.method === 'chocofood' ? { method: 'chocofood' } : {}),
    };
  }
  errorText(error) {
    return saleErrorMessage(error, this.errorContext());
  }
  refValid() {
    return EXTERNAL_ORDER_REF.test(this.draft.externalOrderRef);
  }
  /** "К оплате" on the order screen: checks, a fresh quote, then the repeat screen. */
  async startPayment() {
    const m = this.model;
    if (!m.state.draft?.items.length) return;
    if (!m.hasConfirmedOpenShift) {
      this.say('Сначала откройте смену');
      return;
    }
    if (isAggregator(this.draft.channel) && !this.refValid()) {
      this.openEntry('ref');
      return;
    }
    if (!this.draft.serviceModeChosen) {
      this.say(saleErrorMessage(new Error('SERVICE_MODE_REQUIRED')));
      return;
    }
    await m.calculate();
    if (m.state.quote && !m.state.error) this.setState({ screen: 'review' });
  }
  confirmReview() {
    this.model.confirmReview();
    if (!this.model.reviewed) return;
    this.setState({
      screen: 'pay',
      method: isAggregator(this.draft.channel) ? 'aggregator' : null,
    });
  }
  pick(method) {
    const mixable = this.config ? mixableMethods(this.config) : [];
    this.setState({
      method,
      cash: '',
      mixFirst: '',
      mixCash: '',
      mixEdit: 'first',
      mix: method === 'mixed' ? [mixable[0], mixable[1]] : null,
    });
  }
  /** Mixed parts never hold the same method twice, so cash is always at most one part. */
  pickMix(index, method) {
    const mix = [...this.state.mix];
    if (mix[1 - index] === method) mix[1 - index] = mix[index];
    mix[index] = method;
    this.setState({ mix, mixCash: '' });
  }
  mixAmounts() {
    const total = BigInt(this.quote?.total_minor ?? '0'),
      first = tiyn(this.state.mixFirst);
    return { total, first, second: total - first };
  }
  /** The payment the cashier composed, or null while something required is missing. */
  payment() {
    const s = this.state,
      q = this.quote;
    if (!q) return null;
    const total = BigInt(q.total_minor);
    switch (s.method) {
      case 'cash':
        return tiyn(s.cash) >= total
          ? { method: 'cash', tendered_minor: tiyn(s.cash).toString() }
          : null;
      case 'kaspi_terminal':
        return total % 100n === 0n ? { method: 'kaspi_terminal' } : null;
      case 'kaspi_manual':
        return { method: 'kaspi_manual', ...(s.manualRef ? { reference: s.manualRef } : {}) };
      case 'mixed': {
        const { first, second } = this.mixAmounts();
        if (!s.mix || first <= 0n || second <= 0n) return null;
        const parts = [
          { method: s.mix[0], amount_minor: first.toString() },
          { method: s.mix[1], amount_minor: second.toString() },
        ];
        const cash = parts.find((p) => p.method === 'cash');
        if (cash && s.mixCash && tiyn(s.mixCash) < BigInt(cash.amount_minor)) return null;
        return {
          method: 'mixed',
          parts,
          ...(cash && s.mixCash ? { tendered_minor: tiyn(s.mixCash).toString() } : {}),
        };
      }
      case 'chocofood':
        return EXTERNAL_ORDER_REF.test(s.chocoRef)
          ? { method: 'chocofood', external_order_ref: s.chocoRef }
          : null;
      case 'aggregator':
        return this.refValid() ? { method: 'aggregator' } : null;
      case 'staff_meal':
        return s.beneficiary.trim() && this.model.approvalFor('staff_meal')
          ? { method: 'staff_meal', beneficiary: s.beneficiary }
          : null;
      case 'marketing':
        return s.reason.trim().length >= 3 && this.model.approvalFor('marketing')
          ? { method: 'marketing', reason: s.reason }
          : null;
      default:
        return null;
    }
  }
  /** What is missing, said when the cashier taps an inactive confirm button. */
  missing() {
    const s = this.state;
    if (!s.method) return 'Выберите способ оплаты';
    if (s.method === 'cash') return saleErrorMessage(new Error('CASH_TENDERED_TOO_LOW'));
    if (s.method === 'kaspi_terminal')
      return saleErrorMessage(new Error('TERMINAL_AMOUNT_NOT_WHOLE'));
    if (s.method === 'mixed') return 'Введите сумму первой части: больше 0 и меньше суммы заказа';
    if (s.method === 'chocofood')
      return saleErrorMessage(new Error('EXTERNAL_REF_REQUIRED'), { method: 'chocofood' });
    if (s.method === 'aggregator') return saleErrorMessage(new Error('EXTERNAL_REF_REQUIRED'));
    if (s.method === 'staff_meal' && !s.beneficiary.trim())
      return saleErrorMessage(new Error('BENEFICIARY_REQUIRED'));
    if (s.method === 'marketing' && s.reason.trim().length < 3)
      return saleErrorMessage(new Error('REASON_REQUIRED'));
    return saleErrorMessage(new Error('APPROVAL_REQUIRED'));
  }
  async pay() {
    const payment = this.payment();
    if (!payment) {
      this.say(this.missing());
      return;
    }
    await this.model.sell(payment);
    if (this.model.state.sale && !this.model.state.pending) this.done();
    else if (this.model.state.error?.message === 'ORDER_REVIEW_REQUIRED')
      // A new quote changed what the guest heard: repeat it before taking money.
      this.setState({ screen: 'review' });
  }
  done() {
    this.state = { ...blank(), screen: 'done' };
    this.onChange?.();
  }
  openEntry(purpose) {
    const s = this.state;
    const value =
      purpose === 'ref'
        ? this.draft.externalOrderRef
        : {
            choco: s.chocoRef,
            manualRef: s.manualRef,
            beneficiary: s.beneficiary,
            reason: s.reason,
            receipt: s.receipt,
          }[purpose];
    this.setState({ entry: { purpose, value } });
  }
  type(key) {
    const entry = this.state.entry,
      spec = ENTRIES[entry.purpose];
    if (entry.value.length >= spec.max) return;
    const value =
      spec.space && entry.value && !entry.value.endsWith(' ')
        ? entry.value + key.toLowerCase()
        : entry.value + key;
    this.setState({ entry: { ...entry, value } });
  }
  saveEntry() {
    const { purpose, value } = this.state.entry;
    const text = value.trim();
    if (['ref', 'choco'].includes(purpose) && !EXTERNAL_ORDER_REF.test(text)) {
      this.say(
        saleErrorMessage(new Error('EXTERNAL_REF_REQUIRED'), {
          ...(purpose === 'choco' ? { method: 'chocofood' } : {}),
        }),
      );
      return;
    }
    if (purpose === 'ref') this.model.setExternalOrderRef(text);
    const field = {
      choco: 'chocoRef',
      manualRef: 'manualRef',
      beneficiary: 'beneficiary',
      reason: 'reason',
      receipt: 'receipt',
    }[purpose];
    this.setState({ entry: null, ...(field ? { [field]: text } : {}) });
  }
  async approvalDigit(digit) {
    const pin = (this.state.approvalPin + digit).slice(0, this.pinLength);
    this.setState({ approvalPin: pin });
    if (pin.length < this.pinLength) return;
    // The PIN leaves the view state before the request: it is never kept or journaled.
    this.setState({ approvalPin: '' });
    await this.model.requestApproval(pin, this.state.method);
    const approval = this.model.approvalFor(this.state.method);
    if (approval) {
      this.setState({ approvalOpen: false });
      this.say('Подтвердил: ' + approval.manager.name);
    }
  }
  async saveReceipt() {
    if (!this.state.receipt) {
      this.openEntry('receipt');
      return;
    }
    await this.model.recordReceipt(this.state.receipt);
    const receipt = this.model.state.sale?.fiscal.find((f) => f.kind === 'sale');
    if (receipt?.state === 'recorded') this.say('Номер чека Webkassa сохранён');
  }
  keys(onDigit, onBack) {
    return ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((label) => ({
      label,
      fg: label === 'C' || label === '⌫' ? 'var(--red)' : 'var(--n900)',
      tap: this.guard(() =>
        label === 'C' ? onBack(true) : label === '⌫' ? onBack(false) : onDigit(label),
      ),
    }));
  }
  digitsKeys(field, max = 7) {
    return this.keys(
      (d) => {
        const v = this.state[field];
        if (v.length < max && !(v === '' && d === '0')) this.setState({ [field]: v + d });
      },
      (all) => this.setState({ [field]: all ? '' : this.state[field].slice(0, -1) }),
    );
  }
  typeLabel() {
    const q = this.quote,
      d = this.draft;
    if (isAggregator(d.channel))
      return (
        'ДОСТАВКА · ' +
        CHANNEL_LABELS[d.channel] +
        (d.externalOrderRef ? ' №' + d.externalOrderRef : '')
      );
    return (q?.service_mode ?? this.model.state.draft?.service_mode) === 'dine_in'
      ? 'В ЗАЛЕ'
      : 'С СОБОЙ';
  }
  /** Order screen of the paid mode: channel, explicit service mode and the pay button. */
  orderValues(legacy) {
    const m = this.model,
      d = this.draft,
      config = this.config,
      g = this.guard,
      aggregator = isAggregator(d.channel),
      empty = !m.state.draft?.items.length;
    const channels = config
      ? ['hall', 'yandex_eda', 'glovo'].filter((c) => saleChannelEnabled(config, c))
      : ['hall'];
    const ready = !empty && d.serviceModeChosen && (!aggregator || this.refValid());
    const total = legacy.totalLabel;
    return {
      saleChannelBar: channels.length > 1,
      saleChannels: channels.map((code) => {
        const on = d.channel === code;
        return {
          label: CHANNEL_LABELS[code],
          pressed: on ? 'true' : 'false',
          bg: on ? 'var(--blue)' : '#fff',
          fg: on ? '#fff' : 'var(--n900)',
          pick: g(() => m.setChannel(code)),
        };
      }),
      saleRefShown: aggregator,
      saleRefTitle: 'Номер заказа ' + (OF_CHANNEL[d.channel] ?? '') + '*',
      saleRefValue: d.externalOrderRef || 'Нажмите и введите номер с планшета',
      saleRefBorder: this.refValid() ? 'var(--n300)' : 'var(--orange)',
      saleRefFg: d.externalOrderRef ? 'var(--n900)' : 'var(--n600)',
      saleRefPick: g(() => this.openEntry('ref')),
      modeOpts: [
        ['takeaway', 'С СОБОЙ', aggregator ? 'доставка' : 'в пакет'],
        ['dine_in', 'В ЗАЛЕ', 'на поднос'],
      ].map(([mode, label, note]) => {
        const on = d.serviceModeChosen && m.state.draft?.service_mode === mode,
          off = aggregator && mode === 'dine_in';
        return {
          label,
          note,
          bg: on ? 'var(--blue)' : '#fff',
          fg: on ? '#fff' : off ? 'var(--n300)' : 'var(--n600)',
          shadow: on ? '0 6px 16px rgba(0,71,187,.25)' : 'none',
          pick: g(() => m.chooseServiceMode(mode)),
        };
      }),
      payBtnLabel: legacy.interactionBusy
        ? 'Проверяем запрос...'
        : empty
          ? 'К ОПЛАТЕ'
          : aggregator && !this.refValid()
            ? 'Введите номер заказа агрегатора'
            : !d.serviceModeChosen
              ? 'Выберите: в зале или с собой'
              : 'К ОПЛАТЕ · ' + total,
      ...(ready ? {} : { payBtnBg: 'var(--n300)', payBtnFg: 'var(--n600)', payBtnShadow: 'none' }),
      toPay: g(() => this.startPayment()),
      kkmLine: 'Чеки: вручную в Webkassa',
    };
  }
  /**
   * Everything the template needs from the paid mode, on top of today's values `legacy`.
   * Without the paid mode it only switches every sale block off.
   */
  templateValues(legacy) {
    return this.on ? { ...this.values(), ...this.orderValues(legacy) } : this.values();
  }
  /** Values of the sale overlays; all of them are off unless the edge sells (pos_sale). */
  values() {
    const s = this.state,
      m = this.model,
      sale = m.state.sale;
    const screens = {
      isSaleReview: false,
      isSalePay: false,
      isSaleDone: false,
      saleApprovalOpen: false,
      saleEntryOpen: false,
    };
    const doneShown = s.screen === 'done' && Boolean(sale);
    if (!this.on && !doneShown) return { saleChannelBar: false, saleRefShown: false, ...screens };
    const q = this.quote,
      g = this.guard;
    const values = {
      ...screens,
      isSaleReview: s.screen === 'review' && Boolean(q) && !sale,
      isSalePay: s.screen === 'pay' && Boolean(q) && m.reviewed && !sale,
      isSaleDone: doneShown,
      saleReviewType: this.typeLabel(),
      saleReviewTotal: q ? money(q.total_minor) : '-',
      saleReviewLines: (q?.lines ?? []).map((l) => ({
        key: lineKey(l),
        qty: l.quantity + ' ×',
        name: l.name.ru,
        mods: (l.modifiers ?? [])
          .map((x) => ((x.quantity ?? 1) > 1 ? x.quantity + ' × ' : '') + x.name.ru)
          .join(' · '),
        total: money(l.total_minor),
      })),
      saleReviewBack: g(() => this.setState({ screen: null })),
      saleReviewConfirm: g(() => this.confirmReview()),
      salePayBack: g(() => this.setState({ screen: null, method: null })),
    };
    if (values.isSalePay) Object.assign(values, this.payValues());
    if (doneShown) Object.assign(values, this.doneValues());
    if (s.approvalOpen) Object.assign(values, this.approvalValues());
    if (s.entry) Object.assign(values, this.entryValues());
    return values;
  }
  payValues() {
    const s = this.state,
      m = this.model,
      q = this.quote,
      g = this.guard,
      config = this.config,
      d = this.draft,
      total = BigInt(q.total_minor);
    const tiles = isAggregator(d.channel)
      ? [
          [
            'aggregator',
            'ОПЛАЧЕНО АГРЕГАТОРОМ',
            d.channel === 'glovo' ? 'G' : 'Я',
            d.channel === 'glovo' ? '#C79A00' : 'var(--ya)',
          ],
        ].filter(() => methodEnabled(config, aggregatorMethod(d.channel)))
      : TILES.filter(([code]) =>
          code === 'mixed' ? mixableMethods(config).length >= 2 : methodEnabled(config, code),
        );
    const payment = this.payment();
    const values = {
      saleTiles: tiles.map(([code, label, icon, color]) => {
        const on = s.method === code;
        return {
          label,
          icon,
          isKaspi: code === 'kaspi_terminal' || code === 'kaspi_manual',
          notKaspi: code !== 'kaspi_terminal' && code !== 'kaspi_manual',
          iconBg: color,
          pressed: on ? 'true' : 'false',
          bg: on ? 'rgba(0,71,187,.08)' : '#fff',
          border: on ? 'var(--blue)' : 'transparent',
          fg: on ? 'var(--blue)' : 'var(--n900)',
          pick: g(() => this.pick(code)),
        };
      }),
      salePanelNone: !s.method,
      salePanelCash: s.method === 'cash',
      salePanelTerminal: s.method === 'kaspi_terminal',
      salePanelManual: s.method === 'kaspi_manual',
      salePanelMix: s.method === 'mixed',
      salePanelChoco: s.method === 'chocofood',
      salePanelAggregator: s.method === 'aggregator',
      salePanelFree: s.method === 'staff_meal' || s.method === 'marketing',
      salePayDisabled: payment ? false : 'true',
      salePayBg: payment ? 'var(--orange)' : 'var(--n300)',
      salePayFg: payment ? '#fff' : 'var(--n600)',
      salePayConfirm: g(() => this.pay()),
      salePayLabel: 'Выберите способ оплаты',
    };
    if (s.method === 'cash') {
      const tendered = tiyn(s.cash),
        change = tendered - total;
      Object.assign(values, {
        saleCashLabel: money(tendered.toString()),
        saleCashKeys: this.digitsKeys('cash'),
        saleCashQuick: [
          ...[5000, 10000, 20000].map((n) => ({
            label: money((BigInt(n) * 100n).toString()),
            tap: g(() => this.setState({ cash: String(n) })),
          })),
          { label: 'Без сдачи', tap: g(() => this.setState({ cash: ceilTenge(q.total_minor) })) },
        ],
        saleChangeTitle: change >= 0n ? 'Сдача' : 'Не хватает',
        saleChangeLabel: money((change < 0n ? -change : change).toString()),
        saleChangeBg: change >= 0n ? 'rgba(18,161,80,.1)' : 'rgba(196,48,43,.08)',
        saleChangeFg: change >= 0n ? 'var(--green)' : 'var(--red)',
        salePayLabel:
          change >= 0n
            ? `Принять ${money(tendered.toString())} · сдача ${money(change.toString())}`
            : 'Внесено меньше суммы наличными',
      });
    }
    if (s.method === 'kaspi_terminal') {
      const whole = total % 100n === 0n;
      Object.assign(values, {
        saleTerminalSteps: whole
          ? [
              `1. Введите на терминале Kaspi ${money(q.total_minor)}.`,
              '2. Дождитесь на терминале «Оплата прошла».',
              '3. Только после этого нажмите «Оплата на терминале прошла».',
            ]
          : [
              saleErrorMessage(new Error('TERMINAL_AMOUNT_NOT_WHOLE')) +
                '. Выберите другой способ.',
            ],
        saleTerminalDecline: g(() => {
          this.setState({ method: null });
          this.say('Оплата не прошла. Повторите на терминале или выберите другой способ.');
        }),
        salePayLabel: 'Оплата на терминале прошла',
      });
    }
    if (s.method === 'kaspi_manual')
      Object.assign(values, {
        saleManualRefValue: s.manualRef || 'Нажмите, чтобы ввести',
        saleManualRefPick: g(() => this.openEntry('manualRef')),
        salePayLabel: 'Оплата Kaspi поступила',
      });
    if (s.method === 'mixed') Object.assign(values, this.mixValues());
    if (s.method === 'chocofood')
      Object.assign(values, {
        saleChocoRefValue: s.chocoRef || 'Нажмите и введите номер заказа',
        saleChocoRefBorder: EXTERNAL_ORDER_REF.test(s.chocoRef) ? 'var(--n300)' : 'var(--orange)',
        saleChocoRefPick: g(() => this.openEntry('choco')),
        salePayLabel: 'Заказ ChocoFood оплачен',
      });
    if (s.method === 'aggregator')
      Object.assign(values, {
        saleAggregatorNote: `Заказ оплачен ${IN_CHANNEL[d.channel]} №${d.externalOrderRef} - деньги придут от агрегатора.`,
        salePayLabel: 'Провести заказ ' + OF_CHANNEL[d.channel],
      });
    if (s.method === 'staff_meal' || s.method === 'marketing') {
      const staff = s.method === 'staff_meal',
        text = staff ? s.beneficiary : s.reason,
        approval = m.approvalFor(s.method);
      Object.assign(values, {
        saleFreeNote:
          (staff ? 'Питание сотрудника' : 'Маркетинг') +
          ` по цене меню ${money(q.total_minor)}, без выручки. Нужен PIN начальника смены.`,
        saleFreeTextTitle: staff ? 'Кому*' : 'Причина*',
        saleFreeTextValue: text || 'Нажмите, чтобы ввести',
        saleFreeTextBorder: (staff ? text.trim() : text.trim().length >= 3)
          ? 'var(--n300)'
          : 'var(--orange)',
        saleFreeTextPick: g(() => this.openEntry(staff ? 'beneficiary' : 'reason')),
        saleApprovalLabel: approval
          ? 'Подтвердил: ' + approval.manager.name
          : 'Нажмите, чтобы ввести PIN',
        saleApprovalBorder: approval ? 'var(--green)' : 'var(--orange)',
        saleApprovalPick: g(() => this.setState({ approvalOpen: true, approvalPin: '' })),
        salePayLabel: staff ? 'Провести питание сотрудника' : 'Провести маркетинг',
      });
    }
    return values;
  }
  mixValues() {
    const s = this.state,
      g = this.guard,
      allowed = mixableMethods(this.config);
    const { total, first, second } = this.mixAmounts();
    const valid = first > 0n && second > 0n;
    const cashIndex = s.mix.indexOf('cash');
    const cashPart = cashIndex === 0 ? first : cashIndex === 1 ? second : null;
    const tendered = s.mixCash ? tiyn(s.mixCash) : cashPart;
    const change = cashPart !== null && tendered !== null ? tendered - cashPart : null;
    const amounts = [first, second];
    return {
      saleMixParts: s.mix.map((method, index) => ({
        title: index === 0 ? 'ЧАСТЬ 1 · СУММА С КЛАВИАТУРЫ' : 'ЧАСТЬ 2 · ОСТАТОК',
        border: index === 0 && s.mixEdit === 'first' ? 'var(--blue)' : 'var(--n300)',
        amount: amounts[index] > 0n ? money(amounts[index].toString()) : '-',
        pick: g(() => this.setState({ mixEdit: 'first' })),
        methods: allowed.map((code) => ({
          label: METHOD_NAMES[code],
          pressed: method === code ? 'true' : 'false',
          bg: method === code ? 'var(--blue)' : '#fff',
          fg: method === code ? '#fff' : 'var(--n900)',
          pick: g(() => this.pickMix(index, code)),
        })),
      })),
      saleMixHasCash: cashPart !== null,
      saleMixCashLabel: tendered !== null && tendered > 0n ? money(tendered.toString()) : '-',
      saleMixCashBorder: s.mixEdit === 'cash' ? 'var(--blue)' : 'var(--n300)',
      saleMixCashPick: g(() => this.setState({ mixEdit: 'cash' })),
      saleMixKeys: this.digitsKeys(s.mixEdit === 'cash' ? 'mixCash' : 'mixFirst'),
      saleMixRestTitle: !valid
        ? 'Часть 1 - больше 0 и меньше ' + money(total.toString())
        : change !== null
          ? change >= 0n
            ? 'Сдача'
            : 'Не хватает наличных'
          : 'Остаток',
      saleMixRestLabel: !valid
        ? ''
        : change !== null
          ? money((change < 0n ? -change : change).toString())
          : money('0'),
      saleMixRestBg:
        valid && (change === null || change >= 0n) ? 'rgba(18,161,80,.1)' : 'rgba(196,48,43,.08)',
      saleMixRestFg: valid && (change === null || change >= 0n) ? 'var(--green)' : 'var(--red)',
      salePayLabel: valid ? 'Принять смешанную оплату' : 'Введите сумму первой части',
    };
  }
  doneValues() {
    const s = this.state,
      sale = this.model.state.sale,
      g = this.guard;
    const receipt = sale.fiscal.find((f) => f.kind === 'sale');
    const pending = receipt?.state === 'pending' && !s.receiptLater;
    return {
      saleDoneTitle:
        sale.revenue_kind === 'revenue'
          ? 'Заказ оформлен и передан на кухню'
          : 'Заказ без выручки передан на кухню',
      saleDoneNo: sale.display_number,
      saleDonePickup: pickupText(sale),
      saleDoneMethod: sale.tenders
        .map(
          (t) =>
            METHOD_NAMES[t.method] + (sale.tenders.length > 1 ? ' ' + money(t.amount_minor) : ''),
        )
        .join(' + '),
      saleDoneSum: money(sale.total_minor),
      saleDoneChange:
        sale.change_minor && sale.change_minor !== '0'
          ? 'Сдача ' + money(sale.change_minor)
          : false,
      saleFiscalPending: pending,
      saleReceiptValue: s.receipt || 'Нажмите, чтобы ввести номер',
      saleReceiptPick: g(() => this.openEntry('receipt')),
      saleReceiptSave: g(() => this.saveReceipt()),
      saleReceiptLater: g(() => this.setState({ receiptLater: true })),
      saleFiscalNote:
        receipt?.state === 'recorded'
          ? 'Чек Webkassa №' + receipt.receipt_number + ' сохранён'
          : receipt?.state === 'not_required'
            ? 'Чек Webkassa для этого способа оплаты не нужен'
            : receipt?.state === 'pending' && s.receiptLater
              ? 'Номер чека Webkassa нужно внести до закрытия смены'
              : false,
      saleNext: g(() => this.next()),
    };
  }
  approvalValues() {
    const s = this.state,
      q = this.quote,
      g = this.guard,
      error = this.model.state.error;
    return {
      saleApprovalOpen: true,
      saleApprovalSub:
        (s.method === 'staff_meal' ? 'Питание сотрудника' : 'Маркетинг') +
        (q ? ' · ' + money(q.total_minor) : ''),
      saleApprovalDots: Array.from({ length: this.pinLength }, (_, i) => ({
        bg: i < s.approvalPin.length ? 'var(--blue)' : 'transparent',
      })),
      saleApprovalError: error ? this.errorText(error) : '',
      saleApprovalKeys: this.keys(
        (d) => this.approvalDigit(d),
        (all) => this.setState({ approvalPin: all ? '' : this.state.approvalPin.slice(0, -1) }),
      ),
      saleApprovalClose: g(() => this.setState({ approvalOpen: false, approvalPin: '' })),
    };
  }
  entryValues() {
    const entry = this.state.entry,
      spec = ENTRIES[entry.purpose],
      g = this.guard;
    const title = spec.title ?? 'Номер заказа ' + (OF_CHANNEL[this.draft.channel] ?? 'агрегатора');
    return {
      saleEntryOpen: true,
      saleEntryTitle: title,
      saleEntrySub: spec.sub,
      saleEntryShown: entry.value || 'Пусто',
      saleEntryFg: entry.value ? 'var(--n900)' : 'var(--n600)',
      saleEntryKeys: spec.keys.map((label) => ({ label, tap: g(() => this.type(label)) })),
      saleEntrySpace: Boolean(spec.space),
      saleEntrySpaceTap: g(() => {
        if (entry.value && !entry.value.endsWith(' ') && entry.value.length < spec.max)
          this.setState({ entry: { ...entry, value: entry.value + ' ' } });
      }),
      saleEntryBack: g(() =>
        this.setState({ entry: { ...entry, value: entry.value.slice(0, -1) } }),
      ),
      saleEntryClear: g(() => this.setState({ entry: { ...entry, value: '' } })),
      saleEntryCancel: g(() => this.setState({ entry: null })),
      saleEntrySave: g(() => this.saveEntry()),
      saleEntryCta: 'Готово',
    };
  }
}
