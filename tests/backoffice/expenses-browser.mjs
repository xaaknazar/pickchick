/* global document, innerWidth */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { withCatalog } from './helpers.mjs';

// «Расходы» in the cabinet against real HTTP and PostgreSQL (cloud077), clock 20.11.2026 Almaty.
// Needs the Node Playwright (not in the CI glob, run by hand):
//   node --env-file=.env --test tests/backoffice/expenses-browser.mjs
// Screenshots: .local/expenses-browser/.
const { chromium } = createRequire(import.meta.url)('playwright');
const NOW = () => new Date('2026-11-20T07:00:00Z');
test('«Расходы»: the grid saves each cell, cash reconciliation, journal, P&L, analytics, month close', () =>
  withCatalog(
    async (c) => {
      const output = fileURLToPath(new URL('../../.local/expenses-browser/', import.meta.url));
      await mkdir(output, { recursive: true });
      const browser = await chromium.launch();
      const errors = [];
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
        page.setDefaultTimeout(15000);
        page.on('pageerror', (e) => errors.push(String(e)));
        page.on('dialog', (d) => d.accept());
        await page.goto(c.url + '/backoffice/#expenses');
        await page.getByTestId('credential-file').setInputFiles({
          name: 'synthetic.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(c.manager)),
        });
        await page.getByTestId('expenses-tab-entry').waitFor();
        assert.equal(await page.getByTestId('nav-finance').count(), 0);
        await page.getByTestId('nav-expenses').waitFor();
        const saved = () =>
          page.getByTestId('expenses-save-state').filter({ hasText: 'Всё сохранено' }).waitFor();
        const cell = (category, source) =>
          page.locator(`[data-key="${c.branch}|${category}|${source}"]`);
        await cell('rent', 'bank').fill('150 000');
        await cell('rent', 'bank').press('Enter');
        await saved();
        await page.waitForFunction(
          () => document.activeElement?.getAttribute('data-row') === 'utilities',
        );
        await cell('taxi', 'cash').fill('3 000,50');
        await cell('taxi', 'cash').press('Tab');
        await saved();
        const rows = async () =>
          (
            await c.cloud.pool.query(
              'SELECT category,source,amount_minor::text a FROM bo_expense_entries ORDER BY category',
            )
          ).rows;
        await page.waitForFunction(() => true);
        for (let i = 0; i < 50 && (await rows()).length < 2; i++) await page.waitForTimeout(100);
        assert.deepEqual(await rows(), [
          { category: 'rent', source: 'bank', a: '15000000' },
          { category: 'taxi', source: 'cash', a: '300050' },
        ]);
        // A bad number is refused on the screen, Escape restores the cell.
        await cell('taxi', 'kaspi').fill('12abc');
        await cell('taxi', 'kaspi').press('Tab');
        await page.getByText('Введите сумму числом').waitFor();
        await cell('taxi', 'kaspi').focus();
        await cell('taxi', 'kaspi').press('Escape');
        // The cashier's count 0: the cash is 3 000,50 short of expected −3 000,50 → «!».
        await page.getByTestId('expenses-cash-counted').fill('0');
        await page.getByRole('button', { name: 'Сохранить кассу' }).click();
        await page
          .locator(`[data-testid="expenses-place-${c.branch}"] .expenses-status.mismatch`)
          .waitFor();
        // A record with a counterparty.
        await page.getByTestId('expenses-add-counterparty').click();
        await page.getByTestId('expenses-dialog-amount').fill('25 000');
        await page.getByTestId('expenses-dialog-save').click();
        await page.getByRole('heading', { name: 'Записи с контрагентом' }).waitFor();
        for (const [w, h] of [
          [1440, 960],
          [393, 852],
        ]) {
          await page.setViewportSize({ width: w, height: h });
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `width ${w}`,
          );
          await page.screenshot({ path: `${output}/entry-${w}.png`, fullPage: true });
        }
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.getByTestId('expenses-tab-journal').click();
        await page.getByText('Записей: 3').waitFor();
        await page.screenshot({ path: `${output}/journal.png`, fullPage: true });
        await page.getByTestId('expenses-tab-pnl').click();
        await page.getByRole('rowheader', { name: 'EBITDA', exact: true }).waitFor();
        await page.screenshot({ path: `${output}/pnl.png`, fullPage: true });
        await page.getByTestId('expenses-tab-analytics').click();
        await page.getByRole('heading', { name: 'Сравнение точек' }).waitFor();
        await page.screenshot({ path: `${output}/analytics.png`, fullPage: true });
        await page.getByTestId('expenses-tab-months').click();
        await page.getByTestId('expenses-month-2026-11').click();
        await page.getByText('ноябрь 2026 закрыт.').waitFor();
        await page.screenshot({ path: `${output}/months.png`, fullPage: true });
        await page.getByTestId('expenses-tab-entry').click();
        await page.getByText('Месяц закрыт, данные только для просмотра.').first().waitFor();
        assert.equal(await cell('rent', 'bank').evaluate((i) => i.readOnly), true);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    },
    { staticPrefix: '/backoffice', expenses: true, expensesNow: NOW },
  ));
