/**
 * Lane bo-ui, audit F08: the audit log in words. Every action code the back office writes
 * (bo_audit.action, catalog_audit.action) gets a section and a Russian name; the author is the
 * name of the person (actor_name, sent by servers with BACKOFFICE_POS_DAY_ENABLED). Pure
 * functions, used by operations.ts only while the audit fixes are on.
 */
type Data = Record<string, unknown>;

const RECORD_KINDS: Record<string, [string, string]> = {
  ingredient: ['Склад', 'ингредиент'],
  recipe: ['Склад', 'техкарта'],
  promo: ['Промо и игры', 'промо и баннер'],
  game: ['Промо и игры', 'игра'],
  campaign: ['Гости', 'кампания'],
  ticket: ['Обращения и отзывы', 'обращение'],
  review: ['Обращения и отзывы', 'отзыв'],
  station: ['Станции', 'станция кухни'],
  employee: ['Смены', 'карточка сотрудника'],
  shift: ['Смены', 'журнал смены'],
};
const EXACT: Record<string, [string, string]> = {
  seeded: ['Меню', 'Черновик меню создан из макета'],
  saved: ['Меню', 'Черновик меню сохранён'],
  published: ['Меню', 'Меню опубликовано'],
  'stock:receipt': ['Склад', 'Поставка'],
  'stock:waste': ['Склад', 'Списание'],
  'stock:count': ['Склад', 'Инвентаризация'],
  produce: ['Склад', 'Производство полуфабриката'],
  consume: ['Склад', 'Списание по техкартам заказа'],
  stock_reverse: ['Склад', 'Сторно документа'],
  menu_link_save: ['Склад', 'Связь позиции меню со складом'],
  menu_links_approve: ['Склад', 'Утверждение связей меню со складом'],
  stock_settings: ['Склад', 'Режим списания по продажам'],
  consumption_retry: ['Склад', 'Повтор списания по продаже'],
  consumption_skip: ['Склад', 'Пропуск списания по продаже'],
  manager_shift_open: ['Смены', 'Открытие смены менеджера'],
  manager_shift_save: ['Смены', 'Черновик смены менеджера'],
  manager_shift_close: ['Смены', 'Закрытие смены менеджера'],
  manager_shift_template: ['Смены', 'Новая версия чек-листа смены'],
  staff_positions_save: ['Смены', 'Список должностей'],
  discount_save: ['Скидки', 'Скидка: создание или изменение'],
  discount_state: ['Скидки', 'Скидка: включение, выключение или архив'],
  cancel_order: ['Заказы', 'Отмена заказа'],
  refund: ['Заказы', 'Запрос возврата'],
  manual_refund: ['Заказы', 'Ручной возврат Kaspi'],
  withdraw_refund: ['Заказы', 'Отзыв запроса возврата'],
  revoke_device: ['Устройства', 'Отключение устройства'],
  kiosk_payment_incident: ['Устройства', 'Разбор оплаты киоска'],
  deliver_station_plan: ['Станции', 'Отправка плана станций на кассу'],
  'remote_stop:stop': ['Стоп-лист', 'Стоп на кассе из кабинета'],
  'remote_stop:unstop': ['Стоп-лист', 'Возврат в продажу на кассе из кабинета'],
  'cloud_stop:stop': ['Стоп-лист', 'Стоп в приложении и киоске'],
  'cloud_stop:unstop': ['Стоп-лист', 'Возврат в продажу в приложении и киоске'],
  'cloud_stop:override_cashier': ['Стоп-лист', 'Снятие стопа кассы в приложении и киоске'],
  'cloud_kitchen:screen_create': ['Устройства', 'Новый экран кухни'],
  'cloud_kitchen:pairing_code': ['Устройства', 'Код подключения экрана кухни'],
  'cloud_kitchen:screen_revoke': ['Устройства', 'Отключение экрана кухни'],
  'cloud_kitchen:mode': ['Устройства', 'Режим кухни'],
  'finance.entry': ['Финансы', 'Новая операция'],
  'finance.replace': ['Финансы', 'Исправление операции'],
  'finance.void': ['Финансы', 'Удаление операции'],
  'finance.account': ['Финансы', 'Денежный счёт'],
  'finance.period': ['Финансы', 'Закрытие или открытие месяца'],
  'reconciliation.profile': ['Сверка оплат', 'Настройка выписки'],
  'reconciliation.import': ['Сверка оплат', 'Загрузка выписки'],
  'reconciliation.void_import': ['Сверка оплат', 'Отмена загрузки выписки'],
  'reconciliation.total': ['Сверка оплат', 'Итог за день вручную'],
  'reconciliation.void_total': ['Сверка оплат', 'Отмена итога за день'],
  'reconciliation.item': ['Сверка оплат', 'Решение по расхождению'],
  'reconciliation.accept': ['Сверка оплат', 'Принятие расхождения'],
  'reconciliation.close': ['Сверка оплат', 'Закрытие дня'],
  'reconciliation.reopen': ['Сверка оплат', 'Открытие дня'],
  'workforce.save': ['Смены', 'График, табель, ставка или премия'],
  'workforce.delete': ['Смены', 'Удаление записи смен'],
  'workforce.import': ['Смены', 'Импорт явок'],
  'workforce.generate_payroll': ['Смены', 'Расчёт ведомости'],
  'workforce.period': ['Смены', 'Закрытие или открытие табеля'],
};
const PREFIX: [string, string][] = [
  ['finance.', 'Финансы'],
  ['reconciliation.', 'Сверка оплат'],
  ['workforce.', 'Смены'],
  ['stock:', 'Склад'],
  ['remote_stop:', 'Стоп-лист'],
  ['cloud_stop:', 'Стоп-лист'],
  ['cloud_kitchen:', 'Устройства'],
];

