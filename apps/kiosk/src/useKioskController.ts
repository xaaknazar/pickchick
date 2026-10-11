import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { prefetchCatalogMedia, rememberCatalogMedia } from './assets';
import { startKioskPolling } from './polling';
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
  // Register the publication's photos before the screens render, then keep them on disk.
  const [, setMediaReady] = useState(0);
  useMemo(() => rememberCatalogMedia(state.catalog), [state.catalog]);
  useEffect(() => {
    const urls = rememberCatalogMedia(state.catalog);
    if (!urls.length) return;
    let live = true;
    void prefetchCatalogMedia(urls).then((ready) => {
      if (live && ready) setMediaReady((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [state.catalog]);
  useEffect(() => {
    const stop = startKioskPolling(controller, () => AppState.currentState === 'active');
    const active = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        void controller.tick();
        void controller.refresh();
      }
    });
    return () => {
      stop();
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
    closeProduct: controller.closeProduct,
    editLine: controller.editLine,
    openUpsell: controller.openUpsell,
    openCart: controller.openCart,
    goLoyalty: controller.goLoyalty,
    setPaymentMethod: controller.setPaymentMethod,
    setInvoicePhone:
      controller instanceof CommercialKioskController ? controller.setInvoicePhone : undefined,
    setCatalogLocale:
      controller instanceof CommercialKioskController ? controller.setLocale : undefined,
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
