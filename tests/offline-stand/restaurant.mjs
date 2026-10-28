/**
 * Offline stand actors: the people and devices of one restaurant, driven like the real clients.
 *
 * - Cashier POS: loopback HTTP to the edge (POS and edge share the cashier monoblock). A lost
 *   answer is retried with the same Idempotency-Key, as the POS journal does.
 * - Kitchen screen: HTTP to the edge through the LAN link (second monoblock), same retry rule.
 * - Kiosk: the real cloud KioskCheckout and Kaspi QR processor with a fake bank adapter.
 * - Mobile: the commerce foundation with catalog pricing (as CustomerCheckout prices it); the
 *   bank and fiscal answers are trusted synthetic observations (no Kaspi, no Webkassa).
 * - Back office: the real requestStopInTransaction for a remote stop command.
 * Every order the actors create is recorded in `ledger`, the reference the checks compare with.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { URLSearchParams } from 'node:url';
import { transaction } from '@pickchick/database';
import { requestStopInTransaction } from '@pickchick/backoffice-core';

const commerceCore = () => import('../../packages/commerce-core/dist/index.js');

export class ActorError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const NETWORK = new Set(['NETWORK', 'TIMEOUT']);
/** Domain refusals the cashier explains on screen (apps/pos/src/api.ts); never a stand failure. */
const EXPECTED_REFUSALS = [
  'KITCHEN_UNAVAILABLE',
  'ITEM_STOPPED',
  'MENU_CHANGED',
  'QUOTE_EXPIRED',
  'BRANCH_UNAVAILABLE',
];
export const isNetwork = (error) => error instanceof ActorError && NETWORK.has(error.code);

