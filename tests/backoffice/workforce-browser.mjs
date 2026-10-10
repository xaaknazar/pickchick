// Synthetic, loopback-only UI acceptance. This is not a production API/proxy test.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { Workforce } from '../../packages/backoffice-core/dist/workforce-store.js';
await withSyncDatabases(async ({ cloud, org, branch }) => {
  const manager = await provisionCatalogManager(cloud.pool, {
    organization_id: org,
    name: 'Тестовый управляющий',
    branch_ids: [branch],
  });
  await grantBackoffice(cloud.pool, manager.actor_id, branch, 'manager');
  const bo = new Backoffice(cloud.pool, true),
    workforce = new Workforce(cloud.pool, true);
  const request = (command) => ({
    request_id: randomUUID(),
    reason: 'Синтетическая проверка',
    command,
  });
  for (const [index, name] of ['Тестовый повар', 'Тестовый кассир', 'Тестовый сборщик'].entries()) {
    const employee_id = randomUUID();
    await bo.command(
      manager.token,
      branch,
      request({
        type: 'save',
        kind: 'employee',
        id: employee_id,
        expected_revision: 0,
        payload: {
          name,
          role: ['cook', 'cashier', 'assembler'][index],
          active: true,
          note: 'Синтетические данные',
        },
      }),
    );
    const save = (kind, payload) =>
      workforce.command(
        manager.token,
        branch,
        request({ type: 'save', kind, id: randomUUID(), expected_revision: 0, payload }),
      );
    await save('rate', {
      employee_id,
      effective_date: '2026-09-01',
      hourly_minor: String(100000 + index * 10000),
    });
    await save('plan', {
      employee_id,
      start: '2026-09-01T09:00:00+05:00',
      end: '2026-09-01T18:00:00+05:00',
      unpaid_break_minutes: 30,
      status: 'published',
      position: ['Повар', 'Кассир', 'Сборщик'][index],
    });
    if (index === 0)
      for (const day of ['2026-09-30', '2026-10-01']) {
        await save('plan', {
          employee_id,
          start: day + 'T09:00:00+05:00',
          end: day + 'T17:00:00+05:00',
          unpaid_break_minutes: 0,
          status: 'published',
          position: 'Повар',
        });
        await save('time', {
          employee_id,
          date: day,
          status: 'approved',
          attendance: 'worked',
          intervals: [{ start: day + 'T09:00:00+05:00', end: day + 'T17:00:00+05:00' }],
          source_event_ids: [],
          note: 'Переход месяца',
        });
      }
    await save('time', {
      employee_id,
      date: '2026-09-01',
      status: 'approved',
      attendance: 'worked',
      intervals: [
        { start: '2026-09-01T09:00:00+05:00', end: '2026-09-01T12:00:00+05:00' },
        { start: '2026-09-01T12:30:00+05:00', end: '2026-09-01T18:00:00+05:00' },
      ],
      source_event_ids: [],
      note: 'Проверено по журналу',
    });
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PickChick - проверка смен</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workforce.css"><style>body{margin:0;background:#f3f5f9}main{padding:24px;max-width:1300px;margin:auto} .fixture-note{background:#04143a;color:white;padding:12px 24px;font-size:14px}@media(max-width:700px){main{padding:16px}}</style><div class="fixture-note">PickChick · Синтетический стенд · Не рабочие данные</div><main id="app"></main><script type="module">
        import {WorkforceModel} from '/workforce-model.js';import {WorkforceView} from '/workforce.js';import {ApiError} from '/api.js';
        const root=document.querySelector('#app');let view;const render=()=>{root.replaceChildren();view?.render(root)};
        const model=new WorkforceModel(async(path,r)=>{const res=await fetch('/test/'+path,{method:r?.method??'GET',headers:{'Content-Type':'application/json'},...(r?{body:JSON.stringify(r.body)}:{})});const d=await res.json();if(!res.ok)throw new ApiError(d.code,res.status);return d},sessionStorage,render);view=new WorkforceView(model,render);model.month='2026-09-01';await model.scope('${manager.actor_id}','${branch}');</script></html>`);
        return;
      }
      if (url.pathname.startsWith('/test/')) {
        let result;
        if (req.method === 'GET')
          result = await workforce.read(manager.token, branch, url.searchParams.get('month'));
        else {
          let body = '';
          for await (const c of req) {
            body += c;
            if (body.length > 100000) throw Error('INVALID_REQUEST');
          }
          const input = JSON.parse(body);
          result = url.pathname.endsWith('/workforce/commands')
            ? await workforce.command(manager.token, branch, input)
            : await bo.command(manager.token, branch, input);
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
        return;
      }
      if (!/^\/[a-z-]+\.(css|js)$/.test(url.pathname)) {
        res.writeHead(404).end();
        return;
      }
      const bytes = await readFile(
        new URL('../../apps/backoffice/dist' + url.pathname, import.meta.url),
      );
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(bytes);
    } catch (e) {
      res
        .writeHead(e.code === 'CONFLICT' || e.code === 'NOT_READY' ? 409 : 400, {
          'Content-Type': 'application/json',
        })
        .end(JSON.stringify({ code: e.code ?? 'INVALID_REQUEST' }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await mkdir('.local/workforce-ui', { recursive: true });
    if (process.env.WORKFORCE_PREVIEW === 'true') {
      console.log('Synthetic workforce preview: ' + url);
      await new Promise((r) => {
        process.once('SIGINT', r);
        process.once('SIGTERM', r);
      });
    } else
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
          ['tests/backoffice/workforce-browser.py', url],
          { stdio: 'inherit' },
        );
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(Error('Workforce browser failed: ' + code)),
        );
      });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
