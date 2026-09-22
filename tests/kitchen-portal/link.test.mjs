import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { EdgeLink, validJob, validReply, MAX_REPLY } from '../../infra/kitchen-portal/link.mjs';
import { executeJob } from '../../infra/kitchen-portal/agent.mjs';
import { createPortal } from '../../infra/kitchen-portal/server.mjs';
const origin = 'https://kitchen.example',
  key = 'a'.repeat(64),
  terminals = { prep: randomUUID(), assembly: randomUUID(), display: randomUUID() };
const input = { method: 'GET', path: '/edge/v1/fulfillment/display', headers: {} };
const reply = (id, value = { items: [] }) => ({
  id,
  status: 200,
  body: Buffer.from(JSON.stringify(value)).toString('base64'),
});
async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}
function http(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { Host: 'kitchen.example', ...headers },
      },
      (res) => {
        const parts = [];
        res.on('data', (p) => parts.push(p));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(parts).toString(),
            headers: res.headers,
          }),
        );
      },
    );
    r.on('error', reject);
    r.end(body);
  });
}
test('expired/disconnected/restarted link reports unknown; delivered requests never auto-replay', async () => {
  const link = new EdgeLink({ timeoutMs: 35, pollMs: 100 });
  await assert.rejects(link.forward(input), /UNAVAILABLE/);
  const poll = link.poll();
  const result = link.forward(input);
  const job = await poll;
  await assert.rejects(result, /TIMEOUT/);
  assert.equal(link.reply(reply(job.id)), false);
  const controller = new AbortController();
  const waiting = link.poll(controller.signal);
  controller.abort();
  assert.equal(await waiting, null);
  const p = link.poll();
  const r = link.forward(input);
  await p;
  link.close();
  await assert.rejects(r, /UNAVAILABLE/);
  assert.equal(link.pending.size, 0);
  assert.equal(link.waiters.length, 0);
});
test('allowlist, capacity, duplicate reply and payload bounds', async () => {
  const link = new EdgeLink({ capacity: 1 });
  const p = link.poll();
  const r = link.forward(input);
  const job = await p;
  await assert.rejects(link.forward(input), /UNAVAILABLE/);
  assert.equal(link.reply(reply(job.id)), true);
  assert.equal(link.reply(reply(job.id)), false);
  await r;
  for (const path of [
    '/edge/v1/orders',
    '/edge/v1/fulfillment/../orders',
    'http://evil/edge/v1/fulfillment/display',
    '/edge/v1/fulfillment/display?secret=yes',
  ])
    assert.equal(validJob({ ...job, path }), false);
  assert.equal(validJob({ ...job, body: 'x' }), false);
  assert.equal(validJob({ ...job, headers: { host: 'evil' } }), false);
  assert.equal(validReply({ ...reply(job.id), body: '!!!!' }), false);
  assert.equal(validReply({ ...reply(job.id), status: 302 }), false);
  assert.equal(validReply(reply(job.id, { data: 'x'.repeat(MAX_REPLY) })), false);
  assert.equal(validReply(reply(job.id, { data: 'x'.repeat(1000000) })), true);
  link.close();
});
test('portal exposes exact modes, enforces credentials/origin/terminal and relays real HTTP', async () => {
  let seen = [];
  const edge = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ path: req.url, method: req.method, headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        req.url === '/edge/v1/staff/login' ? { authenticated: true } : { items: [{ number: '7' }] },
      ),
    );
  });
  const edgePort = await listen(edge),
    portal = await createPortal({ origin, key, terminals, branchLabel: 'Office' }),
    port = await listen(portal.server);
  try {
    assert.equal((await http(port, '/kitchen-link/poll')).status, 401);
    assert.equal(
      (
        await http(port, '/kitchen-link/poll', {
          headers: { Authorization: 'Bearer ' + key, Origin: origin },
        })
      ).status,
      401,
    );
    assert.equal((await http(port, '/kitchen-live/prep/edge/v1/fulfillment/kitchen')).status, 401);
    assert.equal(
      (
        await http(port, '/kitchen-live/prep/edge/v1/staff/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal((await http(port, '/kitchen-live/assets/server.mjs')).status, 404);
    const page = await http(port, '/kitchen/prep');
    assert.equal(page.status, 200);
    assert.match(page.body, /\/kitchen-live\/assets\/app.js/);
    const css = await http(port, '/kitchen-live/assets/styles.css');
    assert.match(css.body, /\/kitchen-live\/assets\/fonts/);
    for (const mode of Object.keys(terminals))
      assert.equal(
        JSON.parse((await http(port, `/kitchen-live/${mode}/config.json`)).body).terminalId,
        terminals[mode],
      );
    const auth = { Authorization: 'Bearer ' + 'b'.repeat(64), 'X-Terminal-ID': terminals.prep };
    assert.equal(
      (
        await http(
          port,
          '/kitchen-live/display/edge/v1/fulfillment/orders/' + randomUUID() + '/actions',
          { method: 'POST', headers: { ...auth, Origin: origin } },
        )
      ).status,
      403,
    );
    const poll = http(port, '/kitchen-link/poll', { headers: { Authorization: 'Bearer ' + key } });
    // Wait until an authenticated worker is actually available.
    while (!portal.link.online) await new Promise((r) => setTimeout(r, 5));
    const pending = http(port, '/kitchen-live/prep/edge/v1/fulfillment/kitchen', { headers: auth });
    const job = JSON.parse((await poll).body);
    assert.equal(job.headers['x-terminal-id'], terminals.prep);
    const result = await executeJob(job, edgePort);
    const ack = await http(port, '/kitchen-link/reply', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });
    assert.equal(ack.status, 204);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).items[0].number, '7');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.authorization, auth.Authorization);
    assert.equal(
      (await http(port, '/kitchen-live/assembly/edge/v1/fulfillment/kitchen', { headers: auth }))
        .status,
      401,
    );
  } finally {
    await portal.close();
    edge.closeAllConnections();
    await new Promise((r) => edge.close(r));
  }
});
test('agent rejects expired jobs, redirects and non-JSON, preserves command idempotency', async () => {
  let count = 0;
  const edge = createServer((req, res) => {
    count++;
    if (req.url.includes('display')) {
      res.writeHead(302, { location: '/private' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key: req.headers['idempotency-key'] }));
    }
  });
  const port = await listen(edge);
  try {
    const job = { ...input, id: randomUUID(), expiresAt: Date.now() + 10000 };
    assert.equal((await executeJob({ ...job, expiresAt: Date.now() - 1 }, port)).status, 504);
    assert.equal(count, 0);
    assert.equal((await executeJob(job, port)).status, 504);
    assert.equal(count, 1);
    const command = {
      ...job,
      method: 'POST',
      path: '/edge/v1/fulfillment/orders/' + randomUUID() + '/actions',
      headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      body: '{}',
    };
    for (let n = 0; n < 2; n++)
      assert.equal(
        JSON.parse(Buffer.from((await executeJob(command, port)).body, 'base64')).key,
        command.headers['idempotency-key'],
      );
  } finally {
    edge.closeAllConnections();
    await new Promise((r) => edge.close(r));
  }
});
