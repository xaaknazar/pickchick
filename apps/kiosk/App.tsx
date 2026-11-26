import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KioskApp } from './src/KioskApp';
import { KioskFonts } from './src/components/KioskFonts';
import { BootState } from './src/components/BootState';
import { APP_RESTART_MS, KioskErrorBoundary } from './src/errorBoundary';
import { copy } from './src/i18n';
export default function App() {
  useKeepAwake();
  return (
    <SafeAreaProvider>
      <StatusBar hidden />
      <KioskFonts>
        {/* Audit 23.11 #2: a failed render never leaves a blank screen; the app is mounted
            again and restores its stored flow as after a restart. */}
        <KioskErrorBoundary
          restartMs={APP_RESTART_MS}
          fallback={(restart) => (
            <BootState
              loading={false}
              title={copy('ru').crashTitle}
              message={copy('ru').crashBody}
              onRetry={restart}
              retryLabel={copy('ru').tryAgain}
            />
          )}
        >
          <KioskApp />
        </KioskErrorBoundary>
      </KioskFonts>
    </SafeAreaProvider>
  );
}
