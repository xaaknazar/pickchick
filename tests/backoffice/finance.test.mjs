import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  FinanceEntry,
  FinanceRequest,
  FinanceQuery,
  categories,
} from '../../packages/backoffice-core/dist/finance.js';
const entry = () => ({
  id: randomUUID(),
  kind: 'expense',
  amount_minor: '12345',
  cash_date: '2026-10-06',
  recognition_date: '2026-09-30',
  account_id: randomUUID(),
  to_account_id: null,
  category_id: 'rent',
  center: 'workshop',
  counterparty: 'Synthetic',
  reference: 'SYN-1',
  note: '',
});
test('cash and recognition dates are separate, amounts are exact minor units', () => {
  assert.equal(FinanceEntry.parse(entry()).amount_minor, '12345');
  assert.equal(FinanceEntry.safeParse({ ...entry(), account_id: null }).success, true);
  assert.equal(
    FinanceEntry.safeParse({ ...entry(), account_id: null, cash_date: null }).success,
    false,
  );
  for (const amount_minor of ['0', '-1', '1.5', '1e3', '001', '100000000000000'])
    assert.equal(FinanceEntry.safeParse({ ...entry(), amount_minor }).success, false);
  for (const cash_date of ['2026-02-30', '2026-99-99', '2026-00-01'])
    assert.equal(FinanceEntry.safeParse({ ...entry(), cash_date }).success, false);
});
test('inventory, investment and transfers cannot masquerade as profit', () => {
  for (const category_id of ['ingredients', 'equipment', 'repayment']) {
    assert.equal(FinanceEntry.safeParse({ ...entry(), category_id }).success, false);
    assert.equal(
      FinanceEntry.safeParse({ ...entry(), category_id, recognition_date: null }).success,
      true,
    );
  }
  const e = {
    ...entry(),
    kind: 'transfer',
    category_id: null,
    recognition_date: null,
    to_account_id: randomUUID(),
  };
  assert.equal(FinanceEntry.safeParse(e).success, true);
  assert.equal(FinanceEntry.safeParse({ ...e, account_id: null }).success, false);
  assert.equal(FinanceEntry.safeParse({ ...e, to_account_id: e.account_id }).success, false);
  assert.equal(FinanceEntry.safeParse({ ...e, recognition_date: '2026-10-01' }).success, false);
});
test('COGS, waste, barter and depreciation are noncash recognition entries', () => {
  for (const category_id of ['cogs', 'waste', 'barter', 'depreciation']) {
    assert.equal(FinanceEntry.safeParse({ ...entry(), category_id }).success, false);
    assert.equal(
      FinanceEntry.safeParse({
        ...entry(),
        kind: 'accrual_expense',
        cash_date: null,
        account_id: null,
        category_id,
      }).success,
      true,
    );
  }
  assert.equal(FinanceEntry.safeParse({ ...entry(), category_id: 'sales' }).success, false);
  assert.equal(FinanceEntry.safeParse({ ...entry(), unexpected: true }).success, false);
  assert.equal(new Set(categories.map((c) => c.id)).size, categories.length);
});
test('reports reject invalid windows and period commands require a real first day', () => {
  assert.equal(
    FinanceQuery.safeParse({ start_date: '2026-10-31', end_date: '2026-10-01' }).success,
    false,
  );
  assert.equal(
    FinanceQuery.safeParse({ start_date: '2025-01-01', end_date: '2026-10-01' }).success,
    false,
  );
  assert.equal(
    FinanceRequest.safeParse({
      request_id: randomUUID(),
      reason: 'Synthetic',
      command: { type: 'period', month: '2026-10-02', closed: true, expected_revision: 0 },
    }).success,
    false,
  );
});