/** Section and Russian name of an action code; an unknown code keeps its code after the name. */
export function auditAction(code: unknown): { section: string; text: string } {
  const value = typeof code === 'string' ? code : '';
  const exact = EXACT[value];
  if (exact) return { section: exact[0], text: exact[1] };
  const [verb, kind] = value.split(':');
  const record = kind ? RECORD_KINDS[kind] : undefined;
  if (record && verb === 'save') return { section: record[0], text: `Изменение: ${record[1]}` };
  if (record && verb === 'publish') return { section: record[0], text: `Публикация: ${record[1]}` };
  const prefix = PREFIX.find(([p]) => value.startsWith(p));
  return {
    section: prefix?.[1] ?? 'Другое',
    text: value ? `Другая операция (${value})` : 'Операция не указана',
  };
}

export type AuditRow = {
  id: string;
  at: string;
  day: string;
  author: string;
  section: string;
  action: string;
  reason: string;
};
const almatyDay = (iso: string) =>
  Number.isFinite(Date.parse(iso))
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date(iso))
    : '';
/** Both logs, newest first, with names; a missing name says so instead of showing an id. */
export function auditRows(audit: Data[], catalogAudit: Data[]): AuditRow[] {
  return [...audit, ...catalogAudit]
    .map((v) => {
      const action = auditAction(v['action']);
      const name = typeof v['actor_name'] === 'string' && v['actor_name'] ? v['actor_name'] : '';
      const at = String(v['created_at'] ?? '');
      return {
        id: String(v['id'] ?? ''),
        at,
        day: almatyDay(at),
        author: name || 'Автор не найден',
        section: action.section,
        action: action.text,
        reason: typeof v['reason'] === 'string' && v['reason'] ? v['reason'] : '-',
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
export type AuditFilter = { author: string; section: string; from: string; to: string };
export const NO_FILTER: AuditFilter = { author: '', section: '', from: '', to: '' };
/** The rows that pass the filter (author, section, Almaty days from/to, both inclusive). */
export function auditView(rows: AuditRow[], filter: AuditFilter): AuditRow[] {
  return rows.filter(
    (r) =>
      (!filter.author || r.author === filter.author) &&
      (!filter.section || r.section === filter.section) &&
      (!filter.from || r.day >= filter.from) &&
      (!filter.to || r.day <= filter.to),
  );
}
