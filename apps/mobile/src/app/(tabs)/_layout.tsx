import { t, useLocale } from '../../i18n';
import { useAccount } from '../../useAccount';
import { Tabs, useRouter } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FloatingTabBar, TabBarInsetContext } from '../../components/FloatingTabBar';
import { tabBarMetrics } from '../../tab-bar-metrics';
import { useMobile } from '../../store';
import { kaspiCheckoutEnabled } from '../../commerce-checkout';
import { connectedTestOrdersEnabled } from '../../order-simulator';
import { usePublishedActiveOrderCount } from '../../active-orders';
import { activeOrderCount, testActiveKind } from '../../orders-tab';

// Floating capsule bar (Luma pattern, owner request 2026-10-11). Screens scroll under it
// and reserve its height through TabBarInsetContext. Owner 27.10.2026: exactly three tabs;
// the profile opens from the top header (components/AppHeader) as the /profile stack screen.
export default function TabLayout() {
  useLocale();
  const insets = useSafeAreaInsets();
  const account = useAccount();
  const router = useRouter();
  const gate = (returnTo: string) => ({
    tabPress: (event: { preventDefault(): void }) => {
      if (!account.account) {
        event.preventDefault();
        router.push({ pathname: '/auth', params: { returnTo } });
      }
    },
  });
  const { fontScale } = useWindowDimensions();
  const inset = tabBarMetrics(insets, fontScale).inset;
  // Orange counter of the «Сейчас» orders, from data the app already holds.
  const model = useMobile();
  const kaspiActive = usePublishedActiveOrderCount();
  const activeOrders = !account.account
    ? 0
    : kaspiCheckoutEnabled
      ? kaspiActive
      : connectedTestOrdersEnabled
        ? activeOrderCount(model.testFlow.orders, (order) => testActiveKind(order.state))
        : 0;
  return (
    <TabBarInsetContext.Provider value={inset}>
      <Tabs
        tabBar={(props) => <FloatingTabBar {...props} />}
        screenOptions={{
          headerShown: false,
          // No tab fade on purpose. expo-router 57's bottom-tab view derives a hidden tab's native
          // attach state from the fade's animated value; on iOS a quick switch back can leave the
          // returning tab detached and blank (expo/expo#49681, react-navigation#12755). Instant
          // switching is also the standard iOS tab behaviour.
          animation: 'none',
          tabBarHideOnKeyboard: true,
          sceneStyle: { backgroundColor: '#04143A' },
        }}
      >
        <Tabs.Screen
          name="menu"
          options={{
            title: t('Меню'),
            tabBarButtonTestID: 'tab-menu',
          }}
        />
        <Tabs.Screen
          name="events"
          listeners={gate('M26')}
          options={{
            title: t('События'),
            tabBarButtonTestID: 'tab-events',
          }}
        />
        <Tabs.Screen
          name="orders"
          listeners={gate('M19')}
          options={{
            title: t('Заказы'),
            tabBarButtonTestID: 'tab-orders',
            tabBarBadge: activeOrders > 0 ? activeOrders : undefined,
          }}
        />
      </Tabs>
    </TabBarInsetContext.Provider>
  );
}
