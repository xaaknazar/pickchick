import { element as el, button, field } from './dom.js';
import {
  DevicesModel,
  EDGE_HINT,
  EVENT_LABELS,
  ROLE_LABELS,
  STAFF_RESET_HINT,
  actions,
  canPair,
  codeExpired,
  countdown,
  credentialState,
  explain,
  groupDevices,
  legacyRegistry,
  nameValid,
  presence,
  reasonValid,
  relative,
  sameName,
  summary,
  type Device,
  type DeviceRole,
  type Registry,
} from './devices-model.js';

type Legacy = () => {
  rows: Record<string, unknown>[] | undefined;
  role: string | undefined;
};

const ICONS: Record<DeviceRole, string> = {
  edge: 'M3 4h18v12H3zM9 20h6M12 16v4M7 8h4',
  pos: 'M3 4h18v12H3zM9 20h6M12 16v4M7 8h4',
  kiosk: 'M6 2h12a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1M11 18h2',
  kitchen_prep: 'M8 3h8v3H8zM6 4.5H5V21h14V4.5h-1M8 11h8M8 15h8M8 19h4',
  kitchen_assembly: 'M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2',
  board: 'M2 5h20v12H2zM7 21h10M6 9h3M6 13h3M13 9h5M13 13h5',
};
function icon(role: DeviceRole) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', ICONS[role]);
  svg.append(path);
  const wrap = el('span', 'device-icon');
  wrap.append(svg);
  return wrap;
}
const exact = (at: string) =>
  new Date(at).toLocaleString('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const clock = (at: string) =>
  new Date(at).toLocaleTimeString('ru-RU', {
    timeZone: 'Asia/Almaty',
    hour: '2-digit',
    minute: '2-digit',
  });
const day = (at: string) =>
  new Date(at).toLocaleDateString('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: '2-digit',
    month: '2-digit',
  });
function fact(label: string, value: string, cls = '', title = '') {
  const row = el('div', 'device-fact');
  const dd = el('dd', cls, value);
  if (title) dd.title = title;
  row.append(el('dt', '', label), dd);
  return row;
}
function hint(text: string, cls = '') {
  return el('p', ('device-hint ' + cls).trim(), text);
}
function dialog(title: string, sub: string, testId: string, onClose?: () => void) {
  const d = el('dialog', 'op-dialog device-dialog');
  d.dataset.testid = testId;
  d.setAttribute('aria-label', title);
  const head = el('div', 'panel-head');
  head.append(
    el('h2', '', title),
    button('Закрыть', () => d.close(), 'button subtle', testId + '-close'),
  );
  d.append(head);
  if (sub) d.append(el('p', 'op-note', sub));
  document.body.append(d);
  d.addEventListener(
    'close',
    () => {
      d.remove();
      onClose?.();
    },
    { once: true },
  );
  d.showModal();
  return d;
}
function errorLine() {
  const e = el('p', 'notice error op-form-error');
  e.setAttribute('role', 'alert');
  return e;
}

