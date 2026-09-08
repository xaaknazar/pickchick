import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Jost_600SemiBold } from '@expo-google-fonts/jost/600SemiBold';
import { Jost_700Bold } from '@expo-google-fonts/jost/700Bold';
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold';
import { Manrope_700Bold } from '@expo-google-fonts/manrope/700Bold';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { MobileProvider } from '../store';
import { AccountProvider } from '../useAccount';
import { LaunchScreen, launchBackground } from '../components/LaunchScreen';

// Hold native artwork until its React counterpart has actually laid out and loaded.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function Layout() {
  const [launchVisible, setLaunchVisible] = useState(true);
  const finishLaunch = useCallback(() => setLaunchVisible(false), []);
  const [loaded, error] = useFonts({
    Jost_600SemiBold,
    Jost_700Bold,
    Manrope_400Regular,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });
  return (
    <View style={{ flex: 1, backgroundColor: launchBackground }}>
      <StatusBar style="light" />
      <View
        style={StyleSheet.absoluteFill}
        accessibilityElementsHidden={launchVisible}
        importantForAccessibility={launchVisible ? 'no-hide-descendants' : 'auto'}
        pointerEvents={launchVisible ? 'none' : 'auto'}
      >
        {error ? (
          <View testID="launch-error" style={{ flex: 1, justifyContent: 'center', padding: 32 }}>
            <Text style={{ color: 'white', fontSize: 18, lineHeight: 28 }}>
              Не удалось загрузить приложение. Закройте и откройте PickChick снова.
            </Text>
          </View>
        ) : loaded ? (
          <AccountProvider>
            <MobileProvider>
              <Stack
                screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#04143A' } }}
              />
            </MobileProvider>
          </AccountProvider>
        ) : null}
      </View>
      {launchVisible ? (
        <LaunchScreen ready={loaded || Boolean(error)} onFinish={finishLaunch} />
      ) : null}
    </View>
  );
}
