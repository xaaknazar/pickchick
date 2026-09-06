import { Tabs } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TabIcon } from '../../components/UI';

const activeColor = '#4A85F0';
const inactiveColor = '#93A6C9';
export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: activeColor,
        tabBarInactiveTintColor: inactiveColor,
        tabBarLabelPosition: 'below-icon',
        tabBarStyle: {
          backgroundColor: '#04143A',
          borderTopColor: '#123068',
          flexShrink: 0,
          height: 44 + Math.ceil(16 * fontScale) + insets.bottom,
        },
        tabBarIconStyle: { width: 24, height: 24 },
        tabBarLabelStyle: {
          fontFamily: 'Manrope_600SemiBold',
          fontSize: 11,
          lineHeight: 16,
          includeFontPadding: false,
          textAlign: 'center',
        },
      }}
    >
      <Tabs.Screen
        name="menu"
        options={{
          title: 'Меню',
          tabBarButtonTestID: 'tab-menu',
          tabBarIcon: ({ focused }) => (
            <TabIcon name="menu" color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
      <Tabs.Screen
        name="events"
        options={{
          title: 'События',
          tabBarButtonTestID: 'tab-events',
          tabBarIcon: ({ focused }) => (
            <TabIcon name="events" color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Заказы',
          tabBarButtonTestID: 'tab-orders',
          tabBarIcon: ({ focused }) => (
            <TabIcon name="orders" color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Профиль',
          tabBarButtonTestID: 'tab-profile',
          tabBarIcon: ({ focused }) => (
            <TabIcon name="profile" color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
    </Tabs>
  );
}
