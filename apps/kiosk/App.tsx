import { useFonts } from 'expo-font';
import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  Montserrat_500Medium,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
  Montserrat_800ExtraBold,
} from '@expo-google-fonts/montserrat';
import {
  GolosText_400Regular,
  GolosText_500Medium,
  GolosText_600SemiBold,
  GolosText_700Bold,
} from '@expo-google-fonts/golos-text';
import { KioskApp } from './src/KioskApp';

export default function App() {
  useKeepAwake();
  const [loaded, error] = useFonts({
    Montserrat_500Medium,
    Montserrat_600SemiBold,
    Montserrat_700Bold,
    Montserrat_800ExtraBold,
    GolosText_400Regular,
    GolosText_500Medium,
    GolosText_600SemiBold,
    GolosText_700Bold,
  });
  return (
    <SafeAreaProvider>
      <StatusBar hidden />
      {loaded ? (
        <KioskApp />
      ) : (
        <View style={styles.loading}>
          {error ? (
            <Text style={styles.error}>Не удалось открыть киоск. Обратитесь к сотруднику.</Text>
          ) : (
            <ActivityIndicator size="large" color="#fff" accessibilityLabel="Открываем киоск" />
          )}
        </View>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#0047BB',
  },
  error: { fontSize: 24, color: '#fff', textAlign: 'center' },
});
