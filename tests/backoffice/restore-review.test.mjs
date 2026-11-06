import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allowed } from '../../apps/backoffice/server.mjs';
import { allowedPath } from '../../apps/backoffice/dist/api.js';
import { withCatalog } from './helpers.mjs';

test('restore review proxy only exposes scoped read and decision routes', () => {
  const id = randomUUID(),
    path = `/v1/admin/backoffice/branches/${id}/restore-reviews`;
  for (const suffix of ['', `?after=${randomUUID()}`]) {
    assert.equal(allowed('GET', path + suffix), true);
    assert.equal(allowedPath(`operations/branches/${id}/restore-reviews` + suffix), true);
  }
  assert.equal(allowed('POST', path), true);
  for (const suffix of [
    '?after=bad',
    `?after=${id}&after=${id}`,
    '?token=bad',
    '#extra',
    '/other',
  ]) {
    assert.equal(allowed('GET', path + suffix), false);
    assert.equal(allowedPath(`operations/branches/${id}/restore-reviews` + suffix), false);
  }
  for (const method of ['DELETE', 'PUT', 'PATCH']) assert.equal(allowed(method, path), false);
  assert.equal(allowed('POST', path + '?after=' + id), false);
});
test('actual restore review endpoint enforces authentication and branch grants', () =>
  withCatalog(async (c) => {
    const path = `${c.url}/v1/admin/backoffice/branches/${c.branch}/restore-reviews`;
    assert.equal((await fetch(path)).status, 401);
    const headers = {
      Authorization: `Bearer ${c.manager.token}`,
      'Content-Type': 'application/json',
    };
    const response = await fetch(path, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { installed: true, items: [], next: null });
    assert.equal((await fetch(path.replace(c.branch, randomUUID()), { headers })).status, 403);
    assert.equal(
      (
        await fetch(path, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            commandId: randomUUID(),
            eventId: randomUUID(),
            expectedVersion: 1,
            reason: 'Synthetic check',
          }),
        })
      ).status,
      404,
    );
  }));

// UI protocol fixture; receiver persistence is separately covered with PostgreSQL.
const browserScript =
  "import json,sys\nfrom pathlib import Path\nfrom playwright.sync_api import sync_playwright,expect\nc=json.loads(Path(sys.argv[1]).read_text());sent=[]\nwith sync_playwright() as pw:\n browser=pw.chromium.launch()\n page=browser.new_page(viewport={'width':1440,'height':960});page.set_default_timeout(15000)\n errors=[];page.on('pageerror',lambda e:errors.append(str(e)))\n row={'event_id':'10000000-0000-4000-8000-000000000010','display_number':'17','canonical_state':'handed_over','observed_state':'in_production','reviewed_at':None}\n def route(r):\n  if r.request.method=='POST':\n   sent.append(r.request.post_data_json)\n   if len(sent)==1:r.fulfill(status=503,json={'code':'SERVICE_UNAVAILABLE'})\n   else:\n    row['reviewed_at']='2026-11-03T15:00:00Z';row['review_reason']=sent[-1]['reason']\n    r.fulfill(json={'eventId':row['event_id'],'version':2,'reviewed':True})\n  else:r.fulfill(json={'installed':True,'items':[row],'next':None})\n page.route('**/restore-reviews',route)\n page.goto(c['url']+'#orders')\n page.get_by_test_id('credential-file').set_input_files({'name':'synthetic.json','mimeType':'application/json','buffer':json.dumps(c['manager']).encode()})\n def b(name):return page.get_by_role('button',name=name,exact=True)\n b('Проверка восстановления').click()\n expect(page.get_by_role('dialog')).to_contain_text('№17')\n for width in [1440,393]:\n  page.set_viewport_size({'width':width,'height':960})\n  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')\n  page.screenshot(path=c['output']+'/review-'+str(width)+'.png',full_page=True)\n b('Проверить').click()\n page.get_by_label('Результат проверки').fill('Сверили с кухней: заказ был выдан до восстановления.')\n b('Сохранить проверку').click()\n expect(b('Повторить тот же запрос')).to_be_visible()\n b('Повторить тот же запрос').click()\n expect(page.get_by_role('dialog')).to_have_count(1)\n expect(page.get_by_role('dialog')).to_contain_text('заказ был выдан')\n assert len(sent)==2 and sent[0]==sent[1]\n assert not errors,errors\n browser.close()\nprint('UI: desktop/mobile, reason, lost response and exact retry passed')\n";

test('restore review browser: responsive list and exact retry after an unknown response', () =>
  withCatalog(
    async (c) => {
      const output = resolve('.local/restore-review-browser');
      await mkdir(output, { recursive: true });
      const dir = await mkdtemp(output + '/run-');
      const fixture = dir + '/fixture.json';
      const script = dir + '/check.py';
      await writeFile(
        fixture,
        JSON.stringify({ url: c.url + '/backoffice/', manager: c.manager, output }),
        { mode: 0o600 },
      );
      await writeFile(script, browserScript);
      try {
        const code = await new Promise((ok, fail) => {
          const child = spawn(process.env.BACKOFFICE_TEST_PYTHON ?? 'python3', [script, fixture], {
            stdio: 'inherit',
          });
          const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
          child.once('error', (e) => {
            clearTimeout(timer);
            fail(e);
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            ok(code);
          });
        });
        assert.equal(code, 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice' },
  ));
