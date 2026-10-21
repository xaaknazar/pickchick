import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { withCatalog } from './helpers.mjs';
import { Finance } from '../../packages/backoffice-core/dist/finance.js';

const browserCheck = String.raw`
import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
c = json.loads(Path(sys.argv[1]).read_text())
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 960})
    page.set_default_timeout(10000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(c['url'] + '#finance')
    page.get_by_test_id('credential-file').set_input_files({
        'name': 'synthetic.json', 'mimeType': 'application/json',
        'buffer': json.dumps(c['manager']).encode(),
    })
    def b(name): return page.get_by_role('button', name=name, exact=True)
    b('Настройки').click()
    month = page.get_by_test_id('finance-period-month')
    month.fill('2026-08')
    panel = page.locator('section').filter(has=page.get_by_role('heading', name='Закрытие месяца', exact=True)).last
    # August has an explicitly open row; July has no row at all. Both must be explained truthfully.
    expect(panel).to_contain_text('Статус 2026-08: заблокирован закрытием 2026-09')
    expect(b('Открыть для исправлений')).to_be_disabled()
    expect(panel).to_contain_text('с последнего закрытого месяца: 2026-09')
    expect(panel.locator('tbody tr').filter(has_text='2026-08')).to_contain_text('Заблокирован закрытием 2026-09')
    month.fill('2026-07')
    expect(panel).to_contain_text('Статус 2026-07: заблокирован закрытием 2026-09')
    for width in [1440, 768, 393]:
        page.set_viewport_size({'width': width, 'height': 960})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        page.screenshot(path=str(Path(c['output']) / ('period-' + str(width) + '.png')), full_page=True)
    month.fill('2026-10')
    expect(panel).to_contain_text('Статус 2026-10: открыт')
    expect(b('Закрыть месяц')).to_be_enabled()
    month.fill('2026-09')
    expect(panel).to_contain_text('Статус 2026-09: закрыт')
    expect(b('Открыть для исправлений')).to_be_enabled()
    page.get_by_label('Причина закрытия / открытия', exact=True).fill('Synthetic UI reopening')
    b('Открыть для исправлений').click()
    expect(panel).to_contain_text('Статус 2026-09: открыт')
    month.fill('2026-08')
    expect(panel).to_contain_text('Статус 2026-08: открыт')
    assert errors == [], errors
    browser.close()
`;

test('period settings explain inherited locks and the reverse reopening order in the real browser', () =>
  withCatalog(
    async (c) => {
      const f = new Finance(c.cloud.pool, true);
      for (const [month, closed] of [
        ['2026-08-01', false],
        ['2026-09-01', true],
      ]) {
        await f.command(c.manager.token, c.branch, {
          request_id: randomUUID(),
          reason: 'Synthetic UI period fixture',
          command: { type: 'period', month, closed, expected_revision: 0 },
        });
      }
      const output = fileURLToPath(new URL('../../.local/finance-period-ui/', import.meta.url));
      await mkdir(output, { recursive: true });
      const dir = await mkdtemp(output + '/run-');
      try {
        await writeFile(dir + '/check.py', browserCheck);
        await writeFile(
          dir + '/fixture.json',
          JSON.stringify({
            url: c.url + '/backoffice/',
            manager: c.manager,
            output,
          }),
          { mode: 0o600 },
        );
        const code = await new Promise((resolve, reject) => {
          const p = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [dir + '/check.py', dir + '/fixture.json'],
            { stdio: 'inherit' },
          );
          const timer = setTimeout(() => p.kill('SIGKILL'), 90000);
          p.once('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          p.once('exit', (status) => {
            clearTimeout(timer);
            resolve(status);
          });
        });
        assert.equal(code, 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice' },
  ));
