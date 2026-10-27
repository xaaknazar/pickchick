/**
 * Round glass controls (owner 27.10.2026: «стеклянные» кнопки как у Apple/Drinkit).
 *
 * Real blur needs the expo-blur native view: iOS builds that contain it and the web
 * (CSS backdrop-filter). Android and an older native binary without the module get the
 * same shape as a semi-transparent fill with a hairline rim - never a crash.
 */
export type GlassSurface = 'blur' | 'tint';

export function glassSurface(platform: string, nativeBlurInstalled: boolean): GlassSurface {
  if (platform === 'web') return 'blur';
  if (platform === 'ios' && nativeBlurInstalled) return 'blur';
  return 'tint';
}

export const glass = {
  /** Smallest round control; Apple HIG hit target. */
  minSize: 44,
  size: 48,
  blurIntensity: 38,
  /** Over the blur: a light navy veil keeps the brand colour behind the glyph. */
  veil: 'rgba(20, 48, 107, 0.34)',
  /** Without blur: denser fill so the glyph keeps its contrast on photos. */
  fallback: 'rgba(20, 48, 107, 0.86)',
  rim: 'rgba(255, 255, 255, 0.22)',
  pressedVeil: 'rgba(255, 255, 255, 0.14)',
  sheen:
    'linear-gradient(180deg, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0.05) 48%, rgba(255,255,255,0) 100%)',
  icon: '#FFFFFF',
  /** Drinkit-like red trash; 4.5:1+ on the navy glass. */
  danger: '#FF6B5E',
} as const;

/** The control never shrinks below the 44 pt target, whatever a caller passes. */
export function glassSize(requested?: number): number {
  return Math.max(glass.minSize, Math.round(requested ?? glass.size));
}
