import { Stack } from 'expo-router';
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

export default function Layout() {
  const [loaded, error] = useFonts({
    Jost_600SemiBold,
    Jost_700Bold,
    Manrope_400Regular,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });
  if (!loaded && !error)
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#04143A',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <ActivityIndicator accessibilityLabel="Загрузка PickChick" color="#FF7A3D" />
      </View>
    );
  if (error)
    return (
      <View style={{ flex: 1, backgroundColor: '#04143A', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: 'white', fontSize: 18 }}>
          Не удалось загрузить приложение. Закройте и откройте PickChick снова.
        </Text>
      </View>
    );
  return (
    <AccountProvider>
      <MobileProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#04143A' } }}
        />
      </MobileProvider>
    </AccountProvider>
  );
}
