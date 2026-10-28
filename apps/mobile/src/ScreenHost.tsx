import { t, useLocale } from './i18n';
import { OrderSheet } from './components/OrderSheet';
import { useCallback, useState } from 'react';
import { ScreenTransition } from './components/Motion';
import { Stack, Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAccount } from './useAccount';
import { accountDestination, requiresAccount } from './account-access';
import { Pressable, Text } from 'react-native';
import type { ScreenId } from './model';
import { useMobile } from './store';
import { useTabBarInset, useTabCartDockHeight } from './components/tab-bar-inset';
import { tabContentInset } from './tab-bar-metrics';
import { MobileScreen } from './screens/MobileScreen';

const tabRoutes = {
  M06: '/(tabs)/menu',
  M26: '/(tabs)/events',
  M19: '/(tabs)/orders',
} as const;
/** Owner 27.10.2026: the profile is a stack screen above the tabs, opened from the header. */
const profileRoute = '/profile';
export function ScreenHost({ id, preview = false }: { id: ScreenId; preview?: boolean }) {
  useLocale();
  const [dismissBlocked, setDismissBlocked] = useState(false);
  const router = useRouter();
  const params = useLocalSearchParams();
  const returnTo = accountDestination(params.returnTo);
  const model = useMobile(preview);
  const account = useAccount();
  // The floating tab bar and the cart bar docked on it (owner 28.10.2026: drawn by the tab bar
  // itself, components/TabCartDock) overlay the tab screens; their content stays above both.
  const tabBarInset = useTabBarInset();
  const cartDockHeight = useTabCartDockHeight();
  // Rendered inside the tab layout (outside it the inset is 0). Not «a tab is focused»: with the
  // cart, sign-in or an order status open over a tab, the tab below is still in the tab layout.
  // Before 28.10 a focused route above the tabs made the menu draw a second, standalone cart bar
  // at the very bottom of the screen, under the tab bar, and moved footers behind it too.
  const inTabs = tabBarInset > 0;
  const tabScreen = id in tabRoutes && inTabs;
  const statusSheet = ['M17', 'M18', 'M20'].includes(id);
  const inSheet = id === 'M09' || id === 'M12' || statusSheet;
  const back = useCallback(
    () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/menu')),
    [router],
  );
  const navigate = (next: ScreenId) => {
    if (!preview && (next === 'M02' || (!account.account && requiresAccount(next, false)))) {
      router.push({ pathname: '/auth', params: { returnTo: next === 'M02' ? 'M30' : next } });
      return;
    }
    if (id === 'M09' && next === 'M06') {
      router.dismissTo({
        pathname: '/(tabs)/menu',
        params: { catalogVisit: String(Date.now()), ...(preview ? { preview: '1' } : {}) },
      });
      return;
    }
    if (['M17', 'M18', 'M20'].includes(next)) {
      if (id === 'M12') router.dismissAll();
      router.navigate({
        pathname: '/order-status',
        params: { id: next, ...(preview ? { preview: '1' } : {}) },
      });
      return;
    }
    if (next === 'M09' || next === 'M12') {
      if (id === 'M12' && next === 'M09' && router.canGoBack()) {
        // Back to the cart below. Checkout opened from the cart bar lies right on a tab: there the
        // cart takes its place (never a second sheet on top, never the tab instead of the cart).
        if (preview) router.back();
        else router.dismissTo('/cart');
        return;
      }
      router.push({
        pathname: next === 'M09' ? '/cart' : '/checkout',
        params: preview ? { preview: '1' } : {},
      });
      return;
    }
    if (!preview && returnTo && id === 'M04' && (next === 'M06' || next === 'M30')) {
      // Return to the protected route beneath the whole login flow. Replacing
      // only M04 leaves the OTP screen underneath checkout's transparent sheet.
      if (returnTo === 'pick-man') router.dismissTo('/games/pick-man');
      else if (returnTo === 'pick-blocks') router.dismissTo('/games/pick-blocks');
      else if (returnTo === 'pick-farm') router.dismissTo('/games/pick-farm');
      else if (returnTo === 'M12') router.dismissTo('/checkout');
      // Kaspi build: the guest pressed «Оплатить» in the cart; back to the same cart, no auto-pay.
      else if (returnTo === 'M09') router.dismissTo('/cart');
      else if (['M17', 'M18', 'M20'].includes(returnTo))
        router.dismissTo({ pathname: '/order-status', params: { id: returnTo } });
      else if (returnTo === 'M30') router.dismissTo(profileRoute);
      else if (returnTo in tabRoutes)
        router.dismissTo(tabRoutes[returnTo as keyof typeof tabRoutes]);
      else router.dismissTo({ pathname: '/screen/[id]', params: { id: returnTo } });
      return;
    }
    if (!preview && next === 'M30') {
      // Header button pushes the profile; finishing its edit form (M04) returns to it.
      if (id === 'M04') router.dismissTo(profileRoute);
      else router.push(profileRoute);
      return;
    }
    // The profile sits above the tab navigator: return to it instead of stacking new tabs.
    if (!preview && id === 'M30' && next in tabRoutes)
      router.dismissTo(tabRoutes[next as keyof typeof tabRoutes]);
    else if (!preview && next in tabRoutes)
      router.navigate(tabRoutes[next as keyof typeof tabRoutes]);
    else
      router.push({
        pathname: '/screen/[id]',
        params: {
          id: next,
          ...(preview ? { preview: '1' } : {}),
          ...(!preview && returnTo && ['M02', 'M03', 'M04'].includes(next) ? { returnTo } : {}),
        },
      });
  };
  if (!preview && ['M01', 'M02', 'M03'].includes(id))
    return (
      <Redirect
        href={{ pathname: '/auth', params: { step: id, ...(returnTo ? { returnTo } : {}) } }}
      />
    );
  // Temporarily removed from the customer arcade by the owner. Old links return to events.
  if (id === 'M29') return <Redirect href={profileRoute} />;
  if (id === 'M27' || id === 'M28') return <Redirect href="/(tabs)/events" />;
  const screen = (goBack = back) => (
    <MobileScreen
      screenId={id}
      model={model}
      navigate={navigate}
      goBack={goBack}
      inSheet={inSheet}
      preview={preview}
      cartBottomInset={
        tabScreen ? tabContentInset(tabBarInset, cartDockHeight, model.cart.length) : 0
      }
      inTabLayout={inTabs}
    />
  );
  if (inSheet)
    return (
      <>
        <Stack.Screen options={{ gestureEnabled: !dismissBlocked }} />
        <OrderSheet
          onDismissBlockedChange={setDismissBlocked}
          raised={statusSheet}
          checkout={id === 'M09' || id === 'M12'}
          name={statusSheet ? 'Статус заказа' : id === 'M09' ? 'Корзина' : 'Оформление'}
          onClose={back}
        >
          {(close) => screen(close)}
        </OrderSheet>
      </>
    );
  return (
    <ScreenTransition style={{ flex: 1, minHeight: 0, backgroundColor: '#04143A' }}>
      {screen()}
      {preview ? (
        <Pressable
          testID="close-design-preview"
          accessibilityRole="button"
          accessibilityLabel={t('Вернуться в меню')}
          onPress={() => router.replace('/(tabs)/menu')}
          style={{
            minHeight: 44,
            flexShrink: 0,
            paddingHorizontal: 16,
            paddingVertical: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#0A2050',
          }}
        >
          <Text style={{ color: '#C0CDE6', fontFamily: 'Manrope_600SemiBold', fontSize: 12 }}>
            {t('Вернуться в меню')}
          </Text>
        </Pressable>
      ) : null}
    </ScreenTransition>
  );
}
