import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';
import { KioskError } from './api.ts';
import { selectedPriceMinor } from './cart.ts';
import {
  CommercialKioskController,
  publishedKioskCatalog,
  type CommercialKioskIO,
} from './commercial-controller.ts';
import type { KioskMedia, KioskProduct, KioskSelection } from './model';

/**
 * Hidden staff demo mode (owner decision 2026-10-11, docs/operations/kiosk-design-demo.md).
 *
 * The owner works on the design and needs every guest screen, up to the QR and the order number,
 * while the restaurant does not take orders yet. The demo runs the real commercial controller
 * over an entirely in-memory transport: it never calls fetch, the PickChick API, a bank or a
 * kitchen. Quotes, orders and payments exist only in this object; the QR text is not payable and
 * every screen carries a "ДЕМО" badge. Nothing is persisted: an app restart leaves demo mode, and
 * the device enrollment (SecureStore) is never read or written here.
 */

/** Hold on the start screen logo that opens the demo dialog (staff only, no visible hint). */
export const DEMO_HOLD_MS = 5000;
/** A demo QR becomes "paid" by itself after this delay (or at once with "Демо: оплачено"). */
export const DEMO_AUTO_PAID_MS = 12000;
/** QR text of a demo payment: a plain marker, not a Kaspi link, so it cannot be paid. */
export const DEMO_QR_PAYLOAD = 'PICKCHICK-DEMO-NOT-PAYABLE';
/** First demo order number; the next demo orders count up from it. */
export const DEMO_FIRST_NUMBER = 123;
/** Demo order numbers carry the Cyrillic "Д" (demo) prefix, e.g. "Д-123". */
export const demoOrderNumber = (n: number) => `Д-${n}`;
const DEMO_BRANCH_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** The publication the live kiosk has loaded, reused by the demo so it shows the real menu. */
export interface DemoSeed {
  /** Raw `/catalog` answer: `{ branch: { id }, channel: 'kiosk', version, payload }`. */
  published: unknown;
  /** Photo map of that publication, if it was loaded. */
  media: { version: string; products: Record<string, KioskMedia> } | null;
}
export type DemoOutcome = 'approved' | 'declined' | 'unknown';
type Order = Record<string, unknown> & {
  orderId: string;
  phase: string;
  payment?: { kind: 'kaspi_qr'; state: string; qrPayload: string | null; expiresAt: string | null };
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** The built-in fixture menu (the same mock-up publication the stories use). */
export function demoFixtureSeed(): DemoSeed {
  return {
    published: {
      branch: { id: DEMO_BRANCH_ID },
      channel: 'kiosk',
      version: 1,
      payload: mockupCatalogDraft,
    },
    media: null,
  };
}

/** A usable seed: the live publication when it parses, otherwise the built-in fixture. */
export function demoSeedOrFixture(seed: DemoSeed | null | undefined): DemoSeed {
  if (!seed) return demoFixtureSeed();
  try {
    publishedKioskCatalog(seed.published);
    return seed;
  } catch {
    return demoFixtureSeed();
  }
}

/**
 * In-memory transport of the demo. Every path the commercial controller uses is answered
 * locally; anything else is refused. There is no network code in this function.
 */
export function createDemoTransport(
  seedInput: DemoSeed | null | undefined,
  options: { uuid: () => string; now?: () => number },
) {
  const seed = demoSeedOrFixture(seedInput);
  const now = options.now ?? Date.now;
  const published = seed.published as {
    branch: { id: string };
    version: number;
    payload: { products: { id: string; available: boolean }[] };
  };
  const branchId = published.branch.id;
  const products = new Map<string, KioskProduct>(
    publishedKioskCatalog(published).products.map((p) => [p.sku ?? p.id, p]),
  );
  const iso = (t: number) => new Date(t).toISOString();
  let session: string | null = null;
  let flow: string | null = null;
  let order: Order | null = null;
  /**
   * The guest token and quote of `order`. After «Начать заново» the abandoned guest's late
   * /sessions/end leaves the next guest's order alone, and the next guest's new quote gets a new
   * order instead of the abandoned one.
   */
  let orderToken: string | undefined;
  let orderQuote: unknown = null;
  let quoteToken: string | undefined;
  let autoPaidAt: number | null = null;
  let settled: DemoOutcome | null = null;
  let next = DEMO_FIRST_NUMBER;
  /** Every path the controller asked for, for tests and the staff document. */
  const calls: string[] = [];
  const availability = () => ({
    fresh: true,
    products: published.payload.products.map((p) => ({
      productId: p.id,
      available: p.available,
      stoppedOptions: [],
    })),
  });
  const touch = (patch: Partial<Order>) => {
    order = { ...order!, ...patch, updatedAt: iso(now()) };
    return order;
  };
  /** Moves the open demo payment to its outcome; false when there is nothing to settle. */
  const settle = (outcome: DemoOutcome) => {
    if (!order || !['awaiting_payment', 'checking'].includes(order.phase)) return false;
    settled = outcome;
    autoPaidAt = null;
    const payment = order.payment;
    if (outcome === 'approved')
      touch({
        phase: 'preparing',
        kitchenStage: 'cooking',
        displayNumber: demoOrderNumber(next++),
        ...(payment ? { payment: { ...payment, state: 'paid' } } : {}),
      });
    else if (outcome === 'declined')
      touch({ phase: 'failed', ...(payment ? { payment: { ...payment, state: 'failed' } } : {}) });
    else
      touch({
        phase: 'checking',
        ...(payment ? { payment: { ...payment, state: 'checking' } } : {}),
      });
    return true;
  };
  const quoteTotal = (items: unknown) => {
    if (!Array.isArray(items) || !items.length) throw new KioskError('INVALID', 400);
    let total = 0n;
    for (const item of items) {
      if (!isObject(item)) throw new KioskError('INVALID', 400);
      const product = products.get(String(item.productId));
      if (!product) throw new KioskError('ITEM_STOPPED', 409);
      total +=
        BigInt(selectedPriceMinor(product, item.selections as KioskSelection[])) *
        BigInt(Number(item.quantity));
    }
    return total.toString();
  };
  let quote: { quoteId: string; totalMinor: string; serviceMode: string } | null = null;
  const io: CommercialKioskIO = {
    now,
    uuid: options.uuid,
    // The demo never reads the real enrollment: a fixed marker stands for the device.
    readDevice: async () => 'pickchick-demo-device',
    readSession: async () => session,
    writeSession: async (raw) => {
      session = raw;
    },
    removeSession: async () => {
      session = null;
    },
    readFlow: async () => flow,
    writeFlow: async (raw) => {
      flow = raw;
    },
    read: async (path) => {
      calls.push(path);
      if (path.startsWith('/catalog/media')) {
        if (!seed.media) throw new KioskError('NOT_FOUND', 404);
        return {
          data: { version: Number(seed.media.version), products: seed.media.products },
          catalogVersion: null,
          signature: null,
        };
      }
      if (path.startsWith('/availability'))
        return { data: availability(), catalogVersion: null, signature: null };
      throw new KioskError('DEMO_UNSUPPORTED', 400);
    },
    request: async (path, token, body) => {
      calls.push(path);
      const input = isObject(body) ? body : {};
      if (path === '/sessions')
        return {
          sessionId: input.sessionId,
          branchId,
          expiresAt: iso(now() + 3600000),
        };
      if (path === '/sessions/end') {
        // Only the ending guest's own quote and order go away.
        if (!quote || quoteToken === token) quote = null;
        if (!order || orderToken === token) {
          order = null;
          orderToken = undefined;
          orderQuote = null;
          autoPaidAt = null;
          settled = null;
        }
        return { ended: true };
      }
      if (path === '/config')
        return {
          enabled: true,
          branchId,
          restaurant: 'PickChick',
          paymentMethod: 'kaspi_qr',
          paymentMethods: ['kaspi_qr', 'kaspi_invoice'],
        };
      if (path === '/catalog') return seed.published;
      if (path === '/availability') return availability();
      if (path === '/quotes') {
        quote = {
          quoteId: options.uuid(),
          totalMinor: quoteTotal(input.items),
          serviceMode: input.serviceMode === 'dine_in' ? 'dine_in' : 'takeaway',
        };
        quoteToken = token;
        return { ...quote, expiresAt: iso(now() + 120000) };
      }
      if (path === '/orders') {
        if (!quote || input.quoteId !== quote.quoteId) throw new KioskError('NOT_FOUND', 404);
        // The same quote replays its order; a new quote (the next guest) gets a new one.
        if (order && orderQuote === input.quoteId) return order;
        settled = null;
        autoPaidAt = null;
        orderToken = token;
        orderQuote = input.quoteId;
        const at = iso(now());
        order = {
          orderId: options.uuid(),
          revision: 'd'.repeat(64),
          restaurant: 'PickChick',
          branchId,
          createdAt: at,
          updatedAt: at,
          kitchenStage: null,
          displayNumber: null,
          totalMinor: quote.totalMinor,
          serviceMode: quote.serviceMode,
          phase: 'ready_to_pay',
          expiresAt: null,
          receipt: 'deferred',
          receiptUrl: null,
          items: [],
        };
        return order;
      }
      if (order && path === `/orders/${order.orderId}/payment`) {
        if (order.phase !== 'ready_to_pay') return order;
        settled = null;
        autoPaidAt = now() + DEMO_AUTO_PAID_MS;
        return input.method === 'kaspi_invoice'
          ? touch({ phase: 'awaiting_payment', paymentMethod: 'kaspi_invoice' })
          : touch({
              phase: 'awaiting_payment',
              paymentMethod: 'kaspi_qr',
              payment: {
                kind: 'kaspi_qr',
                state: 'pending',
                qrPayload: DEMO_QR_PAYLOAD,
                expiresAt: iso(now() + 180000),
              },
            });
      }
      if (order && path === `/orders/${order.orderId}`) {
        if (!settled && autoPaidAt !== null && now() >= autoPaidAt) settle('approved');
        return order;
      }
      throw new KioskError('DEMO_UNSUPPORTED', 400);
    },
  };
  const cancelUnpaid = () => {
    if (!settled && autoPaidAt !== null && now() >= autoPaidAt) settle('approved');
    if (order?.phase !== 'awaiting_payment') return false;
    return settle('declined');
  };
  return { io, settle, cancelUnpaid, calls, branchId };
}

/** The demo controller (the real commercial controller over the in-memory transport). */
export function createDemoKiosk(
  seed: DemoSeed | null | undefined,
  options: { uuid: () => string; now?: () => number },
) {
  const transport = createDemoTransport(seed, options);
  const controller = new CommercialKioskController(transport.io);
  return {
    controller,
    transport,
    /** "Демо: оплачено / отказ / неизвестно": settles the open demo payment and re-reads it. */
    pay: async (outcome: DemoOutcome) => (transport.settle(outcome) ? controller.recover() : false),
    cancelPayment: async () => {
      if (!(await controller.recover())) return false;
      if (!transport.cancelUnpaid()) {
        await controller.recover();
        return false;
      }
      return controller.returnAfterFailedPayment();
    },
  };
}
export type DemoKiosk = ReturnType<typeof createDemoKiosk>;
