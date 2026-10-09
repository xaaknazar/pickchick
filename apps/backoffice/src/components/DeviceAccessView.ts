import { element as el, button, field, select } from '../dom.js';
import { message } from '../api.js';
import { DevicesModel, deviceStatus, type DeviceRow } from '../devices-model.js';
const modes = [
  { value: 'prep', label: 'Кухня - приготовление' },
  { value: 'assembly', label: 'Кухня - сборка' },
  { value: 'display', label: 'Табло / LED' },
];
const date = (v: string | null) =>
  v ? new Date(v).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }) : 'Нет данных';
function modal(title: string) {
  const d = el('dialog', 'op-dialog');
  d.append(el('h2', '', title));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
/** Component owns all visual classes. Callers supply the model, never appearance overrides. */
export class DeviceAccessView {
  constructor(private readonly model: DevicesModel) {}
  render(target: HTMLElement) {
    const m = this.model,
      panel = el('section', 'panel op-panel');
    const heading = el('div', 'panel-head');
    heading.append(el('h2', '', 'Подключённые экраны'));
    if (m.data?.role === 'manager')
      heading.append(button('Подключить экран', () => this.pair(), 'button primary', 'device-add'));
    panel.append(
      heading,
      el(
        'p',
        'muted',
        'Кухня и сборка работают через локальную кассу. Табло показывает номера заказов без доступа к их изменению.',
      ),
    );
    if (m.error) {
      const notice = el(
        'p',
        'notice error',
        m.uncertain
          ? 'Ответ не получен. Проверьте список устройств перед выпуском нового кода. Повтор автоматически не отправляется.'
          : message(m.error),
      );
      notice.setAttribute('role', 'alert');
      panel.append(notice);
      panel.append(
        button(
          'Обновить устройства',
          () => void m.load(m.actor, m.branch),
          'button',
          'device-refresh',
        ),
      );
    }
    if (m.code && Date.parse(m.code.expires_at) <= Date.now()) m.hideCode();
    if (m.code) {
      const code = el('section', 'notice');
      code.setAttribute('aria-label', 'Код подключения');
      code.append(
        el(
          'h3',
          '',
          m.code.purpose === 'kitchen-password-reset'
            ? 'Код восстановления пароля кухни'
            : 'Введите код на нужном экране',
        ),
        el('code', '', m.code.code),
        el(
          'p',
          '',
          `Код действует до ${date(m.code.expires_at)}. Показывается только сейчас. Не передавайте его посторонним.`,
        ),
      );
      code.append(
        button(
          'Скрыть код',
          () => {
            m.hideCode();
            code.remove();
          },
          'button',
        ),
      );
      panel.append(code);
    }
    if (!m.data) {
      panel.append(
        el(
          'p',
          'muted',
          m.error
            ? 'Подключение экранов пока недоступно. Действующие устройства не изменены.'
            : 'Загружаем устройства…',
        ),
      );
      target.append(panel);
      return;
    }
    const reset = el('section', 'op-panel');
    reset.append(
      el('h3', '', 'Пароль кухни и сборки'),
      el(
        'p',
        'muted',
        'Для общего входа kitchen. Управляющий выдаёт одноразовый код, а новый пароль сотрудник вводит на подключённом экране кухни или сборки. Старые входы завершатся, личные PIN кассы не меняются.',
      ),
    );
    if (m.data.password_reset)
      reset.append(
        el(
          'p',
          'op-badge',
          m.data.password_reset.state === 'used'
            ? 'Пароль изменён'
            : m.data.password_reset.state === 'applied'
              ? 'Код готов на кассе'
              : m.data.password_reset.state === 'rejected'
                ? 'Сброс отклонён кассой'
                : Date.parse(m.data.password_reset.expires_at) <= Date.now()
                  ? 'Код истёк'
                  : 'Ждём кассу',
        ),
      );
    if (m.data.role === 'manager') {
      const b = button('Восстановить пароль кухни', () => this.resetPassword(), 'button');
      b.disabled = m.busy;
      reset.append(b);
    }
    reset.append(button('Журнал восстановления', () => void this.resetHistory(), 'button subtle'));
    panel.append(reset);
    const groups: [string, (d: DeviceRow) => boolean][] = [
      ['Касса и моноблок', (d) => ['edge', 'pos'].includes(d.kind)],
      ['Киоски iPad', (d) => d.kind === 'kiosk'],
      ['Кухня - приготовление', (d) => d.mode === 'prep' || (d.kind === 'kitchen' && !d.mode)],
      ['Кухня - сборка', (d) => d.mode === 'assembly'],
      ['Табло / LED', (d) => d.kind === 'display'],
    ];
    for (const [title, match] of groups) {
      const rows = m.data.devices.filter(match);
      const group = el('section');
      group.append(el('h3', '', title));
      if (!rows.length) group.append(el('p', 'muted', 'Устройства не подключены.'));
      for (const device of rows) group.append(this.row(device));
      panel.append(group);
    }
    target.append(panel);
  }
  private row(d: DeviceRow) {
    const row = el('article', 'op-panel');
    row.append(el('h4', '', d.name), el('p', 'op-badge', deviceStatus(d)));
    if (d.kind === 'edge')
      row.append(
        el(
          'p',
          'muted',
          `Последний ответ кассы: ${date(d.last_seen_at)}. Ключ облака действует до ${date(d.key_expires_at)}.`,
        ),
        el(
          'p',
          'muted',
          'Замена кассы выполняется по процедуре переноса точки. Отключение здесь недоступно.',
        ),
      );
    else if (d.kind === 'kiosk')
      row.append(
        el(
          'p',
          'muted',
          'Существующая привязка iPad сохранена. Изменение доступа киоска выполняется отдельно от настройки экранов кухни.',
        ),
      );
    else if (!d.mode)
      row.append(
        el(
          'p',
          'muted',
          'Устройство подключено прежним способом. Для нового экрана выпустите отдельный код.',
        ),
      );
    if (d.mode) {
      const actions = el('div', 'op-actions');
      actions.append(button('Журнал', () => void this.history(d), 'button subtle'));
      if (this.model.data?.role === 'manager' && d.status !== 'revoked') {
        const pair = button('Новый код', () => this.pair(d), 'button');
        pair.disabled = this.model.busy;
        const revoke = button('Отключить', () => this.revoke(d), 'button danger');
        revoke.disabled = this.model.busy;
        actions.append(pair, revoke);
      }
      row.append(actions);
    }
    return row;
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
