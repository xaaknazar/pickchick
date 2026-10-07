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
};
export const fonts = {
  body: 'GolosText_400Regular',
  medium: 'GolosText_600SemiBold',
  bold: 'GolosText_700Bold',
  heading: 'Montserrat_700Bold',
  heavy: 'Montserrat_800ExtraBold',
};
export const tones = {
  default: colors.ink,
  muted: colors.muted,
  brand: colors.blue,
  inverse: colors.white,
  accent: colors.orange,
  danger: colors.error,
  success: colors.success,
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
    body: Math.max(18, Math.round(21 * scale)),
    landscape: width > height,
    compact: height < 850,
    columns: width >= 1180 ? 3 : 2,
  };
}
