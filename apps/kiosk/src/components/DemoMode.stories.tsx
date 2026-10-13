import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { createDemoKiosk, type DemoOutcome } from '../demo';
import { ReviewScreen } from '../screens/CartScreens';
import { OrderScreen, PaymentScreen } from '../screens/PaymentOrderScreens';
import { BootState } from './BootState';
import { DemoBadge } from './DemoBadge';
import { ScreenSurface } from './UI';
import type { Locale } from '../i18n';
import type { KioskModel } from '../model';

// Staff demo mode (owner decision 2026-10-11): the real commercial controller over the in-memory
// demo transport (demo.ts) with the built-in fixture menu. No fetch, bank or kitchen; the QR text
// is not payable and the order number is a demo one ("Д-123").
type Scenario = 'review' | 'qr' | DemoOutcome;
function renderDemo({ locale, scenario }: { locale: Locale; scenario: Scenario }) {
  const demo = useMemo(() => createDemoKiosk(null, { uuid: () => crypto.randomUUID() }), []);
  const c = demo.controller;
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
      if (scenario === 'review') return;
      await c.beginPayment();
      if (scenario !== 'qr') await demo.pay(scenario);
    })();
  }, [c, demo, scenario]);
  const model: KioskModel = {
    ...state,
    demo: true,
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
    pay: demo.pay,
    cancelOrder: c.cancelOrder,
    recover: c.recover,
    refresh: c.refresh,
    newGuest: c.newGuest,
    touch: c.touch,
    stay: c.stay,
  };
  const context = { locale, setLocale: () => {}, onHelp: () => {}, onCancel: () => {} };
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
      <DemoBadge locale={locale} onExit={() => {}} />
    </ScreenSurface>
  );
}
const meta = {
  title: 'Kiosk/DemoMode',
  args: { locale: 'ru', scenario: 'qr' },
  render: renderDemo,
  parameters: {
    docs: {
      description: {
        component:
          'Скрытый демо-режим для персонала (решение владельца 2026-10-11): весь путь до QR и номера заказа «Д-123». Все ответы в памяти, заказов и оплат нет, QR не оплачивается.',
      },
    },
  },
} satisfies Meta<{ locale: Locale; scenario: Scenario }>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Review: Story = { args: { scenario: 'review' } };
export const DemoQr: Story = {};
export const DemoQrKk: Story = { args: { locale: 'kk' } };
export const DemoQrEn: Story = { args: { locale: 'en' } };
export const DemoPaid: Story = { args: { scenario: 'approved' } };
export const DemoDeclined: Story = { args: { scenario: 'declined' } };
export const DemoUnknown: Story = { args: { scenario: 'unknown' } };
