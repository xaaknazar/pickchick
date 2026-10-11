import { useReducedMotion } from '../../components/Motion';
import { useAccount } from '../../useAccount';
import { Tabs, useRouter } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FloatingTabBar, TabBarInsetContext } from '../../components/FloatingTabBar';
import { tabBarMetrics } from '../../tab-bar-metrics';

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
