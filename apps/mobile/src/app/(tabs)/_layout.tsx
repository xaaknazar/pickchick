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
  const { fontScale } = useWindowDimensions();
  const inset = tabBarMetrics(insets, fontScale).inset;
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
