import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TerminalAccess } from '../dist/terminal-access.js';

// The paired screen asks the point server every 15 seconds whether it is still paired. Each
// reported change redraws the screen, and a redraw rebuilds the login form. Before 12.11.2026
// every answer was reported, so a password typed slowly on a touch screen was wiped mid-way.

function paired(mode = 'prep') {
  const terminalId = randomUUID();
  let changes = 0;
  const access = new TerminalAccess(() => changes++);
  access.configure({ pairingEnabled: true, mode, paired: true, terminalId });
  return { access, terminalId, changes: () => changes };
}
async function answering(answer, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push([String(url), options]);
    return answer();
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('a steady pairing check redraws nothing; only a change of what the screen shows is reported', async () => {
  const { access, terminalId, changes } = paired();
  let answer = () => json(200, { terminalId, mode: 'prep', generation: 1, valid: true });
  await answering(
    () => answer(),
    async (calls) => {
      await access.check();
      await access.check();
      await access.check();
      assert.equal(calls.length, 3);
      assert.equal(calls[0][0], '/edge/v1/terminals/session');
      assert.equal(calls[0][1].credentials, 'same-origin');
      assert.equal(changes(), 0, 'three unchanged answers must not redraw the login form');
      assert.equal(access.paired, true);
      assert.equal(access.error, '');
      assert.equal(access.busy, false);

      // The point server stops answering: the notice appears once and stays without redraws.
      answer = () => {
        throw new TypeError('fetch failed');
      };
      await access.check();
      assert.equal(changes(), 1);
      assert.match(access.error, /Нет ответа кассы/);
      assert.equal(access.paired, true, 'an outage never unpairs the screen');
      await access.check();
      await access.check();
      assert.equal(changes(), 1, 'the same outage is not reported again');
      answer = () => json(503, { code: 'UNAVAILABLE' });
      await access.check();
      assert.equal(changes(), 1, 'another kind of outage shows the same notice');

      // It answers again: the notice goes away, once.
      answer = () => json(200, { terminalId, mode: 'prep', generation: 1, valid: true });
      await access.check();
      assert.equal(changes(), 2);
      assert.equal(access.error, '');
      await access.check();
      assert.equal(changes(), 2);

      // The screen is revoked in the back office: the pairing form must appear at once.
      answer = () => json(401, { code: 'UNAUTHORIZED' });
      await access.check();
      assert.equal(changes(), 3);
      assert.equal(access.paired, false);
      assert.equal(access.terminalId, undefined);
      assert.match(access.error, /Экран отключён/);
      const asked = calls.length;
      await access.check();
      assert.equal(calls.length, asked, 'an unpaired screen does not ask');
      assert.equal(changes(), 3);
    },
  );
});

test('an answer for another screen is an error shown once; a new identity of the same mode is a change', async () => {
  const { access, terminalId, changes } = paired('assembly');
  let answer = () => json(200, { terminalId, mode: 'display', generation: 1, valid: true });
  await answering(
    () => answer(),
    async () => {
      await access.check();
      assert.equal(changes(), 1);
      assert.match(access.error, /Нет ответа кассы/);
      assert.equal(access.terminalId, terminalId);
      await access.check();
      assert.equal(changes(), 1);
      const replaced = randomUUID();
      answer = () => json(200, { terminalId: replaced, mode: 'assembly', generation: 2 });
      await access.check();
      assert.equal(changes(), 2);
      assert.equal(access.terminalId, replaced);
      assert.equal(access.error, '');
      await access.check();
      assert.equal(changes(), 2);
    },
  );
});

test('a check never overlaps another one and an unconfigured screen never asks', async () => {
  const { access, terminalId, changes } = paired();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await answering(
    async () => {
      await gate;
      return json(200, { terminalId, mode: 'prep' });
    },
    async (calls) => {
      const first = access.check();
      await access.check();
      assert.equal(calls.length, 1, 'the second check returns while the first is in flight');
      release();
      await first;
      assert.equal(changes(), 0);
      assert.equal(access.busy, false);
      const plain = new TerminalAccess(() => assert.fail('must not redraw'));
      plain.configure({ pairingEnabled: false });
      await plain.check();
      assert.equal(calls.length, 1);
    },
  );
});
