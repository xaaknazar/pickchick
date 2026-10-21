import { Platform, type ViewStyle } from 'react-native';
import { redesign } from '../theme';

/** Shared material of the owner's language/mode/close controls. Finite roles keep contrast. */
export function glassSurface(
  tone: 'dark' | 'light' | 'accent' | 'brand' | 'danger' = 'dark',
): ViewStyle {
  const light = tone === 'light';
  const fill =
    tone === 'accent'
      ? '#FF6900'
      : tone === 'brand'
        ? 'rgba(0,71,187,.92)'
        : tone === 'danger'
          ? 'rgba(175,37,37,.94)'
          : light
            ? 'rgba(238,244,255,.94)'
            : redesign.glass;
  return {
    backgroundColor: fill,
    borderWidth: 1,
    borderColor: light ? 'rgba(0,71,187,.25)' : 'rgba(255,255,255,.28)',
    borderTopColor: light ? '#FFFFFF' : 'rgba(255,255,255,.58)',
    shadowColor: '#020A1F',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    ...(Platform.OS === 'web'
      ? ({
          backdropFilter: 'blur(18px) saturate(150%)',
          WebkitBackdropFilter: 'blur(18px) saturate(150%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,.3), 0 6px 18px rgba(2,10,31,.16)',
        } as ViewStyle)
      : {}),
  };
}
