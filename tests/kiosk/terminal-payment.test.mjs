// ADR-0018: guest payment on the kiosk's own Kaspi Smart POS and the staff terminal link,
// through the commercial controller. Synthetic cloud and terminal doubles: nothing is paid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CommercialKioskController } from '../../apps/kiosk/src/commercial-controller.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import { parseTerminalLink } from '../../apps/kiosk/src/kaspi-terminal-link.ts';
import { cart, fixture } from './commercial-fixture.mjs';

const TERMINAL_ID = '30412345';
const storedLink = (over = {}) => ({
  host: '192.168.1.50',
  terminalId: TERMINAL_ID,
  serial: 'SPOS3A1B2C3',
  name: 'pickchick-kiosk-abc123',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  // Far from expiry: these tests are not about renewal (kaspi-terminal.test.mjs is).
  expiresAt: Date.parse('2026-10-05T00:00:00Z'),
  linkedAt: 0,
  ...over,
});

/**
 * The shared commercial fixture plus the ADR-0018 cloud routes and a terminal simulator.
 * `t.statuses` is a queue of /v2/status answers (the last one repeats).
 */
function terminalFixture({
  linked = true,
  enabled = true,
  cloudTerminal = TERMINAL_ID,
  only = false,
} = {}) {
  const h = fixture();
  const t = {
    raw: linked ? JSON.stringify(storedLink()) : null,
    calls: [],
    payment: () => ({ kind: 'ok', data: { processId: 'P-1', status: 'wait' } }),
    statuses: [{ kind: 'ok', data: { status: 'wait', subStatus: 'WaitUser' } }],
    actualize: () => ({ kind: 'ok', data: { status: 'unknown' } }),
    deviceinfo: () => ({ kind: 'ok', data: { terminalId: TERMINAL_ID, serialNum: 'SPOS3A1B2C3' } }),
    register: () => ({
      kind: 'ok',
      data: {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expirationDate: '2026-10-05 05:00:00',
      },
    }),
    attempts: 0,
    events: [],
    cloud: { enabled, terminal: cloudTerminal },
    sends: [],
    putError: null,
  };
  h.terminal = t;
  const base = h.io.request;
  h.io.request = async (path, token, body, key) => {
    if (path === '/config') {
      const config = await base(path, token, body, key);
      return {
        ...config,
        // ADR-0019: another point offers no QR and no invoice.
        ...(only ? { paymentMethods: [] } : {}),
        kaspi_terminal: {
          ...(only ? { only: true } : {}),
          enabled: t.cloud.enabled,
          terminal: t.cloud.terminal
            ? {
                terminal_id: t.cloud.terminal,
                serial: 'SPOS3A1B2C3',
                host: '192.168.1.50',
                linked_at: '2026-10-03T00:00:00Z',
              }
            : null,
        },
      };
    }
    if (path.endsWith('/payment') && body?.method === 'kaspi_terminal') {
      h.calls.push({ path, token, body, key });
      assert.equal(Object.keys(body).sort().join(','), 'method,request_id');
      assert.match(body.request_id, /^[a-f0-9-]{36}$/);
      if (t.paymentError) throw t.paymentError;
      if (!t.open || t.open.request !== body.request_id) {
        // A new attempt only when no attempt is open (the cloud contract).
        if (!t.open || t.open.closed) {
          t.attempts += 1;
          t.open = { id: `attempt-${t.attempts}`, request: body.request_id };
        }
      }
      h.order = {
        ...h.order,
        phase: 'awaiting_payment',
        paymentMethod: 'kaspi_terminal',
        payment: {
          kind: 'kaspi_terminal',
          state: 'pending',
          attempt_id: t.open.id,
          amount_tenge: 4190,
          terminal_id: TERMINAL_ID,
          expires_at: null,
        },
      };
      return {
        attempt_id: t.open.id,
        amount_tenge: 4190,
        terminal_id: TERMINAL_ID,
        expires_at: '2026-10-04T00:15:00Z',
      };
    }
    if (path.endsWith('/terminal-events')) {
      h.calls.push({ path, token, body, key });
      if (t.eventsDown) throw new KioskError('NETWORK_UNCERTAIN');
      t.events.push(body);
      if (body.kind === 'result') {
        t.open.closed = true;
        const status =
          body.status === 'success' ? 'paid' : body.status === 'fail' ? 'failed' : 'checking';
        h.order = {
          ...h.order,
          phase: status,
          payment: { ...h.order.payment, state: status },
        };
      }
      return h.order;
    }
    return base(path, token, body, key);
  };
  h.io.send = async (method, path, token, body) => {
    t.sends.push({ method, path, token, body });
    if (method === 'PUT') {
      if (t.putError) throw t.putError;
      t.cloud.terminal = body.terminal_id;
      return { ...body, linked_at: '2026-10-04T00:00:00Z' };
    }
    t.cloud.terminal = null;
    return { unlinked: true };
  };
  h.io.terminal = {
    store: {
      read: async () => t.raw,
      write: async (raw) => {
        t.raw = raw;
      },
      remove: async () => {
        t.raw = null;
      },
    },
    call: async (host, method, params, options = {}) => {
      t.calls.push({ host, method, params, token: options.token ?? null });
      if (method === 'payment') return t.payment();
      if (method === 'status') return t.statuses.length > 1 ? t.statuses.shift() : t.statuses[0];
      if (method === 'actualize') return t.actualize();
      if (method === 'deviceinfo') return t.deviceinfo();
      if (method === 'register') return t.register();
      if (method === 'revoke') return { kind: 'unreachable', reason: 'CONNECT' };
      throw Error(method);
    },
  };
  return h;
}
const sent = (h, method) => h.terminal.calls.filter((c) => c.method === method);
const flowOf = (h) => JSON.parse(h.rawFlow);
async function pay(h) {
  const c = await cart(h);
  assert.equal(c.getSnapshot().terminalPaymentAvailable, true);
  assert.equal(await c.beginPayment(), true);
  return c;
}
const success = (over = {}) => ({
  kind: 'ok',
  data: {
    status: 'success',
    subStatus: 'CardTransactionSuccess',
    transactionId: 'TX-77',
    chequeInfo: { method: 'card', amount: '4 190 ₸' },
    ...over,
  },
});

