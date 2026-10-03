import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { KioskController } from './controller';
import { CommercialKioskController } from './commercial-controller';
import { commercialKioskEnabled } from './commercial-api';
import { createCommercialKioskIO, createKioskIO } from './storage';
import type { KioskModel } from './model';

export default function useKioskController(): KioskModel {
  const controller = useMemo(
    () =>
      commercialKioskEnabled
        ? new CommercialKioskController(createCommercialKioskIO())
        : new KioskController(createKioskIO()),
    [],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.restore();
  }, [controller]);
  useEffect(() => {
    let stopped = false;
    let failures = 0;
    let catalogPollAt = Date.now();
    let poll: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (stopped) return;
      poll = setTimeout(
        async () => {
          const before = controller.getSnapshot();
          if (
            AppState.currentState === 'active' &&
            before.ready &&
            !before.busy &&
            (before.order ||
              before.recoveryRequired ||
              !before.catalog ||
              (before.step !== 'start' && Date.now() - catalogPollAt >= 60000))
          ) {
            await controller.refresh();
            if (controller.getSnapshot().catalog) catalogPollAt = Date.now();
            failures = controller.getSnapshot().error ? failures + 1 : 0;
          }
          schedule();
        },
        Math.min(30000, 3000 * 2 ** Math.min(failures, 4)),
      );
    };
    schedule();
    const idle = setInterval(() => {
      if (AppState.currentState === 'active') void controller.tick();
    }, 1000);
    const active = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        void controller.tick();
        void controller.refresh();
      }
    });
    return () => {
      stopped = true;
      clearTimeout(poll);
      clearInterval(idle);
      active.remove();
    };
  }, [controller]);
  return {
    ...state,
    start: controller.start,
    setMode: controller.setMode,
    goMode: controller.goMode,
    goMenu: controller.goMenu,
    openProduct: controller.openProduct,
    openUpsell: controller.openUpsell,
    openCart: controller.openCart,
    goLoyalty: controller.goLoyalty,
    setPaymentMethod: controller.setPaymentMethod,
    setInvoicePhone:
      controller instanceof CommercialKioskController ? controller.setInvoicePhone : undefined,
    addToCart: controller.addToCart,
    updateQuantity: controller.updateQuantity,
    beginPayment: controller.beginPayment,
    pay: controller.pay,
    cancelOrder: controller.cancelOrder,
    recover: controller.recover,
    refresh: controller.refresh,
    newGuest: controller.newGuest,
    touch: controller.touch,
    stay: controller.stay,
  };
}
