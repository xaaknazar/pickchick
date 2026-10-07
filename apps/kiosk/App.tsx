import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KioskApp } from './src/KioskApp';
import { KioskFonts } from './src/components/KioskFonts';
export default function App() {
  useKeepAwake();
  return (
    <SafeAreaProvider>
      <StatusBar hidden />
      <KioskFonts>
        <KioskApp />
      </KioskFonts>
    </SafeAreaProvider>
  );
}