test('success: POST payment, /v2/payment once, started, status, result, then the order', async () => {
  const h = terminalFixture();
  const c = await pay(h);
  let s = c.getSnapshot();
  assert.equal(s.step, 'payment');
  assert.equal(s.terminalPayment.phase, 'waiting');
  assert.equal(s.qrPayment, null);
  assert.deepEqual(
    sent(h, 'payment').map((p) => p.params),
    [{ amount: '4190' }],
  );
  assert.equal(sent(h, 'payment')[0].token, 'access-1');
  const stored = flowOf(h).terminal;
  assert.equal(stored.phase, 'wait');
  assert.equal(stored.processId, 'P-1');
  assert.equal(stored.attemptId, 'attempt-1');
  assert.equal(stored.started, true);
  assert.deepEqual(h.terminal.events[0], {
    attempt_id: 'attempt-1',
    kind: 'started',
    process_id: 'P-1',
    terminal_id: TERMINAL_ID,
  });
  // The request_id is the payment key saved with the intent before any request.
  const request = h.calls.find((call) => call.body?.method === 'kaspi_terminal');
  assert.equal(request.body.request_id, stored.requestId);

  h.terminal.statuses = [success()];
  assert.equal(await c.pollTerminal(), true);
  s = c.getSnapshot();
  assert.equal(s.step, 'order');
  assert.equal(s.order.payment_state, 'paid');
  assert.equal(s.terminalPayment, null);
  assert.equal('terminal' in flowOf(h), false, 'the finished attempt leaves the flow');
  assert.deepEqual(h.terminal.events[1], {
    attempt_id: 'attempt-1',
    kind: 'result',
    process_id: 'P-1',
    terminal_id: TERMINAL_ID,
    status: 'success',
    amount_tenge: 4190,
    sub_status: 'CardTransactionSuccess',
    transaction_id: 'TX-77',
    method: 'card',
  });
  assert.equal(sent(h, 'payment').length, 1);
  assert.equal(
    h.terminal.calls.some((call) => call.token === null && call.method !== 'deviceinfo'),
    false,
  );
});

