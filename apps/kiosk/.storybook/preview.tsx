import type { Preview } from '@storybook/react-native-web-vite';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KioskFonts } from '../src/components/KioskFonts';
import { ScreenSurface } from '../src/components/ScreenSurface';
import './preview.css';
const preview: Preview = {
  decorators: [
    (Story) => (
      <SafeAreaProvider>
        <KioskFonts>
          <ScreenSurface testID="kiosk-story-content">
            <Story />
          </ScreenSurface>
        </KioskFonts>
      </SafeAreaProvider>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    a11y: { test: 'error' },
    viewport: {
      options: {
        ipad: { name: 'iPad 10.9 portrait', styles: { width: '820px', height: '1180px' } },
        ipadMini: { name: 'iPad 768 portrait', styles: { width: '768px', height: '1024px' } },
        ipadPro: { name: 'iPad Pro portrait', styles: { width: '1024px', height: '1366px' } },
        landscape: {
          name: 'iPad landscape fallback',
          styles: { width: '1180px', height: '820px' },
        },
      },
    },
    controls: { expanded: true },
  },
  initialGlobals: { viewport: { value: 'ipad', isRotated: false } },
};
export default preview;
