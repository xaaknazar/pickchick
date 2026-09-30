export class ReferenceView {
  state = {
    ready: false,
    screen: 'lock',
    tab: 'order',
    pin: '',
    pinErr: '',
    pinShake: false,
    openCash: 0,
    cart: [],
    sel: null,
    mode: 'take',
    cat: 'combo',
    promo: false,
    rush: false,
    comment: '',
    held: [],
    orderNo: null,
    nextNo: 1,
    guest: null,
    board: '',
    guestOpen: false,
    phone: '',
    found: null,
    mod: null,
    modQty: 1,
    sauce: 'pick',
    drink: 'cola',
    addons: {},
    sizeIdx: 0,
    wiz: null,
    wizStep: 1,
    wizSauces: {},
    wizDrinks: {},
    pay: null,
    cashIn: 0,
    lang: 'ru',
    goods: false,
    posState: 'idle',
    posLeft: 90,
    mix: [],
    mixEdit: 0,
    freeReason: null,
    freePin: '',
    otp: null,
    commentOpen: false,
    draft: '',
    editFor: null,
    alert: null,
    alertAge: 0,
    alertSeq: 0,
    modeFix: {},
    done: null,
    doneLeft: 6,
    offline: false,
    restored: false,
    queued: 0,
    incTab: 'all',
    incSrc: 'all',
    incMode: 'all',
    incOpen: null,
    incoming: null,
    stops: {},
    stopAsk: null,
    dayFilter: 'all',
    closeOpen: false,
    closeStep: 1,
    counted: 0,
    closePin: '',
    toast: '',
    toastUndo: null,
    lastDeleted: null,
    clock: '',
    gift: false,
    drawer: 0,
    user: null,
    shiftOpen: false,
    shiftBy: null,
    shiftAt: '',
    cashLog: [],
  };
  SAUCES = [];
  DRINKS = [];
  ADDONS = [];
  COMBOS = [];
  DUO = [];
  PARTY = [];
  DOPS = [];
  CATS = [
    ['combo', 'КОМБО'],
    ['duo', 'НА ДВОИХ'],
    ['party', 'НА КОМПАНИЮ'],
    ['dops', 'ДОПЫ'],
    ['drinks', 'НАПИТКИ'],
  ];
  SIZES = [
    ['60 мл', 0],
    ['0,3 л', 300],
    ['0,5 л', 500],
  ];
  NUM = (n) => Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');
  MONEY = (n) => this.NUM(n) + ' ₸';
  all() {
    return this.COMBOS.concat(this.DUO, this.PARTY, this.DOPS);
  }
  isOut(id) {
    return !!this.state.stops[id];
  }
  say(m, undo) {
    clearTimeout(this._t);
    this.setState({ toast: m, toastUndo: undo || null });
    this._t = setTimeout(() => this.setState({ toast: '', toastUndo: null }), 4000);
  }
  tickClock = () => {
    const d = new Date();
    const c =
      d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    if (c !== this.state.clock) this.setState({ clock: c });
  };
  keys(onDigit, onBack, dark) {
    const bg = dark ? 'rgba(255,255,255,.14)' : '#fff',
      fg = dark ? '#fff' : 'var(--n900)';
    return ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((k) => ({
      label: k,
      size: k === '⌫' ? '30px' : '38px',
      fg: k === 'C' || k === '⌫' ? (dark ? '#FFB48A' : 'var(--red)') : fg,
      bg: k === 'C' || k === '⌫' ? (dark ? 'rgba(255,255,255,.08)' : 'var(--n100)') : bg,
      tap: () => (k === '⌫' ? onBack(false) : k === 'C' ? onBack(true) : onDigit(k)),
    }));
  }
  subtotal() {
    return this.state.cart.reduce((a, c) => a + (c.price + c.extra) * c.qty, 0);
  }
  discount() {
    return this.state.promo ? Math.round(this.subtotal() * 0.15) : 0;
  }
  total() {
    return this.subtotal() - this.discount();
  }
  addLine(it, mods, extra, qty, gift) {
    const cart = this.state.cart.slice();
    const key = it.id + '|' + (mods || '') + (gift ? '|gift' : '');
    const i = cart.findIndex((c) => c.key === key);
    if (i >= 0) cart[i] = Object.assign({}, cart[i], { qty: cart[i].qty + qty });
    else
      cart.push({
        key,
        id: it.id,
        name: it.name,
        price: gift ? 0 : it.price,
        extra: extra || 0,
        qty,
        mods: mods || '',
        gift: !!gift,
      });
    this.setState({ cart, sel: key, orderNo: this.state.orderNo || this.state.nextNo });
  }
  modExtra() {
    const s = this.state;
    let e = 0;
    if (s.mod && s.mod.combo && s.drink)
      e += (this.DRINKS.find((d) => d.id === s.drink) || {}).d || 0;
    if (s.mod && s.mod.sizes) e += this.SIZES[s.sizeIdx][1];
    for (const k in s.addons) e += s.addons[k] * (this.ADDONS.find((a) => a[0] === k) || [0, 0])[1];
    return e;
  }
  modMods() {
    const s = this.state,
      parts = [];
    if (s.mod.combo) {
      parts.push((this.SAUCES.find((x) => x.id === s.sauce) || {}).name);
      if (s.drink) parts.push((this.DRINKS.find((x) => x.id === s.drink) || {}).name);
    }
    if (s.mod.sizes) parts.push(this.SIZES[s.sizeIdx][0]);
    for (const k in s.addons)
      if (s.addons[k])
        parts.push('+' + (this.DOPS.find((d) => d.id === k) || {}).name + ' ×' + s.addons[k]);
    return parts.filter(Boolean).join(' · ');
  }
  nextOrder = () =>
    this.setState({
      screen: 'work',
      tab: 'order',
      cart: [],
      sel: null,
      promo: false,
      rush: false,
      comment: '',
      orderNo: null,
      guest: null,
      board: '',
      pay: null,
      cashIn: 0,
      posState: 'idle',
      done: null,
      gift: false,
    });
  incomingList() {
    return [];
  }
  constructor(onChange) {
    this.onChange = onChange;
  }
  setState(change) {
    this.state = { ...this.state, ...change };
    this.onChange?.();
  }
  renderVals() {
    const s = this.state,
      cart = s.cart;
    const CH = {
      app: ['ПРИЛОЖЕНИЕ', 'var(--blue)'],
      kiosk: ['КИОСК', 'var(--orange)'],
      ya: ['ЯНДЕКС ЕДА', 'var(--ya)'],
      glovo: ['GLOVO', '#C79A00'],
      wolt: ['WOLT', '#0097B3'],
      pos: ['КАССА', 'var(--n600)'],
    };
    const unavailable = cart.some((c) => this.isOut(c.id));
    const sel = cart.find((c) => c.key === s.sel);
    const inc = this.incomingList();
    const incFilt = inc
      .filter(
        (r) =>
          s.incTab === 'all' ||
          (s.incTab === 'unpaid' && !r.paid) ||
          (s.incTab === 'cook' && r.paid && r.kitchen === 'cook') ||
          (s.incTab === 'ready' && r.paid && r.kitchen === 'ready'),
      )
      .filter((r) => s.incSrc === 'all' || r.ch === s.incSrc)
      .filter((r) => s.incMode === 'all' || r.mode === s.incMode);
    const drinkReq = !!(s.mod && s.mod.combo && !s.drink);
    const change = s.cashIn - this.total();
    const mixSum = s.mix.reduce((a, m) => a + m.sum, 0),
      mixRest = this.total() - mixSum;
    const payOk =
      s.pay === 'cash'
        ? s.cashIn >= this.total()
        : s.pay === 'mix'
          ? s.mix.length > 0 && mixRest === 0
          : s.pay === 'free'
            ? !!s.freeReason && s.freePin === 'ok'
            : !!s.pay && s.posState === 'idle';
    const PM = {
      cash: ['Наличные', '₸', 'var(--green)'],
      pos: ['Kaspi терминал', 'K', 'var(--kaspi)'],
      card: ['Карта', '▭', 'var(--blue)'],
    };
    const numKeys = (field, max) =>
      this.keys(
        (d) => {
          const v = String(s[field] || 0);
          if (v.length < (max || 7)) {
            const st = {};
            st[field] = Number((v === '0' ? '' : v) + d);
            this.setState(st);
          }
        },
        (all) => {
          const st = {};
          st[field] = all ? 0 : Math.floor((s[field] || 0) / 10);
          this.setState(st);
        },
      );
    const isOn = (on) => (on ? 'var(--blue)' : '#fff'),
      fgOn = (on) => (on ? '#fff' : 'var(--n900)');
    return {
      clock: s.clock,
      menuReady: s.ready,
      isLock: s.screen === 'lock',
      isOpenShift: s.screen === 'openshift',
      isWork: s.screen !== 'lock' && s.screen !== 'openshift',
      isPay: s.screen === 'pay',
      isSuccess: s.screen === 'success',
      isOrder: s.tab === 'order',
      isIncoming: false,
      isOrders: s.tab === 'orders',
      isStops: s.tab === 'stops',
      isShift: s.tab === 'shift',
      offline: s.offline,
      restored: s.restored,
      queued: s.queued,
      pinDots: [0, 1, 2, 3].map((i) => ({ bg: i < s.pin.length ? '#fff' : 'transparent' })),
      pinShake: s.pinShake ? 'posShake .45s ease both' : 'none',
      openCashLabel: this.MONEY(s.openCash),
      openQuick: [5000, 10000, 20000, 50000].map((v) => ({
        label: '+' + this.NUM(v),
        tap: () => this.setState({ openCash: s.openCash + v }),
      })),
      openKeys: numKeys('openCash'),
      userInitial: s.user ? s.user.short.slice(0, 1) : '',
      userName: s.user ? s.user.name : '-',
      userShort: s.user ? s.user.short : '-',
      userRole: s.user ? s.user.role : '',
      hasHeld: s.held.length > 0,
      heldCount: s.held.length,
      modeOpts: [
        ['take', 'С СОБОЙ', 'в пакет'],
        ['dine', 'В ЗАЛЕ', 'на поднос'],
      ].map((m) => {
        const on = s.mode === m[0];
        return {
          label: m[1],
          note: m[2],
          bg: on ? 'var(--blue)' : '#fff',
          fg: on ? '#fff' : 'var(--n600)',
          shadow: on ? '0 6px 16px rgba(0,71,187,.25)' : 'none',
          pick: () => this.setState({ mode: m[0] }),
        };
      }),
      modeLabel: s.mode === 'take' ? 'С СОБОЙ' : 'В ЗАЛЕ',
      noGuest: !s.guest && !s.board,
      hasGuest: !!s.guest || !!s.board,
      guestName: s.guest ? s.guest.name : s.board,
      guestPhone: s.guest ? s.guest.phone : 'без номера',
      guestInitials: (s.guest ? s.guest.name : s.board || '-').slice(0, 1),
      boardName: s.board || (s.guest ? s.guest.name : '-'),
      openGuest: () => this.setState({ guestOpen: true, found: null, phone: '' }),
      closeGuest: () => this.setState({ guestOpen: false }),
      guestOpen: s.guestOpen,
      cartEmpty: !cart.length,
      lines: cart.map((c, i) => {
        const out = this.isOut(c.id);
        const on = c.key === s.sel;
        return {
          n: i + 1,
          name: c.name,
          qtyLabel: c.qty > 1 ? '×' + c.qty : '',
          mods: c.mods,
          total: c.gift ? 'ПОДАРОК · 0' : this.NUM((c.price + c.extra) * c.qty),
          bg: on ? 'rgba(0,71,187,.08)' : 'transparent',
          border: out ? 'var(--red)' : on ? 'var(--blue)' : 'transparent',
          nameFg: out ? 'var(--red)' : 'var(--n900)',
          priceFg: c.gift ? 'var(--green)' : 'var(--n900)',
          warn: out,
          select: () => this.setState({ sel: c.key }),
        };
      }),
      selFg: sel ? 'var(--n900)' : 'var(--n600)',
      selDelFg: sel ? 'var(--red)' : 'var(--n600)',
      promoBtnBg: s.promo ? 'rgba(18,161,80,.1)' : '#fff',
      promoBtnFg: s.promo ? 'var(--green)' : 'var(--n900)',
      promoBtnLabel: s.promo ? 'PICK15 ✓' : 'Промокод',
      cats: this.CATS.map((c) => ({
        label: c[1],
        bg: isOn(s.cat === c[0]),
        fg: fgOn(s.cat === c[0]),
        pick: () => this.setState({ cat: c[0] }),
      })),
      holdFg: cart.length ? 'var(--n900)' : 'var(--n600)',
      holdBg: cart.length ? '#fff' : 'var(--n100)',
      rushBg: s.rush ? 'var(--orange)' : '#fff',
      rushBorder: s.rush ? 'var(--orange)' : 'var(--n300)',
      rushFg: s.rush ? '#fff' : 'var(--n900)',
      openComment: () => this.setState({ commentOpen: true, draft: s.comment, editFor: null }),
      commentTitle: s.editFor ? 'Комментарий к заказу №' + s.editFor : 'Комментарий для кухни',
      commentCta: s.editFor ? 'Отправить на кухню' : 'Сохранить в заказ',
      commentOpen: s.commentOpen,
      closeComment: () => this.setState({ commentOpen: false }),
      commentLabel: s.comment ? '✎ ' + s.comment : '✎ Комментарий для кухни',
      commentBg: s.comment ? 'rgba(0,71,187,.08)' : '#fff',
      commentBorder: s.comment ? 'var(--blue)' : 'var(--n300)',
      commentFg: s.comment ? 'var(--blue)' : 'var(--n900)',
      draftShown: s.draft || 'Например: без лука, соус отдельно',
      draftFg: s.draft ? 'var(--n900)' : 'var(--n600)',
      commentKeys: 'ЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ'.split('').map((k) => ({
        label: k,
        tap: () => {
          if (s.draft.length < 60)
            this.setState({ draft: s.draft + (s.draft ? k.toLowerCase() : k) });
        },
      })),
      commentSpace: () => {
        if (s.draft && s.draft.length < 60) this.setState({ draft: s.draft + ' ' });
      },
      commentBack: () => this.setState({ draft: s.draft.slice(0, -1) }),
      commentClear: () => this.setState({ draft: '' }),
      commentQuick: [
        'С собой',
        'Без лука',
        'Без соуса',
        'Соус отдельно',
        'Без соли',
        'Погорячее',
        'Упаковать отдельно',
      ].map((q) => ({ label: q, tap: () => this.setState({ draft: q }) })),
      payBtnBg: cart.length && !unavailable ? 'var(--orange)' : 'var(--n300)',
      payBtnFg: cart.length && !unavailable ? '#fff' : 'var(--n600)',
      payBtnShadow: cart.length && !unavailable ? '0 14px 34px rgba(255,103,31,.35)' : 'none',
      closeMod: () => this.setState({ mod: null }),
      drinkReqLabel: drinkReq ? 'ОБЯЗАТЕЛЬНО · НЕ ВЫБРАН' : 'ОБЯЗАТЕЛЬНО',
      drinkReqBg: drinkReq ? 'rgba(196,48,43,.1)' : 'var(--n100)',
      drinkReqFg: drinkReq ? 'var(--red)' : 'var(--n600)',
      modCtaShadow: drinkReq ? 'none' : '0 14px 34px rgba(255,103,31,.35)',
      closeWiz: () => this.setState({ wiz: null }),
      wizStep1: s.wizStep === 1,
      phoneMask: (() => {
        const p = s.phone.padEnd(10, '_');
        return (
          '(' + p.slice(0, 3) + ') ' + p.slice(3, 6) + '-' + p.slice(6, 8) + '-' + p.slice(8, 10)
        );
      })(),
      phoneKeys: this.keys(
        (d) => {
          if (s.phone.length < 10) this.setState({ phone: s.phone + d, found: null });
        },
        (all) => this.setState({ phone: all ? '' : s.phone.slice(0, -1), found: null }),
      ),
      findLabel: 'Найти',
      findBg: s.phone.length === 10 ? 'var(--blue)' : 'var(--n300)',
      findFg: s.phone.length === 10 ? '#fff' : 'var(--n600)',
      foundGuest: !!s.found && s.found !== 'none',
      notFound: s.found === 'none',
      guestIdle: !s.found,
      boardShown: s.board || 'Имя для табло',
      boardFg: s.board ? 'var(--n900)' : 'var(--n600)',
      boardKeys: 'ЙЦУКЕНГШЩЗХФЫВАПРОЛДЖЭЯЧСМИТЬБЮӘІҢҒҮҰҚӨҺ'
        .split('')
        .concat(['⌫'])
        .map((k) => ({
          label: k,
          bg: k === '⌫' ? 'var(--n300)' : '#fff',
          fg: 'var(--n900)',
          tap: () => {
            if (k === '⌫') this.setState({ board: s.board.slice(0, -1) });
            else if (s.board.length < 14)
              this.setState({ board: s.board + (s.board ? k.toLowerCase() : k) });
          },
        })),
      backToOrder: () => this.setState({ screen: 'work', posState: 'idle' }),
      payTiles: [
        ['cash', 'НАЛИЧНЫЕ', '₸', 'var(--green)'],
        ['pos', 'KASPI ТЕРМИНАЛ', 'K', 'var(--kaspi)'],
        ['card', 'КАРТА ТЕРМИНАЛ', '▭', 'var(--blue)'],
        ['mix', 'СМЕШАННАЯ', '½', 'var(--n600)'],
        ['free', 'БЕЗ ВЫРУЧКИ', '0', 'var(--n300)'],
      ].map((p) => {
        const off = false;
        const on = s.pay === p[0];
        const isK = p[0] === 'pos';
        return {
          label: p[1],
          icon: p[2],
          isKaspi: isK && !off,
          notKaspi: !isK || off,
          iconBg: off ? 'var(--n300)' : p[3],
          bg: on ? 'rgba(0,71,187,.08)' : p[0] === 'free' ? 'var(--n100)' : '#fff',
          border: on ? 'var(--blue)' : p[0] === 'free' ? 'var(--n300)' : 'transparent',
          borderStyle: p[0] === 'free' && !on ? 'dashed' : 'solid',
          fg: on ? 'var(--blue)' : 'var(--n900)',
          opacity: off ? 0.55 : 1,
          reason: off ? 'Нет связи' : false,
          on,
          pick: () => {
            if (!off)
              this.setState({
                pay: p[0],
                posState: 'idle',
                cashIn: 0,
                mix: p[0] === 'mix' ? [{ id: 'cash', sum: 0 }] : [],
                mixEdit: 0,
                freeReason: null,
                freePin: '',
              });
          },
        };
      }),
      payIsCash: s.pay === 'cash',
      payIsPos: s.pay === 'pos' || s.pay === 'card' || (s.pay === 'mix' && s.posState !== 'idle'),
      payIsQr: false,
      payIsMix: s.pay === 'mix' && s.posState === 'idle',
      payIsFree: s.pay === 'free',
      payIsNone: !s.pay,
      posIsKaspi: s.pay === 'pos' || (s.pay === 'mix' && s.mix.some((m) => m.id === 'pos')),
      posIsCard: s.pay === 'card' || (s.pay === 'mix' && !s.mix.some((m) => m.id === 'pos')),
      qrIsKaspi: false,
      qrIsHalyk: true,
      cashInLabel: this.MONEY(s.cashIn),
      cashKeys: numKeys('cashIn'),
      cashClear: () => this.setState({ cashIn: 0 }),
      mixParts: s.mix
        .filter((m) => PM[m.id])
        .map((m, i) => ({
          name: PM[m.id][0],
          icon: PM[m.id][1],
          iconBg: PM[m.id][2],
          sum: this.MONEY(m.sum),
          sumFg: i === s.mixEdit ? 'var(--blue)' : 'var(--n900)',
          border: i === s.mixEdit ? 'var(--blue)' : 'transparent',
          edit: () => this.setState({ mixEdit: i }),
          remove: () => this.setState({ mix: s.mix.filter((_, j) => j !== i), mixEdit: 0 }),
        })),
      mixCanAdd: s.mix.length < 3,
      mixAddOpts: Object.keys(PM)
        .filter((id) => !s.mix.some((m) => m.id === id))
        .map((id) => ({
          label: PM[id][0],
          tap: () =>
            this.setState({
              mix: s.mix.concat([{ id, sum: Math.max(0, mixRest) }]),
              mixEdit: s.mix.length,
            }),
        })),
      mixSumLabel: this.MONEY(mixSum),
      mixRestTitle: mixRest >= 0 ? 'Остаток' : 'Лишнее',
      mixRestLabel: this.MONEY(Math.abs(mixRest)),
      mixRestBg: mixRest === 0 ? 'rgba(18,161,80,.1)' : 'rgba(196,48,43,.08)',
      mixRestFg: mixRest === 0 ? 'var(--green)' : 'var(--red)',
      mixEditTitle:
        s.mix[s.mixEdit] && PM[s.mix[s.mixEdit].id]
          ? 'СУММА · ' + PM[s.mix[s.mixEdit].id][0].toUpperCase()
          : 'ДОБАВЬТЕ ЧАСТЬ',
      mixKeys: this.keys(
        (d) => {
          const m = s.mix[s.mixEdit];
          if (!m) return;
          const v = String(m.sum || 0);
          if (v.length >= 7) return;
          const mix = s.mix.slice();
          mix[s.mixEdit] = { id: m.id, sum: Number((v === '0' ? '' : v) + d) };
          this.setState({ mix });
        },
        (all) => {
          const m = s.mix[s.mixEdit];
          if (!m) return;
          const mix = s.mix.slice();
          mix[s.mixEdit] = { id: m.id, sum: all ? 0 : Math.floor(m.sum / 10) };
          this.setState({ mix });
        },
      ),
      mixFillRest: () => {
        const m = s.mix[s.mixEdit];
        if (!m) return;
        const mix = s.mix.slice();
        mix[s.mixEdit] = { id: m.id, sum: m.sum + mixRest };
        this.setState({ mix });
      },
      freeReasons: ['Бартер · маркетинг', 'Питание персонала', 'Проба', 'Брак'].map((r) => {
        const on = s.freeReason === r;
        return {
          label: r,
          bg: isOn(on),
          fg: fgOn(on),
          border: on ? 'var(--blue)' : 'var(--n300)',
          pick: () => this.setState({ freeReason: r, freePin: '', otp: null }),
        };
      }),
      otpAsked: !!s.otp,
      otpBtnLabel: s.otp ? 'Запросить новый код' : 'Запросить код',
      otpLabel:
        s.freePin === 'ok'
          ? 'Код принят - можно проводить'
          : s.otp
            ? 'Введите код из сообщения управляющего'
            : 'Запросите одноразовый код у управляющего',
      otpDots: [0, 1, 2, 3, 4, 5].map((i) => ({
        bg: s.freePin === 'ok' || i < s.freePin.length ? 'var(--blue)' : 'transparent',
      })),
      freePinKeys: this.keys(
        (d) => {
          if (!s.otp || s.freePin === 'ok' || s.freePin.length >= 6) return;
          const nv = s.freePin + d;
          if (nv.length === 6) {
            if (nv === s.otp) this.setState({ freePin: 'ok' });
            else {
              this.setState({ freePin: '' });
              this.say('Код не подошёл - запросите новый');
            }
          } else this.setState({ freePin: nv });
        },
        (all) =>
          this.setState({ freePin: all || s.freePin === 'ok' ? '' : s.freePin.slice(0, -1) }),
      ),
      quickCash: [100, 200, 500, 1000, 2000, 5000, 10000, 20000].map((v) => ({
        label: '+' + this.NUM(v),
        tap: () => this.setState({ cashIn: s.cashIn + v }),
      })),
      cashExact: () => this.setState({ cashIn: this.total() }),
      changeTitle: change >= 0 ? 'Сдача' : 'Не хватает',
      changeLabel: this.MONEY(Math.abs(change)),
      changeBg: change >= 0 ? 'rgba(18,161,80,.1)' : 'rgba(196,48,43,.08)',
      changeFg: change >= 0 ? 'var(--green)' : 'var(--red)',
      changeSubFg: 'var(--n600)',
      posTitle:
        s.pay === 'mix' && s.posState === 'wait'
          ? 'Безналичная часть отправлена на терминал'
          : s.posState === 'wait'
            ? 'Сумма отправлена на терминал'
            : s.posState === 'ok'
              ? 'Оплата прошла'
              : s.posState === 'fail'
                ? 'Оплата не прошла: недостаточно средств'
                : 'Терминал готов',
      posSub:
        s.posState === 'wait'
          ? 'Гость прикладывает карту или телефон. Не повторяйте оплату - ждём ответ терминала.'
          : s.posState === 'fail'
            ? 'Текст от терминала. Повторите или выберите другой способ.'
            : s.posState === 'ok'
              ? 'Переходим к номеру заказа'
              : 'Нажмите «Оплатить» - сумма уйдёт на карточный терминал',
      posWaiting: s.posState === 'wait',
      posTimer: '1:' + String(s.posLeft - 60 >= 0 ? s.posLeft - 60 : 0).padStart(2, '0'),
      posActions:
        s.posState === 'fail'
          ? [
              {
                label: 'Повторить',
                bg: 'var(--orange)',
                fg: '#fff',
                border: 'var(--orange)',
                tap: () => this.setState({ posState: 'wait', posLeft: 90 }),
              },
              {
                label: 'Другой способ',
                bg: '#fff',
                fg: 'var(--n900)',
                border: 'var(--n300)',
                tap: () => this.setState({ pay: null, posState: 'idle' }),
              },
            ]
          : s.posState === 'wait'
            ? [
                {
                  label: 'Отменить',
                  bg: '#fff',
                  fg: 'var(--red)',
                  border: 'var(--n300)',
                  tap: () => this.setState({ posState: 'idle' }),
                },
              ]
            : [],
      qrBrandBg: 'var(--halyk)',
      qrBrandLetter: 'H',
      qrBrandName: 'Halyk',
      langOpts: [
        ['ru', 'Чек RU'],
        ['kk', 'Чек KZ'],
      ].map((o) => ({
        label: o[1],
        bg: s.lang === o[0] ? '#fff' : 'transparent',
        fg: s.lang === o[0] ? 'var(--blue)' : 'var(--n600)',
        pick: () => this.setState({ lang: o[0] }),
      })),
      goodsBorder: s.goods ? 'var(--blue)' : 'var(--n300)',
      goodsBg: s.goods ? 'rgba(0,71,187,.08)' : '#fff',
      goodsFg: s.goods ? 'var(--blue)' : 'var(--n900)',
      payCtaShadow: payOk ? '0 14px 34px rgba(255,103,31,.35)' : 'none',
      doneLeft: s.doneLeft,
      doneNoteBg2: s.done && s.done.offline ? '#FFF3C4' : 'rgba(18,161,80,.1)',
      doneNoteFg2: s.done && s.done.offline ? '#5A4600' : '#0B7A3B',
      navItems: [
        ['order', 'ЗАКАЗ'],
        ['orders', 'ЗАКАЗЫ'],
        ['stops', 'СТОП-ЛИСТ'],
        ['shift', 'СМЕНА'],
      ].map((n) => {
        const on = s.tab === n[0];
        const cnt =
          n[0] === 'stops'
            ? Object.keys(s.stops).length
            : n[0] === 'order' && s.alert
              ? 1 + (s.queueList || []).length
              : 0;
        return {
          label: n[1],
          bg: isOn(on),
          fg: fgOn(on),
          badge: cnt ? String(cnt) : false,
          pulse: n[0] === 'order' && s.alert ? 'posPulse 1.6s ease infinite' : 'none',
          go: () => this.setState({ tab: n[0], incOpen: null }),
        };
      }),
      incTabs: [
        ['all', 'Все', inc.length],
        ['unpaid', 'Ждут оплаты', inc.filter((r) => !r.paid).length],
        ['cook', 'Готовятся', inc.filter((r) => r.paid && r.kitchen === 'cook').length],
        ['ready', 'Готовы', inc.filter((r) => r.paid && r.kitchen === 'ready').length],
      ].map((t) => {
        const on = s.incTab === t[0];
        return {
          label: t[1],
          count: t[2],
          bg: isOn(on),
          fg: fgOn(on),
          badgeBg: on ? 'rgba(255,255,255,.2)' : 'var(--n100)',
          badgeFg: on ? '#fff' : 'var(--n600)',
          pick: () => this.setState({ incTab: t[0] }),
        };
      }),
      hasAlert: !!s.alert && s.tab === 'order',
      alertNo: s.alert ? '№' + s.alert.no : '',
      alertSrc: s.alert ? s.alert.src : '',
      alertChBg: s.alert
        ? { ya: 'var(--ya)', glovo: '#F2C200', wolt: '#00C2E8' }[s.alert.ch] || 'var(--blue)'
        : '',
      alertGuest: s.alert ? 'Заказ агрегатора ' + s.alert.guest : '',
      alertItems: s.alert ? s.alert.items : '',
      alertSum: s.alert ? this.MONEY(s.alert.sum) : '',
      alertPickup: s.alert ? s.alert.pickup : '',
      alertNoteLine: s.alert && s.alert.note ? 'Комментарий: ' + s.alert.note : 'Комментария нет',
      alertNoteBg: s.alert && s.alert.note ? 'rgba(0,71,187,.08)' : 'var(--n100)',
      alertNoteFg: s.alert && s.alert.note ? 'var(--blue)' : 'var(--n600)',
      alertAge: s.alertAge + ' сек назад',
      alertUrgent: s.alertAge >= 20,
      alertAgeFg: s.alertAge >= 20 ? 'var(--red)' : 'var(--n600)',
      alertMore: (s.queueList || []).length,
      alertTotalCount: 1 + (s.queueList || []).length,
      alertQueue: (s.queueList || []).slice(0, 4).map((q) => ({
        src: q.src,
        no: '№' + q.no,
        sum: this.MONEY(q.sum),
        chBg: { ya: 'var(--ya)', glovo: '#F2C200', wolt: '#00C2E8' }[q.ch] || 'var(--blue)',
      })),
      incSrcOpts: [
        ['all', 'Все источники'],
        ['app', 'Приложение'],
        ['ya', 'Доставка · Яндекс'],
        ['kiosk', 'Киоск'],
        ['pos', 'Кассир'],
      ].map((o) => {
        const on = s.incSrc === o[0],
          n = o[0] === 'all' ? inc.length : inc.filter((r) => r.ch === o[0]).length;
        return {
          label: o[1],
          count: n,
          bg: isOn(on),
          fg: fgOn(on),
          badgeBg: on ? 'rgba(255,255,255,.2)' : 'var(--n100)',
          badgeFg: on ? '#fff' : 'var(--n600)',
          pick: () => this.setState({ incSrc: o[0], incOpen: null }),
        };
      }),
      incModeOpts: [
        ['all', 'Все'],
        ['dine', 'В зале'],
        ['take', 'Навынос'],
        ['delivery', 'Доставка'],
      ].map((o) => {
        const on = s.incMode === o[0],
          n = o[0] === 'all' ? inc.length : inc.filter((r) => r.mode === o[0]).length;
        return {
          label: o[1],
          count: n,
          bg: on ? 'var(--orange)' : '#fff',
          fg: on ? '#fff' : 'var(--n900)',
          badgeBg: on ? 'rgba(255,255,255,.24)' : 'var(--n100)',
          badgeFg: on ? '#fff' : 'var(--n600)',
          pick: () => this.setState({ incMode: o[0], incOpen: null }),
        };
      }),
      incEmpty: !incFilt.length,
      incRows: incFilt.map((r) => {
        const c = CH[r.ch];
        const st = r.unconfirmed
          ? ['НЕ ПОДТВЕРЖДЁН АГРЕГАТОРУ', 'rgba(196,48,43,.1)', 'var(--red)']
          : !r.paid
            ? ['ЖДЁТ ОПЛАТЫ НА КАССЕ', 'rgba(255,103,31,.12)', 'var(--orange)']
            : r.courier
              ? ['ОПЛАЧЕНО · КУРЬЕР ' + r.courier, 'rgba(18,161,80,.1)', '#0B7A3B']
              : ['ОПЛАЧЕНО', 'rgba(18,161,80,.1)', '#0B7A3B'];
        const action = r.unconfirmed
          ? 'Подтвердить вручную'
          : !r.paid
            ? 'ПРИНЯТЬ ОПЛАТУ'
            : r.kitchen === 'ready'
              ? r.ch === 'ya'
                ? 'Передан курьеру'
                : 'Выдано'
              : false;
        const primary = action === 'ПРИНЯТЬ ОПЛАТУ';
        const MODE = {
          dine: ['В ЗАЛЕ', 'var(--blue)'],
          take: ['НАВЫНОС', 'var(--n600)'],
          delivery: ['ДОСТАВКА', 'var(--ya)'],
        }[r.mode] || ['-', 'var(--n600)'];
        return {
          no: r.no,
          channel: c[0],
          chBg: c[1],
          mode: MODE[0],
          modeFg: MODE[1],
          time: r.time,
          guest: r.guest,
          items: r.items,
          sum: this.MONEY(r.sum),
          status: st[0],
          stBg: st[1],
          stFg: st[2],
          kitchenIcon: r.kitchen === 'ready' ? '✓' : r.kitchen === 'cook' ? '♨' : '⏱',
          bg: r.unconfirmed ? 'rgba(196,48,43,.05)' : '#fff',
          border:
            s.incOpen === r.no
              ? 'var(--blue)'
              : r.unconfirmed
                ? 'rgba(196,48,43,.3)'
                : 'transparent',
          expanded: s.incOpen === r.no,
          full: r.full,
          guestInfo: r.ginfo,
          action,
          actBg: primary ? 'var(--orange)' : '#fff',
          actFg: primary ? '#fff' : 'var(--n900)',
          actBorder: primary ? 'var(--orange)' : 'var(--n300)',
          note: r.note || '',
          hasNote: !!r.note,
          editNote: () =>
            this.setState({ commentOpen: true, draft: r.note || '', editFor: r.no, incOpen: r.no }),
          editNoteLabel: r.note ? '✎ Изменить комментарий' : '✎ Комментарий кухне',
          open: () => this.setState({ incOpen: s.incOpen === r.no ? null : r.no }),
          act: () => {
            if (primary) {
              const m = this.COMBOS.find((x) => x.id === 'master') || {
                id: 'master',
                name: 'Master Combo',
                price: 5490,
              };
              this.setState({
                cart: [
                  {
                    key: 'inc' + r.no,
                    id: m.id,
                    name: m.name,
                    price: m.price,
                    extra: 0,
                    qty: 1,
                    mods: 'Острый · Coca-Cola 0.5',
                  },
                ],
                orderNo: r.no,
                guest: { name: r.guest, phone: '+7 700 *** 88 04', level: 'Легенда', chiki: 9640 },
                screen: 'pay',
                pay: null,
                tab: 'order',
                incoming: inc.filter((x) => x.no !== r.no),
              });
            } else {
              this.setState({ incoming: inc.filter((x) => x.no !== r.no) });
              this.say('Заказ №' + r.no + ' - ' + action.toLowerCase());
            }
          },
        };
      }),
      dayFilters: [
        ['all', 'Все'],
        ['pos', 'Касса'],
        ['app', 'Приложение'],
        ['kiosk', 'Киоск'],
        ['ya', 'Яндекс Еда'],
        ['glovo', 'Glovo'],
        ['wolt', 'Wolt'],
      ].map((f) => ({
        label: f[1],
        bg: isOn(s.dayFilter === f[0]),
        fg: fgOn(s.dayFilter === f[0]),
        pick: () => this.setState({ dayFilter: f[0] }),
      })),
      stopAsk: !!s.stopAsk,
      stopAskName: s.stopAsk ? s.stopAsk.name : '',
      stopCancel: () => this.setState({ stopAsk: null }),
      shiftDuration: (() => {
        const a = (s.shiftAt || s.clock || '0:0').split(':').map(Number),
          b = (s.clock || '0:0').split(':').map(Number);
        const mins = b[0] * 60 + b[1] - a[0] * 60 - a[1];
        return mins > 0 ? Math.floor(mins / 60) + ' ч ' + (mins % 60) + ' мин' : 'только что';
      })(),
      retryFg: s.queued ? 'var(--orange)' : 'var(--n600)',
      cancelClose: () => this.setState({ closeOpen: false }),
      closeOpen: s.closeOpen,
      closeSteps: [1, 2, 3, 4, 5].map((i) => ({
        bg: i <= s.closeStep ? 'var(--blue)' : 'var(--n300)',
      })),
      closeStep1: s.closeStep === 1,
      closeStep2: s.closeStep === 2,
      closeStep3: s.closeStep === 3,
      closeStep4: s.closeStep === 4,
      closeStep5: s.closeStep === 5,
      countedLabel: this.MONEY(s.counted),
      closeKeys: numKeys('counted'),
      diffLabel:
        s.counted === s.drawer
          ? 'Расхождения нет'
          : 'Расхождение ' +
            (s.counted > s.drawer ? '+' : '−') +
            this.MONEY(Math.abs(s.counted - s.drawer)) +
            ' - добавьте комментарий',
      diffBg: s.counted === s.drawer ? 'rgba(18,161,80,.1)' : 'rgba(196,48,43,.08)',
      diffFg: s.counted === s.drawer ? '#0B7A3B' : 'var(--red)',
      queueBg: s.queued ? '#FFF3C4' : 'rgba(18,161,80,.1)',
      queueFg: s.queued ? '#5A4600' : '#0B7A3B',
      closePinDots: [0, 1, 2, 3].map((i) => ({
        bg: i < s.closePin.length ? 'var(--blue)' : 'transparent',
      })),
      closeCtaBg: s.closeStep === 5 ? 'var(--n300)' : 'var(--orange)',
      closeCtaFg: s.closeStep === 5 ? 'var(--n600)' : '#fff',
      closeBack: () => this.setState({ closeStep: Math.max(1, s.closeStep - 1) }),
      toast: s.toast,
      toastUndo: !!s.toastUndo,
    };
  }
}