test('fail: the result is reported, the guest may retry (new attempt) or go back to the cart', async () => {
  const h = terminalFixture();
  const c = await pay(h);
  h.terminal.statuses = [
    {
      kind: 'ok',
      data: {
        status: 'fail',
        subStatus: 'CardTransactionFailure',
        message: 'Недостаточно средств',
      },
    },
  ];
  await c.pollTerminal();
  let s = c.getSnapshot();
  assert.equal(s.step, 'payment');
  assert.equal(s.terminalPayment.phase, 'failed');
  assert.equal(h.terminal.events.at(-1).status, 'fail');
  assert.equal(h.terminal.events.at(-1).message, 'Недостаточно средств');
  assert.equal(s.recoveryRequired, false);
  // Nothing runs on the terminal any more: polling stays idle.
  const before = h.terminal.calls.length;
  assert.equal(await c.pollTerminal(), false);
  assert.equal(h.terminal.calls.length, before);

  h.terminal.statuses = [{ kind: 'ok', data: { status: 'wait' } }];
  h.terminal.payment = () => ({ kind: 'ok', data: { processId: 'P-2' } });
  assert.equal(await c.retryTerminal(), true);
  s = c.getSnapshot();
  assert.equal(s.terminalPayment.phase, 'waiting');
  assert.equal(h.terminal.attempts, 2, 'a failed attempt is followed by a new one');
  assert.equal(flowOf(h).terminal.processId, 'P-2');
  const requests = h.calls.filter((call) => call.body?.method === 'kaspi_terminal');
  assert.notEqual(requests[0].body.request_id, requests.at(-1).body.request_id);

  h.terminal.statuses = [
    { kind: 'ok', data: { status: 'fail', subStatus: 'CardTransactionFailure' } },
  ];
  await c.pollTerminal();
  assert.equal(await c.leaveTerminal(), true);
  s = c.getSnapshot();
  assert.equal(s.step, 'cart');
  assert.equal(s.order, null);
  assert.equal(s.terminalPayment, null);
  assert.equal(s.cart.length, 1, 'the cart stays for another choice');
});

test('the guest cancels on the terminal: ProcessCancelled shows «cancelled»', async () => {
  const h = terminalFixture();
  const c = await pay(h);
  h.terminal.statuses = [{ kind: 'ok', data: { status: 'fail', subStatus: 'ProcessCancelled' } }];
  await c.pollTerminal();
  assert.equal(c.getSnapshot().terminalPayment.phase, 'cancelled');
  assert.equal(h.terminal.events.at(-1).sub_status, 'ProcessCancelled');
});

test('lost payment answer: never sent again, staff can review it', async () => {
  const h = terminalFixture();
  h.terminal.payment = () => ({ kind: 'lost', reason: 'TIMEOUT' });
  const c = await pay(h);
  const s = c.getSnapshot();
  assert.equal(s.terminalPayment.phase, 'lost');
  assert.equal(s.staffResetAvailable, false, 'no staff check without the server verifier');
  for (let i = 0; i < 3; i++) {
    await c.pollTerminal();
    await c.refresh();
    await c.recover();
  }
  assert.equal(sent(h, 'payment').length, 1);
  assert.equal(sent(h, 'status').length, 0);
  assert.equal(h.terminal.events.length, 0, 'no process to report');
  assert.equal(c.getSnapshot().step, 'payment');
});

