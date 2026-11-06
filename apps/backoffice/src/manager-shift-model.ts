import { almatyDateTime, tenge } from './ui-fixes.js';

/**
 * «Смена менеджера» in the cabinet (lane bo-ui step 6, BACKOFFICE_MANAGER_SHIFTS_ENABLED;
 * design-bo-ui.md 5.6, design-backoffice.md 5 «Смены»). Pure functions over GET
 * .../ops/manager-shifts: the texts of the automatic checks, the checklist rules (the same as the
 * server's checklistProblems, so a missing comment is said before sending) and the commands.
 */
type Data = Record<string, unknown>;
export type ChecklistItem = {
  code: string;
  label: string;
  auto: string | null;
  required: boolean;
};
export type CheckStatus = 'ok' | 'problem' | 'no_data' | 'off';
export type Check = { status: CheckStatus; facts: Data };
export type AnswerStatus = 'done' | 'problem' | 'not_applicable';
export type Answer = { code: string; status: AnswerStatus; comment: string | null };
export type StoredAnswer = Answer & { label: string; auto: string | null; check: Check | null };
export type Checklist = { version: number; opening: ChecklistItem[]; closing: ChecklistItem[] };
export type ManagerShift = {
  id: string;
  business_date: string;
  state: 'open' | 'closed';
  manager_employee_id: string | null;
  manager_name: string | null;
  opened_at: string;
  opened_by_name: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
  template_version: number;
  opening: { items?: StoredAnswer[] };
  closing: { items?: StoredAnswer[]; handover?: string; draft?: boolean } | null;
  revision: number;
};
export type ManagerShiftsView = {
  date: string;
  template: Checklist & {
    editable: boolean;
    updated_at: string | null;
    updated_by_name: string | null;
  };
  open: ManagerShift | null;
  open_template: Checklist | null;
  shifts: ManagerShift[];
  truncated: boolean;
  checks_date: string;
  checks: Record<string, Check>;
};

export const ANSWER_LABELS: Readonly<Record<AnswerStatus, string>> = Object.freeze({
  done: 'Готово',
  problem: 'Есть проблема',
  not_applicable: 'Не применимо',
});
export const CHECK_LABELS: Readonly<Record<CheckStatus, string>> = Object.freeze({
  ok: 'Проверено',
  problem: 'Есть проблема',
  no_data: 'Нет данных',
  off: 'Не используется',
});
export const HANDOVER_MAX = 2000;

const isObject = (v: unknown): v is Data => !!v && typeof v === 'object' && !Array.isArray(v);
/** The view of GET .../ops/manager-shifts, checked enough to draw it; throws otherwise. */
export function managerShiftsView(value: unknown, branch: string): ManagerShiftsView {
  if (
    !isObject(value) ||
    value['branch_id'] !== branch ||
    !isObject(value['template']) ||
    !Array.isArray((value['template'] as Data)['opening']) ||
    !Array.isArray((value['template'] as Data)['closing']) ||
    !Array.isArray(value['shifts']) ||
    !isObject(value['checks']) ||
    typeof value['date'] !== 'string'
  )
    throw new Error('INVALID_RESPONSE');
  return value as unknown as ManagerShiftsView;
}
/** The checklist a shift answers: its own version while open (a newer one may exist). */
export const shiftChecklist = (view: ManagerShiftsView): Checklist =>
  view.open && view.open_template ? view.open_template : view.template;

