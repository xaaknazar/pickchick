import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

const kiosk = createRequire(new URL('../../apps/kiosk/package.json', import.meta.url));
const platform = createRequire(new URL('../../packages/platform/package.json', import.meta.url));
const nest = createRequire(platform.resolve('@nestjs/platform-express'));
const express = nest('express');
const expressRequire = createRequire(nest.resolve('express'));

test('oversized constrained collections fail before validating attacker-controlled elements', () => {
  const { z } = kiosk('zod');
  let visited = 0;
  const schema = z
    .array(
      z.string().transform((v) => {
        visited++;
        return v;
      }),
    )
    .max(2);
  const result = schema.safeParse(Array(100_000).fill('value'));
  assert.equal(result.success, false);
  assert.equal(visited, 0);
  assert.equal(result.error.issues.length, 1);
  assert.deepEqual(schema.parse(['one', 'two']), ['one', 'two']);
});

test('Expo plugin schemas and MCP command schema still validate with patched Zod', () => {
  for (const app of ['kiosk', 'mobile']) {
    const appRequire = createRequire(new URL(`../../apps/${app}/package.json`, import.meta.url));
    const expo = createRequire(appRequire.resolve('expo/package.json'));
    const cli = createRequire(expo.resolve('@expo/cli/package.json'));
    const { PluginSchema, DevToolsPluginOutputSchema } = cli(
      './build/src/start/server/DevToolsPlugin.schema.js',
    );
    const { createMCPDevToolsExtensionSchema } = cli(
      './build/src/start/server/createMCPDevToolsExtensionSchema.js',
    );
    const plugin = PluginSchema.parse({
      packageName: 'fixture',
      packageRoot: '/fixture',
      cliExtensions: {
        description: 'Fixture only',
        entryPoint: 'fixture.js',
        commands: [
          {
            name: 'inspect',
            title: 'Inspect',
            environments: ['mcp'],
            parameters: [{ name: 'count', type: 'number' }],
          },
        ],
      },
    });
    const schema = createMCPDevToolsExtensionSchema(plugin);
    assert.deepEqual(schema.parse({ command: 'inspect', count: 2 }), {
      command: 'inspect',
      count: 2,
    });
    for (const bad of [
      { command: 'unknown' },
      { command: 'inspect', count: '2' },
      { command: 'inspect', extra: true },
    ])
      assert.equal(schema.safeParse(bad).success, false);
    assert.equal(
      DevToolsPluginOutputSchema.safeParse([{ type: 'text', text: 'ok', level: 'info' }]).success,
      true,
    );
    assert.equal(
      DevToolsPluginOutputSchema.safeParse([{ type: 'audio', url: 'not a URL' }]).success,
      false,
    );
  }
});

async function listen(t, app) {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return server.address().port;
}
function post(port, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('compressed request with trailing garbage cannot terminate the HTTP parser', async (t) => {
  const app = express();
  app.use(expressRequire('body-parser').json());
  app.post('/', (_req, res) => res.sendStatus(204));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    res.sendStatus(400);
  });
  const port = await listen(t, app);
  const malformed = Buffer.concat([gzipSync('{"value":1}'), Buffer.from('invalid trailing bytes')]);
  assert.equal(
    await post(port, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, malformed),
    400,
  );
  assert.equal(await post(port, { 'content-type': 'application/json' }, '{"value":2}'), 204);
});

test('late asynchronous multer file filter after request abort leaves server usable', async (t) => {
  const app = express();
  let entered;
  const filterEntered = new Promise((resolve) => {
    entered = resolve;
  });
  let finish;
  const upload = nest('multer')({
    fileFilter: (_req, _file, callback) => {
      finish = callback;
      entered();
    },
  }).single('file');
  app.post('/', upload, (_req, res) => res.sendStatus(204));
  app.get('/health', (_req, res) => res.sendStatus(204));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    res.sendStatus(400);
  });
  const port = await listen(t, app);
  const req = request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=fixture' },
  });
  req.on('error', () => {});
  req.write(
    '--fixture\r\nContent-Disposition: form-data; name="file"; filename="fixture.txt"\r\nContent-Type: text/plain\r\n\r\npartial data',
  );
  await filterEntered;
  req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  finish(null, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 204);
});