test('connection lost while waiting: only /v2/status is read again until the result comes', async () => {
  const h = terminalFixture();
  const c = await pay(h);
  h.terminal.statuses = [
    { kind: 'unreachable', reason: 'CONNECT' },
    { kind: 'lost', reason: 'TIMEOUT' },
    success(),
  ];
  await c.pollTerminal();
  assert.equal(c.getSnapshot().terminalPayment.offline, true);
  assert.equal(c.getSnapshot().terminalPayment.phase, 'waiting');
  await c.pollTerminal();
  await c.pollTerminal();
  assert.equal(c.getSnapshot().step, 'order');
  assert.equal(sent(h, 'payment').length, 1);
});

test('unknown result: /v2/actualize at most every 10 s, then the result is reported', async () => {
  const h = terminalFixture();
  const c = await pay(h);
  h.terminal.statuses = [{ kind: 'ok', data: { status: 'unknown' } }];
  await c.pollTerminal();
  assert.equal(c.getSnapshot().terminalPayment.phase, 'checking');
  await c.pollTerminal(); // first actualize is due at once
  assert.equal(sent(h, 'actualize').length, 1);
  h.clock += 5000;
  await c.pollTerminal();
  assert.equal(sent(h, 'actualize').length, 1, 'not again within 10 s');
  h.clock += 5000;
  h.terminal.actualize = () => success();
  await c.pollTerminal();
  assert.equal(sent(h, 'actualize').length, 2);
  assert.equal(c.getSnapshot().step, 'order');
  assert.equal(h.terminal.events.at(-1).status, 'success');
  assert.equal(sent(h, 'payment').length, 1);
});

test('restart while waiting: the kiosk resumes the process and reports its result', async () => {
  const h = terminalFixture();
  await pay(h);
  // The iPad restarts; the terminal finished meanwhile.
  h.terminal.statuses = [success({ transactionId: 'TX-9' })];
  const after = new CommercialKioskController(h.io);
  assert.equal(await after.restore(), true);
  const s = after.getSnapshot();
  assert.equal(s.step, 'order');
  assert.equal(s.order.payment_state, 'paid');
  assert.equal(h.terminal.events.at(-1).transaction_id, 'TX-9');
  assert.equal(sent(h, 'payment').length, 1);
});

test('restart while /v2/payment may have been in flight: lost, never sent again', async () => {
  const h = terminalFixture();
  let reached;
  const inFlight = new Promise((resolve) => (reached = resolve));
  // The app is killed while the terminal holds the request: it never answers this process.
  h.terminal.payment = () => {
    reached();
    return new Promise(() => {});
  };
  const c = await cart(h);
  void c.beginPayment();
  await inFlight;
  // The stored phase is the one written before the call.
  assert.equal(flowOf(h).terminal.phase, 'sending');
  const after = new CommercialKioskController(h.io);
  assert.equal(await after.restore(), true);
  assert.equal(after.getSnapshot().terminalPayment.phase, 'lost');
  assert.equal(sent(h, 'payment').length, 1);
});

test('restart after the result but before the cloud took it: the result is sent then', async () => {
  const h = terminalFixture();
  const c = await pay(h);
  h.terminal.eventsDown = true;
  h.terminal.statuses = [success()];
  await c.pollTerminal();
  assert.equal(c.getSnapshot().terminalPayment.phase, 'paid');
  assert.equal(flowOf(h).terminal.phase, 'success');
  h.terminal.eventsDown = false;
  const after = new CommercialKioskController(h.io);
  assert.equal(await after.restore(), true);
  assert.equal(after.getSnapshot().step, 'order');
  assert.equal(h.terminal.events.at(-1).kind, 'result');
  // The terminal is not asked again for a result it already gave.
  assert.equal(sent(h, 'status').length, 2);
});

