import { createContext, useRef } from 'react';
import { useRouter } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { t, useLocale } from '../i18n';
import { useAccount } from '../useAccount';
import { guestCanOpen } from '../account-access';
import { useMobile } from '../store';
import { kaspiCheckoutEnabled } from '../commerce-checkout';
import { connectedTestOrdersEnabled } from '../order-simulator';
import { usePublishedActiveOrderCount } from '../active-orders';
import { activeOrderCount, testActiveKind } from '../orders-tab';
import { colors } from '../theme';

// Shared across native screens: visiting another tab must not replay "item added" feedback.
export const NativeTabCartSeenContext = createContext<{ current: number } | null>(null);

/** UIKit owns the material, selection gesture and interrupted transition on iOS. */
export function NativeTabLayout() {
  useLocale();
  const account = useAccount();
  const router = useRouter();
  const model = useMobile();
  const kaspiActive = usePublishedActiveOrderCount();
  const seenCartCount = useRef(0);
  const activeOrders = !account.account
    ? 0
    : kaspiCheckoutEnabled
      ? kaspiActive
      : connectedTestOrdersEnabled
        ? activeOrderCount(model.testFlow.orders, (order) => testActiveKind(order.state))
        : 0;
  const gamesNeedAccount = !guestCanOpen('M26') && !account.account;
  // Native tabPress is informational, not cancellable. Block selection on the native side
  // before opening auth; otherwise a guest can briefly enter the protected orders screen.
  const signIn = (returnTo: 'M19' | 'M26') => ({
    tabPress: () => {
      if (!account.account) router.push({ pathname: '/auth', params: { returnTo } });
    },
  });
  return (
    <NativeTabCartSeenContext.Provider value={seenCartCount}>
      <NativeTabs tintColor={colors.accentText} minimizeBehavior="never">
        <NativeTabs.Trigger
          name="menu"
          testID="tab-menu"
          disableAutomaticContentInsets
          disableScrollToTop
        >
          <NativeTabs.Trigger.Label>{t('Меню')}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: 'fork.knife', selected: 'fork.knife' }} />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger
          name="events"
          testID="tab-events"
          disabled={gamesNeedAccount}
          listeners={gamesNeedAccount ? signIn('M26') : undefined}
          disableAutomaticContentInsets
          disableScrollToTop
        >
          <NativeTabs.Trigger.Label>{t('Игры')}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{ default: 'gamecontroller', selected: 'gamecontroller.fill' }}
          />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger
          name="orders"
          testID="tab-orders"
          disabled={!account.account}
          listeners={signIn('M19')}
          disableAutomaticContentInsets
          disableScrollToTop
        >
          <NativeTabs.Trigger.Label>{t('Заказы')}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: 'bag', selected: 'bag.fill' }} />
          {activeOrders > 0 ? (
            <NativeTabs.Trigger.Badge>
              {activeOrders > 9 ? '9+' : String(activeOrders)}
            </NativeTabs.Trigger.Badge>
          ) : null}
        </NativeTabs.Trigger>
      </NativeTabs>
    </NativeTabCartSeenContext.Provider>
  );
}
