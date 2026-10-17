// Operator-only entry: reuse the actual kiosk screens, without booting any order/API controller.
import { useState } from 'react';
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KioskFonts } from '../../apps/kiosk/src/components/KioskFonts';
import { ScreenSurface } from '../../apps/kiosk/src/components/ScreenSurface';
import { Hero } from '../../apps/kiosk/src/components/Hero';
import { PhotoEntry } from '../../apps/kiosk/src/components/PhotoEntry';
import { Wrapper } from '../../apps/kiosk/src/components/Wrapper';
import { Language } from '../../apps/kiosk/src/components/Language';
import type { Locale } from '../../apps/kiosk/src/i18n';

function MacPhotoApp() {
  const [locale, setLocale] = useState<Locale>('ru');
  return (
    <SafeAreaProvider>
      <KioskFonts>
        <ScreenSurface tone="dark" testID="kiosk-screen-welcome">
          <Hero />
          <Wrapper flex={1} align="center" justify="center" gap={24}>
            <Language locale={locale} onChange={setLocale} tone="inverse" surface="start" />
            <Wrapper width={220}>
              <PhotoEntry locale={locale} />
            </Wrapper>
          </Wrapper>
        </ScreenSurface>
      </KioskFonts>
    </SafeAreaProvider>
  );
}
registerRootComponent(MacPhotoApp);
