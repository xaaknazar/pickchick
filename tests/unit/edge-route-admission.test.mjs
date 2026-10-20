import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { watchCheckoutOrder } from '../../packages/commerce-core/dist/index.js';
import { EdgeIdentityController } from '../../services/api/dist/edge-identity-controller.js';
import { CustomerCheckoutController } from '../../services/api/dist/customer-checkout-controller.js';

// Release fixes 19.10 (integration): every device-authenticated cashier edge route is admitted
// from the reserved edge budget (ops lane, HTTP_MAX_EDGE_IN_FLIGHT), including the key renewal
// controller the pos lane added. A route without the class would queue behind public traffic.
const source = new URL('../../services/api/src/', import.meta.url);
const ROUTE = 'pickchick:admission-route';

/** Decorator lines directly above a class or method (blank lines and comments allowed). */
function decoratorsAbove(lines, index) {
  const found = [];
  for (let i = index; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('@')) found.push(line);
    else if (line === '' || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*'))
      continue;
    else break;
  }
  return found;
}
function decoratorsBelow(lines, index) {
  const found = [];
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('@')) found.push(line);
    else if (line === '' || line.startsWith('//')) continue;
    else break;
  }
  return found;
}

test('every /internal/v1/edge route in the API source carries @EdgeDeviceRoute()', async () => {
  const files = (await readdir(source)).filter((name) => name.endsWith('.ts'));
  const routes = [];
  for (const name of files) {
    const lines = (await readFile(new URL(name, source), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      const match = line.match(
        /@(Controller|Get|Post|Put|Patch|Delete)\('(internal\/v1\/edge[^']*)'/,
      );
      if (!match) return;
      const decorators = [...decoratorsAbove(lines, index - 1), ...decoratorsBelow(lines, index)];
      routes.push({
        where: `${name}: ${match[2]}`,
        edge: decorators.includes('@EdgeDeviceRoute()'),
      });
    });
  }
  assert.ok(routes.length >= 6, `expected the edge controllers, found ${routes.length}`);
  assert.deepEqual(
    routes.filter((route) => !route.edge).map((route) => route.where),
    [],
    'edge routes outside the reserved edge admission budget',
  );
  assert.ok(routes.some((route) => route.where.includes('internal/v1/edge/identity')));
});

test('the compiled key renewal controller is admitted as an edge device route', () => {
  assert.deepEqual(Reflect.getMetadata(ROUTE, EdgeIdentityController), { kind: 'edge' });
});

// ops x mob: the customer order watch keeps the long-poll admission budget (ops) and the cheap
// change mark (mob 2.8). In overflow mode the deadline is now: one mark and one full read.
test('the customer order watch is a long-poll route and answers an overflow with one read', async () => {
  assert.deepEqual(Reflect.getMetadata(ROUTE, CustomerCheckoutController.prototype.watch), {
    kind: 'long-poll',
  });
  const calls = { mark: 0, read: 0, sleep: 0 };
  const order = await watchCheckoutOrder({
    after: 'a'.repeat(64),
    deadline: Date.now(),
    stopped: () => false,
    mark: async () => (calls.mark++, 'm'),
    read: async () => (calls.read++, { revision: 'a'.repeat(64) }),
    sleep: async () => void calls.sleep++,
  });
  assert.equal(order.revision, 'a'.repeat(64));
  assert.deepEqual(calls, { mark: 1, read: 1, sleep: 0 });
});
