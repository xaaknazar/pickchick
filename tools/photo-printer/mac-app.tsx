// Operator-only entry: reuse the actual kiosk screens, without booting any order/API controller.
import { useState } from 'react';
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KioskFonts } from '../../apps/kiosk/src/components/KioskFonts';
import { ScreenSurface } from '../../apps/kiosk/src/components/ScreenSurface';
import { Hero } from '../../apps/kiosk/src/components/Hero';
import { WelcomeContent } from '../../apps/kiosk/src/components/WelcomeContent';
import type { Locale } from '../../apps/kiosk/src/i18n';

function MacPhotoApp() {
  const [locale, setLocale] = useState<Locale>('ru');
  return (
    <SafeAreaProvider>
      <KioskFonts>
        <ScreenSurface tone="dark" testID="kiosk-screen-welcome">
          <Hero />
          <WelcomeContent
            locale={locale}
            onLocale={setLocale}
            busy={false}
            onStart={() =>
              window.alert(
                'Сейчас открыта проверка фотокабины. Нажмите «Сделать фото» внизу экрана.',
              )
            }
          />
        </ScreenSurface>
      </KioskFonts>
    </SafeAreaProvider>
  );
}
registerRootComponent(MacPhotoApp);
