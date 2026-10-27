/**
 * Glass controls: the round buttons, the header profile, the cart bar capsule and its pills.
 *
 * Owner 27.10.2026: «стеклянные» кнопки как у Apple/Drinkit. Owner 28.10.2026: «это стиль Apple,
 * нужно как у них делать в точности, именно стиль стеклянности». So, best first:
 *
 * - `liquid`: Apple's own Liquid Glass (UIGlassEffect through expo-glass-effect `GlassView`) on
 *   iOS 26 and newer, when the binary contains the module and the system reports the API. Only
 *   here is the look exactly Apple's (edge light, lensing, the native press response).
 * - `blur`: expo-blur on older iOS binaries that contain it, CSS backdrop-filter on the web; a thin
 *   veil, a light rim, a specular edge and a top sheen imitate Liquid Glass.
 * - `tint`: no blur at all (Android, a binary without the blur module): a denser fill with the same
 *   rim and highlights, never a crash.
 * - `solid`: the system asks for reduced transparency: an opaque fill, also on iOS 26.
 *
 * Pure data and decisions (no React Native import) so unit tests cover every branch.
 */
export type GlassSurface = 'liquid' | 'blur' | 'tint' | 'solid';

export type GlassEnvironment = {
  /** `Platform.OS`. */
  platform: string;
  /** `Platform.Version`: '26.0' on iOS, an API level on Android, '' on the web. */
  osVersion?: string | number;
  /**
   * expo-glass-effect is in this binary and reports Liquid Glass: `isLiquidGlassAvailable()` (the
   * app is built with the iOS 26 SDK and does not opt out) and `isGlassEffectAPIAvailable()`
   * (some iOS 26 betas lack the API and would crash).
   */
  liquidGlass: boolean;
  /** expo-blur is in this (iOS) binary. */
  nativeBlur: boolean;
  /** iOS «Reduce Transparency», the web `prefers-reduced-transparency: reduce`. */
  reducedTransparency: boolean;
};

/** Liquid Glass (UIGlassEffect) exists from iOS 26. */
export const LIQUID_GLASS_MIN_IOS = 26;

/** Major version from `Platform.Version` ('26.0.1' -> 26, 18 -> 18); unknown -> 0. */
export function iosMajorVersion(version: string | number | undefined): number {
  if (typeof version === 'number') return Number.isFinite(version) ? Math.floor(version) : 0;
  const major = Number.parseInt(String(version ?? '').trim(), 10);
  return Number.isFinite(major) ? major : 0;
}

export function glassSurface(env: GlassEnvironment): GlassSurface {
  if (env.reducedTransparency) return 'solid';
  if (
    env.platform === 'ios' &&
    env.liquidGlass &&
    iosMajorVersion(env.osVersion) >= LIQUID_GLASS_MIN_IOS
  )
    return 'liquid';
  if (env.platform === 'web') return 'blur';
  if (env.platform === 'ios' && env.nativeBlur) return 'blur';
  return 'tint';
}

/**
 * Where a glass shape sits:
 * - `button`: round icon buttons over the dark sheets and screens (close, back, trash, -/+);
 * - `header`: the profile button over the menu hero video and the dark tabs;
 * - `pill`: the payment handle and the bag pill inside the cart bar;
 * - `bar`: the cart bar capsule itself.
 */
export type GlassPlace = 'button' | 'header' | 'pill' | 'bar';

export type LiquidGlassConfig = {
  glassEffectStyle: 'regular' | 'clear';
  isInteractive: boolean;
  colorScheme: 'dark';
};

/**
 * Apple's settings per place (HIG «Materials», iOS 26):
 * - `regular` everywhere. HIG keeps `clear` for glass over media whose content must stay visible
 *   and asks for an extra dimming layer when that media is bright; the hero video is bright and
 *   the guest glyph must stay readable, and Drinkit's header buttons over its video are the
 *   darkened regular glass, the same as its trash and X over the dark sheet.
 * - `isInteractive` for controls the customer presses (buttons, the profile), so the press, shine
 *   and flex are Apple's. The pay handle is not interactive: its response is the elastic stretch
 *   of the slide (owner 6a), a native flex under the finger would fight it. The capsule is not
 *   interactive either: the handle drags inside it.
 * - No tint: Apple reserves tinted glass for a primary action; the red trash keeps a red glyph on
 *   neutral glass. The app is dark only (`userInterfaceStyle: dark`), so the glass is dark.
 */
export function liquidGlassConfig(place: GlassPlace): LiquidGlassConfig {
  return {
    glassEffectStyle: 'regular',
    isInteractive: place === 'button' || place === 'header',
    colorScheme: 'dark',
  };
}

