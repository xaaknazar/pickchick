import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createRoadmapServer } from '../server.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'roadmap-test-'));
  const assetDir = join(dir, 'app');
  await mkdir(assetDir);
  const project = {
    tasks: [
      {
        id: 'pos-pilot',
        checks: { implemented: true, verified: false, deployed: false, accepted: false },
      },
    ],
    meta: { sourceSha: 'a'.repeat(40) },
  };
  await writeFile(join(assetDir, 'project.json'), JSON.stringify(project));
  await writeFile(join(assetDir, 'index.html'), '<main>Roadmap login</main>');
  const config = {
    assetDir,
    dataDir: join(dir, 'data'),
    key: 'test-only-key-'.repeat(4),
    origin: 'https://roadmap.example',
  };
  let server;
  let url;
  const start = async (changes = {}) => {
    server = await createRoadmapServer({ ...config, ...changes });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}/roadmap/`;
  };
  const stop = async () => {
    if (!server?.listening) return;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  await start();
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  const request = (path, options = {}) => fetch(url + path, options);
  const post = (path, body, cookie, origin = config.origin) =>
    request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const login = async () => {
    const response = await post('api/session', { key: config.key });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie');
  };
  return { request, post, login, start, stop, config, getUrl: () => url };
}
const review = (extra = {}) => ({
  expectedVersion: 0,
  status: 'active',
  result: 'passed',
  author: 'Проверяющий',
  note: 'Сценарий выполнен на тестовом стенде.',
  ...extra,
});

test('private data requires session; login, CSRF, logout and security headers', async (t) => {
  const f = await fixture(t);
  const landing = await f.request('');
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await f.request('api/project')).status, 401);
  assert.equal((await f.request('project.json')).status, 404);
  assert.equal(
    (await f.post('api/session', { key: f.config.key }, null, 'https://attacker.example')).status,
    403,
  );
  assert.equal((await f.post('api/session', { key: 'bad' })).status, 401);
  const cookie = await f.login();
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/roadmap/'])
    assert.ok(cookie.includes(flag));
  assert.equal((await f.request('api/project', { headers: { Cookie: cookie } })).status, 200);
  assert.equal(
    (await f.post('api/reviews/pos-pilot', review(), cookie, 'https://attacker.example')).status,
    403,
  );
  const logout = await f.request('api/session', {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: f.config.origin },
  });
  assert.equal(logout.status, 200);
  assert.equal((await f.request('api/project', { headers: { Cookie: cookie } })).status, 401);
});

test('concurrent reviewers cannot overwrite; history survives process restart; repository facts unchanged', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const attempts = await Promise.all([
    f.post('api/reviews/pos-pilot', review(), cookie),
    f.post('api/reviews/pos-pilot', review({ note: 'Другое замечание' }), cookie),
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  await f.stop();
  await f.start();
  let data = await (await f.request('api/project', { headers: { Cookie: cookie } })).json();
  assert.equal(data.state.revision, 1);
  assert.equal(data.state.reviews['pos-pilot'].version, 1);
  assert.equal(data.tasks[0].checks.verified, false);
  assert.equal(data.tasks[0].checks.accepted, false);
  assert.equal(
    (
      await f.post(
        'api/reviews/pos-pilot',
        review({ expectedVersion: 1, result: 'failed', note: 'Обнаружено повторение заказа.' }),
        cookie,
      )
    ).status,
    200,
  );
  data = await (await f.request('api/project', { headers: { Cookie: cookie } })).json();
  assert.equal(data.state.revision, 2);
  assert.equal(data.state.history.length, 2);
  assert.equal(data.state.history[1].result, 'passed');
  assert.equal(data.state.history[0].result, 'failed');
});

test('invalid task, arbitrary fields and unsubstantiated check result are rejected', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  assert.equal((await f.post('api/reviews/unknown', review(), cookie)).status, 404);
  for (const invalid of [
    { expectedVersion: -1 },
    { checks: { accepted: true } },
    { result: 'paid' },
    { note: '' },
    { author: '' },
    { note: 'x'.repeat(4001) },
  ]) {
    assert.equal((await f.post('api/reviews/pos-pilot', review(invalid), cookie)).status, 400);
  }
  assert.equal(
    (
      await f.request('api/reviews/pos-pilot', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: f.config.origin },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal(
    (await f.post('api/reviews/pos-pilot', review({ note: 'x'.repeat(17000) }), cookie)).status,
    413,
  );
});

test('rotating team key revokes previous sessions after restart', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  await f.stop();
  await f.start({ key: 'replacement-team-key-'.repeat(3) });
  assert.equal((await f.request('api/project', { headers: { Cookie: cookie } })).status, 401);
});

test('persistent login limit caps guesses', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal((await f.post('api/session', { key: 'bad' })).status, 401);
  await f.stop();
  await f.start();
  const limited = await f.post('api/session', { key: f.config.key });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('Russian review text survives UTF-8 characters split across HTTP chunks', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const body = Buffer.from(
    JSON.stringify(review({ author: 'Проверка', note: 'Проверено: бургер и фингерсы' })),
  );
  const split = body.indexOf(Buffer.from('Проверка')) + 1;
  const responseStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(
      f.getUrl() + 'api/reviews/pos-pilot',
      {
        method: 'POST',
        headers: { Cookie: cookie, Origin: f.config.origin, 'Content-Type': 'application/json' },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    req.on('error', reject);
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 10);
  });
  assert.equal(responseStatus, 200);
  await f.stop();
  await f.start();
  const data = await (await f.request('api/project', { headers: { Cookie: cookie } })).json();
  assert.equal(data.state.reviews['pos-pilot'].author, 'Проверка');
  assert.equal(data.state.reviews['pos-pilot'].note, 'Проверено: бургер и фингерсы');
});
