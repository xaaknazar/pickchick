import tokens from '../../../packages/design-tokens/tokens.json';

export const brandColors = tokens.color;

export const colors = {
  ...tokens.theme.mobile,
  raised: tokens.theme.mobile.surfaceRaised,
  border: '#233962',
  orangeInk: '#251609',
  white: '#FFFFFF',
  success: '#ADEDD1',
  warning: '#FFE2C3',
  warningSurface: '#4B311D',
  danger: '#FFDBE5',
  dangerSurface: '#4D2434',
};
export const font = {
  heading: 'Jost_600SemiBold',
  display: 'Jost_700Bold',
  body: 'Manrope_400Regular',
  medium: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
};
export const spacing = { page: tokens.spacing[3] ?? 16, gap: 12, card: 20 };
