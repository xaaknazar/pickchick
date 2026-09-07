import { useWindowDimensions } from 'react-native';
export const colors = {
  blue: '#0047BB',
  orange: '#FF671F',
  background: '#F4F6FA',
  ink: '#0E1524',
  muted: '#5A6478',
  border: '#DFE4EC',
  light: '#F2F4F8',
  dark: '#070C16',
  error: '#C4302B',
  white: '#FFFFFF',
};
export const fonts = {
  body: 'GolosText_400Regular',
  medium: 'GolosText_600SemiBold',
  bold: 'GolosText_700Bold',
  heading: 'Montserrat_700Bold',
  heavy: 'Montserrat_800ExtraBold',
};
export function useMetrics() {
  const { width, height, fontScale } = useWindowDimensions();
  const scale = Math.max(0.68, Math.min(1.12, width / 1024));
  return {
    width,
    height,
    scale,
    landscape: width > height,
    columns: width >= 1180 ? 3 : 2,
    compact: height < 850,
    px: (value: number) => Math.round(value * scale),
    body: Math.max(16, Math.round(21 * scale)),
    fontScale,
  };
}
