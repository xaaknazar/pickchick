// Lane bo-ui step 6 in the cabinet («Смена менеджера», positions; design-bo-ui 5.6, 5.7): the
// gates, the allowlists of the two views, the checklist rules (the same as the server's), the
// texts of the automatic checks, the commands and the «Доступы» column. Pure functions of the
// built cabinet and the core, no PostgreSQL. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allowedPath } from '../../apps/backoffice/dist/api.js';
import { allowed } from '../../apps/backoffice/server.mjs';
import {
  RIGHTS_TEXT,
  commandPermission,
  managerShiftsAvailable,
  permitted,
  staffPositionsAvailable,
} from '../../apps/backoffice/dist/operations-model.js';
import { auditAction } from '../../apps/backoffice/dist/audit-model.js';
import {
  answerProblems,
  checkText,
  closeCommand,
  draftCommand,
  managerShiftsView,
  needsComment,
  newItemCode,
  openCommand,
  problemText,
  remarkLine,
  shiftChecklist,
  shiftTitle,
  templateCommand,
} from '../../apps/backoffice/dist/manager-shift-model.js';
import {
  accessText,
  extraText,
  positionPayload,
  rosterFileName,
  rosterSummary,
  selectablePositions,
  staffPositions,
} from '../../apps/backoffice/dist/staff-positions-model.js';
import {
  MANAGER_SHIFT_TEMPLATE_V1,
  STAFF_POSITIONS_V1,
  checklistProblems,
} from '../../packages/backoffice-core/dist/index.js';

const LONG_DASH = /[–—]/;

test('gates and allowlists: two GET views, exact queries, absent without the capability', () => {
  assert.equal(managerShiftsAvailable({ capabilities: {} }), false);
  assert.equal(managerShiftsAvailable({ capabilities: { manager_shifts: false } }), false);
  assert.equal(managerShiftsAvailable({ capabilities: { manager_shifts: true } }), true);
  assert.equal(staffPositionsAvailable(null), false);
  assert.equal(staffPositionsAvailable({ capabilities: { staff_positions: true } }), true);
  const branch = randomUUID();
  const cabinet = (path) => allowedPath(`operations/branches/${branch}/ops/${path}`);
  const proxy = (path, method = 'GET') =>
    allowed(method, `/v1/admin/backoffice/branches/${branch}/ops/${path}`);
  for (const check of [cabinet, proxy]) {
    assert.equal(check('manager-shifts'), true);
    assert.equal(check('manager-shifts?date=2026-11-19'), true);
    assert.equal(check('manager-shifts?date=19.11.2026'), false);
    assert.equal(check('manager-shifts?date=2026-11-19&date=2026-11-20'), false);
    assert.equal(check('manager-shifts?state=open'), false);
    assert.equal(check('staff-roster'), true);
    assert.equal(check('staff-roster?format=csv'), false);
  }
  assert.equal(proxy('manager-shifts', 'POST'), false);
  assert.equal(proxy('staff-roster', 'POST'), false);
});

test('permissions and rights in words: shift commands, template and positions', () => {
  assert.equal(commandPermission({ type: 'manager_shift_open' }), 'manager_shifts.write');
  assert.equal(commandPermission({ type: 'manager_shift_save' }), 'manager_shifts.write');
  assert.equal(commandPermission({ type: 'manager_shift_close' }), 'manager_shifts.write');
  assert.equal(commandPermission({ type: 'manager_shift_template' }), 'manager_shifts.template');
  assert.equal(commandPermission({ type: 'staff_positions_save' }), 'staff.positions');
  for (const key of ['manager_shifts.write', 'manager_shifts.template', 'staff.positions']) {
    assert.ok(RIGHTS_TEXT[key]);
    assert.doesNotMatch(RIGHTS_TEXT[key], LONG_DASH);
  }
  // Without roles the grant decides: the manager writes, the analyst reads.
  assert.equal(permitted({ role: 'manager' }, 'manager_shifts.write'), true);
  assert.equal(permitted({ role: 'analyst' }, 'manager_shifts.write'), false);
  assert.equal(
    permitted(
      { role: 'analyst', permissions: ['reports.read', 'manager_shifts.write'] },
      'manager_shifts.write',
    ),
    true,
  );
  for (const code of [
    'manager_shift_open',
    'manager_shift_close',
    'manager_shift_template',
    'staff_positions_save',
  ])
    assert.equal(auditAction(code).section, 'Смены', code);
});