const plural = (n: number, forms: [string, string, string]) => {
  const a = Math.abs(n) % 100,
    b = a % 10;
  return forms[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2];
};
const time = (v: unknown) => (typeof v === 'string' ? almatyDateTime(v).slice(11) : '');
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
/** The text of an automatic check, in the words of design-backoffice 5 «Смены». */
export function checkText(auto: string, check: Check | null | undefined): string {
  if (!check) return 'Нет данных. Подтвердите вручную.';
  const f = check.facts ?? {};
  const noCash =
    f['reason'] === 'stale' && f['last_received_at']
      ? `Данные кассы не поступают с ${time(f['last_received_at'])}. Подтвердите вручную.`
      : 'Данные кассы не поступают. Подтвердите вручную.';
  switch (auto) {
    case 'cash_shifts': {
      if (check.status === 'no_data')
        return f['reason'] === 'no_shifts'
          ? 'Кассовых смен за день нет. Подтвердите вручную.'
          : noCash;
      const total = num(f['total']);
      const parts = [`Кассовые смены: ${num(f['closed'])} из ${total} закрыты`];
      if (String(f['cash_discrepancy_minor'] ?? '0') !== '0')
        parts.push(`расхождение ${tenge(f['cash_discrepancy_minor'])}`);
      if (String(f['terminal_discrepancy_minor'] ?? '0') !== '0')
        parts.push(`Kaspi терминал ${tenge(f['terminal_discrepancy_minor'])}`);
      return parts.join(', ') + (check.status === 'problem' ? '. Поясните в комментарии.' : '.');
    }
    case 'webkassa_receipts': {
      if (check.status === 'no_data') return noCash;
      const pending = num(f['pending']);
      return pending > 0
        ? `Не оформлено в Webkassa: ${pending} ${plural(pending, ['чек', 'чека', 'чеков'])} на ${tenge(f['pending_minor'])}. Оформите или поясните.`
        : `Все чеки оформлены в Webkassa: ${num(f['recorded'])}.`;
    }
    case 'cash_float': {
      if (check.status === 'no_data')
        return f['reason'] === 'no_shifts' ? 'Кассы ещё не открыты. Подтвердите вручную.' : noCash;
      const desks = Array.isArray(f['desks']) ? (f['desks'] as Data[]) : [];
      return (
        'На открытии: ' +
        desks.map((d) => `${String(d['label'])} ${tenge(d['opening_cash_minor'])}`).join(', ') +
        '.'
      );
    }
    case 'attendance': {
      if (check.status === 'no_data')
        return 'На этот день нет опубликованного графика. Подтвердите вручную.';
      const names = Array.isArray(f['names']) ? (f['names'] as string[]) : [];
      const planned = num(f['planned']);
      return `По графику: ${planned} ${plural(planned, ['смена', 'смены', 'смен'])}${names.length ? ': ' + names.join(', ') : ''}. Явка внесена: ${num(f['recorded'])}.`;
    }
    case 'stoplist':
      return check.status === 'no_data'
        ? 'Касса не сообщает стоп-лист. Проверьте на кассе.'
        : `В стопе: ${num(f['stopped'])} ${plural(num(f['stopped']), ['позиция', 'позиции', 'позиций'])} (по данным кассы на ${time(f['observed_at'])}).`;
    case 'waste':
      return check.status === 'no_data'
        ? 'Списаний за день не внесено. Подтвердите или внесите в «Остатки».'
        : `Документов списания за день: ${num(f['documents'])}.`;
    case 'key_count':
      // Step 8: the positions marked «Считать каждый день» (count_daily) of the ingredient cards.
      if (f['key_items'] !== undefined) {
        const items = num(f['key_items']),
          missing = num(f['key_missing_count']),
          names = Array.isArray(f['key_missing']) ? f['key_missing'].map(String) : [];
        return missing
          ? `Не посчитаны ключевые позиции: ${missing} из ${items}${names.length ? ' (' + names.join(', ') + (missing > names.length ? ' и другие' : '') + ')' : ''}. Проведите «Подсчёт на закрытии» в «Остатки» или поясните.`
          : `Ключевые позиции посчитаны: ${items} из ${items}, последний подсчёт в ${time(f['last_at'])}.`;
      }
      return check.status === 'no_data'
        ? 'Подсчёта за день нет. Проведите инвентаризацию ключевых позиций в «Остатки».'
        : `Подсчётов за день: ${num(f['documents'])}, позиций: ${num(f['items'])}, последний в ${time(f['last_at'])}.`;
    case 'blocked_consumption': {
      if (check.status === 'off') return 'Списание по продажам не включено. Пункт необязателен.';
      // Review BOUI-R2: sales the worker should have handled (the server says how many).
      const late = num(f['not_processed']);
      const stalled =
        late > 0
          ? `Списание по продажам не работает: не обработано продаж ${late}${typeof f['not_processed_since'] === 'string' ? ` с ${almatyDateTime(f['not_processed_since'])}` : ''}. Сообщите владельцу.`
          : '';
      const blocked =
        num(f['blocked']) > 0
          ? `Не списано продаж: ${num(f['blocked'])}. Разберите в «Остатки» - «Списание по продажам» или поясните.`
          : '';
      return [stalled, blocked].filter(Boolean).join(' ') || 'Заблокированных списаний нет.';
    }
    default:
      return CHECK_LABELS[check.status];
  }
}
export type ItemProblem = { code: string; problem: 'missing' | 'comment' | 'unknown' };
/** The server rule (backoffice-core checklistProblems): what blocks a complete phase. */
export function answerProblems(
  items: readonly ChecklistItem[],
  answers: readonly Answer[],
  checks: Readonly<Record<string, Check>>,
): ItemProblem[] {
  const out: ItemProblem[] = answers
    .filter((a) => !items.some((i) => i.code === a.code))
    .map((a) => ({ code: a.code, problem: 'unknown' as const }));
  for (const item of items) {
    const check = item.auto ? checks[item.auto] : undefined;
    const answer = answers.find((a) => a.code === item.code);
    if (!answer) {
      if (item.required && check?.status !== 'off')
        out.push({ code: item.code, problem: 'missing' });
      continue;
    }
    if (
      (answer.status !== 'done' || check?.status === 'problem') &&
      (answer.comment ?? '').trim().length < 3
    )
      out.push({ code: item.code, problem: 'comment' });
  }
  return out;
}
/** Does this item need a comment with this answer? (Shown next to the field.) */
export const needsComment = (item: ChecklistItem, answer: Answer | undefined, checks: Data) =>
  !!answer &&
  (answer.status !== 'done' ||
    (item.auto !== null && (checks[item.auto] as Check | undefined)?.status === 'problem'));
