import { element as el, button, field, select } from '../dom.js';
import { message } from '../api.js';
import { DevicesModel, deviceStatus, deviceConnection, type DeviceRow } from '../devices-model.js';
const modes = [
  { value: 'prep', label: 'Кухня - приготовление' },
  { value: 'assembly', label: 'Кухня - сборка' },
  { value: 'display', label: 'Табло / LED' },
];
const date = (v: string | null) =>
  v ? new Date(v).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }) : 'Нет данных';
function modal(title: string) {
  const d = el('dialog', 'op-dialog device-dialog');
  const heading = el('h2', '', title);
  heading.id = 'device-dialog-' + crypto.randomUUID();
  d.setAttribute('aria-labelledby', heading.id);
  d.append(heading);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
/** Component owns all visual classes. Callers supply the model, never appearance overrides. */
export class DeviceAccessView {
  constructor(private readonly model: DevicesModel) {}
  private search = '';
  private inventoryEditor: HTMLElement | null = null;
  private target: HTMLElement | null = null;
  private editorScope = '';

  private show = 'active';
  render(target: HTMLElement) {
    this.target = target;
    const scope = this.model.actor + ':' + this.model.branch;
    if (this.editorScope && this.editorScope !== scope) {
      this.inventoryEditor?.remove();
      this.inventoryEditor = null;
    }
    const m = this.model,
      panel = el('section', 'panel device-center');
    const heading = el('div', 'device-heading');
    const intro = el('div');
    intro.append(
      el('h2', '', 'Устройства точки'),
      el('p', 'muted', 'Подключение, состояние приложений и оборудование ресторана'),
    );
    const actions = el('div', 'op-actions');
    if (m.data?.role === 'manager') {
      if (m.data.pairing_enabled !== false)
        actions.append(
          button('Подключить экран', () => this.pair(), 'button primary', 'device-add'),
        );
      if (m.data.inventory_enabled)
        actions.append(
          button('Добавить телевизор', () => this.editInventory(), 'button', 'device-tv-add'),
        );
    }
    actions.append(
      button('Проверить связь', () => void m.load(m.actor, m.branch), 'button', 'device-refresh'),
    );
    heading.append(intro, actions);
    panel.append(heading);
    if (this.inventoryEditor) panel.append(this.inventoryEditor);
    if (m.error) {
      const notice = el(
        'p',
        'notice error',
        m.uncertain
          ? 'Ответ не получен. Проверьте список перед повтором. Для карточки оборудования можно повторить сохранение того же ввода.'
          : message(m.error),
      );
      notice.setAttribute('role', 'alert');
      panel.append(notice);
    }
    if (!m.data) {
      panel.append(
        el(
          'p',
          'muted',
          m.error
            ? 'Нет актуальных данных об устройствах. Проверьте соединение и повторите проверку.'
            : 'Загружаем устройства…',
        ),
      );
      target.append(panel);
      return;
    }
    if (m.data.pairing_enabled === false)
      panel.append(
        el(
          'p',
          'notice',
          'Список устройств доступен. Подключение новых экранов кухни требует завершения настройки кассы. Действующие привязки сохранены.',
        ),
      );
    if (m.code && Date.parse(m.code.expires_at) <= m.now()) m.hideCode();
    if (m.code) {
      const code = el('section', 'device-code');
      code.setAttribute('aria-label', 'Код подключения');
      code.append(
        el(
          'h3',
          '',
          m.code.purpose === 'kitchen-password-reset'
            ? 'Код восстановления пароля кухни'
            : 'Код для нового экрана',
        ),
        el('code', '', m.code.code),
        el(
          'p',
          'muted',
          `Действует до ${date(m.code.expires_at)}. Введите его в PickChick на нужном экране.`,
        ),
      );
      const copy = button(
        'Скопировать код',
        () =>
          void navigator.clipboard
            .writeText(m.code?.code ?? '')
            .then(() => {
              copy.textContent = 'Скопировано';
            })
            .catch(() => {
              copy.textContent = 'Выделите и скопируйте код';
            }),
        'button',
      );
      code.append(
        copy,
        button(
          'Скрыть код',
          () => {
            m.hideCode();
            code.remove();
          },
          'button subtle',
        ),
      );
      panel.append(code);
    }
    const controls = el('div', 'device-filters');
    const rows: { node: HTMLTableRowElement; device: DeviceRow }[] = [];
    const apply = () => {
      let count = 0;
      for (const r of rows) {
        const d = r.device;
        const text = [d.name, d.location, d.notes, d.kind].join(' ').toLocaleLowerCase('ru');
        const state = deviceConnection(d, m.now());
        r.node.hidden = !(
          text.includes(this.search.toLocaleLowerCase('ru')) &&
          (this.show === 'archived'
            ? !!d.archived
            : this.show === 'attention'
              ? !d.archived && state.tone === 'warning'
              : !d.archived)
        );
        if (!r.node.hidden) count++;
      }
      empty.hidden = count > 0;
    };
    controls.append(
      field(
        'Найти устройство',
        this.search,
        (v) => {
          this.search = v;
          apply();
        },
        { id: 'device-search', hint: 'Название или место установки' },
      ),
      select(
        'Показать',
        this.show,
        [
          { value: 'active', label: 'Все действующие' },
          { value: 'attention', label: 'Требуют внимания' },
          { value: 'archived', label: 'Архив оборудования' },
        ],
        (v) => {
          this.show = v;
          apply();
        },
      ),
    );
    panel.append(controls);
    const wrap = el('div', 'device-table-wrap'),
      table = el('table', 'device-table'),
      head = el('thead'),
      hr = el('tr');
    for (const label of ['Устройство', 'Состояние', 'Последний ответ', 'Действия']) {
      const th = el('th', '', label);
      th.scope = 'col';
      hr.append(th);
    }
    head.append(hr);
    table.append(head);
    const body = el('tbody');
    for (const d of m.data.devices) {
      const node = this.row(d);
      rows.push({ node, device: d });
      body.append(node);
    }
    table.append(body);
    wrap.append(table);
    panel.append(wrap);
    const empty = el('p', 'device-empty', 'По выбранным условиям устройств нет.');
    panel.append(empty);
    apply();
    const footer = el(
      'p',
      'muted device-footnote',
      `Последняя проверка: ${date(m.data.as_of)}. Статус приложения не подтверждает питание самого дисплея.`,
    );
    panel.append(footer);
    if (m.data.pairing_enabled !== false) {
      const reset = el('details', 'device-help'),
        summary = el('summary', '', 'Доступ кухни и история восстановления');
      reset.append(
        summary,
        el(
          'p',
          'muted',
          'Привязка экрана и вход сотрудника независимы. Восстановление пароля kitchen не меняет личные PIN кассы.',
        ),
      );
      if (m.data.password_reset)
        reset.append(
          el(
            'p',
            '',
            `Последний запрос: ${m.data.password_reset.state === 'used' ? 'Пароль изменён' : m.data.password_reset.state === 'applied' ? 'Код готов на кассе' : Date.parse(m.data.password_reset.expires_at) <= m.now() ? 'Код истёк' : 'Ожидает подтверждения кассы'}`,
          ),
        );
      if (m.data.role === 'manager')
        reset.append(button('Восстановить пароль кухни', () => this.resetPassword(), 'button'));
      reset.append(
        button('Журнал восстановления', () => void this.resetHistory(), 'button subtle'),
      );
      panel.append(reset);
    }
    target.append(panel);
  }
  private row(d: DeviceRow) {
    const row = el('tr'),
      name = el('td'),
      status = el('td'),
      seen = el('td'),
      actions = el('td');
    const kinds: Record<string, string> = {
      edge: 'Кассовый моноблок / локальный сервер',
      pos: 'Кассовое приложение',
      kiosk: 'Киоск iPad',
      kitchen: 'Кухня',
      display: 'Табло номеров',
      usb_tv: 'Телевизор с USB',
    };
    name.append(
      el('strong', '', d.name),
      el(
        'span',
        'muted',
        d.mode
          ? (modes.find((m) => m.value === d.mode)?.label ?? d.mode)
          : (kinds[d.kind] ?? d.kind),
      ),
    );
    if (d.location) name.append(el('span', 'muted', d.location));
    const state = deviceConnection(d, this.model.now());
    status.append(
      el('span', `device-status ${state.tone}`, state.label),
      el('p', 'muted', state.detail),
    );
    const last = d.kind === 'edge' ? d.last_seen_at : (d.presence?.observed_at ?? null);
    seen.append(el('span', '', d.kind === 'usb_tv' ? 'Не передаётся' : date(last)));
    if (d.presence?.app_version)
      seen.append(el('span', 'muted', `Версия ${d.presence.app_version}`));
    if (d.presence?.menu_version)
      seen.append(el('span', 'muted', `Меню v${d.presence.menu_version}`));
    if (d.mode) seen.append(el('span', 'muted', `Привязка: ${deviceStatus(d, this.model.now())}`));
    const buttons = el('div', 'op-actions');
    if (this.model.data?.inventory_enabled) {
      if (this.model.data.role === 'manager')
        buttons.append(button('Изменить', () => this.editInventory(d), 'button subtle'));
      buttons.append(
        button('История карточки', () => void this.inventoryHistory(d), 'button subtle'),
      );
    }
    if (d.mode) {
      buttons.append(button('История доступа', () => void this.history(d), 'button subtle'));
      if (this.model.data?.role === 'manager' && this.model.data.pairing_enabled !== false) {
        const pair = button(
          d.status === 'revoked' ? 'Подключить снова' : 'Новый код',
          () => this.pair(d),
          'button',
        );
        pair.disabled = this.model.busy;
        buttons.append(pair);
        if (d.status !== 'revoked') {
          const revoke = button('Отключить', () => this.revoke(d), 'button danger');
          revoke.disabled = this.model.busy;
          buttons.append(revoke);
        }
      }
    }
    if (d.kind === 'edge')
      buttons.append(el('span', 'muted', 'Перенос основной кассы выполняется отдельно.'));
    if (d.kind === 'kiosk')
      buttons.append(el('span', 'muted', 'Действующая регистрация iPad сохранена.'));
    actions.append(buttons);
    for (const [cell, label] of [
      [name, 'Устройство'],
      [status, 'Состояние'],
      [seen, 'Последний ответ'],
      [actions, 'Действия'],
    ] as const) {
      cell.dataset['label'] = label;
      row.append(cell);
    }
    return row;
  }
  private editInventory(device?: DeviceRow) {
    this.inventoryEditor?.remove();
    const dialog = el('section', 'device-editor');
    this.inventoryEditor = dialog;
    this.editorScope = this.model.actor + ':' + this.model.branch;
    const title = el('h3', '', device ? 'Карточка устройства' : 'Телевизор с USB');
    title.id = 'device-editor-title';
    dialog.setAttribute('aria-labelledby', title.id);
    dialog.append(title);
    const close = () => {
      dialog.remove();
      if (this.inventoryEditor === dialog) this.inventoryEditor = null;
    };
    const id = device?.id ?? crypto.randomUUID();
    let name = device?.name ?? '',
      location = device?.location ?? '',
      notes = device?.notes ?? '',
      reason = '',
      archived = device?.archived ?? false;
    dialog.append(
      el(
        'p',
        'muted',
        device?.kind === 'usb_tv' || !device
          ? 'Карточка оборудования. USB-воспроизведение не передаёт состояние телевизора.'
          : 'Название и место установки меняются без изменения ключей и прав устройства.',
      ),
    );
    dialog.append(
      field(
        'Название',
        name,
        (v) => {
          name = v;
        },
        { required: true, max: 120, id: 'inventory-device-name' },
      ),
      field(
        'Место установки',
        location,
        (v) => {
          location = v;
        },
        { max: 120, id: 'inventory-device-location' },
      ),
      field(
        'Примечание',
        notes,
        (v) => {
          notes = v;
        },
        { max: 500, id: 'inventory-device-notes' },
      ),
      field(
        'Причина изменения',
        reason,
        (v) => {
          reason = v;
        },
        { required: true, max: 500, id: 'inventory-device-reason' },
      ),
    );
    if (device?.kind === 'usb_tv')
      dialog.append(
        select(
          'Карточка',
          archived ? 'archived' : 'active',
          [
            { value: 'active', label: 'Используется' },
            { value: 'archived', label: 'В архиве' },
          ],
          (v) => {
            archived = v === 'archived';
          },
        ),
      );
    const error = el('p', 'notice error');
    error.setAttribute('role', 'alert');
    dialog.append(error);
    const save = button(
      'Сохранить',
      () =>
        void (async () => {
          if (!name.trim() || reason.trim().length < 3) {
            error.textContent = 'Укажите название и причину.';
            return;
          }
          save.disabled = true;
          try {
            const ok = await this.model.saveInventory({
              id,
              kind: device && device.kind !== 'usb_tv' ? 'registered' : 'usb_tv',
              expected_revision: device?.inventory_revision ?? 0,
              name: name.trim(),
              location: location.trim(),
              notes: notes.trim(),
              archived,
              reason: reason.trim(),
            });
            if (ok) close();
            else error.textContent = message(this.model.error);
          } finally {
            save.disabled = false;
          }
        })(),
      'button primary',
      'inventory-device-save',
    );
    const actions = el('div', 'op-actions');
    actions.append(save, button('Отмена', close, 'button'));
    dialog.append(actions);
    this.target?.querySelector('.device-heading')?.after(dialog);
    dialog.querySelector<HTMLInputElement>('input')?.focus();
  }
  private async inventoryHistory(device: DeviceRow) {
    const dialog = modal(`История карточки: ${device.name}`);
    try {
      const events = await this.model.inventoryHistory(device.id);
      if (!events.length) dialog.append(el('p', 'muted', 'Карточка ещё не изменялась.'));
      for (const e of events) {
        const after = e['after_state'] as Record<string, unknown>,
          before = (e['before_state'] ?? {}) as Record<string, unknown>;
        const entry = el('section', 'device-history-entry');
        entry.append(
          el('h3', '', `${date(String(e['at']))}: ${String(e['reason'])}`),
          el(
            'p',
            'muted',
            `Редакция ${String(after['revision'])}. Автор: ${String(e['actor_id'])}`,
          ),
        );
        for (const [key, label] of [
          ['name', 'Название'],
          ['location', 'Место установки'],
          ['notes', 'Примечание'],
          ['archived', 'Архив'],
        ] as const) {
          if (before[key] !== after[key])
            entry.append(
              el('p', '', `${label}: ${String(before[key] ?? '-')} → ${String(after[key] ?? '-')}`),
            );
        }
        dialog.append(entry);
      }
    } catch {
      dialog.append(
        el('p', 'notice error', 'Не удалось загрузить историю. Закройте окно и повторите.'),
      );
    }
    dialog.append(button('Закрыть', () => dialog.close(), 'button'));
  }
  private pair(device?: DeviceRow) {
    const d = modal(device ? 'Новый код для экрана' : 'Подключить экран');
    let name = device?.name ?? '',
      mode = device?.mode ?? 'prep',
      reason = '',
      confirmation = '';
    if (!device)
      d.append(
        select('Назначение', mode, modes, (v) => {
          mode = v;
        }),
        field(
          'Название экрана',
          name,
          (v) => {
            name = v;
          },
          { required: true, max: 120, id: 'device-name' },
        ),
      );
    else
      d.append(
        el(
          'p',
          '',
          `После получения нового кода касса отключит прежнюю привязку «${name}». Потребуется снова ввести код на этом экране.`,
        ),
        field(
          'Введите название экрана',
          '',
          (v) => {
            confirmation = v;
          },
          { required: true, max: 120, hint: name },
        ),
      );
    d.append(
      field(
        'Причина подключения',
        '',
        (v) => {
          reason = v;
        },
        { required: true, max: 500, id: 'device-reason' },
      ),
    );
    const error = el('p', 'notice error');
    error.setAttribute('role', 'alert');
    d.append(error);
    const send = button(
      'Выпустить код',
      () =>
        void (async () => {
          if (
            !name.trim() ||
            reason.trim().length < 3 ||
            (device && confirmation.trim() !== name)
          ) {
            error.textContent =
              'Заполните название и причину. При замене подтвердите точное название.';
            return;
          }
          send.disabled = true;
          try {
            if (
              await this.model.issue({
                name: name.trim(),
                mode,
                reason: reason.trim(),
                ...(device ? { device_id: device.id, confirm_name: confirmation.trim() } : {}),
              })
            )
              d.close();
            else error.textContent = message(this.model.error);
          } finally {
            send.disabled = false;
          }
        })(),
      'button primary',
      'device-issue',
    );
    d.append(
      button('Отмена', () => d.close(), 'button'),
      send,
    );
  }
  private revoke(device: DeviceRow) {
    const d = modal('Отключить экран');
    let confirmation = '',
      reason = '';
    d.append(
      el(
        'p',
        '',
        `Касса отключит «${device.name}» после получения команды. Заказы и другие экраны останутся доступны.`,
      ),
      field(
        'Введите название экрана',
        '',
        (v) => {
          confirmation = v;
        },
        { required: true, max: 120, hint: device.name },
      ),
      field(
        'Причина отключения',
        '',
        (v) => {
          reason = v;
        },
        { required: true, max: 500 },
      ),
    );
    const error = el('p', 'notice error');
    error.setAttribute('role', 'alert');
    d.append(error);
    const send = button(
      'Отключить экран',
      () =>
        void (async () => {
          if (confirmation.trim() !== device.name || reason.trim().length < 3) {
            error.textContent = 'Введите точное название и причину.';
            return;
          }
          send.disabled = true;
          try {
            if (
              await this.model.revoke({
                device_id: device.id,
                confirm_name: confirmation.trim(),
                reason: reason.trim(),
              })
            )
              d.close();
            else error.textContent = message(this.model.error);
          } finally {
            send.disabled = false;
          }
        })(),
      'button danger',
    );
    d.append(
      button('Отмена', () => d.close(), 'button'),
      send,
    );
  }
  private resetPassword() {
    const d = modal('Восстановить пароль кухни');
    let login = '',
      reason = '';
    d.append(
      el(
        'p',
        '',
        'Код действует 10 минут и показывается один раз. Введите его на уже подключённом экране кухни или сборки. Новый пароль не передаётся бэкофису.',
      ),
      field(
        'Подтвердите логин',
        '',
        (v) => {
          login = v;
        },
        { required: true, max: 64, hint: 'kitchen' },
      ),
      field(
        'Причина восстановления',
        '',
        (v) => {
          reason = v;
        },
        { required: true, max: 500 },
      ),
    );
    const error = el('p', 'notice error');
    error.setAttribute('role', 'alert');
    d.append(error);
    const send = button(
      'Выдать одноразовый код',
      () =>
        void (async () => {
          if (login !== 'kitchen' || reason.trim().length < 3) {
            error.textContent = 'Введите kitchen и причину восстановления.';
            return;
          }
          send.disabled = true;
          try {
            if (await this.model.resetPassword({ confirm_login: login, reason: reason.trim() }))
              d.close();
            else
              error.textContent =
                'Код не выдан. Если действующий код уже был выпущен, дождитесь его истечения. Ответ неизвестен - проверьте журнал перед повтором.';
          } finally {
            send.disabled = false;
          }
        })(),
      'button primary',
    );
    d.append(
      button('Отмена', () => d.close(), 'button'),
      send,
    );
  }
  private async resetHistory() {
    const d = modal('Журнал восстановления пароля'),
      body = el('div');
    d.append(
      body,
      button('Закрыть', () => d.close(), 'button'),
    );
    try {
      const rows = await this.model.resetHistory();
      if (!d.isConnected) return;
      for (const e of rows)
        body.append(el('p', '', `${date(String(e['at']))} · ${e['action']} · ${e['reason']}`));
      if (!rows.length) body.append(el('p', 'muted', 'Записей пока нет.'));
    } catch (e) {
      body.textContent = message(e);
    }
  }
  private async history(device: DeviceRow) {
    const d = modal(`Журнал: ${device.name}`),
      body = el('div');
    d.append(
      body,
      button('Закрыть', () => d.close(), 'button'),
    );
    try {
      const entries = await this.model.history(device.id);
      if (!d.isConnected) return;
      for (const e of entries)
        body.append(el('p', '', `${date(String(e['at']))} · ${e['action']} · ${e['reason']}`));
      if (!entries.length) body.append(el('p', 'muted', 'Записей пока нет.'));
    } catch (error) {
      if (d.isConnected) body.append(el('p', 'notice error', message(error)));
    }
  }
}
