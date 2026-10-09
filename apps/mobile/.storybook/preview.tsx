import type { Preview } from '@storybook/react-native-web-vite';
import type { PropsWithChildren } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { Jost_600SemiBold } from '@expo-google-fonts/jost/600SemiBold';
import { Jost_700Bold } from '@expo-google-fonts/jost/700Bold';
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold';
import { Manrope_700Bold } from '@expo-google-fonts/manrope/700Bold';
import { colors } from '../src/theme';
function StorySurface({ children }: PropsWithChildren) {
  const [loaded, error] = useFonts({
    Jost_600SemiBold,
    Jost_700Bold,
    Manrope_400Regular,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });
  if (error) throw error;
  return loaded ? (
    <SafeAreaProvider>
      <View style={{ padding: 24, minHeight: 220, backgroundColor: colors.background }}>
        {children}
      </View>
    </SafeAreaProvider>
  ) : null;
}
const preview: Preview = {
  decorators: [
    (Story) => (
      <StorySurface>
        <Story />
      </StorySurface>
    ),
  ],
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
};
export default preview;
