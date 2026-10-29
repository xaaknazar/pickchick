import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import Constants from 'expo-constants';
import { startDevicePresence } from './device-presence';
import { KIOSK_API_URL, KIOSK_BUILD_PROFILE, KIOSK_RELEASE_ID } from './api';
import { openKioskHealth, type KioskHeartbeat } from './kiosk-health';
import * as Crypto from 'expo-crypto';
import { prefetchCatalogMedia, rememberCatalogMedia } from './assets';
import { startKioskPolling } from './polling';
import { KioskController } from './controller';
import { CommercialKioskController } from './commercial-controller';
import { commercialKioskEnabled } from './commercial-api';
import { createCommercialKioskIO, createKioskIO } from './storage';
import { createDemoKiosk, demoIdleExpired, DEMO_IDLE_CHECK_MS, type DemoKiosk } from './demo';
import type { KioskModel } from './model';

export default function useKioskController(reviewExit?: () => void): KioskModel {
  // Review mounts only the in-memory controller; live IO is never constructed.
  const review = useMemo(
    () => (reviewExit ? createDemoKiosk(null, { uuid: Crypto.randomUUID }) : null),
    [reviewExit],
  );
  const live = useMemo(
    () =>
      review
        ? review.controller
        : commercialKioskEnabled
          ? new CommercialKioskController(createCommercialKioskIO())
          : new KioskController(createKioskIO()),
    [review],
  );
  // Staff demo mode (owner decision 2026-10-11): React state only, so an app restart always
  // starts in normal mode. The demo controller has its own in-memory transport (demo.ts).
  const [staffDemo, setDemoKiosk] = useState<DemoKiosk | null>(null);
  const demo = review ?? staffDemo;
  const controller = demo?.controller ?? live;
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    if (!review) void live.restore();
  }, [live, review]);
  // Last touch while the demo is shown; the demo leaves by itself after a while (finding 3.4).
  const demoActivity = useRef(0);
  const setDemo = useCallback(
    async (on: boolean, pin?: string) => {
      if (review) {
        if (!on) reviewExit?.();
        return !on;
      }
      if (!on) {
        setDemoKiosk(null);
        return true;
      }
      // Only from the idle start screen: a live guest, order or payment is never left behind.
      const idle = () => {
        const current = live.getSnapshot();
        return (
          current.step === 'start' && !current.busy && !current.recoveryRequired && !current.order
        );
      };
      if (!idle()) return false;
      // Audit 19.10, finding 3.4: the commercial kiosk enters the demo only after the staff code
      // (checked by the server). The simulator build has no real payments and keeps the hold.
      if (live instanceof CommercialKioskController) {
        if (!(await live.verifyStaff(pin ?? '')) || !idle()) return false;
      }
      const seed = live instanceof CommercialKioskController ? live.demoSeed() : null;
      demoActivity.current = Date.now();
      setDemoKiosk((previous) => previous ?? createDemoKiosk(seed, { uuid: Crypto.randomUUID }));
      return true;
    },
    [live, review, reviewExit],
  );
  useEffect(() => {
    if (!demo || review) return;
    const timer = setInterval(() => {
      if (demoIdleExpired(demoActivity.current, Date.now())) setDemoKiosk(null);
    }, DEMO_IDLE_CHECK_MS);
    return () => clearInterval(timer);
  }, [demo, review]);
  const touch = controller.touch;
  const touchAny = useCallback(() => {
    demoActivity.current = Date.now();
    touch();
  }, [touch]);
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
  // Outcome of the last device presence request, for the staff health line only.
  const heartbeat = useRef<KioskHeartbeat | null>(null);
  useEffect(() => {
    if (!commercialKioskEnabled || review) return;
    const io = createCommercialKioskIO();
    const build = `${Constants.expoConfig?.version ?? 'unknown'} (${Constants.expoConfig?.ios?.buildNumber ?? 'unknown'})`;
    const presence = startDevicePresence({
      readDevice: io.readDevice,
      origin: KIOSK_API_URL,
      onResult: (result) => {
        heartbeat.current = result;
      },
      // The release id names the pinned build; the server keeps at most 60 characters.
      appVersion: [build, KIOSK_RELEASE_ID].filter(Boolean).join(' ').slice(0, 60),
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
  }, [live, demo, review]);
  // Stage 2 (lane kln): the staff health line, behind the server-checked staff code. It reads
  // only build constants and the last presence outcome, never the device credentials.
  const staffHealth = useCallback(
    (pin?: string) =>
      openKioskHealth(
        {
          verifyStaff: live instanceof CommercialKioskController ? live.verifyStaff : undefined,
          facts: () => ({
            version: Constants.expoConfig?.version ?? 'unknown',
            build: Constants.expoConfig?.ios?.buildNumber ?? 'unknown',
            releaseId: KIOSK_RELEASE_ID,
            profile: KIOSK_BUILD_PROFILE,
            apiOrigin: KIOSK_API_URL,
            commercial: commercialKioskEnabled,
            staffCode: live instanceof CommercialKioskController ? 'verified' : 'not-required',
            heartbeat: heartbeat.current,
            checkedAt: Date.now(),
          }),
        },
        pin,
      ),
    [live],
  );
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
    if (review) return;
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
  }, [live, review]);
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
    staffReset: controller instanceof CommercialKioskController ? controller.staffReset : undefined,
    clearStaffError:
      controller instanceof CommercialKioskController ? controller.clearStaff : undefined,
    // Not in the demo: its staff dialog only leaves the demo.
    staffHealth: demo ? undefined : staffHealth,
    // The simulator build keeps the plain hold; a commercial kiosk asks for the staff code.
    staffPinRequired: live instanceof CommercialKioskController,
    recover: controller.recover,
    refresh: controller.refresh,
    newGuest: controller.newGuest,
    touch: touchAny,
    stay: controller.stay,
  };
}
