import test from 'node:test';
import assert from 'node:assert/strict';
import { excel, excelAmount } from '../../apps/backoffice/dist/expenses-model.js';
import { deviceStatus } from '../../apps/backoffice/dist/devices-model.js';

test('expenses CSV: staff text never starts an Excel formula, amounts stay numbers', () => {
  const out = excel([
    ['=HYPERLINK("http://x";"y")', '+7 700', '-скидка', '@a', excelAmount('-123450'), -5, 12],
  ]);
  const cells = out.slice(1).split(';');
  assert.equal(cells[0].startsWith(`"'=HYPERLINK`), true);
  assert.equal(out.includes("'+7 700;'-скидка;'@a;-1234,50;-5;12"), true);
});

test('a kiosk outside working mode is named without the word demo', () => {
  const s = deviceStatus({
    kind: 'kiosk',
    status: 'active',
    presence: { observed_at: new Date().toISOString(), state: 'active', issue: 'demo' },
  });
  assert.equal(/демо|тест/i.test(s.label + s.detail), false);
});
