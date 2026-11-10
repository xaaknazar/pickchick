import { element as el, button, field, select } from './dom.js';
import { ApiError, message } from './api.js';
import { labelledCards } from './ui-fixes.js';
import { guard, mayClose, settle } from './dialog-guard.js';
import {
  ASSIGNMENT_ERRORS,
  allowedFor,
  assignCommand,
  assignmentDayView,
  clock,
  dmy,
  intervalText,
  nightTime,
  nowClock,
  openOf,
  stationChoices,
  stationGrid,
  unassigned,
  unassignCommand,
  validTime,
  type Assignment,
  type AssignmentDay,
} from './assignment-model.js';

type Data = Record<string, unknown>;
/**
 * What app.ts hands to «Расстановка» (lane bo-ui2 step 5). `execute` sends one command with its
 * reason and answers null on success or the error itself (the page says it in words).
 */
export type AssignmentCallbacks = {
  load: (query: Record<string, string>) => Promise<unknown>;
  branch: () => string;
  execute: (command: Data, reason: string) => Promise<unknown>;
  can: (permission: string) => boolean;
  rights: (permission: string) => string | null;
  /** actor:branch: a new person or branch loads the page again. */
  scope: () => string;
  changed: () => void;
};
/** An assignment command error in words: the reasons of the staff assignment first. */
export function assignmentErrorText(error: unknown, rights?: string | null): string {
  if (error instanceof ApiError) {
    if (error.reason === 'ROLE_FORBIDDEN' && rights) return rights;
    const precise = error.reason ? ASSIGNMENT_ERRORS[error.reason] : undefined;
    if (precise) return precise;
    if (!error.reason && ASSIGNMENT_ERRORS[error.code]) return ASSIGNMENT_ERRORS[error.code]!;
  }
  return message(error);
}
function dialog(title: string, sub: string, testId: string) {
  const d = el('dialog', 'op-dialog as-dialog'),
    top = el('div', 'panel-head'),
    close = button(
      'Закрыть',
      () => {
        if (!mayClose(d)) return;
        d.close();
        d.remove();
      },
      'button subtle',
      'as-close',
    );
  d.dataset.testid = testId;
  top.append(el('h2', '', title), close);
  d.append(top);
  if (sub) d.append(el('p', 'op-note', sub));
  document.body.append(d);
  d.showModal();
  d.addEventListener('close', () => d.remove());
  return d;
}

/**
 * «Расстановка» (А9, design-backoffice 5 «Смены»): who stands on which station of the shown
 * business day, «Поставить», the quick «Переставить с ЧЧ:ММ» for the rush hour, «Закончить»,
 * the people without a station and the history of the day. The station list and every rule come
 * from the server; buttons a role may not use stay visible, disabled, with the reason in words.
 */
