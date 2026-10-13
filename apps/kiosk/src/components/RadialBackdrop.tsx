import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { redesign } from '../theme';
const [glow, brand, deep] = redesign.screen;
/** README "Фон экранов": radial-gradient(120% 60% at 75% 0%, #1E6BE6, #0047BB 45%, #02297A). */
const gradient = `radial-gradient(120% 60% at 75% 0%, ${glow}, ${brand} 45%, ${deep})`;
/**
 * Owner-approved screen background of the kiosk redesign 2026-10-13: a bright blue glow from
 * the top right fading to the deep brand blue. Drawn behind the screen's content (first child of
 * the surface); it takes no touches and is hidden from assistive technology. The web draws the
 * CSS gradient, iOS the same string through React Native's background image; the solid deep
 * blue stays underneath should a platform not draw it.
 */
export function RadialBackdrop() {
  const image = (
    Platform.OS === 'web'
      ? { backgroundImage: gradient }
      : { experimental_backgroundImage: gradient }
  ) as ViewStyle;
  return (
    <View
      testID="kiosk-radial-backdrop"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={[StyleSheet.absoluteFill, { backgroundColor: deep }, image]}
    />
  );
}