test('the cabinet checklist rule is the server rule', () => {
  const items = MANAGER_SHIFT_TEMPLATE_V1.closing;
  const statuses = ['done', 'problem', 'not_applicable'];
  const checksSets = [
    {},
    {
      cash_shifts: { status: 'problem', facts: {} },
      blocked_consumption: { status: 'off', facts: {} },
    },
    { cash_shifts: { status: 'no_data', facts: {} } },
  ];
  // Every closing item answered in every way, with and without a comment.
  for (const checks of checksSets)
    for (const status of statuses)
      for (const comment of [null, 'ок', 'Расхождение пояснено']) {
        const answers = items.slice(1).map((i) => ({ code: i.code, status, comment }));
        assert.deepEqual(
          answerProblems(items, answers, checks),
          checklistProblems(items, answers, checks),
          JSON.stringify({ checks, status, comment }),
        );
      }
  const problems = answerProblems(
    items,
    [{ code: 'cash_handover', status: 'problem', comment: null }],
    { blocked_consumption: { status: 'off', facts: {} } },
  );
  const text = problemText(problems, items);
  assert.match(text, /^Ответьте на пункты: Кассовые смены закрыты, расхождения пояснены;/);
  assert.match(text, /Нужен комментарий \(минимум 3 символа\): Наличные сданы\./);
  assert.doesNotMatch(text, /Заблокированных списаний/, 'an off check is optional');
  assert.equal(
    needsComment(
      items[0],
      { code: items[0].code, status: 'done', comment: null },
      {
        cash_shifts: { status: 'problem', facts: {} },
      },
    ),
    true,
  );
});

test('texts of the automatic checks: money in tenge, Almaty time, no long dashes', () => {
  const at = '2026-11-19T16:10:00.000Z'; // 21:10 Almaty
  const cases = [
    [
      'cash_shifts',
      {
        status: 'problem',
        facts: {
          total: 2,
          closed: 2,
          open: 0,
          cash_discrepancy_minor: '-50000',
          terminal_discrepancy_minor: '0',
        },
      },
      'Кассовые смены: 2 из 2 закрыты, расхождение -500 ₸. Поясните в комментарии.',
    ],
    [
      'cash_shifts',
      {
        status: 'ok',
        facts: {
          total: 2,
          closed: 2,
          open: 0,
          cash_discrepancy_minor: '0',
          terminal_discrepancy_minor: '0',
        },
      },
      'Кассовые смены: 2 из 2 закрыты.',
    ],
    [
      'cash_shifts',
      { status: 'no_data', facts: { reason: 'stale', last_received_at: at } },
      'Данные кассы не поступают с 21:10. Подтвердите вручную.',
    ],
    [
      'cash_shifts',
      { status: 'no_data', facts: { reason: 'not_received' } },
      'Данные кассы не поступают. Подтвердите вручную.',
    ],
    [
      'webkassa_receipts',
      { status: 'problem', facts: { pending: 3, pending_minor: '1167000', recorded: 10 } },
      'Не оформлено в Webkassa: 3 чека на 11 670 ₸. Оформите или поясните.',
    ],
    [
      'webkassa_receipts',
      { status: 'ok', facts: { pending: 0, pending_minor: '0', recorded: 21 } },
      'Все чеки оформлены в Webkassa: 21.',
    ],
    [
      'cash_float',
      { status: 'ok', facts: { desks: [{ label: 'Касса 1', opening_cash_minor: '500000' }] } },
      'На открытии: Касса 1 5 000 ₸.',
    ],
    [
      'blocked_consumption',
      { status: 'off', facts: {} },
      'Списание по продажам не включено. Пункт необязателен.',
    ],
    [
      'blocked_consumption',
      { status: 'ok', facts: { blocked: 0, not_processed: 0, not_processed_since: null } },
      'Заблокированных списаний нет.',
    ],
    // Review BOUI-R2: a worker that does not run is a problem in words, never «нет».
    [
      'blocked_consumption',
      {
        status: 'problem',
        facts: { blocked: 0, not_processed: 4, not_processed_since: '2026-11-19T09:05:00.000Z' },
      },
      'Списание по продажам не работает: не обработано продаж 4 с 19.11.2026 14:05. Сообщите владельцу.',
    ],
    [
      'blocked_consumption',
      {
        status: 'problem',
        facts: { blocked: 2, not_processed: 1, not_processed_since: '2026-11-19T09:05:00.000Z' },
      },
      'Списание по продажам не работает: не обработано продаж 1 с 19.11.2026 14:05. Сообщите владельцу. Не списано продаж: 2. Разберите в «Остатки» - «Списание по продажам» или поясните.',
    ],
    [
      'key_count',
      { status: 'no_data', facts: { documents: 0, items: 0, last_at: null } },
      'Подсчёта за день нет. Проведите инвентаризацию ключевых позиций в «Остатки».',
    ],
  ];
  for (const [auto, check, text] of cases) {
    assert.equal(checkText(auto, check), text);
    assert.doesNotMatch(checkText(auto, check), LONG_DASH);
  }
  for (const item of [...MANAGER_SHIFT_TEMPLATE_V1.opening, ...MANAGER_SHIFT_TEMPLATE_V1.closing])
    assert.doesNotMatch(item.label, LONG_DASH);
});