test('error 107: the terminal is busy, nothing started; «Повторить» sends the same attempt', async () => {
  const h = terminalFixture();
  h.terminal.payment = () => ({
    kind: 'refused',
    httpStatus: 400,
    statusCode: 107,
    message: 'busy',
  });
  const c = await pay(h);
  let s = c.getSnapshot();
  assert.equal(s.terminalPayment.phase, 'not_started');
  assert.equal(s.terminalPayment.reason, 'busy');
  assert.equal(await c.pollTerminal(), false, 'never resent by itself');
  assert.equal(sent(h, 'payment').length, 1);
  h.terminal.payment = () => ({ kind: 'ok', data: { processId: 'P-5' } });
  assert.equal(await c.retryTerminal(), true);
  s = c.getSnapshot();
  assert.equal(s.terminalPayment.phase, 'waiting');
  assert.equal(sent(h, 'payment').length, 2);
  assert.equal(h.terminal.attempts, 1, 'the same cloud attempt');
});

test('a payment that never started can be left: back to the cart, nothing paid', async () => {
  const h = terminalFixture();
  h.terminal.payment = () => ({ kind: 'unreachable', reason: 'CONNECT' });
  const c = await pay(h);
  assert.equal(c.getSnapshot().terminalPayment.reason, 'unreachable');
  assert.equal(await c.leaveTerminal(), true);
  assert.equal(c.getSnapshot().step, 'cart');
  assert.equal(c.getSnapshot().order, null);
});

test('without a linked terminal, or disabled in the cloud, the QR flow is unchanged', async () => {
  for (const options of [{ linked: false }, { enabled: false }, { cloudTerminal: 'OTHER' }]) {
    const h = terminalFixture(options);
    const c = await cart(h);
    assert.equal(c.getSnapshot().terminalPaymentAvailable, false);
    assert.equal(await c.beginPayment(), true);
    const s = c.getSnapshot();
    assert.equal(s.terminalPayment, null);
    assert.equal(s.step, 'payment');
    assert.equal(h.terminal.calls.length, 0, JSON.stringify(options));
    assert.ok(h.calls.some((call) => call.body?.method === 'kaspi_qr'));
  }
});

test('ADR-0019 terminal-only point: the Kaspi choice is the terminal, paid as on the main point', async () => {
  const h = terminalFixture({ only: true });
  const c = await pay(h);
  assert.deepEqual(c.getSnapshot().commercialPaymentMethods, ['kaspi']);
  assert.equal(c.getSnapshot().terminalPayment.phase, 'waiting');
  assert.equal(sent(h, 'payment').length, 1);
  assert.equal(
    h.calls.some((call) => call.body?.method === 'kaspi_qr'),
    false,
  );
  h.terminal.statuses = [success()];
  assert.equal(await c.pollTerminal(), true);
  assert.equal(c.getSnapshot().order.payment_state, 'paid');
});

test('ADR-0019 terminal-only point without a linked terminal: a staff notice, never a QR', async () => {
  const { dictionariesForTest } = await import('../../apps/kiosk/src/i18n.ts');
  for (const options of [{ linked: false }, { cloudTerminal: 'OTHER' }, { enabled: false }]) {
    const h = terminalFixture({ only: true, ...options });
    const c = await cart(h);
    const before = h.calls.length;
    assert.equal(await c.beginPayment(), false, JSON.stringify(options));
    const s = c.getSnapshot();
    assert.equal(s.errorCode, 'TERMINAL', JSON.stringify(options));
    assert.match(s.error, /терминале Kaspi.*Пригласите сотрудника/);
    assert.equal(s.order, null);
    assert.equal(s.recoveryRequired, false);
    assert.equal(h.terminal.calls.length, 0);
    // Nothing was created: no quote, order or payment request after the config reload.
    assert.equal(
      h.calls
        .slice(before)
        .some((call) => /\/quotes|\/orders/.test(call.path) || call.body?.method),
      false,
    );
  }
  for (const [locale, strings] of Object.entries(dictionariesForTest)) {
    assert.equal(typeof strings.err_TERMINAL, 'string', locale);
    assert.doesNotMatch(strings.err_TERMINAL, /[–—]|тест|test/i, locale);
  }
});