async function call(origin, path, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  let response;
  try {
    response = await fetch(origin + path, {
      method,
      redirect: 'error',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ActorError(error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) throw new ActorError('INVALID_RESPONSE', response.status);
  }
  if (!response.ok)
    throw new ActorError(payload?.code ?? `HTTP_${response.status}`, response.status);
  return payload;
}

export class Restaurant {
  constructor(stand, { random = Math.random } = {}) {
    this.stand = stand;
    this.random = random;
    this.ledger = {
      pos: new Map(),
      mobile: new Map(),
      kiosk: new Map(),
      stops: [],
      remoteStops: [],
      shifts: [],
      duplicatePaymentReplays: 0,
    };
    this.counters = {
      pos_sales: 0,
      pos_cancels: 0,
      pos_retries: 0,
      pos_refused: {},
      kitchen_actions: 0,
      kitchen_retries: 0,
      kitchen_unreachable: 0,
      kitchen_conflicts: 0,
      mobile_refused: {},
      kiosk_refused: {},
    };
    this.lastKitchenRead = null;
    /** Items staff stopped; the cashier does not offer them (the real POS greys them out). */
    this.stopped = new Set();
  }

  // ---------- cashier POS (loopback) ----------
  staffHeaders(key, extra = {}) {
    const c = this.stand.staff[key];
    return {
      Authorization: `Bearer ${c.token}`,
      'X-Staff-Session-Id': c.session_id,
      ...extra,
    };
  }
  /** One POS command; a lost answer is repeated with the same key until it is known. */
  async pos(method, path, body, { actor = 'cashier', key = randomUUID(), attempts = 30 } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call(this.stand.edgeOrigin, `/edge/v1/${path}`, {
          method,
          body,
          headers: this.staffHeaders(actor, method === 'POST' ? { 'Idempotency-Key': key } : {}),
        });
      } catch (error) {
        if (!(isNetwork(error) || error.status >= 500) || attempt >= attempts) {
          // Which POS command failed, without ids: 'POST orders/:id/cancel'.
          error.path = `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`;
          error.attempt = attempt;
          throw error;
        }
        this.counters.pos_retries++;
        await sleep(1000);
      }
    }
  }
  async posMenu() {
    if (!this.menu || this.menuAt < Date.now() - 30000) {
      for (let attempt = 1; ; attempt++) {
        try {
          this.menu = await call(this.stand.edgeOrigin, '/edge/v1/menu');
          break;
        } catch (error) {
          // The POS keeps its screen and asks again while the cashier edge restarts.
          if (!(isNetwork(error) || error.status >= 500) || attempt >= 30) throw error;
          this.counters.pos_retries++;
          await sleep(1000);
        }
      }
      this.menuAt = Date.now();
    }
    return this.menu;
  }
  variant(slug) {
    const item = this.menu.items.find((i) => i.source_id === slug);
    if (!item) throw new ActorError('MENU_ITEM_MISSING');
    return item;
  }
  /** One cashier sale (unpaid service, straight to the kitchen); optionally cancelled at once. */
  async posSale({ cancel = false } = {}) {
    const menu = await this.posMenu();
    const burger = this.variant('burger'),
      group = burger.modifier_groups[0];
    const pick = ['wings', 'fries', 'cola', 'combo-day', 'pie', 'tea'].filter(
      (slug) => !this.stopped.has(slug),
    );
    const items = [
      {
        variant_id: burger.variant_id,
        quantity: 1 + Math.floor(this.random() * 2),
        ...(this.random() < 0.5
          ? { modifiers: [{ group_id: group.id, option_id: group.options[0].id, quantity: 1 }] }
          : {}),
      },
    ];
    const second = pick[Math.floor(this.random() * pick.length)];
    items.push({ variant_id: this.variant(second).variant_id, quantity: 1 });
    let quote;
    try {
      quote = await this.pos('POST', 'checkout/quotes', {
        release_id: menu.release_id,
        service_mode: this.random() < 0.5 ? 'takeaway' : 'dine_in',
        items,
      });
    } catch (error) {
      this.refused(this.counters.pos_refused, error);
      if (error.code === 'MENU_CHANGED') this.menu = null;
      return null;
    }
    let order;
    try {
      order = await this.pos('POST', 'orders', {
        quote_id: quote.quote_id,
        kitchen_admission: 'unpaid',
      });
    } catch (error) {
      // The cashier shows the reason and sells nothing (for example all 299 live numbers are
      // taken). Unknown codes and bare CONFLICT stay failures of the scenario.
      if (!EXPECTED_REFUSALS.includes(error.code)) throw error;
      this.refused(this.counters.pos_refused, error);
      return null;
    }
    this.counters.pos_sales++;
    const entry = {
      orderId: order.order_id,
      total: order.snapshot.total_minor,
      cancelled: false,
      at: Date.now(),
    };
    this.ledger.pos.set(order.order_id, entry);
    if (cancel) await this.posCancel(entry);
    return entry;
  }
  async posCancel(entry) {
    try {
      await this.pos('POST', `orders/${entry.orderId}/cancel`, {
        expected_version: 1,
        reason: 'Стенд: гость передумал',
      });
    } catch (error) {
      // The kitchen already started it: the cashier may not cancel any more.
      if (error.code !== 'ORDER_IN_PRODUCTION') throw error;
      this.refused(this.counters.pos_refused, error);
      return;
    }
    entry.cancelled = true;
    this.counters.pos_cancels++;
  }
  /** A cashier refuses an item in the POS stop list (manager command on the edge). */
  async posStop(slug, stopped) {
    const item = this.variant(slug);
    const state = await this.pos('GET', `availability/stops/${item.variant_id}`, undefined, {
      actor: 'manager',
    });
    const result = await this.pos(
      'POST',
      'availability/stops',
      {
        variant_id: item.variant_id,
        stopped,
        expected_version: state.version,
        reason: stopped ? 'Стенд: закончилось' : 'Стенд: снова в наличии',
        duration: stopped ? 'manual' : undefined,
      },
      { actor: 'manager' },
    );
    this.ledger.stops.push({ slug, variantId: item.variant_id, stopped, version: result.version });
    if (stopped) this.stopped.add(slug);
    else this.stopped.delete(slug);
    return result;
  }
  async posStopped(slug) {
    const item = this.variant(slug);
    return (
      await this.pos('GET', `availability/stops/${item.variant_id}`, undefined, {
        actor: 'manager',
      })
    ).stopped;
  }
  /** Shift close with a cash count, then a new shift (both on the edge only). */
  async closeAndReopenShift() {
    const current = await this.pos('GET', 'cash-shifts/current', undefined, { actor: 'manager' });
    const shift = current.shift ?? current;
    const closed = await this.pos(
      'POST',
      `cash-shifts/${shift.shift_id}/close`,
      {
        expected_version: shift.version,
        counted_cash_minor: shift.expected_cash_minor ?? '0',
        reason: 'Стенд: закрытие смены',
      },
      { actor: 'manager' },
    );
    this.ledger.shifts.push({
      shiftId: shift.shift_id,
      orders: Number(closed.order_count ?? 0),
      total: closed.order_total_minor ?? '0',
    });
    const opened = await this.pos(
      'POST',
      'cash-shifts',
      { opening_cash_minor: '0' },
      { actor: 'manager' },
    );
    return { closed, opened };
  }

  // ---------- kitchen screen (LAN) ----------
  kitchenHeaders(key, extra = {}) {
    const c = this.stand.staff[key];
    return {
      Authorization: `Bearer ${c.token}`,
      'X-Staff-Session-Id': c.session_id,
      'X-Terminal-Id': c.terminal_id,
      ...extra,
    };
  }
  async kitchenQueue(actor, stationId) {
    const items = [];
    let after = null;
    for (let page = 0; page < 40; page++) {
      const query = new URLSearchParams({ stationId, limit: '50' });
      if (after) query.set('afterOrderId', after);
      const result = await call(this.stand.lan.url, `/edge/v1/fulfillment/kitchen?${query}`, {
        headers: this.kitchenHeaders(actor),
        timeoutMs: 5000,
      });
      items.push(...result.items);
      after = result.nextAfterOrderId;
      if (!after) break;
    }
    this.lastKitchenRead = Date.now();
    return items;
  }
  async kitchenAct(actor, order, body) {
    const key = randomUUID();
    for (let attempt = 1; attempt <= 20; attempt++) {
      try {
        const result = await call(
          this.stand.lan.url,
          `/edge/v1/fulfillment/orders/${order.orderId}/actions`,
          { method: 'POST', body, headers: this.kitchenHeaders(actor, { 'Idempotency-Key': key }) },
        );
        this.counters.kitchen_actions++;
        return result;
      } catch (error) {
        if (error.status === 409 || error.status === 422 || error.status === 400) {
          this.counters.kitchen_conflicts++;
          return null;
        }
        if (!(isNetwork(error) || error.status >= 500)) throw error;
        this.counters.kitchen_retries++;
        await sleep(1000);
      }
    }
    throw new ActorError('KITCHEN_GAVE_UP');
  }
  /**
   * One kitchen pass: each station advances each visible order by one step (start, complete,
   * stop a cancelled task, ready, hand over, confirm a cancellation). `share` limits how many
   * orders move per pass so the kitchen lags behind sales like a real one.
   */
  async kitchenPass({ share = 1 } = {}) {
    const { prep, assembly } = this.stand.ids;
    let moved = 0;
    try {
      for (const [actor, station] of [
        ['cook', prep],
        ['packer', assembly],
      ]) {
        const queue = await this.kitchenQueue(actor, station);
        for (const order of queue) {
          if (this.random() >= share) continue;
          const own = order.tasks.filter((t) => t.stationId === station);
          const task =
            own.find((t) => t.state === 'cancel_requested') ??
            own.find((t) => t.state === 'in_progress') ??
            own.find((t) => t.state === 'queued');
          let body = null;
          if (task?.state === 'cancel_requested')
            body = {
              action: 'confirm_stop',
              expectedVersion: order.version,
              taskId: task.taskId,
              expectedTaskVersion: task.version,
            };
          else if (task && order.state !== 'cancel_requested')
            body = {
              action: task.state === 'queued' ? 'start_task' : 'complete_task',
              expectedVersion: order.version,
              taskId: task.taskId,
              expectedTaskVersion: task.version,
            };
          else if (station === assembly && order.state === 'cancel_requested')
            body = {
              action: 'confirm_cancel',
              expectedVersion: order.version,
              reason: 'Стенд: отмена подтверждена',
              inventoryDisposition: 'recorded_elsewhere',
            };
          else if (station === assembly && order.state === 'ready')
            body = { action: 'handoff', expectedVersion: order.version };
          else if (
            station === assembly &&
            ['accepted', 'in_production'].includes(order.state) &&
            order.tasks.every((t) => t.state === 'done')
          )
            body = { action: 'ready', expectedVersion: order.version };
          if (!body) continue;
          if (await this.kitchenAct(actor, order, body)) moved++;
        }
      }
    } catch (error) {
      if (!isNetwork(error)) throw error;
      this.counters.kitchen_unreachable++;
      return { reachable: false, moved };
    }
    return { reachable: true, moved };
  }

  // ---------- cloud channels ----------
  async commerce() {
    if (!this.commerceModule) {
      const core = await commerceCore();
      const { CatalogPricing } = await this.stand.pricing();
      const s = this.stand;
      const sessions = new core.KioskSessions(s.cloud, { piiKey: randomBytes(32) });
      // Ordering hours are checked against a fixed noon in Almaty; the database clock drives
      // everything else (sessions, invoices, admission review).
      const noon = () => new Date(new Date().toISOString().slice(0, 10) + 'T07:00:00Z');
      const kiosk = new core.KioskCheckout(
        s.cloud,
        {
          organizationId: s.ids.org,
          branchId: s.ids.branch,
          paymentAccountId: s.ids.kioskPayment,
          paymentMethod: 'kaspi_qr',
          fiscalPolicy: 'deferred_pilot',
          approvalReference: 'Synthetic offline stand',
          taxCode: 'PENDING_PILOT',
          maxOrderMinor: '5000000',
          hours: { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' },
        },
        sessions,
        noon,
      );
      const bank = new FakeKaspiBank();
      const processor = new core.KioskKaspiQrProcessor(
        s.cloud,
        {
          accountId: s.ids.kioskPayment,
          bridgeUrl: 'http://127.0.0.1:1',
          requestTimeoutMs: 1000,
          invoiceTtlSeconds: 180,
          webhookSecret: 'x'.repeat(32),
          session: null,
          latitude: 43,
          longitude: 76,
        },
        bank,
      );
      this.commerceModule = {
        core,
        repo: new core.CommerceRepository(s.cloud),
        pricing: new CatalogPricing(s.cloud),
        sessions,
        kiosk,
        bank,
        processor,
      };
    }
    return this.commerceModule;
  }
  refused(map, error) {
    const code = error?.code ?? 'UNKNOWN';
    map[code] = (map[code] ?? 0) + 1;
  }
  /** Mobile order up to the admission request (the cloud asks the cashier for a reservation). */
  async mobileOrder({
    items = [
      { sku: 'COMBO_DAY', quantity: 1, selections: [] },
      {
        sku: 'BURGER',
        quantity: 1,
        selections: [{ group_id: 'extra', option_id: 'sauce', quantity: 1 }],
      },
    ],
  } = {}) {
    const { repo, pricing, core } = await this.commerce();
    const s = this.stand;
    const customerId = randomUUID();
    const scope = {
      organizationId: s.ids.org,
      branchId: s.ids.branch,
      principalId: customerId,
      role: 'sales',
    };
    try {
      const priced = await pricing.price(
        { organizationId: s.ids.org, branchId: s.ids.branch, customerId, channel: 'mobile' },
        { catalog_version: 1, service_mode: 'takeaway', items },
      );
      // The app refuses checkout when the restaurant is offline or the item is stopped.
      await core.assertBranchItemsAvailable(
        s.cloud,
        s.ids.branch,
        core.snapshotAvailabilityItems(priced),
      );
      const quote = await repo.issueQuote(scope, randomUUID(), {
        ...priced,
        taxBinding: {
          legalEntityId: s.ids.legal,
          approvalReference: 'Synthetic offline stand',
          version: 1,
        },
        lines: priced.lines.map((line) => ({ ...line, taxCode: 'SYNTHETIC' })),
      });
      const order = await repo.createOrder(scope, randomUUID(), {
        quoteId: quote.quoteId,
        fiscalAccountId: s.ids.fiscal,
      });
      const entry = {
        orderId: order.orderId,
        scope,
        total: quote.snapshot.totalMinor,
        comboUnits: items
          .filter((item) => item.sku === 'COMBO_DAY')
          .reduce((n, item) => n + item.quantity, 0),
        paid: false,
        at: Date.now(),
      };
      this.ledger.mobile.set(order.orderId, entry);
      return entry;
    } catch (error) {
      this.refused(this.counters.mobile_refused, error);
      return null;
    }
  }
  async reservationState(orderId) {
    return (
      await this.stand.cloud.query(
        'SELECT state FROM cloud_fulfillment_projection WHERE order_id=$1',
        [orderId],
      )
    ).rows[0]?.state;
  }
  /** Customer pays: attempt (needs the reservation), then the bank's capture and the receipt. */
  async mobilePayStart(entry) {
    const { repo } = await this.commerce();
    const attempt = await repo.startPaymentAttempt(entry.scope, randomUUID(), {
      orderId: entry.orderId,
      providerAccountId: this.stand.ids.payment,
    });
    entry.attempt = attempt;
    return attempt;
  }
  async mobileBankConfirms(entry, { replay = false } = {}) {
    const { repo } = await this.commerce();
    const s = this.stand;
    entry.captureEvent ??= {
      eventId: randomUUID(),
      attemptId: entry.attempt.attemptId,
      outcome: 'captured',
      operationId: randomUUID(),
      amountMinor: entry.attempt.amountMinor,
      occurredAt: new Date().toISOString(),
    };
    const provider = {
      organizationId: s.ids.org,
      branchId: s.ids.branch,
      accountId: s.ids.payment,
    };
    await repo.observePayment(provider, entry.captureEvent);
    if (replay) {
      // The bank repeats its callback: the same event must not pay or stamp twice.
      await repo.observePayment(provider, entry.captureEvent);
      this.ledger.duplicatePaymentReplays++;
    }
    const sale = (await repo.readOrder(entry.scope, entry.orderId)).fiscalDocuments.find(
      (d) => d.kind === 'sale',
    );
    await repo.observeFiscal(
      { organizationId: s.ids.org, branchId: s.ids.branch, accountId: s.ids.fiscal },
      {
        eventId: randomUUID(),
        documentId: sale.id,
        outcome: 'issued',
        providerDocumentId: randomUUID(),
        fiscalMark: 'synthetic-offline-stand',
        receiptUrl: 'https://example.invalid/offline-stand',
        amountMinor: sale.amount_minor,
        occurredAt: new Date().toISOString(),
      },
    );
    entry.paid = true;
  }
  /** Kiosk guest: order and Kaspi QR before the cashier admission (owner decision 8 Oct). */
  async kioskOrder({ items = ['BURGER', 'FRIES'] } = {}) {
    const { sessions, kiosk } = await this.commerce();
    const s = this.stand;
    let who = null;
    try {
      const token = randomBytes(32).toString('hex');
      await sessions.start(s.ids.kiosk, s.kioskKey, { sessionId: randomUUID(), token });
      who = await sessions.authenticate(s.ids.kiosk, s.kioskKey, token);
      const quote = await kiosk.quote(who, {
        key: randomUUID(),
        branchId: s.ids.branch,
        catalog_version: 1,
        serviceMode: 'takeaway',
        items: items.map((productId) => ({ productId, quantity: 1, selections: [] })),
      });
      const created = await kiosk.create(who, { key: randomUUID(), quoteId: quote.quoteId });
      await kiosk.pay(who, created.orderId, { method: 'kaspi_qr' });
      const entry = { orderId: created.orderId, who, paid: false, at: Date.now(), ended: false };
      this.ledger.kiosk.set(created.orderId, entry);
      return entry;
    } catch (error) {
      this.refused(this.counters.kiosk_refused, error);
      // The guest saw the refusal and left: the iPad ends the guest session (at most ten open).
      if (who) await sessions.end(who.sessionId).catch(() => {});
      return null;
    }
  }
  /** The guest scans and pays: the fake bank answers Processed for every issued QR. */
  async kioskBankPass() {
    const { processor, kiosk } = await this.commerce();
    await processor.tick(50);
    await this.stand.cloud.query(
      "UPDATE commerce_kiosk_kaspi_qr SET next_check_at=clock_timestamp()-interval '1 second' WHERE next_check_at>clock_timestamp()",
    );
    await processor.tick(50);
    const { sessions } = await this.commerce();
    for (const entry of this.ledger.kiosk.values()) {
      if (entry.ended) continue;
      if (!entry.paid) {
        const view = await kiosk.read(entry.who, entry.orderId).catch(() => null);
        if (view?.payment?.state === 'paid') entry.paid = true;
      }
      // The iPad ends the guest once the QR is paid or abandoned; a kiosk holds at most ten
      // open guests (KioskSessions.start).
      if (entry.paid || Date.now() - entry.at > 120000) {
        await sessions.end(entry.who.sessionId);
        entry.ended = true;
      }
    }
  }

  /** Back-office manager stops (or releases) a catalog item for the cashier from the cabinet. */
  async remoteStop(productId, stopped) {
    const s = this.stand;
    const variant = this.variant(productId).variant_id;
    const states =
      (
        await s.cloud.query(
          'SELECT stop_states FROM cloud_branch_availability WHERE branch_id=$1',
          [s.ids.branch],
        )
      ).rows[0]?.stop_states ?? [];
    const version = states.find((st) => st.id === variant)?.version ?? 0;
    const result = await transaction(s.cloud, (client) =>
      requestStopInTransaction(
        client,
        { id: s.ids.catalogManager, organization_id: s.ids.org, role: 'manager' },
        s.ids.branch,
        {
          request_id: randomUUID(),
          catalog_ref: { product_id: productId },
          stopped,
          duration: 'manual',
          reason: 'Стенд: стоп из кабинета',
          expected_version: version,
        },
        { remoteStopsEnabled: true },
      ),
    );
    this.ledger.remoteStops.push({ commandId: result.command_id, productId, variant, stopped });
    if (stopped) this.stopped.add(productId);
    else this.stopped.delete(productId);
    return result;
  }
}

/** Kaspi QR bridge stand-in: every QR is paid at once with the exact amount. */
export class FakeKaspiBank {
  constructor() {
    this.next = 1000;
    this.amounts = new Map();
    this.creates = 0;
  }
  async checkSession() {
    return true;
  }
  async create(amount) {
    const id = this.next++;
    this.amounts.set(id, amount);
    this.creates++;
    return {
      kind: 'ok',
      data: { QrOperationId: id, Amount: amount, QrToken: 'https://qr.kaspi.kz/synthetic' },
    };
  }
  async status(id) {
    const amount = this.amounts.get(Number(id));
    return {
      kind: 'ok',
      data: { QrOperationId: Number(id), Amount: amount, Status: 'Processed' },
    };
  }
}