export const glass = {
  /** Smallest round control; Apple HIG hit target. */
  minSize: 44,
  size: 48,
  /**
   * expo-blur strength (iOS < 26: UIBlurEffect `.dark` run to `intensity / 100`; the web:
   * `blur(intensity * 0.2 px) saturate(180%)` over a dark tint). Raised with the thinner veil so
   * a white glyph keeps 3:1 over a white backdrop on both: the native dark blur tints a little
   * less than the web one at the same strength (by the model in liquid-glass.test.mjs, 46 gave
   * about 2.9:1 natively, 52 gives about 3.2:1; not yet measured on an iPhone with iOS 18).
   */
  blurIntensity: 52,
  /** Over the blur: a thin navy veil (0.34 before 28.10), so more of what is behind shows. */
  veil: 'rgba(16, 36, 84, 0.26)',
  /** Without blur: denser fill so the glyph keeps its contrast on photos. */
  fallback: 'rgba(20, 48, 107, 0.86)',
  /** Reduced transparency: an opaque raised navy that still reads on the dark background. */
  solid: '#123068',
  /** Dark Liquid Glass lifts dark content a little; this keeps the button lighter than the sheet. */
  lift: 'rgba(255, 255, 255, 0.05)',
  /** The light rim (0.22 before 28.10). */
  rim: 'rgba(255, 255, 255, 0.3)',
  pressedVeil: 'rgba(255, 255, 255, 0.14)',
  /** Light from above and a faint glow along the bottom edge, as on Liquid Glass. */
  sheen:
    'linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.04) 45%, rgba(255,255,255,0) 70%, rgba(255,255,255,0.06) 100%)',
  /** Specular edge: a bright inner line along the top, a softer one along the bottom. */
  specular: 'inset 0 1px 1px rgba(255, 255, 255, 0.5), inset 0 -1px 1px rgba(255, 255, 255, 0.16)',
  icon: '#FFFFFF',
  /** Drinkit-like red trash (iOS system red, owner 27.10); >= 3:1 on the navy glass (WCAG non-text). */
  danger: '#FF3B30',
  /** The cart bar capsule: it carries the total over scrolling photos, so its veil is denser. */
  bar: {
    /** Web, over `backdrop` (0.94 before 28.10). */
    veil: 'rgba(10, 32, 80, 0.8)',
    backdrop: 'saturate(180%) blur(20px)',
    /** Native without Liquid Glass: nothing blurs behind the capsule, so the fill stays dense. */
    fallback: 'rgba(10, 32, 80, 0.94)',
    solid: '#0A2050',
    rim: 'rgba(255, 255, 255, 0.24)',
  },
} as const;

/** What the fallback glass is made of, per surface (`liquid` draws none of it: Apple does). */
export type GlassLayers = {
  blur: boolean;
  /** The colour right over the blur, or instead of it; null on `liquid`. */
  fill: string | null;
  lift: boolean;
  /** Sheen and specular edge. */
  highlights: boolean;
  /** Our own rim; `liquid` shows Apple's edge instead. */
  rim: string;
  /** Our press veil and scale; `liquid` has the native interactive response. */
  pressFeedback: boolean;
};

export function glassLayers(surface: GlassSurface): GlassLayers {
  switch (surface) {
    case 'liquid':
      return {
        blur: false,
        fill: null,
        lift: false,
        highlights: false,
        rim: 'transparent',
        pressFeedback: false,
      };
    case 'blur':
      return {
        blur: true,
        fill: glass.veil,
        lift: true,
        highlights: true,
        rim: glass.rim,
        pressFeedback: true,
      };
    case 'tint':
      // The dense navy is already lighter than the sheet; a lift would take the red trash
      // below 3:1.
      return {
        blur: false,
        fill: glass.fallback,
        lift: false,
        highlights: true,
        rim: glass.rim,
        pressFeedback: true,
      };
    case 'solid':
      return {
        blur: false,
        fill: glass.solid,
        lift: false,
        highlights: true,
        rim: glass.rim,
        pressFeedback: true,
      };
  }
}

/** The cart bar capsule's own body per surface; `web` adds the CSS backdrop blur. */
export function glassBarBody(
  surface: GlassSurface,
  web: boolean,
): { fill: string; backdrop: string | null; rim: string } {
  if (surface === 'liquid') return { fill: 'transparent', backdrop: null, rim: 'transparent' };
  if (surface === 'solid') return { fill: glass.bar.solid, backdrop: null, rim: glass.bar.rim };
  if (surface === 'blur' && web)
    return { fill: glass.bar.veil, backdrop: glass.bar.backdrop, rim: glass.bar.rim };
  return { fill: glass.bar.fallback, backdrop: null, rim: glass.bar.rim };
}

/** The control never shrinks below the 44 pt target, whatever a caller passes. */
export function glassSize(requested?: number): number {
  return Math.max(glass.minSize, Math.round(requested ?? glass.size));
}
