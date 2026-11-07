import { z } from 'zod';

/**
 * Manager shift of the back office (lane bo-ui step 6, owner decision 05.11; design-bo-ui.md 5.6,
 * design-backoffice.md section 2 А10, А11, Ск7): schemas, the built-in checklist and the pure
 * checklist rules. The database side is manager-shifts-store.ts. Everything runs only while
 * BACKOFFICE_MANAGER_SHIFTS_ENABLED is on and cloud075 with its rights is there.
 *
 * A checklist item is answered «Готово» (done), «Есть проблема» (problem) or «Не применимо»
 * (not_applicable); the last two need a comment. An item may read an automatic check (`auto`)
 * that the server computes on the fly for the business day of the shift (cash desks from
 * ops/pos-day, Webkassa receipts, waste, counts, blocked consumption, schedule, stop list):
 * - `problem` (an open cash desk, an unexplained discrepancy, unrecorded receipts, blocked
 *   sales) needs a comment whatever the answer: the comment is the explanation;
 * - `no_data` (the cash desks send nothing) needs a manual answer;
 * - `off` (the feature behind it is not running, e.g. automatic consumption) makes the item
 *   optional.
 * The answer stores the label and the check as they were, so a closed shift reads the same later.
 */

/** Automatic checks a checklist item may read (manager-shifts-store.ts managerShiftChecks). */
export const MANAGER_SHIFT_AUTO = [
  'attendance',
  'stoplist',
  'cash_float',
  'cash_shifts',
  'webkassa_receipts',
  'waste',
  'key_count',
  'blocked_consumption',
] as const;
export type ManagerShiftAuto = (typeof MANAGER_SHIFT_AUTO)[number];
export const ANSWER_STATUSES = ['done', 'problem', 'not_applicable'] as const;
export type CheckStatus = 'ok' | 'problem' | 'no_data' | 'off';
export type ManagerShiftCheck = { status: CheckStatus; facts: Record<string, unknown> };