test('the cloud refuses the terminal (disabled since): the guest is back at the cart, QR next', async () => {
  const h = terminalFixture();
  h.terminal.paymentError = new KioskError('KIOSK_TERMINAL_DISABLED', 409);
  const c = await cart(h);
  assert.equal(await c.beginPayment(), false);
  const s = c.getSnapshot();
  assert.equal(s.errorCode, 'RETRY_PAYMENT');
  assert.equal(s.step, 'cart');
  assert.equal(s.terminalPaymentAvailable, false);
  assert.equal(h.terminal.calls.length, 0);
});

test('staff reset of an unknown terminal result reports it as unknown first', async () => {
  const h = terminalFixture();
  h.io.verifyStaff = async (pin) => {
    if (pin !== '4829') throw new KioskError('UNAUTHORIZED', 401);
  };
  const c = await pay(h);
  h.terminal.statuses = [{ kind: 'ok', data: { status: 'unknown' } }];
  await c.pollTerminal();
  assert.equal(c.getSnapshot().staffResetAvailable, true);
  assert.equal(await c.staffReset('4829'), true);
  assert.equal(h.terminal.events.at(-1).status, 'unknown');
  assert.equal(c.getSnapshot().step, 'start');
});

test('terminal setup: staff code, IP, deviceinfo, register, SecureStore, PUT terminal', async () => {
  const h = terminalFixture({ linked: false, cloudTerminal: null });
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  assert.equal(c.getSnapshot().terminalSetup.open, false);
  // No server staff check (the demo transport, older servers): nothing opens.
  assert.equal(await c.openTerminalSetup('4829'), false);
  assert.equal(c.getSnapshot().staffPinError, 'unavailable');
  h.io.verifyStaff = async (pin) => {
    if (pin !== '4829') throw new KioskError('UNAUTHORIZED', 401);
  };
  const c2 = new CommercialKioskController(h.io);
  assert.equal(await c2.restore(), true);
  assert.equal(await c2.openTerminalSetup('1111'), false);
  assert.equal(c2.getSnapshot().terminalSetup.open, false);
  assert.equal(await c2.openTerminalSetup('4829'), true);
  assert.equal(c2.getSnapshot().terminalSetup.open, true);

  await c2.linkTerminal('8.8.8.8');
  assert.equal(c2.getSnapshot().terminalSetup.result, 'host');
  assert.equal(h.terminal.calls.length, 0);

  let confirming = false;
  h.terminal.register = () => {
    confirming = c2.getSnapshot().terminalSetup.confirming;
    return {
      kind: 'ok',
      data: {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expirationDate: '2026-10-05 05:00:00',
      },
    };
  };
  assert.equal(await c2.linkTerminal(' 192.168.1.50 '), true);
  assert.equal(confirming, true, '«Нажмите «Разрешить» на терминале» while register waits');
  const setup = c2.getSnapshot().terminalSetup;
  assert.equal(setup.result, 'linked');
  assert.deepEqual(setup.link, {
    terminalId: TERMINAL_ID,
    serial: 'SPOS3A1B2C3',
    host: '192.168.1.50',
  });
  assert.equal(setup.cloudLinked, true);
  assert.deepEqual(
    h.terminal.calls.map((call) => call.method),
    ['deviceinfo', 'register'],
  );
  assert.match(h.terminal.calls[1].params.name, /^pickchick-kiosk-[a-z0-9]{6}$/);
  const link = parseTerminalLink(h.terminal.raw);
  assert.equal(link.accessToken, 'access-2');
  assert.equal(link.name, h.terminal.calls[1].params.name);
  assert.equal(link.expiresAt, Date.parse('2026-10-05T00:00:00Z'));
  assert.deepEqual(h.terminal.sends[0], {
    method: 'PUT',
    path: '/terminal',
    token: JSON.parse(h.rawSession).token,
    body: { terminal_id: TERMINAL_ID, serial: 'SPOS3A1B2C3', host: '192.168.1.50' },
  });
  assert.equal(
    JSON.stringify(h.terminal.sends).includes('access-2'),
    false,
    'no token to the cloud',
  );
  // The next guest pays on the terminal.
  assert.equal(c2.getSnapshot().terminalPaymentAvailable, true);

  assert.equal(await c2.checkTerminal(), true);
  assert.equal(c2.getSnapshot().terminalSetup.result, 'ok');
  h.terminal.deviceinfo = () => ({ kind: 'ok', data: { terminalId: 'OTHER', serialNum: 'X' } });
  await c2.checkTerminal();
  assert.equal(c2.getSnapshot().terminalSetup.result, 'mismatch');

  assert.equal(await c2.unlinkTerminal(), true);
  assert.equal(h.terminal.sends.at(-1).method, 'DELETE');
  assert.equal(h.terminal.raw, null);
  assert.equal(c2.getSnapshot().terminalSetup.link, null);
  assert.equal(c2.getSnapshot().terminalPaymentAvailable, false);
  c2.closeTerminalSetup();
  assert.equal(c2.getSnapshot().terminalSetup.open, false);
  assert.equal(await c2.checkTerminal(), false, 'closed: actions need the staff code again');
});

