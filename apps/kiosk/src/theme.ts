import { useWindowDimensions } from 'react-native';
export const colors = {
  blue: '#0047BB',
  orange: '#FF6900',
  background: '#F6F7F9',
  ink: '#15213A',
  muted: '#5A6579',
  border: '#DDE2EA',
  light: '#EDF1F7',
  dark: '#071B45',
  error: '#AF2525',
  white: '#FFFFFF',
  success: '#187244',
  // v3 kiosk palette (design/kiosk v3, 2026-10-08)
  navy: '#04143A',
  blueBright: '#014FCE',
  night: '#061B4E',
  cream: '#FEF8F0',
  peach: '#FFF0E5',
  orangeDeep: '#E25C00',
  sky: '#EAF1FF',
  soft: '#EEF2FA',
  ok: '#13804A',
  glass: 'rgba(255,255,255,.14)',
  glassLine: 'rgba(255,255,255,.18)',
  onBlueMuted: 'rgba(255,255,255,.78)',
};
export const fonts = {
  body: 'GolosText_400Regular',
  medium: 'GolosText_600SemiBold',
  bold: 'GolosText_700Bold',
  heading: 'Montserrat_700Bold',
  heavy: 'Montserrat_800ExtraBold',
  black: 'Montserrat_900Black',
};
export const tones = {
  default: colors.ink,
  muted: colors.muted,
  brand: colors.blue,
  inverse: colors.white,
  accent: colors.orange,
  danger: colors.error,
  success: colors.success,
  navy: colors.navy,
  onBlue: colors.onBlueMuted,
  deep: colors.orangeDeep,
};
export type Tone = keyof typeof tones;
export function useMetrics() {
  const { width, height, fontScale } = useWindowDimensions();
  const scale = Math.max(0.8, Math.min(1.08, width / 1024));
  return {
    width,
    height,
    fontScale,
    scale,
    px: (n: number) => Math.round(n * scale),
    /** v3 design unit: the v3 kiosk was drawn at 820 pt; 13-inch screens get +25%. */
    v: (n: number) => Math.round(n * 1.25 * scale),
    body: Math.max(18, Math.round(21 * scale)),
    landscape: width > height,
    compact: height < 850,
    columns: width >= 1180 ? 3 : 2,
  };
}