export function problemText(problems: readonly ItemProblem[], items: readonly ChecklistItem[]) {
  if (!problems.length) return '';
  const label = (code: string) => items.find((i) => i.code === code)?.label ?? code;
  const missing = problems.filter((p) => p.problem === 'missing').map((p) => label(p.code));
  const comment = problems.filter((p) => p.problem === 'comment').map((p) => label(p.code));
  return [
    missing.length ? `Ответьте на пункты: ${missing.join('; ')}.` : '',
    comment.length ? `Нужен комментарий (минимум 3 символа): ${comment.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
/** «Смена открыта · менеджер ...» */
export function shiftTitle(shift: ManagerShift) {
  const who = shift.manager_name ?? shift.opened_by_name ?? 'не указан';
  return shift.state === 'open'
    ? `Смена открыта · менеджер ${who}`
    : `Смена закрыта · менеджер ${who}`;
}
/** Answers with a problem or «не применимо» in a stored phase, for the history. */
export function remarks(items: readonly StoredAnswer[] | undefined) {
  return (items ?? []).filter((a) => a.status !== 'done' || a.comment);
}
export function openCommand(id: string, manager: string | null, answers: readonly Answer[]): Data {
  return {
    type: 'manager_shift_open',
    id,
    manager_employee_id: manager || null,
    items: answers.map(clean),
    expected_revision: 0,
  };
}
const clean = (a: Answer): Answer => {
  const comment = (a.comment ?? '').trim();
  return { code: a.code, status: a.status, comment: comment ? comment : null };
};
export function closeCommand(
  shift: ManagerShift,
  answers: readonly Answer[],
  handover: string,
): Data {
  return {
    type: 'manager_shift_close',
    id: shift.id,
    items: answers.map(clean),
    handover: handover.trim(),
    expected_revision: shift.revision,
  };
}
export function draftCommand(
  shift: ManagerShift,
  answers: readonly Answer[],
  handover: string,
): Data {
  return {
    type: 'manager_shift_save',
    id: shift.id,
    phase: 'closing',
    items: answers.map(clean),
    handover: handover.trim(),
    expected_revision: shift.revision,
  };
}
export function templateCommand(
  version: number,
  opening: readonly ChecklistItem[],
  closing: readonly ChecklistItem[],
): Data {
  const fix = (i: ChecklistItem) => ({
    code: i.code,
    label: i.label.trim(),
    auto: i.auto,
    required: i.required,
  });
  return {
    type: 'manager_shift_template',
    opening: opening.map(fix),
    closing: closing.map(fix),
    expected_version: version,
  };
}
/** A new item code that no phase has yet. */
export function newItemCode(items: readonly ChecklistItem[]) {
  let n = 1;
  while (items.some((i) => i.code === `item_${n}`)) n++;
  return `item_${n}`;
}
