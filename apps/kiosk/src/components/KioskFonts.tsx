import type { ReactNode } from 'react';
import { useFonts } from 'expo-font';
import { BootState } from './BootState';
import { Montserrat_700Bold, Montserrat_800ExtraBold } from '@expo-google-fonts/montserrat';
import {
  GolosText_400Regular,
  GolosText_600SemiBold,
  GolosText_700Bold,
} from '@expo-google-fonts/golos-text';
export function KioskFonts({ children }: { children: ReactNode }) {
  const [loaded, error] = useFonts({
    Montserrat_700Bold,
    Montserrat_800ExtraBold,
    GolosText_400Regular,
    GolosText_600SemiBold,
    GolosText_700Bold,
  });
  return loaded ? (
    <>{children}</>
  ) : (
    <BootState message={error ? 'Не удалось открыть киоск. Обратитесь к сотруднику.' : undefined} />
  );
}