export class DevicesView {
  private pairingDialog: HTMLDialogElement | null = null;
  private pairingStage = '';
  private reason = '';
  private name = '';
  constructor(
    private model: DevicesModel,
    private legacy: Legacy,
  ) {}
  registry(): Registry | null {
    const m = this.model;
    if (m.data) return m.data;
    if (!m.unavailable) return null;
    const l = this.legacy();
    if (!l.rows) return null;
    return legacyRegistry(l.rows, m.branch, l.role, new Date().toISOString());
  }
  /** Closes every device dialog (logout, branch reset). */
  close() {
    this.pairingDialog?.close();
    document.querySelectorAll<HTMLDialogElement>('.device-dialog').forEach((d) => d.close());
  }
  /** Called every second while the page is visible: countdowns and code expiry. */
  tick() {
    this.model.tick();
    const p = this.model.pairing;
    const now = this.model.now();
    this.pairingDialog
      ?.querySelectorAll<HTMLElement>('[data-countdown]')
      .forEach((n) => (n.textContent = countdown(p?.expiresAt ?? null, now)));
  }
  /** Keeps the pairing dialog in step with the model without disturbing typed input. */
  sync() {
    const p = this.model.pairing;
    if (!p) {
      if (this.pairingDialog) {
        const d = this.pairingDialog;
        this.pairingDialog = null;
        d.close();
      }
      return;
    }
    if (!this.pairingDialog) {
      this.reason = '';
      this.name = p.name;
      this.pairingStage = '';
      this.pairingDialog = dialog(
        'Подключить iPad',
        'Киоск подключается одноразовым логином и паролем. Они действуют 30 минут и показываются один раз.',
        'device-pairing',
        () => {
          this.pairingDialog = null;
          if (this.model.pairing) this.model.closePairing();
        },
      );
    }
    const stage = p.stage === 'issuing' ? 'form' : p.stage;
    if (stage !== this.pairingStage) {
      this.pairingStage = stage;
      this.pairingBody(this.pairingDialog);
    }
    const d = this.pairingDialog;
    const error = d.querySelector<HTMLElement>('.op-form-error');
    if (error) error.textContent = p.error;
    const submit = d.querySelector<HTMLButtonElement>('[data-testid="device-pairing-issue"]');
    if (submit) {
      submit.disabled = p.stage === 'issuing';
      submit.textContent = p.stage === 'issuing' ? 'Выпускаем…' : 'Выпустить данные для входа';
    }
  }
  private pairingBody(d: HTMLDialogElement) {
    const p = this.model.pairing!;
    d.querySelector('.device-pairing-body')?.remove();
    const body = el('div', 'device-pairing-body');
    d.append(body);
    if (p.stage === 'form' || p.stage === 'issuing') {
      if (!p.deviceId)
        body.append(
          field('Название киоска', this.name, (v) => (this.name = v), {
            id: 'device-pairing-name',
            max: 64,
            required: true,
            hint: 'Так киоск будет подписан в кабинете, например «iPad у входа».',
          }),
        );
      else body.append(hint(`Новый код для «${p.name}». Прежний открытый код будет отменён.`));
      body.append(
        field('Причина', this.reason, (v) => (this.reason = v), {
          id: 'device-pairing-reason',
          max: 500,
          required: true,
          multiline: true,
          hint: 'Попадёт в журнал устройства. От 3 до 500 символов.',
        }),
        errorLine(),
      );
      const actionsRow = el('div', 'device-dialog-actions');
      actionsRow.append(
        button(
          'Выпустить данные для входа',
          () => void this.model.issue(this.name, this.reason),
          'button primary',
          'device-pairing-issue',
        ),
      );
      body.append(actionsRow);
      return;
    }
    if (p.stage === 'code') {
      const secret = el('div', 'device-secret');
      secret.dataset.testid = 'device-pairing-secret';
      const pair = (label: string, value: string, id: string) => {
        const row = el('div', 'device-secret-row');
        const v = el('output', 'device-secret-value', value);
        v.dataset.testid = id;
        row.append(el('span', 'device-secret-label', label), v);
        return row;
      };
      if (p.login && p.password)
        secret.append(
          pair('Логин', p.login, 'device-pairing-login'),
          pair('Пароль', p.password, 'device-pairing-password'),
        );
      if (p.code) secret.append(pair('Код', p.code, 'device-pairing-code'));
      const timer = el('p', 'device-timer');
      const left = el('strong', '', countdown(p.expiresAt, this.model.now()));
      left.dataset.countdown = '';
      left.dataset.testid = 'device-pairing-countdown';
      timer.append(
        document.createTextNode('Действует ещё '),
        left,
        document.createTextNode(p.expiresAt ? ` - до ${clock(p.expiresAt)}` : ''),
      );
      const steps = el('ol', 'device-steps');
      for (const s of [
        'На iPad откройте приложение PickChick Kiosk.',
        'На экране подключения введите логин и пароль.',
        'Дождитесь меню киоска. Здесь появится «iPad подключён».',
      ])
        steps.append(el('li', '', s));
      const status = el('p', 'device-waiting', 'Ожидаем подключения iPad…');
      status.setAttribute('role', 'status');
      const row = el('div', 'device-dialog-actions');
      row.append(
        button(
          'Отменить код',
          () => {
            if (p.deviceId && p.codeId) void this.model.cancelCode(p.deviceId, p.codeId);
          },
          'button subtle',
          'device-pairing-cancel',
        ),
      );
      body.append(
        secret,
        timer,
        hint(
          'Данные показываются один раз. После закрытия окна их нельзя посмотреть снова - только выпустить новые.',
          'warn',
        ),
        steps,
        status,
        errorLine(),
        row,
      );
      return;
    }
    const outcome: Record<string, [string, string, string]> = {
      paired: ['good', 'iPad подключён', 'Киоск появился в списке устройств точки.'],
      expired: [
        'bad',
        'Срок действия истёк',
        'Данные для входа больше не действуют. Выпустите новые.',
      ],
      cancelled: ['muted', 'Код отменён', 'Данные для входа больше не действуют.'],
    };
    const [tone, title, text] = outcome[p.stage] ?? ['muted', '', ''];
    const box = el('div', 'device-outcome ' + tone);
    box.setAttribute('role', 'status');
    box.dataset.testid = 'device-pairing-' + p.stage;
    box.append(el('strong', '', title), el('span', '', text));
    const row = el('div', 'device-dialog-actions');
    const device = this.model.device(p.deviceId);
    if (p.stage === 'expired' && device?.status === 'pending')
      row.append(
        button(
          'Выпустить новые данные',
          () => {
            this.model.startPairing(device);
          },
          'button primary',
          'device-pairing-again',
        ),
      );
    row.append(button('Готово', () => d.close(), 'button', 'device-pairing-finish'));
    body.append(box, row);
  }
  render(content: HTMLElement, branchName: string) {
    const m = this.model;
    const r = this.registry();
    const wrap = el('div', 'devices');
    wrap.dataset.testid = 'devices';
    content.append(wrap);
    const head = el('div', 'devices-head');
    const titles = el('div', 'devices-titles');
    titles.append(el('h2', '', branchName ? `Устройства - ${branchName}` : 'Устройства точки'));
    titles.append(
      el(
        'p',
        'muted',
        r
          ? `Данные на ${clock(r.as_of)}. «На связи» - обмен за последние 2 минуты.`
          : 'Касса, киоски, экраны кухни и табло выбранной точки.',
      ),
    );
    head.append(titles);
    if (canPair(r)) {
      const pair = button(
        'Подключить iPad',
        () => m.startPairing(),
        'button primary',
        'devices-pair',
      );
      pair.disabled = Boolean(m.pairing);
      head.append(pair);
    }
    wrap.append(head);
    if (m.notice) {
      const n = el('div', 'notice', m.notice);
      n.setAttribute('role', 'status');
      wrap.append(n);
    }
    if (m.error) {
      const n = el('div', 'notice error', m.error);
      n.setAttribute('role', 'alert');
      n.append(button('Повторить', () => void m.load(), 'button subtle', 'devices-retry'));
      wrap.append(n);
    }
    if (!r) {
      if (!m.error) wrap.append(el('p', 'device-loading', 'Загружаем устройства…'));
      return;
    }
    if (r.source === 'legacy') {
      const n = el(
        'div',
        'notice',
        'Реестр устройств на сервере ещё не включён. Показан прежний список без действий: отключать устройства из кабинета пока нельзя.',
      );
      n.setAttribute('role', 'status');
      n.dataset.testid = 'devices-legacy';
      wrap.append(n);
    } else if (r.role !== 'manager')
      wrap.append(hint('Режим просмотра: действия с устройствами доступны управляющему точки.'));
    const now = m.now();
    const s = summary(r, now);
    const totals = el('dl', 'devices-summary');
    totals.dataset.testid = 'devices-summary';
    for (const [label, value, cls] of [
      ['Подключено', s.online, 'good'],
      ['Требуют внимания', s.attention, s.attention ? 'bad' : ''],
      ['Ожидают подключения', s.pending, s.pending ? 'wait' : ''],
    ] as const) {
      const item = el('div', ('devices-total ' + cls).trim());
      item.append(el('dt', '', label), el('dd', '', String(value)));
      totals.append(item);
    }
    wrap.append(totals);
    for (const g of groupDevices(r.devices)) {
      const section = el('section', 'device-group');
      section.dataset.testid = 'device-group-' + g.id;
      section.setAttribute('aria-labelledby', 'device-group-title-' + g.id);
      const gh = el('div', 'device-group-head');
      const title = el('h3', '', g.title);
      title.id = 'device-group-title-' + g.id;
      gh.append(title, el('span', 'device-count', String(g.current.length)));
      section.append(gh, el('p', 'device-group-hint', g.hint));
      if (g.id === 'kiosk' && r.source === 'registry' && !r.kiosk_supported)
        section.append(hint('Киоск для этой точки пока не настроен.', 'warn'));
      const grid = el('div', 'device-grid');
      for (const d of g.current) grid.append(this.card(d, r, now));
      if (!g.current.length)
        grid.append(
          el(
            'p',
            'device-empty',
            g.id === 'cashier' || g.id === 'kiosk'
              ? 'Устройств этого типа нет.'
              : 'Экраны пока не зарегистрированы в облаке. Они подключаются на кассе точки.',
          ),
        );
      section.append(grid);
      if (g.revoked.length) {
        const old = el('details', 'device-revoked');
        old.append(el('summary', '', `Отозванные (${g.revoked.length})`));
        for (const d of g.revoked) {
          const row = el('div', 'device-revoked-row');
          row.append(
            el('span', '', d.name),
            el('span', 'muted', d.revoked_at ? `отозвано ${exact(d.revoked_at)}` : 'отозвано'),
          );
          old.append(row);
        }
        section.append(old);
      }
      wrap.append(section);
    }
  }
  private card(d: Device, r: Registry, now: number) {
    const state = presence(d, now);
    const card = el('article', 'device-card');
    card.dataset.testid = 'device-' + d.id;
    card.dataset.tone = state.tone;
    const head = el('header', 'device-card-head');
    const titles = el('div', 'device-card-title');
    titles.append(el('h4', '', d.name), el('span', 'muted', ROLE_LABELS[d.role]));
    const badge = el('span', 'device-status ' + state.tone);
    badge.dataset.testid = 'device-status-' + d.id;
    badge.append(el('span', 'device-dot'), document.createTextNode(state.label));
    head.append(icon(d.role), titles, badge);
    card.append(head);
    const facts = el('dl', 'device-facts');
    facts.append(
      fact(
        'Последняя связь',
        relative(d.last_seen_at, now),
        '',
        d.last_seen_at ? exact(d.last_seen_at) : '',
      ),
      fact('Версия', d.app_version ?? '-'),
    );
    const key = credentialState(d.credential_expires_at, now);
    if (key && d.credential_expires_at)
      facts.append(
        fact(
          'Ключ облака',
          key === 'expired' ? 'истёк' : `до ${day(d.credential_expires_at)}`,
          key === 'ok' ? '' : key === 'warn' ? 'warn' : 'bad',
          exact(d.credential_expires_at),
        ),
      );
    if (d.open_code)
      facts.append(
        fact(
          'Код подключения',
          codeExpired(d, now) ? 'просрочен' : `до ${clock(d.open_code.expires_at)}`,
          codeExpired(d, now) ? 'bad' : '',
        ),
      );
    card.append(facts);
    if (d.payment_open)
      card.append(
        hint('Идёт оплата Kaspi. Отключить киоск можно только после закрытия платежа.', 'warn'),
      );
    if (d.role === 'edge') card.append(hint(EDGE_HINT));
    if (['pos', 'kitchen_prep', 'kitchen_assembly', 'board'].includes(d.role))
      card.append(hint(STAFF_RESET_HINT));
    const list = actions(d, r);
    if (list.length) {
      const row = el('div', 'device-actions');
      for (const a of list) {
        if (a === 'code')
          row.append(
            button(
              'Новый код подключения',
              () => this.model.startPairing(d),
              'button subtle',
              'device-code-' + d.id,
            ),
          );
        if (a === 'cancel_code' && d.open_code) {
          const codeId = d.open_code.id;
          row.append(
            button(
              'Отменить код',
              () => void this.model.cancelCode(d.id, codeId),
              'button subtle',
              'device-cancel-code-' + d.id,
            ),
          );
        }
        if (a === 'rename')
          row.append(
            button(
              'Переименовать',
              () => this.renameDialog(d),
              'button subtle',
              'device-rename-' + d.id,
            ),
          );
        if (a === 'journal')
          row.append(
            button('Журнал', () => this.journal(d), 'button subtle', 'device-journal-' + d.id),
          );
        if (a === 'revoke')
          row.append(
            button(
              'Отключить',
              () => this.revokeDialog(d),
              'button subtle danger',
              'device-revoke-' + d.id,
            ),
          );
      }
      card.append(row);
    }
    return card;
  }
  private revokeDialog(d: Device) {
    const box = dialog(
      'Отключить устройство',
      `«${d.name}» сразу потеряет доступ к заказам и оплате. Вернуть доступ нельзя: чтобы снова подключить этот iPad, подключите его как новое устройство и переустановите приложение киоска.`,
      'device-revoke-dialog',
    );
    let reason = '',
      typed = '';
    const submit = button(
      'Отключить устройство',
      async () => {
        submit.disabled = true;
        const result = await this.model.revoke(d, reason, typed);
        error.textContent = result;
        if (!result) box.close();
        else submit.disabled = false;
      },
      'button primary danger',
      'device-revoke-confirm',
    );
    const update = () => {
      submit.disabled = !reasonValid(reason) || !sameName(typed, d);
    };
    const error = errorLine();
    const actionsRow = el('div', 'device-dialog-actions');
    actionsRow.append(submit);
    box.append(
      field(
        'Причина',
        '',
        (v) => {
          reason = v;
          update();
        },
        {
          id: 'device-revoke-reason',
          max: 500,
          required: true,
          multiline: true,
          hint: 'От 3 до 500 символов. Попадёт в журнал устройства.',
        },
      ),
      field(
        `Для подтверждения введите название: ${d.name}`,
        '',
        (v) => {
          typed = v;
          update();
        },
        { id: 'device-revoke-name', max: 120, required: true },
      ),
      error,
      actionsRow,
    );
    update();
  }
  private renameDialog(d: Device) {
    const box = dialog(
      'Переименовать устройство',
      'Новое название увидят все управляющие точки.',
      'device-rename-dialog',
    );
    let name = d.name,
      reason = '';
    const error = errorLine();
    const submit = button(
      'Сохранить',
      async () => {
        submit.disabled = true;
        const result = await this.model.rename(d, name, reason);
        error.textContent = result;
        if (!result) box.close();
        else submit.disabled = false;
      },
      'button primary',
      'device-rename-confirm',
    );
    const update = () => {
      submit.disabled = !nameValid(name) || !reasonValid(reason) || name.trim() === d.name;
    };
    const row = el('div', 'device-dialog-actions');
    row.append(submit);
    box.append(
      field(
        'Название',
        name,
        (v) => {
          name = v;
          update();
        },
        { id: 'device-rename-name', max: 64, required: true },
      ),
      field(
        'Причина',
        '',
        (v) => {
          reason = v;
          update();
        },
        { id: 'device-rename-reason', max: 500, required: true, multiline: true },
      ),
      error,
      row,
    );
    update();
  }
  private journal(d: Device) {
    const box = dialog(`Журнал: ${d.name}`, 'Последние 50 событий устройства.', 'device-journal');
    const list = el('ol', 'device-events');
    list.append(el('li', 'device-loading', 'Загружаем журнал…'));
    box.append(list);
    this.model.events(d).then(
      (events) => {
        list.replaceChildren();
        if (!events.length) list.append(el('li', 'device-empty', 'Событий пока нет.'));
        for (const e of events) {
          const li = el('li', 'device-event');
          li.append(
            el('time', '', exact(e.at)),
            el('strong', '', EVENT_LABELS[e.action] ?? e.action),
          );
          if (e.reason) li.append(el('span', 'muted', e.reason));
          list.append(li);
        }
      },
      (e: unknown) => {
        list.replaceChildren(el('li', 'notice error', explain(e)));
      },
    );
  }
}
