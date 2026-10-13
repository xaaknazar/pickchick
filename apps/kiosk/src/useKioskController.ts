import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import Constants from 'expo-constants';
import { startDevicePresence } from './device-presence';
import { KIOSK_API_URL } from './api';
import * as Crypto from 'expo-crypto';
import { prefetchCatalogMedia, rememberCatalogMedia } from './assets';
import { startKioskPolling } from './polling';
import { KioskController } from './controller';
import { CommercialKioskController } from './commercial-controller';
import { commercialKioskEnabled } from './commercial-api';
import { createCommercialKioskIO, createKioskIO } from './storage';
import { createDemoKiosk, type DemoKiosk } from './demo';
import type { KioskModel } from './model';

export default function useKioskController(): KioskModel {
  const live = useMemo(
    () =>
      commercialKioskEnabled
        ? new CommercialKioskController(createCommercialKioskIO())
        : new KioskController(createKioskIO()),
    [],
  );
  // Staff demo mode (owner decision 2026-10-11): React state only, so an app restart always
  // starts in normal mode. The demo controller has its own in-memory transport (demo.ts).
  const [demo, setDemoKiosk] = useState<DemoKiosk | null>(null);
  const controller = demo?.controller ?? live;
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void live.restore();
  }, [live]);
  const setDemo = useCallback(
    (on: boolean) => {
      if (!on) {
        setDemoKiosk(null);
        return;
      }
      // Only from the idle start screen: a live guest, order or payment is never left behind.
      const current = live.getSnapshot();
      if (current.step !== 'start' || current.busy || current.recoveryRequired || current.order)
        return;
      const seed = live instanceof CommercialKioskController ? live.demoSeed() : null;
      setDemoKiosk((previous) => previous ?? createDemoKiosk(seed, { uuid: Crypto.randomUUID }));
    },
    [live],
  );
  useEffect(() => {
    if (!demo) return;
    const c = demo.controller;
    void c.restore();
    // Order reads and the idle return to the start screen; no availability long-poll in demo.
    return startKioskPolling(
      { getSnapshot: c.getSnapshot, refresh: c.refresh, tick: c.tick },
      () => AppState.currentState === 'active',
    );
  }, [demo]);
  useEffect(() => {
    if (!commercialKioskEnabled) return;
    const io = createCommercialKioskIO();
    const presence = startDevicePresence({
      readDevice: io.readDevice,
      origin: KIOSK_API_URL,
      appVersion: `${Constants.expoConfig?.version ?? 'unknown'} (${Constants.expoConfig?.ios?.buildNumber ?? 'unknown'})`,
      snapshot: () => {
        const current = live.getSnapshot();
        const version = Number(current.catalog?.catalog_version);
        return {
          state: AppState.currentState === 'active' ? 'active' : 'background',
          issue: demo ? 'demo' : current.error ? 'connection' : !current.catalog ? 'data' : 'none',
          menuVersion: Number.isInteger(version) && version > 0 ? version : null,
        };
      },
    });
    const subscription = AppState.addEventListener('change', () => void presence.send());
    return () => {
      presence.stop();
      subscription.remove();
    };
  }, [live, demo]);
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
    // The live kiosk keeps its own polling while the demo is shown (menu reads only).
    const stop = startKioskPolling(live, () => AppState.currentState === 'active');
    const active = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        void live.tick();
        void live.refresh();
      }
    });
    return () => {
      stop();
      active.remove();
    };
  }, [live]);
  return {
    ...state,
    demo: !!demo,
    setDemo,
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
    pay: demo ? demo.pay : controller.pay,
    cancelOrder: controller.cancelOrder,
    cancelPayment: demo?.cancelPayment,
    startOver: controller instanceof CommercialKioskController ? controller.startOver : undefined,
    recover: controller.recover,
    refresh: controller.refresh,
    newGuest: controller.newGuest,
    touch: controller.touch,
    stay: controller.stay,
  };
}
