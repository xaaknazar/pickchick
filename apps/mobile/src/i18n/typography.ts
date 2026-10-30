import type { TextStyle } from 'react-native';
import type { Locale } from './core';

const weights: Record<string, TextStyle['fontWeight']> = {
  Jost_600SemiBold: '600',
  Jost_700Bold: '700',
  Manrope_400Regular: '400',
  Manrope_600SemiBold: '600',
  Manrope_700Bold: '700',
};

// Bundled Jost and Manrope do not contain the complete Kazakh alphabet.
// Use one coherent system face, retaining hierarchy and dynamic text scaling.
export function kazakhTextStyle(
  locale: Locale,
  style: TextStyle | undefined,
  platform: string,
): TextStyle | undefined {
  if (locale !== 'kk') return undefined;
  const family = style?.fontFamily;
  if (family && !Object.hasOwn(weights, family)) return undefined;
  const weight = style?.fontWeight ?? (family ? weights[family] : undefined);
  return {
    fontFamily: platform === 'ios' ? 'System' : platform === 'android' ? 'sans-serif' : 'system-ui',
    ...(weight ? { fontWeight: weight } : {}),
  };
}
