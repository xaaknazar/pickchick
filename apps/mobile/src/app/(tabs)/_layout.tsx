import { useReducedMotion } from '../../components/Motion';
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
// and reserve its height through TabBarInsetContext.
export default function TabLayout() {
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
  const reduced = useReducedMotion();
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
          animation: reduced ? 'none' : 'fade',
          tabBarHideOnKeyboard: true,
          sceneStyle: { backgroundColor: '#04143A' },
        }}
      >
        <Tabs.Screen
          name="menu"
          options={{
            title: 'Меню',
            tabBarButtonTestID: 'tab-menu',
          }}
        />
        <Tabs.Screen
          name="events"
          listeners={gate('M26')}
          options={{
            title: 'События',
            tabBarButtonTestID: 'tab-events',
          }}
        />
        <Tabs.Screen
          name="orders"
          listeners={gate('M19')}
          options={{
            title: 'Заказы',
            tabBarButtonTestID: 'tab-orders',
            tabBarBadge: activeOrders > 0 ? activeOrders : undefined,
          }}
        />
        <Tabs.Screen
          name="profile"
          listeners={gate('M30')}
          options={{
            title: 'Профиль',
            tabBarButtonTestID: 'tab-profile',
          }}
        />
      </Tabs>
    </TabBarInsetContext.Provider>
  );
}
