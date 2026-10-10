import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';
import { CommercialKioskController, type CommercialKioskIO } from '../commercial-controller';
import { ReviewScreen } from '../screens/CartScreens';
import { OrderScreen, PaymentScreen } from '../screens/PaymentOrderScreens';
import { BootState } from './BootState';
import { Notice } from './Notice';
import { ScreenSurface } from './UI';
import { copy, type Locale } from '../i18n';
import type { KioskModel } from '../model';

// Storybook-only, entirely in-memory transport for a branch in mode 'cloud' (ADR-0014).
// It never calls fetch, a bank or a kitchen; the QR text is not payable.
type Scenario = 'kitchen-offline' | 'paid-number';
function fixture() {
  const branchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const state = { kitchen: 'online' as 'online' | 'offline', signature: 'a' };
  let session: string | null = null;
  let flow: string | null = null;
  let order: Record<string, unknown> | null = null;
  const availability = () => ({
    fresh: state.kitchen === 'online',
    products: mockupCatalogDraft.products.map((p) => ({
      productId: p.id,
      available: p.available,
      stoppedOptions: [],
    })),
  });
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
    read: async (path) => {
      if (path.startsWith('/catalog/media')) throw new Error('No photo map in the story');
      return {
        data: availability(),
        catalogVersion: null,
        signature: state.signature.repeat(64),
      };
    },
    request: async (path, _token, body) => {
      const input = body as Record<string, unknown>;
      if (path === '/sessions')
        return { ...input, branchId, expiresAt: new Date(Date.now() + 3600000).toISOString() };
      if (path === '/config')
        return {
          enabled: state.kitchen === 'online',
          branchId,
          paymentMethod: 'kaspi_qr',
          paymentMethods: ['kaspi_qr'],
          kitchen: state.kitchen,
        };
      if (path === '/catalog')
        return {
          branch: { id: branchId },
          channel: 'kiosk',
          version: 1,
          payload: mockupCatalogDraft,
        };
      if (path === '/availability') return availability();
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
          displayNumber: null,
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
          paymentMethod: 'kaspi_qr',
          payment: {
            kind: 'kaspi_qr',
            state: 'pending',
            qrPayload: 'SYNTHETIC-STORY-QR-NOT-PAYABLE',
            expiresAt: new Date(Date.now() + 180000).toISOString(),
          },
        };
        return order;
      }
      if (path.startsWith('/orders/')) return order;
      throw new Error('Unsupported synthetic story route');
    },
  };
  return {
    controller: new CommercialKioskController(io),
    /** The kitchen screens stop polling: the next availability answer is not fresh. */
    kitchenOffline() {
      state.kitchen = 'offline';
      state.signature = 'b';
    },
    /** The bank captured the payment and the cloud kitchen gave the order number 342. */
    paidInCloudKitchen() {
      order = {
        ...order,
        phase: 'preparing',
        kitchenStage: 'cooking',
        displayNumber: '342',
        payment: { ...(order?.payment as object), state: 'paid' },
      };
    },
  };
}
function renderCloudKitchen({ locale, scenario }: { locale: Locale; scenario: Scenario }) {
  const f = useMemo(fixture, []);
  const c = f.controller;
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
      if (scenario === 'kitchen-offline') {
        f.kitchenOffline();
        await c.watchAvailability();
        return;
      }
      await c.beginPayment();
      f.paidInCloudKitchen();
      await c.refresh();
    })();
  }, [c, f, scenario]);
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
  const t = copy(locale);
  // The same notice GuestScreen shows: the guest's language for the error code.
  const errorText = state.errorCode ? t[`err_${state.errorCode}`] : state.error;
  if (!state.ready) return <BootState />;
  return (
    <ScreenSurface>
      {state.step === 'order' ? (
        <OrderScreen model={model} context={context} />
      ) : state.step === 'payment' ? (
        <PaymentScreen model={model} context={context} />
      ) : (
        <ReviewScreen model={model} context={context} />
      )}
      {errorText ? <Notice testID="kiosk-error" body={errorText} tone="error" /> : null}
    </ScreenSurface>
  );
}
const meta = {
  title: 'Kiosk/CloudKitchen',
  args: { locale: 'ru', scenario: 'kitchen-offline' },
  render: renderCloudKitchen,
  parameters: {
    docs: {
      description: {
        component:
          'Точка в режиме cloud (ADR-0014): кухня не на связи (KITCHEN_OFFLINE) и оплаченный заказ с номером облачной кухни 300-599. Все ответы в памяти, банка и кухни нет.',
      },
    },
  },
} satisfies Meta<{ locale: Locale; scenario: Scenario }>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KitchenOffline: Story = {};
export const KitchenOfflineKk: Story = { args: { locale: 'kk' } };
export const KitchenOfflineEn: Story = { args: { locale: 'en' } };
export const PaidNumber: Story = { args: { scenario: 'paid-number' } };
