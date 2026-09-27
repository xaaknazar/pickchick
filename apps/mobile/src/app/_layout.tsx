import { useState } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { LaunchReveal } from '../components/LaunchReveal';
import { Stack } from 'expo-router';
import { MotionProvider, useReducedMotion } from '../components/Motion';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Jost_600SemiBold } from '@expo-google-fonts/jost/600SemiBold';
import { Jost_700Bold } from '@expo-google-fonts/jost/700Bold';
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold';
import { Manrope_700Bold } from '@expo-google-fonts/manrope/700Bold';
import { ActivityIndicator, Text, View } from 'react-native';
import { MobileProvider } from '../store';
import { AccountProvider } from '../useAccount';

// Keep the OS launch image until the matching React layer has laid out.
void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function Layout() {
  return (
    <MotionProvider>
      <AppLayout />
    </MotionProvider>
  );
}
function AppLayout() {
  const reduced = useReducedMotion();
  const [introDone, setIntroDone] = useState(false);
  const [loaded, error] = useFonts({
    Jost_600SemiBold,
    Jost_700Bold,
    Manrope_400Regular,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });
  return (
    <View style={{ flex: 1, backgroundColor: '#04143A' }}>
      <View
        style={{ flex: 1 }}
        pointerEvents={introDone ? 'auto' : 'none'}
        aria-hidden={!introDone}
        accessibilityElementsHidden={!introDone}
        importantForAccessibility={introDone ? 'auto' : 'no-hide-descendants'}
      >
        {error ? (
          <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
            <Text style={{ color: 'white', fontSize: 18 }}>
              Не удалось загрузить приложение. Закройте и откройте PickChick снова.
            </Text>
          </View>
        ) : loaded ? (
          <AccountProvider>
            <MobileProvider>
              <StatusBar style="light" />
              <Stack
                screenOptions={{
                  headerShown: false,
                  animation: reduced ? 'none' : 'default',
                  contentStyle: { backgroundColor: '#04143A' },
                }}
              >
                <Stack.Screen
                  name="order-status"
                  options={{
                    presentation: 'transparentModal',
                    animation: 'none',
                    contentStyle: { backgroundColor: 'transparent' },
                  }}
                />
                <Stack.Screen
                  name="cart"
                  options={{
                    presentation: 'transparentModal',
                    animation: 'none',
                    contentStyle: { backgroundColor: 'transparent' },
                  }}
                />
                <Stack.Screen
                  name="checkout"
                  options={{
                    presentation: 'transparentModal',
                    animation: 'none',
                    contentStyle: { backgroundColor: 'transparent' },
                  }}
                />
              </Stack>
            </MobileProvider>
          </AccountProvider>
        ) : (
          <ActivityIndicator accessibilityLabel="Загрузка PickChick" color="#FF7A3D" />
        )}
      </View>
      {!introDone ? (
        <LaunchReveal
          ready={loaded || !!error}
          failed={!!error}
          onComplete={() => setIntroDone(true)}
        />
      ) : null}
    </View>
  );
}
