import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases, running } from '../helpers/sync.mjs';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import { provisionStaff, setStaffPin, setOrdering } from '@pickchick/local-orders';
import { createEdge } from '@pickchick/edge';
import { createPosServer } from '../../apps/pos/server.mjs';

// Two tiny real lossless WebP images (8x8). B is stored on the edge but the mock edge serves
// A's bytes under B's name, so the POS must reject it and show the fallback.
const WEBP_A = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvB8ABAAdQrcLXo/+BiOh/AAA=', 'base64');
const WEBP_B = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvB8ABAAdQnlIUuf+BiOh/AAA=', 'base64');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const auth = (c) => ({ sessionId: c.session_id, token: c.token });
const names = (ru) => ({ ru, kk: ru });

/** Loopback "edge" in front of the real edge: forwards everything, tampers one photo. */
async function mockEdge(target, tampered) {
  const server = createServer(async (req, res) => {
    if (req.url === `/edge/v1/media/${tampered}.webp`) {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      res.end(WEBP_A);
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = {};
    for (const name of ['authorization', 'x-staff-session-id', 'idempotency-key', 'content-type'])
      if (req.headers[name]) headers[name] = req.headers[name];
    try {
      const response = await fetch(target + req.url, {
        method: req.method,
        headers,
        redirect: 'error',
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

test('POS live menu: snapshot categories, verified hash photos, mid-draft publication and MENU_CHANGED re-quote', async () => {
  await withSyncDatabases(async (ctx) => {
    const good = sha(WEBP_A),
      bad = sha(WEBP_B);
    for (const bytes of [WEBP_A, WEBP_B])
      await ctx.edge.pool.query(
        "INSERT INTO menu_media(sha256,mime,bytes) VALUES ($1,'image/webp',$2)",
        [sha(bytes), bytes],
      );
    const category = (source_id, ru, sort_order) => ({
      id: randomUUID(),
      source_id,
      name: names(ru),
      sort_order,
    });
    const combos = category('combo', 'Комбо-наборы', 0),
      snacks = category('snacks', 'Хрустящие закуски', 1),
      drinks = category('drinks', 'Холодные напитки', 2);
    const product = (category_id, ru, price_minor, sort_order, image) => ({
      product_id: randomUUID(),
      variant_id: randomUUID(),
      category_id,
      name: names(ru),
      currency: 'KZT',
      price_minor,
      sort_order,
      ...(image ? { image, image_url: image.url } : {}),
    });
    const image = (digest) => ({ sha256: digest, url: `/assets/menu/${digest}.webp` });
    const combo = product(combos.id, 'Тест комбо', '249000', 0),
      nuggets = product(snacks.id, 'Наггетсы', '99000', 5, image(good)),
      sticks = product(snacks.id, 'Сырные палочки', '79000', 6, image(bad)),
      fries = product(snacks.id, 'Картофель фри', '69000', 1),
      lemonade = product(drinks.id, 'Лимонад', '59000', 0);
    const release = (version, items) => ({
      schema_version: 1,
      release_id: randomUUID(),
      branch_id: ctx.branch,
      version,
      published_at: new Date().toISOString(),
      // Snapshot order differs from sort_order on purpose.
      items,
      categories: [combos, snacks, drinks],
    });
    const releases = {
      1: release(1, [combo, nuggets, sticks, fries, lemonade]),
      2: release(2, [combo, { ...nuggets, price_minor: '119000' }, fries, lemonade]),
      3: release(3, [combo, { ...nuggets, price_minor: '129000' }, fries, lemonade]),
    };
    const publish = async (version) => {
      await applyMenu(
        ctx.edge.pool,
        ctx.branch,
        await publishMenu(ctx.cloud.pool, globalThis.structuredClone(releases[version])),
      );
      const { rows } = await ctx.edge.pool.query('SELECT release_id FROM active_menu');
      assert.equal(rows[0].release_id, releases[version].release_id, `menu v${version} applied`);
    };
    await publish(1);
    const terminal = randomUUID();
    const manager = await provisionStaff(ctx.edge.pool, ctx.branch, {
      staff_id: randomUUID(),
      terminal_id: terminal,
      name: 'Тестовый начальник',
      role: 'shift_manager',
    });
    await setOrdering(ctx.edge.pool, ctx.branch, auth(manager), randomUUID(), true, {
      expected_version: 1,
    });
    await setStaffPin(ctx.edge.pool, ctx.branch, auth(manager), '2468');
    const edge = await running(createEdge, ctx.edge.config);
    const mock = await mockEdge(edge.url, bad);
    // No operator category config: every label must come from the publication.
    const pos = createPosServer({
      edgePort: mock.address().port,
      branchLabel: 'Абая 62',
      terminalId: terminal,
    });
    await new Promise((r) => pos.listen(0, '127.0.0.1', r));
    const published = [];
    const control = createServer(async (req, res) => {
      const version = Number(/^\/publish\/(\d)$/.exec(req.url ?? '')?.[1]);
      try {
        if (req.method !== 'POST' || !releases[version]) throw new Error('bad control request');
        await publish(version);
        published.push(version);
        res.writeHead(204);
      } catch {
        res.writeHead(500);
      }
      res.end();
    });
    await new Promise((r) => control.listen(0, '127.0.0.1', r));
    const output = new URL('../../.local/pos-live-menu/', import.meta.url);
    await mkdir(output, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(fileURLToPath(new URL('run-', output)));
    try {
      const file = temp + '/fixture.json';
      await writeFile(
        file,
        JSON.stringify({
          url: `http://127.0.0.1:${pos.address().port}`,
          control: `http://127.0.0.1:${control.address().port}`,
          good,
          bad,
          output: fileURLToPath(output),
        }),
        { mode: 0o600 },
      );
      const exit = await new Promise((resolve, reject) => {
        const child = spawn(
          process.env.POS_TEST_PYTHON ?? 'python3',
          [fileURLToPath(new URL('live_menu_ui.py', import.meta.url)), file],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.stdout.on('data', (d) => process.stdout.write(d));
        child.stderr.on('data', (d) => process.stderr.write(d));
        child.on('error', reject);
        child.on('exit', resolve);
      });
      assert.equal(exit, 0, 'Live menu browser scenarios must pass');
      assert.deepEqual(published, [2, 3]);
      // Quotes are recorded on the edge: the rejected one never existed, the retry used v3.
      const quotes = (
        await ctx.edge.pool.query('SELECT release_id,total_minor FROM checkout_quotes')
      ).rows;
      assert.deepEqual(quotes, [{ release_id: releases[3].release_id, total_minor: '129000' }]);
      assert.equal(
        (await ctx.edge.pool.query('SELECT count(*)::int AS n FROM local_orders')).rows[0].n,
        0,
        'A menu change never creates or loses an order',
      );
    } finally {
      await new Promise((r) => control.close(r));
      await new Promise((r) => pos.close(r));
      await new Promise((r) => mock.close(r));
      await edge.app.close();
      await rm(temp, { recursive: true, force: true });
    }
  });
});