export class AssignmentPage {
  private view: AssignmentDay | null = null;
  private date = '';
  private error = '';
  private loading = false;
  private loadedFor = '';
  constructor(private cb: AssignmentCallbacks) {}
  clear() {
    this.view = null;
    this.date = '';
    this.error = '';
    this.loadedFor = '';
  }
  async reload() {
    this.loading = true;
    this.cb.changed();
    try {
      this.view = assignmentDayView(
        await this.cb.load(this.date ? { date: this.date } : {}),
        this.cb.branch(),
      );
      this.date = this.view.date;
      this.error = '';
    } catch {
      this.error = 'Расстановка не загрузилась. Проверьте связь и нажмите «Обновить».';
    } finally {
      this.loading = false;
      this.cb.changed();
    }
  }
  render(host: HTMLElement) {
    const scope = this.cb.scope();
    if (this.loadedFor !== scope && !this.loading) {
      this.loadedFor = scope;
      this.date = '';
      void this.reload();
    }
    const p = el('section', 'panel assignment');
    p.dataset.testid = 'assignment';
    const top = el('div', 'panel-head');
    top.append(el('h2', '', 'Расстановка'));
    const tools = el('div', 'op-actions');
    tools.append(button('Обновить', () => void this.reload(), 'button subtle', 'as-refresh'));
    top.append(tools);
    p.append(top);
    host.append(p);
    if (this.error) {
      const e = el('p', 'notice error', this.error);
      e.setAttribute('role', 'alert');
      p.append(e);
    }
    const v = this.view;
    if (!v) {
      p.append(el('p', 'op-note', this.loading ? 'Загружаем расстановку...' : ''));
      return;
    }
    const write = this.cb.can('staff.assign');
    const why = write ? null : this.cb.rights('staff.assign');
    this.bar(p, v, write, why);
    this.earlier(p, v, write, why);
    this.grid(p, v, write, why);
    this.free(p, v, write, why);
    this.history(p, v);
  }
  private bar(p: HTMLElement, v: AssignmentDay, write: boolean, why: string | null) {
    const bar = el('div', 'as-bar');
    bar.append(
      field(
        'День смены',
        this.date,
        (value) => {
          if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            this.date = value;
            void this.reload();
          }
        },
        { id: 'as-date', type: 'date' },
      ),
    );
    if (v.date !== v.today)
      bar.append(
        button(
          'К сегодняшнему дню',
          () => {
            this.date = v.today;
            void this.reload();
          },
          'button subtle',
          'as-today',
        ),
      );
    const place = button(
      'Поставить на станцию',
      () => this.assignDialog(v, null),
      'button primary',
      'as-assign',
    );
    place.disabled = !write || v.employees.length === 0;
    if (why) place.title = why;
    bar.append(place);
    p.append(bar);
    const notes: string[] = [
      `День смены ${dmy(v.date)}${v.date === v.today ? ' (сегодня)' : ''}. Время с 00:00 до 05:59 - ночь после этого дня.`,
    ];
    if (v.manager_shift)
      notes.push(`Смена менеджера открыта, её день - ${dmy(v.manager_shift.business_date)}.`);
    for (const text of notes) p.append(el('p', 'op-note as-note', text));
    if (why) {
      const n = el('p', 'op-note as-rights', why);
      n.dataset.testid = 'as-rights';
      p.append(n);
    }
    if (!v.employees.length)
      p.append(
        el(
          'p',
          'notice',
          'Нет работающих сотрудников с должностью. Заполните должности в «Смены» - «Сотрудники».',
        ),
      );
  }
  /** Intervals left open on an earlier business day: ended first. */
  private earlier(p: HTMLElement, v: AssignmentDay, write: boolean, why: string | null) {
    if (!v.earlier_open.length) return;
    const box = el('div', 'notice error as-earlier');
    box.dataset.testid = 'as-earlier';
    box.append(
      el(
        'p',
        '',
        'Не закрыты интервалы прошлых дней смены. Пока интервал открыт, сотрудника нельзя поставить на новый день. Укажите, когда он ушёл со станции.',
      ),
    );
    for (const a of v.earlier_open) {
      const line = el('p', 'as-earlier-line');
      line.append(
        el(
          'span',
          '',
          `${a.employee_name ?? 'Сотрудник'} - ${a.station_label}, день ${dmy(a.business_date)}, ${intervalText(a)}`,
        ),
      );
      const end = button('Закончить', () => this.endDialog(a), 'button subtle', 'as-end-earlier');
      end.disabled = !write;
      if (why) end.title = why;
      line.append(end);
      box.append(line);
    }
    p.append(box);
  }
  private grid(p: HTMLElement, v: AssignmentDay, write: boolean, why: string | null) {
    p.append(el('h3', 'as-heading', 'Станции'));
    const grid = el('div', 'as-grid');
    for (const row of stationGrid(v)) {
      const card = el('article', 'as-station' + (row.current.length ? ' as-station-busy' : ''));
      card.dataset.testid = 'as-station-' + row.station.code;
      const title = el('div', 'as-station-head');
      title.append(
        el('h4', '', row.station.label),
        el(
          'span',
          'as-count',
          row.current.length ? `На станции: ${row.current.length}` : 'Никого нет',
        ),
      );
      card.append(title);
      if (!row.station.active)
        card.append(el('p', 'op-note', 'Должность выключена: новых не ставят.'));
      const list = el('ul', 'as-people');
      for (const a of row.current) {
        const li = el('li', 'as-person');
        li.dataset.testid = 'as-person';
        const who = el('div', 'as-who');
        who.append(
          el('strong', '', a.employee_name ?? 'Сотрудник'),
          el('span', '', intervalText(a)),
        );
        if (a.override_reason)
          who.append(el('span', 'as-override', `Не по должности: ${a.override_reason}`));
        li.append(who);
        const actions = el('div', 'as-person-actions');
        const move = button(
          'Переставить',
          () => this.assignDialog(v, a.employee_id),
          'button',
          'as-move',
        );
        const end = button('Закончить', () => this.endDialog(a), 'button subtle', 'as-end');
        for (const b of [move, end]) {
          b.disabled = !write;
          if (why) b.title = why;
          actions.append(b);
        }
        li.append(actions);
        list.append(li);
      }
      if (row.current.length) card.append(list);
      if (row.past.length)
        card.append(
          el(
            'p',
            'op-note as-past',
            'Было: ' +
              row.past
                .map((a) => `${a.employee_name ?? 'Сотрудник'} ${intervalText(a)}`)
                .join('; '),
          ),
        );
      grid.append(card);
    }
    p.append(grid);
  }
  /** Working employees nobody has put on a station. */
  private free(p: HTMLElement, v: AssignmentDay, write: boolean, why: string | null) {
    const people = unassigned(v);
    p.append(el('h3', 'as-heading', `Без станции: ${people.length}`));
    if (!people.length) {
      p.append(el('p', 'op-note', 'Все работающие сотрудники стоят на станциях.'));
      return;
    }
    const list = el('ul', 'as-free');
    list.dataset.testid = 'as-free';
    for (const e of people) {
      const li = el('li', 'as-person');
      const who = el('div', 'as-who');
      const allowed = stationChoices(v, e).allowed.map((s) => s.label);
      who.append(
        el('strong', '', e.name),
        el('span', 'muted', allowed.length ? allowed.join(', ') : 'Нет станций по должности'),
      );
      const b = button(
        'Поставить',
        () => this.assignDialog(v, e.employee_id),
        'button',
        'as-place',
      );
      b.disabled = !write;
      if (why) b.title = why;
      li.append(who, b);
      list.append(li);
    }
    p.append(list);
  }
  private history(p: HTMLElement, v: AssignmentDay) {
    p.append(el('h3', 'as-heading', `История дня ${dmy(v.date)}`));
    const headers = ['Сотрудник', 'Станция', 'Время', 'Поставил', 'Закончил', 'Примечание'];
    const wrap = el('div', 'inventory-table'),
      t = el('table', 'op-table'),
      h = el('thead'),
      tr = el('tr');
    for (const text of headers) {
      const th = el('th', '', text);
      th.scope = 'col';
      tr.append(th);
    }
    h.append(tr);
    const body = el('tbody');
    for (const a of v.intervals) {
      const row = el('tr');
      row.dataset.testid = 'as-history-row';
      for (const text of [
        a.employee_name ?? 'Сотрудник',
        a.station_label,
        intervalText(a) + (a.ended_at === null ? ' (сейчас)' : ''),
        a.set_by_name ?? '-',
        a.ended_at ? (a.ended_by_name ?? '-') : '-',
        a.override_reason
          ? `Не по должности: ${a.override_reason}`
          : a.ended_at === a.started_at
            ? 'Меньше минуты'
            : '',
      ]) {
        const td = el('td', '', text);
        row.append(td);
      }
      body.append(row);
    }
    t.append(h, body);
    wrap.append(t);
    if (!v.intervals.length) wrap.append(el('p', 'op-note', 'За этот день расстановки ещё нет.'));
    if (v.truncated.intervals)
      wrap.append(el('p', 'notice', 'Показаны первые 500 интервалов дня.'));
    p.append(labelledCards(wrap, headers));
  }

  // -------------------------------------------------------------------------- dialogs ----

  /** «Поставить» (no open interval) or «Переставить» (closes the open one at the new start). */
  private assignDialog(v: AssignmentDay, employeeId: string | null) {
    let employee = employeeId ?? v.employees[0]?.employee_id ?? '';
    const person = () => v.employees.find((e) => e.employee_id === employee);
    const open = () => openOf(v, employee);
    const first = () => {
      const c = stationChoices(v, person());
      return (c.allowed[0] ?? c.other[0])?.code ?? '';
    };
    let station = first();
    let time = nowClock();
    let override = '';
    const moving = employeeId !== null && open() !== null;
    const d = dialog(
      moving ? 'Переставить' : 'Поставить на станцию',
      `День смены ${dmy(v.date)}. Время с 00:00 до 05:59 - ночь после этого дня.`,
      'as-assign-dialog',
    );
    guard(d, { question: 'Закрыть окно? Выбор не сохранится.' });
    const form = el('div', 'as-form');
    const status = el('p', 'op-note as-current');
    const stationHost = el('div');
    const overrideHost = el('div');
    const error = el('p', 'notice error op-form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const save = button(
      moving ? 'Переставить' : 'Поставить',
      () => void submit(),
      'button primary',
      'as-save',
    );
    const mayOverride = this.cb.can('staff.assign_override');
    const sync = () => {
      const o = open();
      status.textContent = o
        ? o.business_date === v.date
          ? `Сейчас: ${o.station_label}, ${intervalText(o)}. Интервал закончится в момент нового начала.`
          : `Не закрыт интервал дня ${dmy(o.business_date)} (${o.station_label}). Сначала закончите его.`
        : 'Сейчас не на станции.';
      const choices = stationChoices(v, person());
      stationHost.replaceChildren(
        select(
          'Станция',
          station,
          [
            ...choices.allowed.map((s) => ({ value: s.code, label: s.label })),
            ...choices.other.map((s) => ({ value: s.code, label: `${s.label} - не по должности` })),
          ],
          (value) => {
            station = value;
            sync();
          },
          'as-station',
        ),
      );
      const outside = station !== '' && !allowedFor(person(), station);
      overrideHost.replaceChildren();
      if (outside) {
        if (mayOverride)
          overrideHost.append(
            field(
              'Причина: почему не по должности',
              override,
              (value) => {
                override = value;
              },
              {
                id: 'as-override',
                max: 300,
                required: true,
                hint: 'Обязательно, минимум 3 символа. Видна в истории дня.',
              },
            ),
          );
        else
          overrideHost.append(
            el(
              'p',
              'notice',
              this.cb.rights('staff.assign_override') ??
                'Поставить не по должности может только управляющий.',
            ),
          );
      }
      save.disabled =
        !station || !employee || (outside && !mayOverride) || (!!o && o.business_date !== v.date);
    };
    if (employeeId === null)
      form.append(
        select(
          'Сотрудник',
          employee,
          v.employees.map((e) => {
            const o = openOf(v, e.employee_id);
            return {
              value: e.employee_id,
              label: o ? `${e.name} - сейчас ${o.station_label}` : e.name,
            };
          }),
          (value) => {
            employee = value;
            station = first();
            sync();
          },
          'as-employee',
        ),
      );
    else form.append(el('p', 'as-name', person()?.name ?? 'Сотрудник'));
    form.append(
      status,
      stationHost,
      field(
        moving ? 'Переставить с' : 'С',
        time,
        (value) => {
          time = value;
        },
        {
          id: 'as-time',
          type: 'time',
          required: true,
          hint: 'Часы и минуты. Время с 00:00 до 05:59 - ночь после дня смены.',
        },
      ),
      overrideHost,
    );
    d.append(form, error, save);
    sync();
    const submit = async () => {
      error.hidden = true;
      const o = open();
      if (!validTime(time)) {
        error.textContent = 'Укажите время: часы и минуты.';
        error.hidden = false;
        return;
      }
      const outside = !allowedFor(person(), station);
      if (outside && override.trim().length < 3) {
        error.textContent = 'Укажите причину: почему сотрудник стоит не по должности.';
        error.hidden = false;
        return;
      }
      save.disabled = true;
      const st = v.stations.find((s) => s.code === station);
      const failed = await this.cb.execute(
        assignCommand(employee, station, v.date, time, o?.revision ?? 0, outside ? override : null),
        `Расстановка: ${person()?.name ?? 'сотрудник'} - ${st?.label ?? station} с ${time}${nightTime(time, v.night_end) ? ' (ночь)' : ''}`,
      );
      save.disabled = false;
      if (failed) {
        error.textContent = assignmentErrorText(failed, this.cb.rights('staff.assign_override'));
        error.hidden = false;
        if (failed instanceof ApiError && failed.code === 'CONFLICT') await this.reload();
        return;
      }
      settle(d);
      await this.reload();
      d.close();
    };
  }
  /** «Закончить»: the end of the open interval, a clock time of its own business day. */
  private endDialog(a: Assignment) {
    let time = nowClock();
    const d = dialog(
      'Закончить',
      `${a.employee_name ?? 'Сотрудник'} - ${a.station_label}, ${intervalText(a)}. День смены ${dmy(a.business_date)}: время с 00:00 до 05:59 - ночь после него.`,
      'as-end-dialog',
    );
    guard(d, { question: 'Закрыть окно? Интервал останется открытым.' });
    const error = el('p', 'notice error op-form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const save = button(
      'Закончить',
      () =>
        void (async () => {
          if (!validTime(time)) {
            error.textContent = 'Укажите время: часы и минуты.';
            error.hidden = false;
            return;
          }
          save.disabled = true;
          const failed = await this.cb.execute(
            unassignCommand(a.employee_id, time, a.revision),
            `Расстановка: ${a.employee_name ?? 'сотрудник'} ушёл со станции ${a.station_label} в ${time}`,
          );
          save.disabled = false;
          if (failed) {
            error.textContent = assignmentErrorText(failed, this.cb.rights('staff.assign'));
            error.hidden = false;
            if (failed instanceof ApiError && failed.code === 'CONFLICT') await this.reload();
            return;
          }
          settle(d);
          await this.reload();
          d.close();
        })(),
      'button primary',
      'as-end-save',
    );
    d.append(
      field(
        'До',
        time,
        (value) => {
          time = value;
        },
        {
          id: 'as-end-time',
          type: 'time',
          required: true,
          hint: `Начало: ${clock(a.started_at)}.`,
        },
      ),
      error,
      save,
    );
  }
}
