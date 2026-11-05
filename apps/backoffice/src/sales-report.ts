import { element as el, button, field } from './dom.js';
import {
  NO_REVENUE_LABELS,
  REFUND_KIND_LABELS,
  REFUND_REASON_LABELS,
  SALES_CHANNEL_LABELS,
  SALES_METHOD_LABELS,
  SALES_REPORT_RULES,
  almatyTime,
  approverLabel,
  dayLabel,
  money,
  salesCsv,
  salesCsvText,
  type Data,
  type SalesReport,
} from './sales-report-model.js';

/** Calendar day in Asia/Almaty, `days` before now. */
const almatyDay = (days = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(
    new Date(Date.now() - days * 86400000),
  );
const label = (map: Readonly<Record<string, string>>, code: unknown) =>
  map[String(code)] ?? String(code);
function table(headers: string[], rows: string[][], empty = 'Нет данных за период', testId = '') {
  const wrap = el('div', 'table-wrap sales-table'),
    t = el('table', 'op-table'),
    head = el('thead'),
    tr = el('tr');
  if (testId) wrap.dataset.testid = testId;
  for (const h of headers) tr.append(el('th', '', h));
  head.append(tr);
  const body = el('tbody');
  for (const row of rows) {
    const r = el('tr');
    for (const c of row) r.append(el('td', '', c));
    body.append(r);
  }
  if (!rows.length) {
    const r = el('tr'),
      td = el('td', 'op-empty', empty);
    td.colSpan = headers.length;
    r.append(td);
    body.append(r);
  }
  t.append(head, body);
  wrap.append(t);
  return wrap;
}
function stats(items: [string, string, string?][]) {
  const n = el('div', 'stats');
  for (const [name, value, detail] of items) {
    const c = el('div', 'stat');
    c.append(el('span', 'muted', name), el('strong', '', value));
    if (detail) c.append(el('small', 'muted', detail));
    n.append(c);
  }
  return n;
}
const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, 8) : '-');

/**
 * «Продажи» on the reports page (cutover CC-7): every channel, the eight cashier payment
 * methods, days, hours, voids and refunds with the approver, «Без выручки», cashier shifts and
 * a CSV of all of it. Keeps its window and last result between renders of the page.
 */