const itemCode = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
export const ChecklistItemSchema = z.strictObject({
  code: itemCode,
  label: z.string().trim().min(1).max(120),
  auto: z.enum(MANAGER_SHIFT_AUTO).nullable(),
  required: z.boolean(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
const phaseItems = z.array(ChecklistItemSchema).min(1).max(30);
/** A checklist: item codes unique over both phases, each check read at most once per phase. */
export const ChecklistTemplateSchema = z
  .strictObject({ opening: phaseItems, closing: phaseItems })
  .superRefine((t, ctx) => {
    const codes = [...t.opening, ...t.closing].map((i) => i.code);
    if (new Set(codes).size !== codes.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate checklist item' });
    for (const phase of [t.opening, t.closing]) {
      const autos = phase.map((i) => i.auto).filter((a) => a !== null);
      if (new Set(autos).size !== autos.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate automatic check' });
    }
  });
export type ChecklistTemplate = z.infer<typeof ChecklistTemplateSchema>;

const item = (
  code: string,
  label: string,
  auto: ManagerShiftAuto | null = null,
  required = true,
): ChecklistItem => Object.freeze({ code, label, auto, required });
/**
 * Version 1, the built-in checklist (design-bo-ui 5.6): opening А10, closing А11 and Ск7. The
 * handover text is not an item: closing always asks for it.
 */
export const MANAGER_SHIFT_TEMPLATE_V1: Readonly<ChecklistTemplate> = Object.freeze({
  opening: Object.freeze([
    item('attendance', 'Явка по графику: все на месте', 'attendance'),
    item('meat_prep', 'Мясо и заготовки по срокам: просроченное списано'),
    item('equipment', 'Оборудование работает: фритюр, тепловой шкаф, холодильники'),
    item('screens', 'Касса и экраны кухни включены'),
    item('cash_float', 'Разменный фонд на месте', 'cash_float'),
    item('stoplist', 'Стоп-лист проверен', 'stoplist'),
  ]) as ChecklistItem[],
  closing: Object.freeze([
    item('cash_shifts', 'Кассовые смены закрыты, расхождения пояснены', 'cash_shifts'),
    item('cash_handover', 'Наличные сданы'),
    item('webkassa_receipts', 'Все чеки оформлены в Webkassa', 'webkassa_receipts'),
    item('webkassa_shift', 'Смена Webkassa закрыта'),
    item('waste', 'Списания за день внесены', 'waste'),
    item('key_count', 'Подсчёт ключевых позиций проведён', 'key_count'),
    item('courier_incidents', 'Инциденты курьеров записаны'),
    item('blocked_consumption', 'Заблокированных списаний по продажам нет', 'blocked_consumption'),
  ]) as ChecklistItem[],
});

export const ChecklistAnswerSchema = z.strictObject({
  code: itemCode,
  status: z.enum(ANSWER_STATUSES),
  comment: z.string().trim().max(500).nullable(),
});
export type ChecklistAnswer = z.infer<typeof ChecklistAnswerSchema>;
const answers = z
  .array(ChecklistAnswerSchema)
  .max(30)
  .refine((v) => new Set(v.map((a) => a.code)).size === v.length);
const revision = z.number().int().min(1).max(2147483646);
/** The handover text of a closing: required (3+ characters after trim), up to 2000. */
export const HANDOVER_MAX = 2000;
const handover = z.string().max(HANDOVER_MAX);

export const ManagerShiftOpenCommand = z.strictObject({
  type: z.literal('manager_shift_open'),
  id: z.uuid(),
  manager_employee_id: z.uuid().nullable(),
  items: answers,
  expected_revision: z.literal(0),
});
export const ManagerShiftSaveCommand = z.strictObject({
  type: z.literal('manager_shift_save'),
  id: z.uuid(),
  phase: z.enum(['opening', 'closing']),
  items: answers,
  handover: handover.optional(),
  expected_revision: revision,
});
export const ManagerShiftCloseCommand = z.strictObject({
  type: z.literal('manager_shift_close'),
  id: z.uuid(),
  items: answers,
  handover,
  expected_revision: revision,
});
export const ManagerShiftTemplateCommand = z.strictObject({
  type: z.literal('manager_shift_template'),
  opening: phaseItems,
  closing: phaseItems,
  expected_version: z.number().int().min(1).max(2147483646),
});
/** The manager shift commands (BACKOFFICE_MANAGER_SHIFTS_ENABLED). */
export const MANAGER_SHIFT_COMMANDS: readonly string[] = Object.freeze([
  'manager_shift_open',
  'manager_shift_save',
  'manager_shift_close',
  'manager_shift_template',
]);

export type ChecklistProblem = { code: string; problem: 'unknown' | 'missing' | 'comment' };
const commented = (a: ChecklistAnswer) => (a.comment ?? '').trim().length >= 3;
/**
 * What keeps a phase from being complete: an answer to an item the checklist does not have, a
 * required item without an answer (unless its check is `off`), a «problem» or «not applicable»
 * answer without a comment, and an item whose check reports a problem without a comment.
 * `partial` (a saved draft of a closing) reports unknown items only.
 */
export function checklistProblems(
  items: readonly ChecklistItem[],
  given: readonly ChecklistAnswer[],
  checks: Readonly<Partial<Record<ManagerShiftAuto, ManagerShiftCheck>>>,
  partial = false,
): ChecklistProblem[] {
  const known = new Map(items.map((i) => [i.code, i]));
  const out: ChecklistProblem[] = given
    .filter((a) => !known.has(a.code))
    .map((a) => ({ code: a.code, problem: 'unknown' as const }));
  if (partial) return out;
  for (const i of items) {
    const check = i.auto ? checks[i.auto] : undefined;
    const a = given.find((g) => g.code === i.code);
    if (!a) {
      if (i.required && check?.status !== 'off') out.push({ code: i.code, problem: 'missing' });
      continue;
    }
    if ((a.status !== 'done' || check?.status === 'problem') && !commented(a))
      out.push({ code: i.code, problem: 'comment' });
  }
  return out;
}
export type StoredAnswer = {
  code: string;
  label: string;
  auto: ManagerShiftAuto | null;
  status: ChecklistAnswer['status'];
  comment: string | null;
  check: ManagerShiftCheck | null;
};
/** Answers in checklist order with the label and the check as they were (history). */
export function storedAnswers(
  items: readonly ChecklistItem[],
  given: readonly ChecklistAnswer[],
  checks: Readonly<Partial<Record<ManagerShiftAuto, ManagerShiftCheck>>>,
): StoredAnswer[] {
  const out: StoredAnswer[] = [];
  for (const i of items) {
    const a = given.find((g) => g.code === i.code);
    if (!a) continue;
    const comment = (a.comment ?? '').trim();
    out.push({
      code: i.code,
      label: i.label,
      auto: i.auto,
      status: a.status,
      comment: comment ? comment : null,
      check: i.auto ? (checks[i.auto] ?? null) : null,
    });
  }
  return out;
}