test('terminal setup: a terminal held by another kiosk is not kept; a refused register keeps none', async () => {
  const h = terminalFixture({ linked: false, cloudTerminal: null });
  h.io.verifyStaff = async () => {};
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  assert.equal(await c.openTerminalSetup('4829'), true);
  h.terminal.register = () => ({
    kind: 'refused',
    httpStatus: 400,
    statusCode: 105,
    message: null,
  });
  await c.linkTerminal('192.168.1.50');
  assert.equal(c.getSnapshot().terminalSetup.result, 'pending');
  assert.equal(h.terminal.raw, null);
  h.terminal.register = () => ({ kind: 'lost', reason: 'TIMEOUT' });
  await c.linkTerminal('192.168.1.50');
  assert.equal(c.getSnapshot().terminalSetup.result, 'denied');
  h.terminal.register = () => ({
    kind: 'ok',
    data: { accessToken: 'a', refreshToken: 'r', expirationDate: '2026-10-05 05:00:00' },
  });
  h.terminal.putError = new KioskError('KIOSK_TERMINAL_TAKEN', 409);
  await c.linkTerminal('192.168.1.50');
  assert.equal(c.getSnapshot().terminalSetup.result, 'taken');
  assert.equal(h.terminal.raw, null);
  h.terminal.deviceinfo = () => ({ kind: 'unreachable', reason: 'CONNECT' });
  await c.linkTerminal('192.168.1.51');
  assert.equal(c.getSnapshot().terminalSetup.result, 'unreachable');
});

test('the stored terminal attempt is strictly checked on restore', async () => {
  const h = terminalFixture();
  await pay(h);
  const flow = flowOf(h);
  h.rawFlow = JSON.stringify({ ...flow, terminal: { ...flow.terminal, phase: 'paid' } });
  const after = new CommercialKioskController(h.io);
  assert.equal(await after.restore(), false);
  assert.equal(after.getSnapshot().ready, false);
});

test('terminal copy: same keys in ru/kk/en, no long dash, never the word «тест»', async () => {
  const { terminalCopyForTest } = await import('../../apps/kiosk/src/terminalCopy.ts');
  const keys = Object.keys(terminalCopyForTest.ru).sort();
  for (const [locale, table] of Object.entries(terminalCopyForTest)) {
    assert.deepEqual(Object.keys(table).sort(), keys, locale);
    for (const [key, value] of Object.entries(table)) {
      assert.ok(value.trim(), `${locale}.${key}`);
      assert.doesNotMatch(value, /[–—]/, `${locale}.${key}`);
      assert.doesNotMatch(value, /тест|test/i, `${locale}.${key}`);
    }
  }
  for (const value of Object.values(terminalCopyForTest.en))
    assert.doesNotMatch(value, /[А-Яа-яЁё]/);
  assert.equal(terminalCopyForTest.ru.title, 'Оплатите на терминале');
  assert.equal(terminalCopyForTest.ru.subtitle, 'картой или Kaspi QR');
  assert.equal(terminalCopyForTest.ru.confirmTitle, 'Нажмите «Разрешить» на терминале');
});
