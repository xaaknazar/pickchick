import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';
import { CommercialKioskController, type CommercialKioskIO } from '../commercial-controller';
import { CartScreen, ReviewScreen, UpsellScreen, type UpsellMemory } from '../screens/CartScreens';
import { PaymentScreen, RecoveryScreen } from '../screens/PaymentOrderScreens';
import { defaultSelections } from '../cart';
import { BootState } from './BootState';
import type { KioskModel } from '../model';
import type { Locale } from '../i18n';

type Methods = 'qr' | 'qrAndInvoice';
type Draft = (typeof mockupCatalogDraft)['products'][number];
// Storybook-only, entirely in-memory transport (as Kiosk/PaymentCheckout). It never calls fetch
// or a bank; the QR payload is synthetic and not payable. Quotes price the posted items.
function fixture(methods: Methods) {
  const branchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let session: string | null = null;
  let flow: string | null = null;
  let order: Record<string, unknown> | null = null;
  let quoted = '0';
  const products = mockupCatalogDraft.products as readonly Draft[];
  const price = (items: { productId: string; quantity: number; selections: unknown[] }[]) =>
    items
      .reduce((sum, item) => {
        const product = products.find((p) => p.sku === item.productId)!;
        const extras = (
          item.selections as { group_id: string; option_id: string; quantity: number }[]
        )
          .map((s) => {
            const group = product.modifier_groups.find((g) => g.id === s.group_id);
            const option = group?.options.find((o) => o.id === s.option_id);
            return BigInt(option?.price_delta_minor ?? '0') * BigInt(s.quantity);
          })
          .reduce((a, b) => a + b, 0n);
        return sum + (BigInt(product.price_minor) + extras) * BigInt(item.quantity);
      }, 0n)
      .toString();
  const io: CommercialKioskIO = {
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    readDevice: async () => 'synthetic-story-device',
    readSession: async () => session,
    writeSession: async (value) => {
      session = value;
    },
    removeSession: async () => {
      session = null;
    },
    readFlow: async () => flow,
    writeFlow: async (value) => {
      flow = value;
    },
    request: async (path, _token, body) => {
      const input = body as Record<string, unknown>;
      if (path === '/sessions')
        return { ...input, branchId, expiresAt: new Date(Date.now() + 3600000).toISOString() };
      if (path === '/config')
        return {
          enabled: true,
          branchId,
          paymentMethod: 'kaspi_qr',
          paymentMethods: methods === 'qr' ? ['kaspi_qr'] : ['kaspi_qr', 'kaspi_invoice'],
        };
      if (path === '/catalog')
        return {
          branch: { id: branchId },
          channel: 'kiosk',
          version: 1,
          payload: mockupCatalogDraft,
        };
      if (path === '/availability')
        return {
          fresh: true,
          products: products.map((p) => ({
            productId: p.id,
            available: p.available,
            stoppedOptions: [],
          })),
        };
      if (path === '/quotes') {
        quoted = price(input.items as Parameters<typeof price>[0]);
        return {
          quoteId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          totalMinor: quoted,
          serviceMode: 'takeaway',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
      }
      if (path === '/orders') {
        order ??= {
          orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          revision: 'f'.repeat(64),
          restaurant: 'PickChick',
          branchId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          kitchenStage: null,
          displayNumber: '42',
          totalMinor: quoted,
          serviceMode: 'takeaway',
          phase: 'ready_to_pay',
          expiresAt: null,
          receipt: 'deferred',
          receiptUrl: null,
          items: [],
        };
        return order;
      }
      if (path.endsWith('/payment')) {
        order = {
          ...order,
          phase: 'awaiting_payment',
          paymentMethod: input.method,
          ...(input.method === 'kaspi_qr'
            ? {
                payment: {
                  kind: 'kaspi_qr',
                  state: 'pending',
                  qrPayload: 'SYNTHETIC-STORY-QR-NOT-PAYABLE',
                  expiresAt: new Date(Date.now() + 180000).toISOString(),
                },
              }
            : {}),
        };
        return order;
      }
      if (path.startsWith('/orders/')) return order;
      throw new Error('Unsupported synthetic story route');
    },
  };
  return new CommercialKioskController(io);
}
function renderUpsell({
  locale,
  methods,
  order,
}: {
  locale: Locale;
  methods: Methods;
  /** Catalog ids put in the cart before the upsell opens. */
  order: string[];
}) {
  const c = useMemo(() => fixture(methods), [methods]);
  const state = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const memory = useMemo<UpsellMemory>(() => ({ base: null }), []);
  const [shownLocale, setLocale] = useState(locale);
  useEffect(() => {
    void (async () => {
      await c.restore();
      await c.start();
      await c.setMode('takeaway');
      for (const id of order) {
        const product = c.getSnapshot().catalog!.products.find((p) => p.id === id)!;
        await c.addToCart(product.id, defaultSelections(product));
      }
      c.openUpsell();
    })();
  }, [c]);
  useEffect(() => c.setLocale(shownLocale), [c, shownLocale]);
  const model: KioskModel = {
    ...state,
    start: c.start,
    setMode: c.setMode,
    goMode: c.goMode,
    goMenu: c.goMenu,
    openProduct: c.openProduct,
    closeProduct: c.closeProduct,
    editLine: c.editLine,
    openUpsell: c.openUpsell,
    openCart: c.openCart,
    goLoyalty: c.goLoyalty,
    setInvoicePhone: c.setInvoicePhone,
    setCatalogLocale: c.setLocale,
    setPaymentMethod: c.setPaymentMethod,
    addToCart: c.addToCart,
    updateQuantity: c.updateQuantity,
    beginPayment: c.beginPayment,
    pay: c.pay,
    cancelOrder: c.cancelOrder,
    recover: c.recover,
    refresh: c.refresh,
    newGuest: c.newGuest,
    touch: c.touch,
    stay: c.stay,
  };
  const context = {
    locale: shownLocale,
    setLocale,
    onHelp: () => {},
    onCancel: () => {},
  };
  return !state.ready ? (
    <BootState />
  ) : state.step === 'upsell' ? (
    <UpsellScreen model={model} context={context} memory={memory} />
  ) : state.step === 'payment' ? (
    <PaymentScreen model={model} context={context} />
  ) : state.step === 'recovery' ? (
    <RecoveryScreen model={model} context={context} />
  ) : state.step === 'loyalty' ? (
    <ReviewScreen model={model} context={context} />
  ) : state.step === 'cart' ? (
    <CartScreen model={model} context={context} />
  ) : (
    <BootState />
  );
}
const meta = {
  title: 'Kiosk/UpsellCheckout',
  args: { locale: 'ru', methods: 'qr', order: ['pick-combo'] },
  render: renderUpsell,
  parameters: {
    docs: {
      description: {
        component:
          'Умные допы на реальном коммерческом контроллере. Все ответы в памяти, QR не платёжный, банковских запросов нет. «К оплате» при единственном способе Kaspi QR сразу открывает QR.',
      },
    },
  },
} satisfies Meta<{ locale: Locale; methods: Methods; order: string[] }>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Fingers in the order and Kaspi QR as the only method: «К оплате» opens the QR. */
export const QrOnly: Story = {};
/** A burger in the order: fingers are suggested. */
export const BurgerOrder: Story = { args: { order: ['burger-combo'] } };
/** Both mains: the lemonade is the hero. */
export const BothMains: Story = { args: { order: ['pick-combo', 'burger'] } };
export const Kazakh: Story = { args: { locale: 'kk' } };
/** QR and phone invoice: «К оплате» opens the existing payment-method screen. */
export const QrAndInvoice: Story = { args: { methods: 'qrAndInvoice' } };