export class SalesReportView {
  private start = almatyDay(6);
  private end = almatyDay();
  private result: SalesReport | null = null;
  private error = '';
  private busy = false;
  render(load: (start: string, end: string) => Promise<SalesReport>): HTMLElement {
    const root = el('section', 'panel op-panel sales-report');
    root.dataset.testid = 'sales-report';
    const head = el('div', 'panel-head'),
      title = el('div');
    title.append(
      el('h2', '', 'Продажи'),
      el(
        'p',
        'muted',
        'Все каналы: касса, Яндекс Еда, Glovo, приложение и киоск. Дни и часы - по времени Алматы.',
      ),
    );
    const csv = button(
      'Скачать CSV',
      () => {
        if (!this.result) return;
        const r = this.result;
        const url = URL.createObjectURL(
          new Blob([salesCsvText(salesCsv(r))], { type: 'text/csv;charset=utf-8' }),
        );
        const a = el('a');
        a.href = url;
        a.download = `pickchick-sales-${r.start_date}-${r.end_date}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      'button',
      'sales-report-csv',
    );
    csv.disabled = !this.result;
    head.append(title, csv);
    const result = el('div', 'sales-report-result');
    result.dataset.testid = 'sales-report-result';
    const run = button(
      'Показать',
      () => {
        if (this.busy) return;
        this.busy = true;
        run.disabled = true;
        load(this.start, this.end)
          .then((value) => {
            this.result = value;
            this.error = '';
          })
          .catch((error: unknown) => {
            this.result = null;
            this.error =
              error instanceof Error && error.message === 'INVALID_REQUEST'
                ? 'Проверьте даты: период - не больше 92 дней, начало не позже конца.'
                : 'Отчёт не загрузился. Проверьте связь и повторите.';
          })
          .finally(() => {
            this.busy = false;
            run.disabled = false;
            csv.disabled = !this.result;
            this.show(result);
          });
      },
      'button primary',
      'sales-report-run',
    );
    const controls = el('div', 'inventory-filters sales-report-filters');
    controls.append(
      field(
        'С',
        this.start,
        (v) => {
          this.start = v;
        },
        { id: 'sales-report-start', type: 'date' },
      ),
      field(
        'По',
        this.end,
        (v) => {
          this.end = v;
        },
        { id: 'sales-report-end', type: 'date' },
      ),
      run,
    );
    root.append(head, controls, result);
    this.show(result);
    return root;
  }
  private show(result: HTMLElement) {
    result.replaceChildren();
    if (this.error) {
      const n = el('p', 'notice error', this.error);
      n.setAttribute('role', 'alert');
      result.append(n);
      return;
    }
    const r = this.result;
    if (!r) {
      result.append(el('p', 'op-note', 'Выберите период и нажмите «Показать».'));
      return;
    }
    const coverage = el(
      'p',
      'notice compact',
      r.coverage.pos
        ? r.coverage.pos_received_at
          ? `Касса: данные продаж получены ${almatyTime(r.coverage.pos_received_at)}.`
          : 'Касса: продаж кассы в кабинете пока нет.'
        : 'Касса: продажи кассы ещё не поступают в кабинет. Показаны только приложение и киоск.',
    );
    coverage.dataset.testid = 'sales-report-coverage';
    coverage.setAttribute('role', 'status');
    const t = r.totals;
    result.append(
      coverage,
      stats([
        ['Выручка', money(t['revenue_minor']), 'Продажи - отмены - возвраты'],
        ['Чеки', String(t['checks']), `Средний чек ${money(t['average_check_minor'])}`],
        [
          'Отмены и возвраты',
          money(BigInt(String(t['voids_minor'])) + BigInt(String(t['refunds_minor']))),
          `Отменено до кухни: ${String(t['voided_checks'])}`,
        ],
        [
          'Без выручки',
          money(t['no_revenue_minor']),
          `Питание и маркетинг, чеков: ${String(t['no_revenue_checks'])}`,
        ],
      ]),
      el('h3', '', 'Каналы'),
      table(
        ['Канал', 'Чеки', 'Продажи', 'Отмены', 'Возвраты', 'Выручка', 'Средний чек'],
        r.channels.map((c) => [
          label(SALES_CHANNEL_LABELS, c['channel']),
          String(c['checks']) +
            (Number(c['voided_checks']) ? ` (+${c['voided_checks']} отм.)` : ''),
          money(c['sales_minor']),
          money(c['voids_minor']),
          money(c['refunds_minor']),
          money(c['revenue_minor']),
          money(c['average_check_minor']),
        ]),
        'Нет данных за период',
        'sales-report-channels',
      ),
      el('h3', '', 'Способы оплаты'),
      table(
        ['Способ', 'Оплат', 'Продажи', 'Отмены', 'Возвраты', 'Итого'],
        r.methods.map((m) => [
          label(SALES_METHOD_LABELS, m['method']) +
            (m['revenue'] === false ? ' (без выручки)' : ''),
          String(m['payments']),
          money(m['sales_minor']),
          money(m['voids_minor']),
          money(m['refunds_minor']),
          money(m['net_minor']),
        ]),
        'Нет данных за период',
        'sales-report-methods',
      ),
      el('h3', '', 'По дням'),
      table(
        ['День', 'Чеки', 'Продажи', 'Отмены и возвраты', 'Выручка', 'Без выручки'],
        r.by_day.map((d) => [
          dayLabel(d['day']),
          String(d['checks']),
          money(d['sales_minor']),
          money(BigInt(String(d['voids_minor'])) + BigInt(String(d['refunds_minor']))),
          money(d['revenue_minor']),
          money(d['no_revenue_minor']),
        ]),
        'Нет данных за период',
        'sales-report-days',
      ),
      el('h3', '', 'По часам'),
      table(
        ['Час', 'Чеки', 'Продажи'],
        r.by_hour
          .filter((h) => Number(h['checks']) > 0)
          .map((h) => [
            `${String(h['hour']).padStart(2, '0')}:00 - ${String(h['hour']).padStart(2, '0')}:59`,
            String(h['checks']),
            money(h['sales_minor']),
          ]),
        'Оплаченных чеков за период нет',
        'sales-report-hours',
      ),
      el('h3', '', 'Отмены и возвраты'),
      table(
        ['Время', 'Заказ', 'Канал', 'Вид', 'Сумма', 'Причина', 'Подтвердил'],
        r.refunds.map((v) => [
          almatyTime(v['created_at']),
          v['display_number'] === null ? short(v['order_id']) : '№' + String(v['display_number']),
          label(SALES_CHANNEL_LABELS, v['channel']),
          label(REFUND_KIND_LABELS, v['kind']) +
            (v['revenue_kind'] !== 'revenue'
              ? ` (${label(NO_REVENUE_LABELS, v['revenue_kind'])})`
              : ''),
          money(v['amount_minor']),
          [
            v['reason_code'] ? label(REFUND_REASON_LABELS, v['reason_code']) : '',
            String(v['reason'] ?? ''),
          ]
            .filter(Boolean)
            .join(': '),
          approverLabel(v),
        ]),
        'Отмен и возвратов за период нет',
        'sales-report-refunds',
      ),
    );
    if (r.truncated.refunds)
      result.append(el('p', 'op-note', 'Показаны последние 200 отмен и возвратов периода.'));
    result.append(
      el('h3', '', 'Без выручки'),
      table(
        ['Вид', 'Чеки', 'Сумма'],
        r.no_revenue.kinds.map((k) => [
          label(NO_REVENUE_LABELS, k['revenue_kind']),
          String(k['checks']) +
            (Number(k['voided_checks']) ? ` (+${k['voided_checks']} отм.)` : ''),
          money(k['total_minor']),
        ]),
        'Нет данных за период',
        'sales-report-no-revenue',
      ),
      table(
        ['Время', 'Заказ', 'Вид', 'Сумма', 'Получатель или причина', 'Подтвердил'],
        r.no_revenue.items.map((i: Data) => [
          almatyTime(i['sold_at']),
          '№' + String(i['display_number']) + (i['state'] === 'voided' ? ' (отменён)' : ''),
          label(NO_REVENUE_LABELS, i['revenue_kind']),
          money(i['total_minor']),
          String(i['beneficiary'] ?? i['reason'] ?? '-'),
          typeof i['approval_manager_staff_id'] === 'string'
            ? `PIN начальника смены, сотрудник ${short(i['approval_manager_staff_id'])}`
            : '-',
        ]),
        'Питания сотрудников и маркетинга за период нет',
        'sales-report-no-revenue-items',
      ),
    );
    if (r.truncated.no_revenue)
      result.append(el('p', 'op-note', 'Показаны последние 200 чеков без выручки.'));
    if (r.coverage.pos)
      result.append(
        el('h3', '', 'Смены кассы'),
        table(
          ['Смена', 'Касса', 'Продажи с', 'по', 'Чеки', 'Продажи', 'Z-отчёт'],
          r.shifts.map((s) => {
            const z = s['z'] as Data | null;
            return [
              short(s['shift_id']),
              short(s['terminal_id']),
              almatyTime(s['first_sale_at']),
              almatyTime(s['last_sale_at']),
              String(s['checks']),
              money(s['sales_minor']),
              z
                ? `Закрыта ${almatyTime(z['closed_at'])}, расхождение наличных ${money(z['discrepancy_minor'])}`
                : 'Открыта или Z-отчёт ещё не получен',
            ];
          }),
          'Смен кассы за период нет',
          'sales-report-shifts',
        ),
        el('h3', '', 'Популярные позиции кассы'),
        table(
          ['Позиция', 'Количество', 'Сумма'],
          r.top_items.map((i) => [
            String(i['name'] || '-'),
            String(i['quantity']),
            money(i['total_minor']),
          ]),
          'Продаж кассы за период нет',
          'sales-report-top',
        ),
      );
    const rules = el('div', 'sales-report-rules');
    rules.append(el('h3', '', 'Как считается'));
    const ul = el('ul');
    for (const rule of SALES_REPORT_RULES) ul.append(el('li', '', rule));
    rules.append(ul);
    result.append(rules);
  }
}
