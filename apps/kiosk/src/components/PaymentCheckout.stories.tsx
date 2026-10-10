import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';
import { CommercialKioskController, type CommercialKioskIO } from '../commercial-controller';
import { ReviewScreen } from '../screens/CartScreens';
import { PaymentScreen, RecoveryScreen } from '../screens/PaymentOrderScreens';
import { BootState } from './BootState';
import type { KioskModel } from '../model';
import type { Locale } from '../i18n';

// Storybook-only, entirely in-memory transport. It never calls fetch or a bank.
function fixture() {
  const branchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let session: string | null = null;
  let flow: string | null = null;
  let order: Record<string, unknown> | null = null;
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
          paymentMethods: ['kaspi_qr', 'kaspi_invoice'],
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
          products: mockupCatalogDraft.products.map((p) => ({
            productId: p.id,
            available: p.available,
            stoppedOptions: [],
          })),
        };
      if (path === '/quotes')
        return {
          quoteId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          totalMinor: '419000',
          serviceMode: 'takeaway',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
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
          totalMinor: '419000',
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
function renderCheckout({ locale }: { locale: Locale }) {
  const c = useMemo(fixture, []);
  const state = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => {
    void (async () => {
      await c.restore();
      await c.start();
      await c.setMode('takeaway');
      const product = c.getSnapshot().catalog!.products[0]!;
      await c.addToCart(
        product.id,
        product.modifier_groups.flatMap((g) =>
          g.options
            .filter((o) => o.default_quantity)
            .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity })),
        ),
      );
      c.goLoyalty();
    })();
  }, [c]);
  const model: KioskModel = {
    ...state,
    start: c.start,
    setMode: c.setMode,
    goMode: c.goMode,
    goMenu: c.goMenu,
    openProduct: c.openProduct,
    closeProduct: c.closeProduct,
    openUpsell: c.openUpsell,
    openCart: c.openCart,
    goLoyalty: c.goLoyalty,
    setInvoicePhone: c.setInvoicePhone,
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
  const context = { locale, setLocale: () => {}, onHelp: () => {}, onCancel: () => {} };
  return !state.ready ? (
    <BootState />
  ) : state.step === 'payment' ? (
    <PaymentScreen model={model} context={context} />
  ) : state.step === 'recovery' ? (
    <RecoveryScreen model={model} context={context} />
  ) : (
    <ReviewScreen model={model} context={context} />
  );
}
const meta = {
  title: 'Kiosk/PaymentCheckout',
  args: { locale: 'ru' },
  render: renderCheckout,
  parameters: {
    docs: {
      description: {
        component:
          'Синтетический сценарий реального контроллера. Все ответы в памяти, QR не платёжный, банковских запросов нет.',
      },
    },
  },
} satisfies Meta<{ locale: Locale }>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BothMethods: Story = {};
export const BothMethodsKk: Story = { args: { locale: 'kk' } };
