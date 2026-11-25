// Floating capsule tab bar (owner request 2026-10-11: Luma pattern in PickChick colors).
// Pure geometry and palette so the screens, the bar and unit tests share one source.

export const tabBarPalette = {
  // Navy glass from the brand theme (--glass in mobile-v2). 0.92 is the body where nothing blurs
  // behind the capsule (Android): inactive labels stay AA-readable even over a white photo.
  glass: 'rgba(10, 32, 80, 0.92)',
  /**
   * Web: the backdrop is blurred, saturated and dimmed (`webDim`), then a thinner navy veil, so
   * the photos below read through it like Apple's glass; inactive labels keep AA even over a white
   * photo (tab-bar.test.mjs models the dim).
   */
  webVeil: 'rgba(10, 32, 80, 0.88)',
  webDim: 0.42,
  webBackdrop: 'blur(28px) saturate(180%) brightness(0.42)',
  /** iOS before 26: Apple's own tab bar material (systemChromeMaterialDark) under a brand veil. */
  chromeVeil: 'rgba(10, 32, 80, 0.7)',
  /**
   * iOS 26: Apple's Liquid Glass tinted navy. Untinted it was nearly clear on the iPhone, so the
   * photos showed through and the icons and labels got lost (owner 16.11.2026: «чуть темнее»,
   * variant 2 of the mock-ups on his screenshot, 70 %).
   */
  liquidTint: 'rgba(10, 32, 80, 0.7)',
  solid: '#0A2050',
  border: 'rgba(255, 255, 255, 0.10)',
  shadow: '#000000',
  /**
   * The selection (owner 15.11.2026: «как у Apple в точности»): iOS 26 marks the selected tab
   * with a light platter on the glass, not a darker pill. While pressed or dragged it swells into
   * a brighter lens with a light rim, like Liquid Glass.
   */
  pill: 'rgba(255, 255, 255, 0.1)',
  lens: 'rgba(255, 255, 255, 0.2)',
  lensRim: 'rgba(255, 255, 255, 0.42)',
  /** The selected icon and label: brand orange (accentText). */
  active: '#FF8A3D',
  inactive: '#B4C2DC',
} as const;

/** Labels follow Dynamic Type up to this factor; the bar must stay compact. */
export const tabLabelMaxScale = 1.3;

/** Owner 27.10.2026: Меню, События, Заказы. The profile moved to the top header. */
export const tabBarTabCount = 3;

/** Base label size: three tabs leave room for 12pt (11pt with four). Line height stays 16. */
export const tabLabelSize = 12;

/** iOS may shrink a label to this share of its size before truncating it. */
export const tabLabelMinFit = 0.8;

export type TabBarMetrics = {
  /** Distance from the bottom edge of the screen to the bottom of the capsule. */
  bottom: number;
  /** Horizontal inset of the capsule from each screen edge (before max width centering). */
  side: number;
  maxWidth: number;
  padding: number;
  itemHeight: number;
  height: number;
  /** Space the bar occupies from the screen bottom up to its top edge. */
  inset: number;
};

export function tabBarMetrics(
  insets: { bottom: number; left?: number; right?: number },
  fontScale = 1,
): TabBarMetrics {
  const scale = Math.min(Math.max(fontScale || 1, 1), tabLabelMaxScale);
  const label = Math.ceil(16 * scale);
  const padding = 5;
  // icon 23 + gap 3 + label, 6 above and below; never under the 48pt touch target.
  const itemHeight = Math.max(52, 6 + 23 + 3 + label + 6);
  const height = itemHeight + padding * 2;
  // Above the home indicator like Luma; devices without one keep a 12pt gap.
  const bottom = insets.bottom > 0 ? Math.max(12, insets.bottom - 14) : 12;
  const side = 16 + Math.max(insets.left ?? 0, insets.right ?? 0);
  return { bottom, side, maxWidth: 440, padding, itemHeight, height, inset: bottom + height };
}

/**
 * The cart bar (quick pay) lives in the tab bar's own layer, laid out right on top of the tab
 * capsule (owner 28.10.2026, TestFlight 25: «быстрая оплата застревает за иконками»). Before, each
 * tab screen drew it at `bottom: inset` computed from this formula, in a layer UNDER the tab bar:
 * whenever the real tab bar came out taller than the formula, or the screen's frame was shifted
 * for a moment, the tab bar covered the cart bar and took its taps. Stacked in one layer they
 * cannot overlap; this is the gap between the two capsules.
 */
