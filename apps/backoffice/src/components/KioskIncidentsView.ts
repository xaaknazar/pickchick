import { element as el, button, field, select, check } from '../dom.js';
import { message } from '../api.js';
import {
  KioskIncidentsModel,
  incidentAdvice,
  incidentAgeMinutes,
  tenge,
  type KaspiCheck,
  type KioskIncidentCandidate,
} from '../kiosk-incidents-model.js';
const date = (v: string) => new Date(v).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
const short = (id: string) => id.slice(0, 8);
const attemptStates: Record<string, string> = {
  pending: 'ждёт ответа банка',
  unknown: 'результат неизвестен',
  failed: 'банк отклонил',
  succeeded: 'оплата получена',
};
const checks: { value: KaspiCheck; label: string }[] = [
  { value: 'payment_not_found', label: 'В Kaspi Pay оплаты нет' },
  { value: 'payment_found', label: 'В Kaspi Pay оплата есть' },
];
/**
 * Audit 19.10, finding 4.3: «Киоск: неизвестный результат оплаты» on the devices page. A branch
 * manager releases a kiosk stuck on a QR payment whose result is unknown for 15+ minutes and records
 * what Kaspi Pay shows. Nothing here declares the payment paid or failed. The component owns its
 * classes; callers supply only the model.
 */
export class KioskIncidentsView {
  constructor(private readonly model: KioskIncidentsModel) {}
  render(target: HTMLElement) {
    const m = this.model,
      panel = el('section', 'panel device-center');
    panel.dataset.testid = 'kiosk-incidents';
    const heading = el('div', 'device-heading');
    const intro = el('div');
    intro.append(
      el('h2', '', 'Киоск: неизвестный результат оплаты'),
      el(
        'p',
        'muted',
        'Если киоск завис на «Уточняем результат оплаты», проверьте платёж в Kaspi Pay и освободите киоск. Решение и проверка записываются в журнал аудита.',
      ),
    );
    const actions = el('div', 'op-actions');
    actions.append(
      button('Обновить', () => void m.load(m.actor, m.branch), 'button', 'kiosk-incidents-refresh'),
    );
    heading.append(intro, actions);
    panel.append(heading);
    if (m.error) {
      const notice = el(
        'p',
        'notice error',
        m.uncertain
          ? 'Ответ не получен. Обновите список: если заказ исчез из него, киоск уже освобождён. Повтор того же решения безопасен.'
          : message(m.error),
      );
      notice.setAttribute('role', 'alert');
      panel.append(notice);
    }
    if (m.last) {
      const done = el('p', 'notice');
      done.setAttribute('role', 'status');
      done.textContent = `Киоск освобождён (заказ ${short(m.last.order_id)}). ${incidentAdvice(m.last.kaspi_check)}`;
      panel.append(done);
    }
    if (!m.data) {
      panel.append(el('p', 'muted', m.error ? 'Нет актуальных данных.' : 'Загружаем…'));
      target.append(panel);
      return;
    }
    const data = m.data;
    if (!data.candidates.length)
      panel.append(
        el(
          'p',
          'muted device-empty',
          `Сейчас нет оплат киоска без результата дольше ${data.min_age_minutes} минут.`,
        ),
      );
    else {
      const wrap = el('div', 'device-table-wrap'),
        table = el('table', 'device-table'),
        head = el('tr');
      for (const title of ['Заказ', 'Оплата', 'Состояние', '']) head.append(el('th', '', title));
      const body = el('tbody');
      for (const c of data.candidates) {
        const row = el('tr');
        const order = el('td');
        order.append(
          el('strong', '', `№ ${short(c.order_id)}`),
          el('span', 'muted', `QR создан ${date(c.issue_started_at)}`),
        );
        const pay = el('td');
        pay.append(
          el('strong', '', tenge(c.total_minor)),
          el('span', 'muted', `Без результата ${incidentAgeMinutes(c)} мин`),
        );
        const state = el('td');
        state.append(
          el(
            'span',
            'muted',
            c.has_operation_id
              ? 'Номер операции Kaspi известен, банк не дал окончательного ответа.'
              : 'Ответ банка на создание QR потерян: гость не мог увидеть этот QR.',
          ),
        );
        const action = el('td');
        if (data.role === 'manager')
          action.append(
            button(
              'Проверить и освободить',
              () => this.release(c),
              'button primary',
              'kiosk-incident-release',
            ),
          );
        else action.append(el('span', 'muted', 'Решение принимает управляющий точки'));
        row.append(order, pay, state, action);
        body.append(row);
      }
      const thead = el('thead');
      thead.append(head);
      table.append(thead, body);
      wrap.append(table);
      panel.append(wrap);
    }
    if (data.accepted.length) {
      const list = el('div', 'device-footnote');
      list.append(el('h3', '', 'Освобождённые киоски'));
      for (const a of data.accepted.slice(0, 10))
        list.append(
          el(
            'p',
            'muted',
            `${date(a.accepted_at)} - заказ ${short(a.order_id)}, ${a.accepted_by_name}: ${
              a.kaspi_check === 'payment_found'
                ? 'оплата найдена в Kaspi Pay'
                : a.kaspi_check === 'payment_not_found'
                  ? 'оплаты в Kaspi Pay нет'
                  : 'без отметки о проверке'
            }. Сверка: ${attemptStates[a.attempt_state] ?? a.attempt_state}. ${a.note}`,
          ),
        );
      panel.append(list);
    }
    target.append(panel);
  }
  private release(candidate: KioskIncidentCandidate) {
    const d = el('dialog', 'op-dialog device-dialog');
    const title = el('h2', '', `Освободить киоск: заказ ${short(candidate.order_id)}`);
    title.id = 'kiosk-incident-' + crypto.randomUUID();
    d.setAttribute('aria-labelledby', title.id);
    d.addEventListener('close', () => d.remove());
    let kaspi: KaspiCheck = 'payment_not_found',
      note = '',
      understood = false;
    d.append(
      title,
      el(
        'p',
        '',
        `Найдите в Kaspi Pay оплату на ${tenge(candidate.total_minor)} около ${date(candidate.issue_started_at)}. Киоск перейдёт к новому гостю, а результат платежа в системе останется неизвестным до ответа банка: поздняя оплата привяжется к этому заказу автоматически.`,
      ),
      select(
        'Что показывает Kaspi Pay',
        kaspi,
        checks,
        (v) => {
          kaspi = v as KaspiCheck;
        },
        'kiosk-incident-kaspi',
      ),
      field(
        'Комментарий для журнала',
        '',
        (v) => {
          note = v;
        },
        { required: true, max: 500, multiline: true, id: 'kiosk-incident-note' },
      ),
      check(
        'Понимаю: оплата не отмечается как полученная или отклонённая, результат остаётся на сверке',
        false,
        (v) => {
          understood = v;
        },
        'kiosk-incident-confirm',
      ),
    );
    const error = el('p', 'notice error');
    error.setAttribute('role', 'alert');
    d.append(error);
    const send = button(
      'Освободить киоск',
      () =>
        void (async () => {
          if (note.trim().length < 3 || !understood) {
            error.textContent = 'Заполните комментарий (от 3 символов) и подтвердите условие.';
            return;
          }
          send.disabled = true;
          try {
            if (await this.model.accept(candidate, kaspi, note)) d.close();
            else error.textContent = message(this.model.error);
          } finally {
            send.disabled = false;
          }
        })(),
      'button primary',
      'kiosk-incident-submit',
    );
    d.append(
      button('Отмена', () => d.close(), 'button'),
      send,
    );
    document.body.append(d);
    d.showModal();
  }
}