test('view, title and commands', () => {
  const branch = randomUUID();
  assert.throws(() => managerShiftsView({ branch_id: randomUUID() }, branch), /INVALID_RESPONSE/);
  const shift = {
    id: randomUUID(),
    business_date: '2026-11-19',
    state: 'open',
    manager_employee_id: null,
    manager_name: 'Синтетический менеджер',
    opened_at: '2026-11-19T04:00:00.000Z',
    opened_by_name: 'Синтетический управляющий',
    closed_at: null,
    closed_by_name: null,
    template_version: 2,
    opening: { items: [] },
    closing: null,
    revision: 3,
  };
  const view = managerShiftsView(
    {
      branch_id: branch,
      date: '2026-11-19',
      template: { ...MANAGER_SHIFT_TEMPLATE_V1, version: 3, editable: true },
      open: shift,
      open_template: { ...MANAGER_SHIFT_TEMPLATE_V1, version: 2 },
      shifts: [shift],
      checks: {},
      checks_date: '2026-11-19',
    },
    branch,
  );
  assert.equal(shiftChecklist(view).version, 2, 'an open shift answers its own version');
  assert.equal(shiftTitle(shift), 'Смена открыта · менеджер Синтетический менеджер');
  assert.equal(
    shiftTitle({ ...shift, state: 'closed', manager_name: null }),
    'Смена закрыта · менеджер Синтетический управляющий',
  );
  const answers = [
    { code: 'cash_handover', status: 'problem', comment: '  Не хватает 500 тенге  ' },
  ];
  assert.deepEqual(openCommand(shift.id, '', answers), {
    type: 'manager_shift_open',
    id: shift.id,
    manager_employee_id: null,
    items: [{ code: 'cash_handover', status: 'problem', comment: 'Не хватает 500 тенге' }],
    expected_revision: 0,
  });
  assert.deepEqual(
    closeCommand(shift, [{ code: 'x', status: 'done', comment: ' ' }], ' Передал '),
    {
      type: 'manager_shift_close',
      id: shift.id,
      items: [{ code: 'x', status: 'done', comment: null }],
      handover: 'Передал',
      expected_revision: 3,
    },
  );
  assert.equal(draftCommand(shift, [], '').phase, 'closing');
  const command = templateCommand(3, MANAGER_SHIFT_TEMPLATE_V1.opening, [
    { code: 'item_1', label: '  Журнал холодильников  ', auto: null, required: false },
  ]);
  assert.equal(command.expected_version, 3);
  assert.equal(command.closing[0].label, 'Журнал холодильников');
  assert.equal(newItemCode([{ code: 'item_1' }, { code: 'item_2' }]), 'item_3');
});