export const tabCartGap = 10;

/**
 * Height of the docked cart bar before its first layout (padding 10 + capsule 64 + rims +
 * the gap), so tab content does not jump while it is measured.
 */
export const tabCartDockEstimate = 86;

/**
 * Space the tab bar covers from the screen bottom, from the tab capsule's measured height (never
 * less than the formula, which also holds until the first layout). Screen footers and the
 * payment scenes sit above it.
 */
export function measuredTabBarInset(
  metrics: Pick<TabBarMetrics, 'bottom' | 'height'>,
  tabBarHeight?: number | null,
): number {
  return metrics.bottom + Math.max(metrics.height, Math.ceil(tabBarHeight ?? 0));
}

/**
 * Space a tab screen reserves under its content: the tab bar plus the dock's measured height
 * while the cart has lines or the dock shows the payment resume banner on this tab (owner
 * 28.10.2026, the menu only); the estimate until it is measured with them.
 */
export function tabContentInset(
  tabBarInset: number,
  cartDockHeight: number | null | undefined,
  cartLines: number,
  resumeBanner = false,
): number {
  return (
    tabBarInset +
    (cartLines > 0 || resumeBanner ? Math.ceil(cartDockHeight || tabCartDockEstimate) : 0)
  );
}

/** Width of one tab: the items share the capsule evenly (flex: 1 in FloatingTabBar). */
export function tabItemWidth(
  screenWidth: number,
  metrics: Pick<TabBarMetrics, 'side' | 'maxWidth' | 'padding'>,
  count = tabBarTabCount,
): number {
  const bar = Math.min(metrics.maxWidth, screenWidth - metrics.side * 2);
  return (bar - metrics.padding * 2) / count;
}

// Last in the file: worklets capture what they use when they are defined (Reanimated).

/**
 * Selection motion, close to iOS 26's tab bar: a spring with a response of about 0.38 s and a
 * little bounce (damping ratio ~0.78) that carries the platter, and a faster one for the lens.
 */
export const tabSelectionSpring = { mass: 1, stiffness: 280, damping: 26 } as const;
export const tabLensSpring = { mass: 1, stiffness: 420, damping: 30 } as const;

/** After a tap the lens stays raised this long, so it rides to the new tab as glass. */
export const tabLensHoldMs = 220;

/** The chosen tab's glyph pops by this share, then springs back with a small bounce. */
export const tabIconBounce = 0.2;
// Damping ratio 0.7 (was 0.34): the glyph still pops once (owner 16.11), but settles without a
// visible wobble; a tab is pressed dozens of times a day (Emil Kowalski: bounce stays subtle).
export const tabIconBounceSpring = { mass: 1, stiffness: 320, damping: 25 } as const;

/** How far the platter stretches along its path mid-flight, and how much the lens swells. */
export const tabLensShape = { stretchX: 0.18, squashY: 0.06, swellX: 0.08, swellY: 0.2 } as const;

/**
 * The platter's shape at `position` (a tab index, fractional while it moves) with the lens
 * raised by `lens` (0..1): gel-like, widest halfway between two tabs, round again at rest.
 * Pure so the worklet and the unit tests share it.
 */
export function tabPlatterScale(position: number, lens: number): { x: number; y: number } {
  'worklet';
  const fraction = position - Math.floor(position);
  const moving = 1 - Math.abs(fraction - 0.5) * 2;
  return {
    x: 1 + tabLensShape.stretchX * moving + tabLensShape.swellX * lens,
    y: 1 - tabLensShape.squashY * moving + tabLensShape.swellY * lens,
  };
}

/** How selected tab `index` looks with the platter at `position`: 1 under it, 0 a tab away. */
export function tabSelection(position: number, index: number): number {
  'worklet';
  return Math.max(0, 1 - Math.abs(position - index));
}

/** The tab under a finger at `x` along the items row, clamped to the row. */
export function tabAt(x: number, itemWidth: number, count = tabBarTabCount): number {
  'worklet';
  if (!(itemWidth > 0)) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor(x / itemWidth)));
}