test('positions: list gate, «Доступы», payload checks and the roster file', () => {
  const base = { capabilities: { staff_positions: true } };
  assert.equal(staffPositions({ capabilities: {}, staff_positions: {} }), null);
  assert.equal(staffPositions(base), null, 'a malformed answer draws nothing');
  const list = staffPositions({
    ...base,
    staff_positions: {
      version: 1,
      editable: true,
      positions: STAFF_POSITIONS_V1.map((p) => (p.code === 'runner' ? { ...p, active: false } : p)),
      updated_at: null,
      updated_by_name: null,
    },
  });
  assert.equal(list.positions.length, 11);
  assert.equal(
    selectablePositions(list).some((p) => p.code === 'runner'),
    false,
  );
  assert.equal(
    selectablePositions(list, ['runner']).some((p) => p.code === 'runner'),
    true,
  );
  const cashier = {
    name: 'Синтетическая кассир',
    active: true,
    position_code: 'cashier',
    extra_position_codes: ['issue', 'assembler'],
    pos_access: 'cashier',
  };
  assert.equal(accessText(list, cashier), 'Касса (PIN), экраны 2, 4 общим входом кухни');
  assert.equal(extraText(list, cashier), 'Выдача, Сборщик');
  assert.equal(
    accessText(list, {
      ...cashier,
      extra_position_codes: [],
      position_code: 'fryer',
      pos_access: 'none',
    }),
    'Нет',
  );
  assert.equal(
    accessText(list, { position_code: 'manager', pos_access: 'shift_manager', active: true }),
    'Касса: начальник смены (PIN)',
  );
  assert.equal(accessText(list, { ...cashier, active: false }), 'Нет: не работает');
  assert.deepEqual(
    positionPayload(list, {
      position_code: 'cashier',
      extra_position_codes: 'issue',
      pos_access: 'cashier',
    }),
    { position_code: 'cashier', extra_position_codes: ['issue'], pos_access: 'cashier' },
  );
  assert.deepEqual(positionPayload(list, {}), { extra_position_codes: [], pos_access: 'none' });
  assert.throws(
    () => positionPayload(list, { extra_position_codes: 'issue,prep,fryer,runner' }),
    /не больше 3/,
  );
  assert.throws(
    () => positionPayload(list, { position_code: 'issue', extra_position_codes: 'issue' }),
    /не может повторять/,
  );
  assert.equal(
    rosterFileName('2026-11-18T20:30:00.000Z'),
    'PickChick-состав-кассы-19.11.2026.json',
  );
  assert.equal(
    rosterSummary({ staff: [{ role: 'cashier' }, { role: 'shift_manager' }, { role: null }] }),
    'В выгрузке 3 карточки: кассиров 1, начальников смены 1. Остальные без доступа к кассе.',
  );
});

test('opening remarks (review BOUI-R8): «пункт - ответ» and the comment apart', () => {
  assert.deepEqual(
    remarkLine({
      label: 'Явка по графику: все на месте',
      status: 'problem',
      comment: ' Жарщик опоздал на 20 минут ',
    }),
    {
      text: 'Явка по графику: все на месте - Есть проблема',
      comment: 'Комментарий: Жарщик опоздал на 20 минут',
    },
  );
  assert.deepEqual(remarkLine({ label: 'Зал чистый', status: 'not_applicable', comment: null }), {
    text: 'Зал чистый - Не применимо',
    comment: null,
  });
  assert.equal(remarkLine({ label: 'Пункт', status: 'done', comment: '   ' }).comment, null);
});
